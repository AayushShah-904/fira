const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getDb } = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/auth');

const localAgentPath = path.resolve(__dirname, '../../../fixed-income-analytics/rate-discovery-agent');
const siblingAgentPath = path.resolve(__dirname, '../../../../fixed-income-analytics/rate-discovery-agent');
const DEFAULT_AGENT_ROOT = fs.existsSync(localAgentPath) ? localAgentPath : siblingAgentPath;
const configuredAgentRoot = (process.env.RATE_AGENT_ROOT || '').replace(/^["']|["']$/g, '');
const AGENT_ROOT = configuredAgentRoot || DEFAULT_AGENT_ROOT;

const AZURE_COHORT_BANKS = {
  'fcnr-top-5': [
    'bank-of-ceylon',
    'canara-bank',
    'bandhan-bank-limited',
    'bank-of-bahrain-and-kuwait-bsc'
  ],
  'gold-11-nri-banks': [
    'yes-bank-limited',
    'yes-bank-ibu',
    'axis-bank-limited',
    'axis-bank-ibu',
    'au-small-finance-bank-limited',
    'icici-bank-limited',
    'icici-bank-ibu',
    'rbl-bank-limited',
    'rbl-bank-ibu',
    'idfc-first-bank-limited',
    'idfc-first-bank-ibu',
    'canara-bank',
    'canara-bank-ibu',
    'indian-overseas-bank',
    'bank-of-maharashtra',
    'bank-of-maharashtra-ibu',
    'saraswat-co-operative-bank-ltd',
    'cosmos-co-operative-bank-ltd'
  ],
  'top-12': [
    'state-bank-of-india',
    'bank-of-baroda',
    'punjab-national-bank',
    'hdfc-bank-limited',
    'icici-bank-limited',
    'axis-bank-limited',
    'kotak-mahindra-bank-limited',
    'au-small-finance-bank-limited',
    'equitas-small-finance-bank-limited',
    'citibank-na',
    'bank-of-india-ibu',
    'abhyudaya-co-operative-bank-ltd-mumbai'
  ]
};

function readCohortBanks(cohortName) {
  const cohortPath = path.join(AGENT_ROOT, 'data', 'cohorts', `${cohortName}.json`);
  const cohort = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));

  if (!Array.isArray(cohort)) {
    throw new Error(`Invalid cohort file: ${cohortPath}`);
  }

  return cohort
    .map(entry => entry?.bank_code)
    .filter(Boolean);
}

function parseTargetFlags(target) {
  const parts = String(target || '').split(/\s+/).filter(Boolean);
  const flags = {};

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.startsWith('--')) continue;

    const key = part.slice(2);
    const values = [];
    while (parts[i + 1] && !parts[i + 1].startsWith('--')) {
      values.push(parts[++i]);
    }
    flags[key] = values;
  }

  return flags;
}

function buildAzureDiscoveryPayload(target) {
  const trimmedTarget = String(target || '').trim();
  const flags = parseTargetFlags(trimmedTarget);

  if (flags.banks?.length) {
    return { banks: flags.banks.flatMap(bank => bank.split(',')).map(bank => bank.trim()).filter(Boolean) };
  }

  if (flags.category?.[0]) {
    return { category: flags.category[0] };
  }

  if (flags.cadence?.[0]) {
    return { cadence: flags.cadence[0] };
  }

  if (flags.cohort?.[0]) {
    const cohortName = flags.cohort[0];
    let banks = [];

    try {
      banks = readCohortBanks(cohortName);
    } catch (err) {
      banks = AZURE_COHORT_BANKS[cohortName] || [];
    }

    if (banks.length > 0) {
      return { banks };
    }

    return { cadence: cohortName };
  }

  return { banks: [trimmedTarget] };
}

// All admin routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/v1/admin/stats — platform overview
router.get('/stats', (req, res) => {
  const db = getDb();

  // User stats
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active=1').get().c;
  const planBreakdown = db.prepare('SELECT plan, COUNT(*) as c FROM users WHERE is_active=1 GROUP BY plan').all();
  const recentRegistrations = db.prepare(`
    SELECT COUNT(*) as c FROM users
    WHERE is_active=1 AND created_at >= datetime('now', '-7 days')
  `).get().c;
  const recentLogins = db.prepare(`
    SELECT COUNT(*) as c FROM users
    WHERE is_active=1 AND last_login >= datetime('now', '-7 days')
  `).get().c;
  const todayRegistrations = db.prepare(`
    SELECT COUNT(*) as c FROM users
    WHERE is_active=1 AND created_at >= datetime('now', '-1 days')
  `).get().c;

  // Content stats
  const totalBanks = db.prepare('SELECT COUNT(*) as c FROM banks WHERE is_active=1').get().c;
  const totalRates = db.prepare('SELECT COUNT(*) as c FROM fd_rates').get().c;
  const verifiedRates = db.prepare('SELECT COUNT(*) as c FROM fd_rates WHERE verified=1').get().c;
  const scrapedRates = db.prepare("SELECT COUNT(*) as c FROM fd_rates WHERE verified=0").get().c;

  // Rate product breakdown
  const ratesByProduct = db.prepare(`
    SELECT product_type, COUNT(*) as c FROM fd_rates GROUP BY product_type ORDER BY c DESC
  `).all();

  // Bank category breakdown
  const banksByCategory = db.prepare(`
    SELECT c.code, c.name, COUNT(b.id) as count
    FROM bank_categories c
    LEFT JOIN banks b ON b.category_id=c.id AND b.is_active=1
    GROUP BY c.id ORDER BY c.sort_order
  `).all();

  // Email verification stats
  const emailVerified = db.prepare('SELECT COUNT(*) as c FROM users WHERE email_verified=1').get().c;

  // Watchlist/client stats
  const totalWatchlists = db.prepare('SELECT COUNT(*) as c FROM watchlists').get().c;
  const totalClients = db.prepare('SELECT COUNT(*) as c FROM client_profiles').get().c;

  // Feedback stats
  const totalFeedback = db.prepare('SELECT COUNT(*) as c FROM feedback').get().c;
  const feedbackByCategory = db.prepare('SELECT category, COUNT(*) as c FROM feedback GROUP BY category ORDER BY c DESC').all();

  res.json({
    users: {
      total: totalUsers,
      plans: planBreakdown,
      registrations_today: todayRegistrations,
      registrations_7d: recentRegistrations,
      active_logins_7d: recentLogins,
      email_verified: emailVerified,
    },
    content: {
      banks: totalBanks,
      rates_total: totalRates,
      rates_verified: verifiedRates,
      rates_scraped: scrapedRates,
      rates_by_product: ratesByProduct,
      banks_by_category: banksByCategory,
    },
    engagement: {
      watchlists: totalWatchlists,
      client_profiles: totalClients,
      feedback_total: totalFeedback,
      feedback_by_category: feedbackByCategory,
    },
  });
});

// GET /api/v1/admin/users — recent users list
router.get('/users', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const lim = Math.min(100, parseInt(limit) || 50);

  const users = db.prepare(`
    SELECT id, email, name, firm, advisor_type, ria_reg_no, role, plan,
           email_verified, created_at, last_login, is_active
    FROM users
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(lim, offset);

  const { total } = db.prepare('SELECT COUNT(*) as total FROM users').get();

  res.json({
    data: users,
    pagination: { page: parseInt(page), limit: lim, total, pages: Math.ceil(total / lim) },
  });
});

// POST /api/v1/admin/users/:id/role — change user role
router.post('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const db = getDb();
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  res.json({ success: true });
});

// GET /api/v1/admin/onboarding-stats — breakdown of user onboarding answers
router.get('/onboarding-stats', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      COALESCE(onboarding_answer, 'no_response') as answer,
      COUNT(*) as count
    FROM users
    WHERE role != 'guest' AND is_active = 1
    GROUP BY answer
    ORDER BY count DESC
  `).all();
  const total = rows.reduce((s, r) => s + r.count, 0);
  res.json({
    data: rows.map(r => ({ ...r, pct: total ? Math.round(r.count * 1000 / total) / 10 : 0 })),
    total,
  });
});

// GET /api/v1/admin/feedback — recent feedback list
router.get('/feedback', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 20 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const lim = Math.min(100, parseInt(limit) || 20);

  const feedback = db.prepare(`
    SELECT f.*, u.name as user_name, u.email as user_email
    FROM feedback f
    JOIN users u ON u.id = f.user_id
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(lim, offset);

  const { total } = db.prepare('SELECT COUNT(*) as total FROM feedback').get();

  res.json({
    data: feedback,
    pagination: { page: parseInt(page), limit: lim, total, pages: Math.ceil(total / lim) },
  });
});

// GET /api/v1/admin/analytics — page view stats
router.get('/analytics', (req, res) => {
  const db = getDb();
  const since = req.query.since || "datetime('now', '-7 days')";

  // Top pages (by view count)
  const topPages = db.prepare(`
    SELECT resource as path, COUNT(*) as views,
           AVG(CAST(resource_id AS INTEGER)) as avg_duration_ms,
           COUNT(DISTINCT user_id) as unique_users
    FROM audit_log
    WHERE action = 'page_view'
      AND created_at >= datetime('now', '-7 days')
    GROUP BY resource
    ORDER BY views DESC
    LIMIT 50
  `).all();

  // Active users by day
  const activeUsersByDay = db.prepare(`
    SELECT DATE(created_at) as day,
           COUNT(DISTINCT user_id) as active_users,
           COUNT(*) as page_views
    FROM audit_log
    WHERE action = 'page_view'
      AND created_at >= datetime('now', '-30 days')
    GROUP BY DATE(created_at)
    ORDER BY day DESC
    LIMIT 30
  `).all();

  // Most engaged users
  const topUsers = db.prepare(`
    SELECT u.name, u.email, u.role, u.plan,
           COUNT(a.id) as page_views,
           SUM(CAST(a.resource_id AS INTEGER)) as total_time_ms,
           COUNT(DISTINCT a.resource) as unique_pages
    FROM audit_log a
    JOIN users u ON u.id = a.user_id
    WHERE a.action = 'page_view'
      AND a.created_at >= datetime('now', '-30 days')
    GROUP BY a.user_id
    ORDER BY page_views DESC
    LIMIT 20
  `).all();

  const total = db.prepare(`
    SELECT COUNT(*) as views,
           COUNT(DISTINCT user_id) as unique_users
    FROM audit_log
    WHERE action = 'page_view'
      AND created_at >= datetime('now', '-30 days')
  `).get();

  res.json({
    summary: { views_30d: total.views, unique_users_30d: total.unique_users },
    top_pages: topPages,
    active_users_by_day: activeUsersByDay,
    top_users: topUsers,
  });
});

// ─── ADMIN PIPELINE ROUTE HANDLERS ─────────────────────────────────
const pipelineJobs = new Map();
let activeJobId = null;

function logToJob(job, text) {
  const formatted = `[${new Date().toLocaleTimeString()}] ${text}`;
  job.logs.push(formatted);
  if (job.logFile) {
    try {
      const fs = require('fs');
      fs.appendFileSync(job.logFile, formatted + '\n');
    } catch (err) {
      // ignore
    }
  }
}

function addLogs(job, data) {
  const text = data.toString();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim()) {
      logToJob(job, line);
    }
  }
  if (job.logs.length > 500) {
    job.logs = job.logs.slice(job.logs.length - 500);
  }
}

function parseSummaryFromLogs(logs) {
  const summary = {
    banksAdded: 0,
    banksMatched: 0,
    ratesAdded: 0,
    ratesUpdated: 0,
    ratesSkipped: 0,
    totalBanks: 0,
    totalRates: 0
  };

  for (const line of logs) {
    if (line.includes('Banks added:')) {
      const match = line.match(/Banks added:\s+(\d+)/);
      if (match) summary.banksAdded = parseInt(match[1], 10);
    } else if (line.includes('Banks matched:')) {
      const match = line.match(/Banks matched:\s+(\d+)/);
      if (match) summary.banksMatched = parseInt(match[1], 10);
    } else if (line.includes('Rates added:')) {
      const match = line.match(/Rates added:\s+(\d+)/);
      if (match) summary.ratesAdded = parseInt(match[1], 10);
    } else if (line.includes('Rates updated:')) {
      const match = line.match(/Rates updated:\s+(\d+)/);
      if (match) summary.ratesUpdated = parseInt(match[1], 10);
    } else if (line.includes('Rates kept (ours):')) {
      const match = line.match(/Rates kept \(ours\):\s+(\d+)/);
      if (match) summary.ratesSkipped = parseInt(match[1], 10);
    } else if (line.includes('Total banks:')) {
      const match = line.match(/Total banks:\s+(\d+)/);
      if (match) summary.totalBanks = parseInt(match[1], 10);
    } else if (line.includes('Total rates:')) {
      const match = line.match(/Total rates:\s+(\d+)/);
      if (match) summary.totalRates = parseInt(match[1], 10);
    }
  }

  return summary;
}

function runPipelineJob(jobId) {
  const job = pipelineJobs.get(jobId);
  if (!job) return;

  const target = job.target || 'hdfc-bank-limited';
  const functionUrl = process.env.AZURE_FUNCTION_URL;
  const functionKey = process.env.AZURE_FUNCTION_KEY;
  const ratesPackUrl = process.env.RATES_PACK_URL;

  const isAzureConfigured = 
    functionUrl && 
    functionKey && 
    ratesPackUrl &&
    !functionKey.includes('your_retrieved_default_key_here') &&
    !ratesPackUrl.includes('?sv=...');

  if (isAzureConfigured) {
    // ─── AZURE EXECUTION MODE ─────────────────────────────────────────
    job.phase = 'discovery';
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    logToJob(job, `[SYSTEM] Starting Azure Trigger Rate Discovery (target: ${target})`);
    logToJob(job, `[SYSTEM] Target Azure Function: ${functionUrl.split('?')[0]}`);

    // Parse dropdown target into the Azure Function contract:
    // exactly one of banks, category, or cadence.
    const payload = buildAzureDiscoveryPayload(target);
    logToJob(job, `[SYSTEM] Azure request selector: ${JSON.stringify(payload)}`);

    const startController = new AbortController();
    const startTimeoutId = setTimeout(() => startController.abort(), 15000);

    // Call start-discovery function
    fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-functions-key': functionKey
      },
      body: JSON.stringify(payload),
      signal: startController.signal
    })
    .then(async (response) => {
      clearTimeout(startTimeoutId);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Azure Function responded with ${response.status}: ${text}`);
      }
      return response.json();
    })
    .then((data) => {
      const executionId = data.executionId;
      logToJob(job, `[AZURE] Triggered successfully. Execution ID: ${executionId}`);
      
      // Start background polling loop
      const statusUrl = `${functionUrl.substring(0, functionUrl.lastIndexOf('/'))}/job-status/${executionId}`;
      
      const downloadAndImportRates = async () => {
        const ratesPackUrl = process.env.RATES_PACK_URL;
        if (!ratesPackUrl) {
          throw new Error('RATES_PACK_URL environment variable is not configured.');
        }

        // Clean the URL by stripping any existing SAS query string (anything after '?')
        const cleanUrl = ratesPackUrl.split('?')[0];

        logToJob(job, `[SYSTEM] Fetching rates-pack.json from Blob Storage using Entra ID...`);
        
        let headers = {};
        try {
          const { DefaultAzureCredential } = require('@azure/identity');
          const credential = new DefaultAzureCredential();
          // Request token for Azure Storage API
          const tokenResponse = await credential.getToken('https://storage.azure.com/.default');
          headers = {
            'Authorization': `Bearer ${tokenResponse.token}`,
            'x-ms-version': '2023-11-03' // required for bearer token storage requests
          };
          logToJob(job, `[SYSTEM] Entra ID token acquired successfully.`);
        } catch (authErr) {
          logToJob(job, `[SYSTEM WARNING] Failed to acquire Entra ID token: ${authErr.message}. Attempting anonymous fetch...`);
        }

        const res = await fetch(cleanUrl, { headers });
        if (!res.ok) {
          throw new Error(`Failed to download rates-pack: HTTP ${res.status}`);
        }

        const packData = await res.json();
        logToJob(job, `[SYSTEM] Downloaded rates pack: ${packData.banks?.length || 0} banks.`);

        // Save a local copy for developer inspection
        try {
          const localPackPath = path.resolve(__dirname, '../../logs', 'rates-pack-latest.json');
          fs.writeFileSync(localPackPath, JSON.stringify(packData, null, 2));
          logToJob(job, `[SYSTEM] Saved rates-pack snapshot: ${localPackPath}`);
        } catch (saveErr) {
          logToJob(job, `[SYSTEM WARNING] Could not save local rates-pack copy: ${saveErr.message}`);
        }

        logToJob(job, `[SYSTEM] Running database import transaction...`);
        const { importRatesPack } = require('../services/importer');
        const stats = importRatesPack(getDb(), packData);

        logToJob(job, `[SYSTEM] Database sync complete.`);
        logToJob(job, `  - Banks added: ${stats.banksAdded}`);
        logToJob(job, `  - Banks matched: ${stats.banksMatched}`);
        logToJob(job, `  - Rates added: ${stats.ratesAdded}`);
        logToJob(job, `  - Rates updated: ${stats.ratesUpdated}`);
        logToJob(job, `  - Rates kept (ours): ${stats.ratesOurVerifiedKept}`);

        job.status = 'done';
        job.phase = 'done';
        job.finishedAt = new Date().toISOString();
        job.summary = stats;
        activeJobId = null;
      };

      const poll = async () => {
        // Stop polling if job status is no longer running (e.g. aborted)
        const currentJob = pipelineJobs.get(jobId);
        if (!currentJob || currentJob.status !== 'running') return;

        try {
          const pollController = new AbortController();
          const pollTimeoutId = setTimeout(() => pollController.abort(), 10000);

          const res = await fetch(statusUrl, {
            headers: { 'x-functions-key': functionKey },
            signal: pollController.signal
          });
          clearTimeout(pollTimeoutId);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const statusData = await res.json();
          const armStatus = statusData.arm_status;
          const receiptFound = statusData.receipt_found;
          const summary = statusData.summary;

          logToJob(currentJob, `[AZURE] Job Execution: ${armStatus} (Receipt found: ${receiptFound ? 'Yes' : 'No'})`);

          if (summary) {
            const completed = (summary.succeeded || 0) + (summary.failed || 0) + (summary.rate_limited || 0) + (summary.skipped || 0);
            const total = summary.total_banks || 0;
            const progressKey = `${completed}/${total}-S:${summary.succeeded}-F:${summary.failed}`;
            
            if (currentJob.lastProgressKey !== progressKey) {
              currentJob.lastProgressKey = progressKey;
              logToJob(currentJob, `[AZURE] Progress: ${completed}/${total} banks processed (Succeeded: ${summary.succeeded || 0}, Failed: ${summary.failed || 0})`);
            }
          }

          if (armStatus === 'Succeeded' || (armStatus === 'Failed' && receiptFound)) {
            if (armStatus === 'Failed') {
              logToJob(currentJob, `[AZURE] Job failed on the platform, but business receipt was found. Syncing available rates.`);
            }
            currentJob.phase = 'sync';
            await downloadAndImportRates();
          } else if (armStatus === 'Failed' || armStatus === 'Stopped') {
            throw new Error(`Azure Job failed/stopped with status: ${armStatus} (No receipt found)`);
          } else {
            // Re-schedule poll in 15 seconds
            setTimeout(poll, 15000);
          }
        } catch (err) {
          logToJob(currentJob, `[SYSTEM ERROR] Status polling failed: ${err.message}`);
          currentJob.status = 'error';
          currentJob.finishedAt = new Date().toISOString();
          activeJobId = null;
        }
      };

      // Kick off the polling loop
      setTimeout(poll, 10000);
    })
    .catch((err) => {
      logToJob(job, `[SYSTEM ERROR] Failed to dispatch Azure Job: ${err.message}`);
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      activeJobId = null;
    });

    return;
  }

  // ─── LOCAL EXECUTION MODE (FALLBACK) ──────────────────────────────
  job.phase = 'discovery';
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  logToJob(job, `[SYSTEM] Starting Local Rate Discovery Agent (target: ${target})`);
  logToJob(job, `[SYSTEM] Working Directory: ${AGENT_ROOT}`);

  const runBatchPath = path.join(AGENT_ROOT, 'run-batch.js');
  const targetDbPath = path.resolve(__dirname, '../../data/fdrates.db');

  let args = [];
  if (target.startsWith('--cohort')) {
    args = target.split(/\s+/).filter(Boolean);
  } else {
    args = [target];
  }

  // Spawn rate discovery process
  const discoveryProcess = spawn(
    process.execPath,
    [runBatchPath, ...args],
    {
      cwd: AGENT_ROOT,
      env: { ...process.env, DB_PATH: targetDbPath }
    }
  );

  job.process = discoveryProcess;

  discoveryProcess.stdout.on('data', (data) => {
    addLogs(job, data);
  });

  discoveryProcess.stderr.on('data', (data) => {
    addLogs(job, data);
  });

  discoveryProcess.on('error', (err) => {
    if (job.status === 'done' || job.status === 'error') return;
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    logToJob(job, `[SYSTEM ERROR] Discovery process error: ${err.message}`);
    activeJobId = null;
  });

  discoveryProcess.on('exit', (code) => {
    if (job.status === 'error') return; // process was terminated or errored out already

    const fs = require('fs');
    const latestBatchResults = path.join(AGENT_ROOT, 'output/latest/_batch_results_all.json');
    let completedSuccessfully = false;
    try {
      if (fs.existsSync(latestBatchResults)) {
        const stats = fs.statSync(latestBatchResults);
        const mtimeMs = stats.mtimeMs;
        completedSuccessfully = mtimeMs >= new Date(job.startedAt).getTime() - 5000;
      }
    } catch (err) {
      // ignore
    }

    if (code !== 0 && !completedSuccessfully) {
      job.status = 'error';
      job.phase = 'discovery';
      job.finishedAt = new Date().toISOString();
      logToJob(job, `[SYSTEM ERROR] Discovery process exited with code ${code}`);
      activeJobId = null;
      return;
    }

    const outcomeText = code === 0 ? 'successfully' : 'with failed banks';
    logToJob(job, `[SYSTEM] Rate Discovery finished ${outcomeText} (exit code: ${code}). Starting Sync pipeline...`);
    job.phase = 'sync';

    const syncScriptPath = path.join(AGENT_ROOT, 'sync-rates-to-fira.js');

    // Spawn sync script
    const syncProcess = spawn(
      process.execPath,
      [syncScriptPath],
      {
        cwd: AGENT_ROOT,
        env: { ...process.env, DB_PATH: targetDbPath }
      }
    );

    job.process = syncProcess;

    syncProcess.stdout.on('data', (data) => {
      addLogs(job, data);
    });

    syncProcess.stderr.on('data', (data) => {
      addLogs(job, data);
    });

    syncProcess.on('error', (err) => {
      if (job.status === 'done' || job.status === 'error') return;
      job.status = 'error';
      job.phase = 'sync';
      job.finishedAt = new Date().toISOString();
      logToJob(job, `[SYSTEM ERROR] Sync process error: ${err.message}`);
      activeJobId = null;
    });

    syncProcess.on('exit', (syncCode) => {
      if (job.status === 'error') return;
      job.finishedAt = new Date().toISOString();
      activeJobId = null;

      if (syncCode !== 0) {
        job.status = 'error';
        job.phase = 'sync';
        logToJob(job, `[SYSTEM ERROR] Sync process exited with code ${syncCode}`);
        return;
      }

      job.status = 'done';
      job.phase = 'done';
      logToJob(job, `[SYSTEM] Pipeline finished successfully!`);
      job.summary = parseSummaryFromLogs(job.logs);
    });
  });
}

// POST /api/v1/admin/pipeline/start
router.post('/pipeline/start', (req, res) => {
  if (activeJobId) {
    const activeJob = pipelineJobs.get(activeJobId);
    if (activeJob && activeJob.status === 'running') {
      return res.status(400).json({ error: 'A rate refresh pipeline is already running.', jobId: activeJobId });
    }
  }

  const { target = 'hdfc-bank-limited' } = req.body;

  const jobId = `run_${Date.now()}`;
  
  const fs = require('fs');
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  
  const y = istDate.getUTCFullYear();
  const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(istDate.getUTCDate()).padStart(2, '0');
  const h = String(istDate.getUTCHours()).padStart(2, '0');
  const min = String(istDate.getUTCMinutes()).padStart(2, '0');
  const s = String(istDate.getUTCSeconds()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}_${h}-${min}-${s}`;
  
  const logFile = path.resolve(__dirname, '../../logs', `manual_run_${dateStr}.log`);
  
  // Ensure logs directory exists
  const logsDir = path.dirname(logFile);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const job = {
    jobId,
    target,
    phase: 'idle',
    status: 'running',
    startedAt: now.toISOString(),
    finishedAt: null,
    logs: [],
    logFile,
    summary: null,
    process: null
  };

  pipelineJobs.set(jobId, job);
  activeJobId = jobId;

  // Run in background asynchronously
  runPipelineJob(jobId);

  res.json({ success: true, jobId });
});

// GET /api/v1/admin/pipeline/status/:jobId
// Optional query param: ?offset=N  — only returns log lines [N..end], plus totalLines count.
// If offset is omitted, returns all logs (first load / reconstruction).
router.get('/pipeline/status/:jobId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  
  const jobId = req.params.jobId;
  const offset = req.query.offset !== undefined ? parseInt(req.query.offset, 10) : null;
  let job = pipelineJobs.get(jobId);
  
  // Reconstruct job state from disk log if it was wiped (e.g. nodemon restart)
  if (!job) {
    const timestampStr = jobId.replace('run_', '');
    const timestamp = parseInt(timestampStr, 10);
    if (!isNaN(timestamp)) {
      const now = new Date(timestamp);
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istDate = new Date(now.getTime() + istOffset);
      
      const y = istDate.getUTCFullYear();
      const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
      const d = String(istDate.getUTCDate()).padStart(2, '0');
      const h = String(istDate.getUTCHours()).padStart(2, '0');
      const min = String(istDate.getUTCMinutes()).padStart(2, '0');
      const s = String(istDate.getUTCSeconds()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}_${h}-${min}-${s}`;
      
      const logFile = path.resolve(__dirname, '../../logs', `manual_run_${dateStr}.log`);
      if (fs.existsSync(logFile)) {
        job = {
          jobId,
          target: 'Unknown (Reconstructed)',
          phase: 'discovery',
          status: 'running',
          startedAt: now.toISOString(),
          finishedAt: null,
          logs: [],
          logFile,
          summary: null
        };
        pipelineJobs.set(jobId, job);
      }
    }
  }

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Read entire log file from disk on every request (source of truth)
  let allLines = [];
  if (job.logFile && fs.existsSync(job.logFile)) {
    try {
      const content = fs.readFileSync(job.logFile, 'utf8');
      allLines = content.split('\n').filter(Boolean);

      // Derive job status/phase/summary from disk content
      const isDone = content.includes('[SYSTEM] Pipeline finished successfully!') ||
                     content.includes('Database sync complete') ||
                     content.includes('- Rates updated:') ||
                     content.includes('- Banks matched:');
      const isError = !isDone && (
        content.includes('[SYSTEM ERROR]') ||
        content.includes('exited with code') ||
        content.includes('process error') ||
        content.includes('Status polling failed')
      );

      if (isDone) {
        job.status = 'done';
        job.phase = 'done';
        job.summary = parseSummaryFromLogs(allLines);
        if (!job.finishedAt) job.finishedAt = new Date().toISOString();
      } else if (isError) {
        job.status = 'error';
        if (!job.finishedAt) job.finishedAt = new Date().toISOString();
      } else {
        job.status = 'running';
        if (content.includes('Starting Sync pipeline') ||
            content.includes('Running database import') ||
            content.includes('Fetching rates-pack.json')) {
          job.phase = 'sync';
        } else {
          job.phase = 'discovery';
        }
      }
    } catch (err) {
      // ignore read errors — fall through with empty allLines
    }
  }

  const totalLines = allLines.length;

  // If offset provided, only send new lines since that offset (incremental mode)
  // If offset is null/missing, send all lines (initial load)
  const newLines = (offset !== null && !isNaN(offset) && offset >= 0)
    ? allLines.slice(offset)
    : allLines;

  res.json({
    jobId: job.jobId,
    phase: job.phase,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    logs: newLines,
    totalLines,
  });
});

// POST /api/v1/admin/pipeline/stop/:jobId
router.post('/pipeline/stop/:jobId', (req, res) => {
  const job = pipelineJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status === 'running') {
    job.status = 'error';
    logToJob(job, `[SYSTEM] Terminated by admin.`);
    job.finishedAt = new Date().toISOString();
    
    if (job.process) {
      try {
        job.process.kill('SIGTERM');
      } catch (err) {
        logToJob(job, `[SYSTEM ERROR] Failed to terminate child process: ${err.message}`);
      }
    }
    
    if (activeJobId === req.params.jobId) {
      activeJobId = null;
    }
  }

  res.json({ success: true });
});

// POST /api/v1/admin/ingest-rates (Phase 5b Rate Ingestion API)
router.post('/ingest-rates', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.body?.api_key;
  const expectedKey = process.env.INGEST_API_KEY || 'fira_ingest_secret_2026';
  
  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing ingest API key' });
  }

  const { rates } = req.body;
  if (!Array.isArray(rates) || rates.length === 0) {
    return res.status(400).json({ error: 'Invalid payload: rates array required' });
  }

  const db = getDb();
  let inserted = 0;

  const insertStmt = db.prepare(`
    INSERT INTO fd_rates (
      bank_id, product_type, tenure_days_min, tenure_days_max, tenure_label,
      rate_general, rate_senior, rate_bulk_1cr, rate_staff, min_amount, max_amount,
      compounding, effective_from, source_url, verified, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
    ON CONFLICT(bank_id, product_type, tenure_days_min, tenure_days_max) DO UPDATE SET
      rate_general = excluded.rate_general,
      rate_senior = excluded.rate_senior,
      tenure_label = excluded.tenure_label,
      effective_from = excluded.effective_from,
      verified = excluded.verified,
      updated_at = datetime('now')
  `);

  const transaction = db.transaction((rateItems) => {
    for (const r of rateItems) {
      if (!r.bank_id || !r.product_type || r.rate_general == null) continue;
      const result = insertStmt.run(
        r.bank_id,
        r.product_type,
        r.tenure_days_min || 365,
        r.tenure_days_max || 365,
        r.tenure_label || '1 Year',
        r.rate_general,
        r.rate_senior || null,
        r.rate_bulk_1cr || null,
        r.rate_staff || null,
        r.min_amount || null,
        r.max_amount || null,
        r.compounding || 'quarterly',
        r.effective_from || new Date().toISOString().split('T')[0],
        r.source_url || null,
        r.verified ? 1 : 0
      );
      if (result.changes > 0) inserted++;
    }
  });

  try {
    transaction(rates);
    res.json({ success: true, count: inserted, message: `Successfully ingested ${inserted} rate records.` });
  } catch (err) {
    res.status(500).json({ error: `Ingestion transaction failed: ${err.message}` });
  }
});

// GET /api/v1/admin/pipeline/rates-pack
// Returns the locally cached rates-pack-latest.json downloaded from Azure Blob on last run.
// Optional query params:
//   ?bank=<bank_code>       — filter to a single bank
//   ?product=<product_type> — filter rates by product type (fd_nre, fd_fcnr, etc.)
router.get('/pipeline/rates-pack', (req, res) => {
  const localPackPath = path.resolve(__dirname, '../../logs', 'rates-pack-latest.json');

  if (!fs.existsSync(localPackPath)) {
    return res.status(404).json({
      error: 'No rates-pack snapshot found. Run the pipeline at least once to generate it.',
    });
  }

  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(localPackPath, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Failed to parse rates-pack: ${err.message}` });
  }

  const { bank, product } = req.query;

  // Filter to a specific bank if requested
  if (bank) {
    const found = (pack.banks || []).find(b => b.bank_code === bank);
    if (!found) {
      return res.status(404).json({ error: `Bank '${bank}' not found in rates-pack.` });
    }

    // Optionally filter product type within the bank's products
    if (product && found.products) {
      const [prodType, subtype] = product.split('/');
      const prodGroup = found.products[prodType];
      if (!prodGroup) {
        return res.status(404).json({ error: `Product type '${prodType}' not found for bank '${bank}'.` });
      }
      const subtypeData = subtype ? prodGroup[subtype] : prodGroup;
      return res.json({
        bank_code: found.bank_code,
        bank_name: found.bank_name,
        effective_date: found.effective_date,
        product: product,
        data: subtypeData || null,
      });
    }

    return res.json(found);
  }

  // No bank filter — return summary (bank list + metadata, not all slabs)
  const summary = {
    generated_at: pack.generated_at || pack.timestamp || null,
    total_banks: (pack.banks || []).length,
    banks: (pack.banks || []).map(b => {
      const productSummary = {};
      for (const [prodType, prodData] of Object.entries(b.products || {})) {
        if (!prodData) continue;
        productSummary[prodType] = {};
        for (const [subtype, subtypeData] of Object.entries(prodData)) {
          if (!subtypeData) continue;
          const slabs = subtypeData.slabs || subtypeData.rates || [];
          productSummary[prodType][subtype] = {
            slabs: slabs.length,
            effective_date: subtypeData.effective_date || null,
          };
        }
      }
      return {
        bank_code: b.bank_code,
        bank_name: b.bank_name,
        bank_type: b.bank_type,
        status: b.status,
        effective_date: b.effective_date,
        products: productSummary,
      };
    }),
  };

  res.json(summary);
});

router.pipelineJobs = pipelineJobs;
router.getActiveJobId = () => activeJobId;
router.setActiveJobId = (id) => { activeJobId = id; };
router.runPipelineJob = runPipelineJob;
router.buildAzureDiscoveryPayload = buildAzureDiscoveryPayload;

module.exports = router;

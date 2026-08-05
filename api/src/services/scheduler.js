/**
 * scheduler.js
 * Background scheduler service for rate discovery agent runs.
 * - Schedule: Sunday and Wednesday at 2:00 AM IST
 */

const path = require('path');
const fs = require('fs');

// We import the admin router to access pipeline variables and functions
const adminRouter = require('../routes/admin');

function getIstDateTime() {
  const utcDate = new Date();
  // IST offset is UTC + 5:30 (5.5 hours)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(utcDate.getTime() + istOffset);
  
  return {
    hours: istDate.getUTCHours(),
    minutes: istDate.getUTCMinutes(),
    day: istDate.getUTCDay(), // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    date: istDate
  };
}

function formatDateForFile(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}_${h}-${min}-${s}`;
}

async function triggerScheduledJob(jobType) {
  const { pipelineJobs, getActiveJobId, setActiveJobId, runPipelineJob } = adminRouter;
  
  // 1. Check if a pipeline job is already active/running
  const activeJobId = getActiveJobId();
  if (activeJobId) {
    const activeJob = pipelineJobs.get(activeJobId);
    if (activeJob && activeJob.status === 'running') {
      console.warn(`[SCHEDULER] Skipping ${jobType} run. Active job ${activeJobId} is already running.`);
      return;
    }
  }

  // Check internet connectivity to decide target flags
  let target = process.env.SCHEDULE_COHORT || '--cohort gold-11-nri-banks';
  
  const dns = require('dns').promises;
  let offlineFallback = false;
  try {
    // Attempt resolving a public domain
    await dns.lookup('google.com');
    console.log('[SCHEDULER] Internet connection is active. Running in default mode.');
  } catch (err) {
    console.warn('[SCHEDULER] No internet connection detected! Falling back to Re-extract mode (--rates-only).');
    offlineFallback = true;
    if (!target.includes('--rates-only')) {
      target += ' --rates-only';
    }
  }

  // 2. Prepare log file path
  const now = getIstDateTime().date;
  const dateStr = formatDateForFile(now);
  const logFile = path.resolve(__dirname, '../../logs', `schedule_run_${dateStr}.log`);

  // Ensure logs directory exists
  const logsDir = path.dirname(logFile);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // 3. Create job definition
  const jobId = `schedule_run_${Date.now()}`;
  
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
  setActiveJobId(jobId);

  // 4. Log start
  const formattedTime = now.toISOString().replace('T', ' ').slice(0, 19);
  fs.writeFileSync(logFile, `=== Scheduled ${jobType.toUpperCase()} Run Started at ${formattedTime} (IST) ===\n`);
  if (offlineFallback) {
    fs.appendFileSync(logFile, `[SYSTEM WARNING] No internet connection detected! Switched automatically to Re-extract mode (--rates-only).\n\n`);
  } else {
    fs.appendFileSync(logFile, `\n`);
  }

  console.log(`[SCHEDULER] Triggering ${jobType} pipeline run. Job ID: ${jobId}. Log file: ${logFile}`);

  // 5. Run asynchronously (automatically routes to Azure if configured)
  runPipelineJob(jobId);
}

function checkAndRunSchedule() {
  const ist = getIstDateTime();
  const hr = ist.hours;
  const min = ist.minutes;
  const day = ist.day;

  // Sunday and Wednesday at 2:00 AM IST (day === 0 or day === 3, hr === 2, min === 0)
  if ((day === 0 || day === 3) && hr === 2 && min === 0) {
    triggerScheduledJob('biweekly');
  }
}

function init() {
  console.log('⏰ Starting Rates Refresh Scheduler service...');
  console.log('   - Schedule: Sunday and Wednesday at 2:00 AM IST');
  console.log('   - Default cohort: gold-11-nri-banks');
  
  // Check once a minute
  setInterval(checkAndRunSchedule, 60000);
}

module.exports = {
  init,
  triggerScheduledJob // exported for testing/manual triggering
};

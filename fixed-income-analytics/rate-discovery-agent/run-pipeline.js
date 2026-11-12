#!/usr/bin/env node

/**
 * run-pipeline.js — Orchestrated bank discovery and extraction pipeline.
 *
 * Reads a master CSV, classifies every bank's status, and routes each
 * bank to the cheapest action: deterministic extraction (free, ~5s) when
 * a config with captured selectors already exists, or LLM discovery
 * (~$0.46, ~116s) when not. Can be interrupted and resumed.
 *
 * Usage:
 *   node run-pipeline.js banks.csv                         # process all banks
 *   node run-pipeline.js banks.csv --batch-size 20         # larger batches
 *   node run-pipeline.js banks.csv --category "PSB"        # filter
 *   node run-pipeline.js banks.csv --max-age 7             # stale threshold (days)
 *   node run-pipeline.js banks.csv --resume                # continue from checkpoint
 *   node run-pipeline.js banks.csv --retry-blocked         # retry CAPTCHA/WAF banks
 *   node run-pipeline.js banks.csv --dry-run               # show plan, don't execute
 *   node run-pipeline.js banks.csv --limit 50              # cap total banks processed
 *   node run-pipeline.js banks.csv --concurrency 3         # parallel bank processing
 *   node run-pipeline.js banks.csv --delay 2               # seconds between banks
 *   node run-pipeline.js banks.csv --timeout 300           # per-bank timeout (sec)
 *   node run-pipeline.js banks.csv --log-level debug       # verbosity
 */

const { spawnSync } = require("child_process");
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { slugify } = require("./scripts/utils/slugify");
const { createLogger } = require("./scripts/utils/logger");
const { normalizeRatesFile } = require("./scripts/utils/normalize-rates");
const { buildRunAnalysis } = require("./lib/run-aggregator");
const { renderRunReport } = require("./lib/run-report-renderer");

// ── Constants ──────────────────────────────────────────────────────

const LATEST_DIR = path.join(__dirname, "output", "latest");
const INDEX_FILE = path.join(LATEST_DIR, "_bank_index.json");

const STATUS = {
  PENDING: "pending",
  PARSE_FAIL: "parse_fail",
  STALE: "stale",
  CURRENT: "current",
  BLOCKED: "blocked",
  NO_WEBSITE: "no_website",
  MANUAL: "manual",
};

// Category priority for processing order (lower = higher priority)
const CATEGORY_PRIORITY = {
  "Public Sector Bank": 1,
  "Private Sector Bank (Indian)": 2,
  "Private Sector Bank": 2,
  "Small Finance Bank": 3,
  "Foreign Bank": 4,
  "IFSC Banking Unit (IFSCA)": 5,
  "Payments Bank": 6,
  "Scheduled State Co-operative Bank": 7,
  "Scheduled Urban Co-operative Bank": 8,
  "Regional Rural Bank": 9,
  "District Central Co-operative Bank": 10,
  "Non-Scheduled State Co-operative Bank": 11,
  "Non-Scheduled Urban Co-operative Bank": 12,
  "Local Area Bank": 13,
  "Financial Institution": 14,
  "Housing Finance Company": 15,
};

const STATUS_PRIORITY = {
  [STATUS.PARSE_FAIL]: 1,
  [STATUS.STALE]: 2,
  [STATUS.PENDING]: 3,
  [STATUS.BLOCKED]: 10,
  [STATUS.NO_WEBSITE]: 11,
  [STATUS.MANUAL]: 12,
  [STATUS.CURRENT]: 99,
};

// ── Argument parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
let csvFile = "";
let categoryFilter = "";
let batchSize = 10;
let maxAgeDays = 7;
let limit = 0;
let delay = 2;
let timeout = 300_000;
let concurrency = 1;
let logLevel = "info";
let dryRun = false;
let resume = false;
let retryBlocked = false;
let includeSkipped = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--category" && args[i + 1]) categoryFilter = args[++i];
  else if (args[i] === "--batch-size" && args[i + 1]) batchSize = parseInt(args[++i], 10);
  else if (args[i] === "--max-age" && args[i + 1]) maxAgeDays = parseInt(args[++i], 10);
  else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
  else if (args[i] === "--delay" && args[i + 1]) delay = parseInt(args[++i], 10);
  else if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i], 10) * 1000;
  else if (args[i] === "--concurrency" && args[i + 1]) concurrency = Math.min(parseInt(args[++i], 10), 5);
  else if (args[i] === "--log-level" && args[i + 1]) logLevel = args[++i];
  else if (args[i] === "--dry-run") dryRun = true;
  else if (args[i] === "--resume") resume = true;
  else if (args[i] === "--retry-blocked") retryBlocked = true;
  else if (args[i] === "--include-skipped") includeSkipped = true;
  else if (args[i] === "--rebuild-index") { /* handled below */ }
  else if (!args[i].startsWith("--") && !csvFile) csvFile = args[i];
}

const rebuildIndex = args.includes("--rebuild-index");

if (!csvFile) {
  console.error("Usage: node run-pipeline.js <csv_file> [options]");
  console.error("");
  console.error("Options:");
  console.error("  --batch-size <n>     Banks per batch (default: 10)");
  console.error("  --category <filter>  Filter by bank category (substring match)");
  console.error("  --max-age <days>     Treat rates older than N days as stale (default: 7)");
  console.error("  --limit <n>          Process at most N banks total");
  console.error("  --delay <sec>        Delay between banks (default: 2)");
  console.error("  --timeout <sec>      Per-bank timeout in seconds (default: 300)");
  console.error("  --concurrency <n>    Parallel banks (default: 1, max: 5)");
  console.error("  --log-level <lvl>    Log level: error, warn, info (default), debug");
  console.error("  --dry-run            Show what would happen, don't execute");
  console.error("  --resume             Continue from checkpoint, skip CURRENT banks");
  console.error("  --retry-blocked      Retry CAPTCHA/WAF/no-website banks");
  console.error("  --rebuild-index      Force rebuild of bank index from filesystem");
  process.exit(1);
}

csvFile = path.resolve(csvFile);
if (!fs.existsSync(csvFile)) {
  console.error(`File not found: ${csvFile}`);
  process.exit(1);
}

const log = createLogger(logLevel);

// ── CSV parsing (reused from run-batch.js) ─────────────────────────

const KNOWN_CATEGORIES = new Set([
  "Public Sector Bank", "Private Sector Bank (Indian)", "Private Sector Bank",
  "Small Finance Bank", "Payments Bank", "Foreign Bank", "Regional Rural Bank",
  "Scheduled Urban Co-operative Bank", "Non-Scheduled Urban Co-operative Bank",
  "Scheduled State Co-operative Bank", "Non-Scheduled State Co-operative Bank",
  "District Central Co-operative Bank", "Local Area Bank", "Financial Institution",
  "IFSC Banking Unit (IFSCA)", "Housing Finance Company",
]);

function parseCSVLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) { fields.push(field.trim()); field = ""; }
    else field += c;
  }
  fields.push(field.trim());
  return fields;
}

function loadCSV(filePath) {
  let raw = fs.readFileSync(filePath, "utf-8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const banks = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    let name = fields[1]?.trim();
    let category = fields[2]?.trim();
    let state = fields[3]?.trim() || "";
    if (!KNOWN_CATEGORIES.has(category)) {
      for (let j = 2; j < fields.length; j++) {
        if (KNOWN_CATEGORIES.has(fields[j]?.trim())) {
          name = fields.slice(1, j).map((f) => f.trim()).join(", ").replace(/,\s*$/, "").trim();
          category = fields[j].trim();
          state = fields[j + 1]?.trim() || "";
          break;
        }
      }
    }
    if (!name || !category) continue;
    if (categoryFilter && !category.toLowerCase().includes(categoryFilter.toLowerCase())) continue;
    const bankCode = slugify(name);
    banks.push({ name, category, state, bankCode });
  }
  return banks;
}

// ── Bank index (persistent status store) ───────────────────────────

function loadIndex() {
  if (!rebuildIndex && fs.existsSync(INDEX_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    } catch {
      log.warn("Corrupt bank index, rebuilding from filesystem...");
    }
  }
  return buildIndexFromFilesystem();
}

function saveIndex(index) {
  index.updated_at = new Date().toISOString();
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  // safe-write-exempt: bank index file is an aggregator output, not a per-bank artifact.
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n");
}

function buildIndexFromFilesystem() {
  log.info("Building bank index from output/latest/...");
  const index = { updated_at: new Date().toISOString(), banks: {} };
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  const configFiles = fs.readdirSync(LATEST_DIR).filter((f) => f.endsWith("_config.json") && !f.startsWith("_"));

  for (const f of configFiles) {
    const bankCode = f.replace(/_config\.json$/, "");
    const entry = classifyFromFilesystem(bankCode);
    if (entry) index.banks[bankCode] = entry;
  }

  log.info(`  Indexed ${Object.keys(index.banks).length} banks from filesystem`);
  saveIndex(index);
  return index;
}

function classifyFromFilesystem(bankCode) {
  const configPath = path.join(LATEST_DIR, `${bankCode}_config.json`);
  if (!fs.existsSync(configPath)) return null;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }

  const scraperType = config.scraper_type || "unknown";
  const website = config.website || null;
  const confidence = config.discovery_metadata?.confidence || null;

  // Read domestic rates file
  const ratesPath = path.join(LATEST_DIR, `${bankCode}_rates.json`);
  let slabCount = 0;
  let scrapedAt = null;
  let effectiveDate = null;
  if (fs.existsSync(ratesPath)) {
    try {
      const rates = JSON.parse(fs.readFileSync(ratesPath, "utf-8"));
      slabCount = (rates.rate_slabs || []).length;
      scrapedAt = rates.scraped_at || null;
      effectiveDate = rates.effective_date || null;
    } catch {}
  }

  // Determine status
  let status;
  if (scraperType === "manual") {
    const notes = JSON.stringify(config.notes || "") + JSON.stringify(config.scraper_notes || {});
    if (/no website|not found|no official/i.test(notes)) status = STATUS.NO_WEBSITE;
    else if (/captcha|blocked|waf|403|forbidden|imperva|cloudflare|radware/i.test(notes)) status = STATUS.BLOCKED;
    else status = STATUS.MANUAL;
  } else if (slabCount === 0) {
    status = STATUS.PARSE_FAIL;
  } else {
    // Check freshness
    const ageMs = scrapedAt ? Date.now() - new Date(scrapedAt).getTime() : Infinity;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    status = ageMs <= maxAgeMs ? STATUS.CURRENT : STATUS.STALE;
  }

  return {
    status,
    bank_name: config.bank_name || bankCode,
    category: config.category || null,
    scraper_type: scraperType,
    website,
    slab_count: slabCount,
    scraped_at: scrapedAt,
    effective_date: effectiveDate,
    confidence,
  };
}

// ── Classify a bank (index-first, filesystem-fallback) ─────────────

function classifyBank(bankCode, index) {
  const cached = index.banks[bankCode];
  if (cached && !rebuildIndex) {
    // Re-evaluate staleness based on current --max-age
    if (cached.status === STATUS.CURRENT || cached.status === STATUS.STALE) {
      const ageMs = cached.scraped_at ? Date.now() - new Date(cached.scraped_at).getTime() : Infinity;
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      cached.status = ageMs <= maxAgeMs ? STATUS.CURRENT : STATUS.STALE;
    }
    return cached;
  }
  return { status: STATUS.PENDING };
}

// ── Actions ────────────────────────────────────────────────────────

/**
 * Try deterministic extraction via scripts/extract_rates.js.
 * Returns { success, slabCount }.
 */
function tryDeterministic(bankCode) {
  const extractScript = path.join(__dirname, "scripts", "extract_rates.js");
  const result = spawnSync(
    process.execPath,
    [extractScript, bankCode, "--config-dir", LATEST_DIR],
    { cwd: __dirname, timeout: 60_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.status !== 0) {
    return { success: false, slabCount: 0, output: result.stdout || "", error: result.stderr || "" };
  }

  // Normalize the output and count slabs
  const ratesFile = path.join(LATEST_DIR, `${bankCode}_rates.json`);
  if (fs.existsSync(ratesFile)) {
    normalizeRatesFile(ratesFile);
    try {
      const data = JSON.parse(fs.readFileSync(ratesFile, "utf-8"));
      const slabCount = (data.rate_slabs || []).length;
      return { success: slabCount > 0, slabCount, output: result.stdout || "" };
    } catch {}
  }

  return { success: false, slabCount: 0, output: result.stdout || "" };
}

/**
 * Run LLM discovery via run-discovery.js.
 * Returns { success, slabCount, cost, elapsed }.
 */
function runLlmDiscovery(bank, mode) {
  const discoveryScript = path.join(__dirname, "run-discovery.js");
  const discoveryArgs = [discoveryScript, bank.name, bank.category || "", bank.state || ""];
  if (mode === "rates-only") discoveryArgs.push("--rates-only");
  else if (mode === "expand-nri") discoveryArgs.push("--expand-nri");
  if (logLevel !== "info") discoveryArgs.push("--log-level", logLevel);
  discoveryArgs.push("--output-dir", LATEST_DIR);

  const start = Date.now();
  const result = spawnSync(
    process.execPath,
    discoveryArgs,
    { cwd: __dirname, timeout, stdio: "inherit", shell: false },
  );
  const elapsedSec = Math.round((Date.now() - start) / 1000);

  // Read the summary.json if written
  const summaryFile = path.join(LATEST_DIR, `${bank.bankCode}.summary.json`);
  let cost = null;
  if (fs.existsSync(summaryFile)) {
    try {
      const summary = JSON.parse(fs.readFileSync(summaryFile, "utf-8"));
      cost = summary.total_cost_usd || null;
    } catch {}
  }

  // Check if rates were produced
  const ratesFile = path.join(LATEST_DIR, `${bank.bankCode}_rates.json`);
  let slabCount = 0;
  if (fs.existsSync(ratesFile)) {
    normalizeRatesFile(ratesFile);
    try {
      const data = JSON.parse(fs.readFileSync(ratesFile, "utf-8"));
      slabCount = (data.rate_slabs || []).length;
    } catch {}
  }

  return {
    success: result.status === 0 && slabCount > 0,
    slabCount,
    cost,
    elapsed: elapsedSec,
    exitCode: result.status,
  };
}

/**
 * Compare old slabs to new slabs. Returns { changed, delta }.
 */
function compareSlabs(bankCode) {
  // We already wrote new rates on top of old. To compare, we'd need the
  // old rates. For now, just return "changed: true" — the cost to re-write
  // is near-zero, and we get fresh scraped_at timestamps.
  // TODO: implement slab-by-slab comparison with a pre-extract snapshot.
  return { changed: true, delta: null };
}

// ── Process one bank ───────────────────────────────────────────────

// Load domain statuses once for skip checking
const SKIP_STATUSES = new Set(["no_retail_deposits", "no_website", "website_not_found", "wholesale_only", "rates_in_images", "rates_not_published", "site_unreachable"]);
let _domainStatuses = null;
function getDomainStatus(bankCode) {
  if (!_domainStatuses) {
    try {
      const domainsFile = path.join(__dirname, "data", "bank-domains.json");
      _domainStatuses = JSON.parse(fs.readFileSync(domainsFile, "utf-8"));
    } catch {
      _domainStatuses = {};
    }
  }
  return _domainStatuses[bankCode]?.status || null;
}

function processBank(bank, index, batchIndex, batchTotal) {
  const { bankCode, name, category } = bank;
  const info = classifyBank(bankCode, index);
  const status = info.status;

  const prefix = `[${batchIndex}/${batchTotal}]`;

  // Skip banks with status tags in bank-domains.json
  if (!includeSkipped) {
    const domainStatus = getDomainStatus(bankCode);
    if (SKIP_STATUSES.has(domainStatus)) {
      log.debug(`${prefix} SKIP ${name} (domain status: ${domainStatus})`);
      return { name, bankCode, status: domainStatus, action: "skip", slabCount: 0, cost: 0 };
    }
  }

  // Skip logic
  if (status === STATUS.CURRENT) {
    log.debug(`${prefix} SKIP ${name} (current, scraped ${info.scraped_at?.slice(0, 10) || "?"})`);
    return { name, bankCode, status, action: "skip", slabCount: info.slab_count, cost: 0 };
  }
  if ((status === STATUS.BLOCKED || status === STATUS.NO_WEBSITE || status === STATUS.MANUAL) && !retryBlocked) {
    log.debug(`${prefix} SKIP ${name} (${status})`);
    return { name, bankCode, status, action: "skip", slabCount: 0, cost: 0 };
  }

  // Determine action
  let action = "";
  let slabCount = 0;
  let cost = 0;
  let elapsed = 0;

  if (status === STATUS.PENDING || ((status === STATUS.BLOCKED || status === STATUS.NO_WEBSITE) && retryBlocked)) {
    // No config exists (or retrying blocked) → full LLM discovery
    log.info(`${prefix} DISCOVER ${name} (${category})`);
    action = "llm_discover";
    const llm = runLlmDiscovery(bank, "discover");
    slabCount = llm.slabCount;
    cost = llm.cost || 0;
    elapsed = llm.elapsed;
    if (!llm.success) {
      log.warn(`${prefix}   → ${slabCount > 0 ? slabCount + " slabs" : "0 slabs"} (exit ${llm.exitCode})`);
    }

  } else if (status === STATUS.PARSE_FAIL || status === STATUS.STALE) {
    // Config exists → try deterministic first
    log.info(`${prefix} EXTRACT ${name} (${status}, ${info.scraper_type})`);
    action = "deterministic";
    const det = tryDeterministic(bankCode);
    slabCount = det.slabCount;

    if (det.success) {
      log.info(`${prefix}   → ${slabCount} slabs (deterministic, $0)`);
    } else {
      // Deterministic failed → LLM fallback
      log.info(`${prefix}   → deterministic: 0 slabs, falling back to LLM...`);
      action = "llm_fallback";
      const llm = runLlmDiscovery(bank, "rates-only");
      slabCount = llm.slabCount;
      cost = llm.cost || 0;
      elapsed = llm.elapsed;
      if (!llm.success) {
        log.warn(`${prefix}   → LLM fallback: ${slabCount > 0 ? slabCount + " slabs" : "0 slabs"}`);
      }
    }
  }

  // Update index with new state
  const newInfo = classifyFromFilesystem(bankCode);
  if (newInfo) {
    index.banks[bankCode] = newInfo;
  }

  return { name, bankCode, status: newInfo?.status || status, action, slabCount, cost, elapsed };
}

// ── Priority sort ──────────────────────────────────────────────────

function sortBanks(banks, index) {
  return banks.sort((a, b) => {
    const infoA = classifyBank(a.bankCode, index);
    const infoB = classifyBank(b.bankCode, index);
    const sp = (STATUS_PRIORITY[infoA.status] || 50) - (STATUS_PRIORITY[infoB.status] || 50);
    if (sp !== 0) return sp;
    const cp = (CATEGORY_PRIORITY[a.category] || 50) - (CATEGORY_PRIORITY[b.category] || 50);
    if (cp !== 0) return cp;
    return a.name.localeCompare(b.name);
  });
}

// ── Dry-run mode ───────────────────────────────────────────────────

function dryRunReport(banks, index) {
  const counts = {};
  for (const s of Object.values(STATUS)) counts[s] = 0;

  for (const bank of banks) {
    const info = classifyBank(bank.bankCode, index);
    counts[info.status] = (counts[info.status] || 0) + 1;
  }

  // Estimate costs
  const pendingLlm = counts[STATUS.PENDING] * 0.46;
  const parseFailDet = Math.round(counts[STATUS.PARSE_FAIL] * 0.7); // 70% succeed deterministic
  const parseFailLlm = counts[STATUS.PARSE_FAIL] - parseFailDet;
  const staleDet = counts[STATUS.STALE]; // most succeed deterministic

  console.log("=== Pipeline Dry Run ===");
  console.log(`Master CSV: ${banks.length} banks`);
  if (categoryFilter) console.log(`Filter: ${categoryFilter}`);
  console.log();
  console.log("Status breakdown:");
  console.log(`  CURRENT:      ${String(counts[STATUS.CURRENT]).padStart(5)}  (skip — rates fresh within ${maxAgeDays}d)`);
  console.log(`  STALE:        ${String(counts[STATUS.STALE]).padStart(5)}  (deterministic re-extract, ~$0 each)`);
  console.log(`  PARSE_FAIL:   ${String(counts[STATUS.PARSE_FAIL]).padStart(5)}  (deterministic first, LLM fallback ~$0.30)`);
  console.log(`  BLOCKED:      ${String(counts[STATUS.BLOCKED]).padStart(5)}  (skip — CAPTCHA/WAF${retryBlocked ? ", --retry-blocked: will retry" : ""})`);
  console.log(`  NO_WEBSITE:   ${String(counts[STATUS.NO_WEBSITE]).padStart(5)}  (skip — no discoverable site${retryBlocked ? ", --retry-blocked: will retry" : ""})`);
  console.log(`  MANUAL:       ${String(counts[STATUS.MANUAL]).padStart(5)}  (skip)`);
  console.log(`  PENDING:      ${String(counts[STATUS.PENDING]).padStart(5)}  (LLM discover ~$0.46 each)`);
  console.log();

  const detCalls = staleDet + parseFailDet;
  const llmCalls = counts[STATUS.PENDING] + parseFailLlm + (retryBlocked ? counts[STATUS.BLOCKED] + counts[STATUS.NO_WEBSITE] : 0);
  const skipped = counts[STATUS.CURRENT] + (retryBlocked ? 0 : counts[STATUS.BLOCKED] + counts[STATUS.NO_WEBSITE]) + counts[STATUS.MANUAL];
  const estCost = llmCalls * 0.46 + parseFailLlm * 0.30;
  const estTimeSec = llmCalls * 116 + detCalls * 5;

  console.log("Estimated actions:");
  console.log(`  Deterministic extractions:  ${String(detCalls).padStart(5)}  (~${Math.ceil(detCalls * 5 / 60)} min, ~$0)`);
  console.log(`  LLM discovery calls:        ${String(llmCalls).padStart(5)}  (~${(llmCalls * 116 / 3600).toFixed(1)}h sequential, ~$${(llmCalls * 0.46).toFixed(0)})`);
  console.log(`  Skipped:                    ${String(skipped).padStart(5)}`);
  console.log();
  console.log(`Total estimated cost:  ~$${estCost.toFixed(0)}`);
  console.log(`Total estimated time:  ~${(estTimeSec / 3600).toFixed(1)}h sequential, ~${(estTimeSec / 3600 / 5).toFixed(1)}h at concurrency=5`);
  console.log(`Batch size: ${batchSize}  |  Max age: ${maxAgeDays}d  |  Limit: ${limit || "none"}`);
}

// ── Main ───────────────────────────────────────────────────────────

function main() {
  // Load CSV
  const allBanks = loadCSV(csvFile);
  log.info(`Loaded ${allBanks.length} banks from ${path.basename(csvFile)}`);

  // Deduplicate by bank_code (keep first occurrence)
  const seen = new Set();
  const banks = [];
  for (const b of allBanks) {
    if (seen.has(b.bankCode)) continue;
    seen.add(b.bankCode);
    banks.push(b);
  }
  if (banks.length < allBanks.length) {
    log.info(`  Deduplicated: ${allBanks.length} → ${banks.length}`);
  }

  // Load or build index
  const index = loadIndex();

  // Dry run
  if (dryRun) {
    dryRunReport(banks, index);
    return;
  }

  // Sort by priority
  sortBanks(banks, index);

  // Apply limit
  const toProcess = limit > 0 ? banks.slice(0, limit) : banks;

  // Pre-filter: skip CURRENT (and optionally BLOCKED/NO_WEBSITE)
  const actionable = toProcess.filter((b) => {
    const info = classifyBank(b.bankCode, index);
    if (info.status === STATUS.CURRENT) return false;
    if ((info.status === STATUS.BLOCKED || info.status === STATUS.NO_WEBSITE || info.status === STATUS.MANUAL) && !retryBlocked) return false;
    return true;
  });

  const skippedCount = toProcess.length - actionable.length;

  console.log("============================================");
  console.log(" Pipeline: Orchestrated Bank Discovery");
  console.log("============================================");
  console.log(` Source:     ${path.basename(csvFile)} (${banks.length} banks)`);
  console.log(` Actionable: ${actionable.length}  |  Skipped: ${skippedCount}`);
  console.log(` Batch size: ${batchSize}  |  Max age: ${maxAgeDays}d`);
  console.log(` Timeout:    ${timeout / 1000}s  |  Delay: ${delay}s`);
  if (resume) console.log(` Resume:     ON`);
  if (retryBlocked) console.log(` Retry blocked: ON`);
  console.log("============================================");
  console.log();

  // Pipeline run identity (used for the run analysis report)
  const pipelineStartedAt = new Date().toISOString();
  const pipelineRunLabel = pipelineStartedAt.replace(/[:.]/g, "").slice(0, 15)
    + (categoryFilter ? `_${slugify(categoryFilter)}` : "_pipeline");
  const processedBankCodes = [];

  // Process in batches
  let totalProcessed = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalSkipped = skippedCount;
  let totalCost = 0;
  let totalDetOk = 0;
  let totalLlmOk = 0;
  let batchNum = 0;

  for (let bi = 0; bi < actionable.length; bi += batchSize) {
    batchNum++;
    const batch = actionable.slice(bi, bi + batchSize);
    const batchStart = Date.now();
    const batchResults = [];

    console.log(`--- Batch ${batchNum} (banks ${bi + 1}–${bi + batch.length} of ${actionable.length} actionable) ---`);

    for (let j = 0; j < batch.length; j++) {
      const bank = batch[j];
      const result = processBank(bank, index, bi + j + 1, actionable.length);
      batchResults.push(result);
      processedBankCodes.push(bank.bankCode);
      totalProcessed++;

      if (result.slabCount > 0) {
        totalSucceeded++;
        if (result.action === "deterministic") totalDetOk++;
        else totalLlmOk++;
      } else if (result.action !== "skip") {
        totalFailed++;
      }
      totalCost += result.cost || 0;

      // Delay between banks
      if (j < batch.length - 1 && delay > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay * 1000);
      }
    }

    // Batch summary
    const batchElapsed = Math.round((Date.now() - batchStart) / 1000);
    const batchCost = batchResults.reduce((s, r) => s + (r.cost || 0), 0);
    const batchOk = batchResults.filter((r) => r.slabCount > 0).length;
    const batchFail = batchResults.filter((r) => r.action !== "skip" && r.slabCount === 0).length;
    const batchSkip = batchResults.filter((r) => r.action === "skip").length;

    console.log();
    console.log(`  Batch ${batchNum}: ${batchOk} ok, ${batchFail} fail, ${batchSkip} skip | ${batchElapsed}s | $${batchCost.toFixed(2)}`);
    console.log(`  Running: ${totalSucceeded} ok / ${totalProcessed} processed (${totalDetOk} deterministic, ${totalLlmOk} LLM) | $${totalCost.toFixed(2)} spent`);
    console.log();

    // Save index after each batch (checkpoint)
    saveIndex(index);
    log.debug("Index saved (checkpoint)");
  }

  // Final summary
  console.log("============================================");
  console.log(" Pipeline Complete");
  console.log("============================================");
  console.log(` Processed:     ${totalProcessed}`);
  console.log(` Succeeded:     ${totalSucceeded} (${totalDetOk} deterministic, ${totalLlmOk} LLM)`);
  console.log(` Failed:        ${totalFailed}`);
  console.log(` Skipped:       ${totalSkipped}`);
  console.log(` Total cost:    $${totalCost.toFixed(2)}`);
  console.log(` Index:         ${INDEX_FILE}`);
  console.log("============================================");

  // Final index save
  saveIndex(index);

  // Run analysis + markdown report (Sprint 002 item #2)
  if (processedBankCodes.length > 0) {
    try {
      const pendingChangesFile = path.join(__dirname, "data", "bank-domains-pending.json");
      const analysis = buildRunAnalysis({
        runDir: LATEST_DIR,
        runLabel: pipelineRunLabel,
        category: categoryFilter || null,
        startedAt: pipelineStartedAt,
        endedAt: new Date().toISOString(),
        bankCodes: processedBankCodes,
        pendingChangesFile: fs.existsSync(pendingChangesFile) ? pendingChangesFile : null,
      });
      const analysisFile = path.join(LATEST_DIR, "_run_analysis.json");
      // safe-write-exempt: aggregator output (_run_analysis.json), not a per-bank artifact.
      fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2) + "\n");
      const reportFile = path.join(LATEST_DIR, "_run_report.md");
      // safe-write-exempt: aggregator output (_run_report.md markdown), not a per-bank artifact.
      fs.writeFileSync(reportFile, renderRunReport(analysis));
      console.log(` Analysis:      ${analysisFile}`);
      console.log(` Report:        ${reportFile}`);
    } catch (err) {
      log.warn("Failed to write run analysis/report:", err.message);
    }
  }
}

main();

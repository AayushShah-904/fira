#!/usr/bin/env node

/**
 * run-batch.js — Run the Rate Discovery Agent for a batch of banks.
 *
 * Three input modes (auto-detected from positional args / flags):
 *
 *   1. CSV mode (operator-driven, existing):
 *      node run-batch.js banks.csv --category "Public Sector Bank"
 *      node run-batch.js banks.csv --resume --retry-failed
 *
 *   2. Slug-list mode (cloud-driven via Function trigger):
 *      node run-batch.js state-bank-of-india hdfc-bank-limited
 *      node run-batch.js hdfc-bank-limited --dry-run
 *
 *   3. Category mode (cloud-driven, expands via bank-domains.json):
 *      node run-batch.js --category PSB
 *      node run-batch.js --category PSB --dry-run
 *
 * CSV format (columns): Sr. No., Bank Name, Category, State / Country, City, Notes
 *
 * --dry-run prints the resolved bank list and exits 0 without invoking the agent
 * (no LLM calls). Used by the Function trigger's dry-run path.
 *
 * If BIRD_STORAGE=azure, bank-domains.json is synced from the agent-state
 * blob container at start, and output/latest/* + bank-domains.json are synced
 * back at end (Mode A — see sprint 001 design notes).
 */

require("dotenv").config();
try {
  require("./evaluation/futureagi/telemetry");
} catch (e) {
  // no-op if telemetry module not found or fails to load
}

const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { slugify } = require("./scripts/utils/slugify");
const { loadCohort, listCohorts, CohortLoadError } = require("./scripts/utils/load-cohort");

// ── Bank category code → friendly name (for --category in slug/category modes) ────

const BANK_TYPE_TO_CATEGORY = {
  PSB: "Public Sector Bank",
  PVB: "Private Sector Bank",
  SFB: "Small Finance Bank",
  PB: "Payments Bank",
  FB: "Foreign Bank",
  RRB: "Regional Rural Bank",
  SUCB: "Scheduled Urban Co-operative Bank",
  NSUCB: "Non-Scheduled Urban Co-operative Bank",
  SSCB: "Scheduled State Co-operative Bank",
  NSSCB: "Non-Scheduled State Co-operative Bank",
  DCCB: "District Central Co-operative Bank",
  LAB: "Local Area Bank",
  FI: "Financial Institution",
  IBU: "IFSC Banking Unit (IFSCA)",
  HFC: "Housing Finance Company",
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

// ── Argument parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
const positionals = [];
let categoryFilter = "";
let limit = 0;
let delay = 2;
let resume = false;
let retryFailed = false;
let timeout = 900_000; // 15 minutes default — Sprint 4 Track A 2026-05-20 (Bug A): bumped from 5 min so the up-to-3-attempt retry loop in run-discovery.js can complete without SIGTERM cutting it short. Per-attempt agent runs commonly take 1-4 min; 3 × 5 min + slack = 15 min.
let concurrency = 1;
let extractOnly = false;
let agentMode = ""; // "" = discover (default), "expand-nri", "rates-only"
let agentPath = ""; // "" = run-discovery default, "orchestrator" or "llm"
let logLevel = "info";
let banksFilter = ""; // file path or comma-separated slugs
let includeSkipped = false;
let dryRun = false;
let cohortName = ""; // --cohort=<name> loads data/cohorts/<name>.json

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--category" && args[i + 1]) categoryFilter = args[++i];
  else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
  else if (args[i] === "--delay" && args[i + 1]) delay = parseInt(args[++i], 10);
  else if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i], 10) * 1000;
  else if (args[i] === "--concurrency" && args[i + 1]) concurrency = Math.min(parseInt(args[++i], 10), 5);
  else if (args[i] === "--extract-only") extractOnly = true;
  else if (args[i] === "--expand-nri") agentMode = "expand-nri";
  else if (args[i] === "--rates-only") agentMode = "rates-only";
  else if (args[i] === "--log-level" && args[i + 1]) logLevel = args[++i];
  else if (args[i] === "--resume") resume = true;
  else if (args[i] === "--retry-failed") retryFailed = true;
  else if (args[i] === "--banks" && args[i + 1]) banksFilter = args[++i];
  else if (args[i] === "--include-skipped") includeSkipped = true;
  else if (args[i] === "--dry-run") dryRun = true;
  else if (args[i] === "--cohort" && args[i + 1]) cohortName = args[++i];
  else if (args[i].startsWith("--cohort=")) cohortName = args[i].slice(9);
  // Phase 2c (sprint-004 2026-05-22): forward --path to run-discovery.js so
  // cohort runs honor the orchestrator/llm path selection. Without this,
  // run-batch defaulted to LLM path regardless of operator intent.
  else if (args[i] === "--path" && args[i + 1]) agentPath = args[++i];
  else if (!args[i].startsWith("--")) positionals.push(args[i]);
}

// ── Mode detection ──────────────────────────────────────────────────

const BUNDLED_CSV_PATH = path.join(__dirname, "data", "Indian_Banks_Comprehensive_List_RBI.csv");

let csvFile = "";
let invocationMode; // 'csv' | 'slugs' | 'category' | 'cohort'
let cohortEntries = null; // populated when invocationMode === 'cohort'

const looksLikeCsvPath = positionals.length === 1
  && /\.csv$/i.test(positionals[0])
  && fs.existsSync(path.resolve(positionals[0]));
const looksLikeSlugList = positionals.length >= 1
  && positionals.every((p) => SLUG_RE.test(p));

if (cohortName) {
  // Cohort mode (Sprint 4 Track A 2026-05-20): load slugs+category+state
  // from data/cohorts/<name>.json. Replaces the "args baked into job
  // template" pattern — cohort JSON is version-controlled and operator-
  // visible, and the cloud job just gets a stable `--cohort=<name>`.
  try {
    cohortEntries = loadCohort(cohortName);
  } catch (err) {
    if (err instanceof CohortLoadError) {
      console.error(`Cohort load failed: ${err.message}`);
      console.error(`Available cohorts: ${listCohorts().join(", ") || "(none)"}`);
    } else {
      console.error(`Cohort load failed: ${err.message}`);
    }
    process.exit(1);
  }
  invocationMode = "cohort";
} else if (looksLikeCsvPath) {
  invocationMode = "csv";
  csvFile = path.resolve(positionals[0]);
} else if (looksLikeSlugList) {
  invocationMode = "slugs";
} else if (positionals.length === 0 && categoryFilter) {
  // No CSV positional but --category given: cloud category mode. Expands via
  // the bundled RBI bank list. Accepts either a bank-type code (PSB, PVB, ...)
  // or a full category name (preserves existing operator behavior of passing
  // a CSV positional + --category "Public Sector Bank").
  if (!fs.existsSync(BUNDLED_CSV_PATH)) {
    console.error(`Cloud category mode requires the bundled bank list at ${BUNDLED_CSV_PATH}.`);
    console.error("That file is missing — make sure data/Indian_Banks_Comprehensive_List_RBI.csv is part of your checkout.");
    process.exit(2);
  }
  invocationMode = "category";
  csvFile = BUNDLED_CSV_PATH;
  // If the user passed a bank-type code (PSB / PVB / ...), translate it to the
  // full category name the CSV uses. Full category names pass through unchanged.
  if (BANK_TYPE_TO_CATEGORY[categoryFilter]) {
    categoryFilter = BANK_TYPE_TO_CATEGORY[categoryFilter];
  }
} else {
  console.error("Usage:");
  console.error("  CSV mode (operator):");
  console.error("    node run-batch.js <csv_file> [options]");
  console.error("");
  console.error("  Slug-list mode (cloud / direct):");
  console.error("    node run-batch.js <slug> [<slug> ...] [--dry-run]");
  console.error("");
  console.error("  Cohort mode (cloud, version-controlled):");
  console.error("    node run-batch.js --cohort <name> [--dry-run]");
  console.error(`    Reads data/cohorts/<name>.json. Available: ${listCohorts().join(", ") || "(none)"}`);
  console.error("");
  console.error("  Category mode (cloud):");
  console.error("    node run-batch.js --category <CODE> [--dry-run]");
  console.error("    (CODE = PSB | PVB | SFB | PB | FB | RRB | SUCB | NSUCB | SSCB | NSSCB | DCCB | LAB | FI | IBU | HFC,");
  console.error("     OR a full category name for CSV-mode --category)");
  console.error("");
  console.error("Common options:");
  console.error("  --dry-run             Resolve bank list, print, exit 0 (no LLM calls)");
  console.error("  --log-level <lvl>     Log level: error, warn, info (default), debug");
  console.error("  --timeout <sec>       Timeout per bank in seconds (default: 900). Must accommodate up-to-3 retry attempts.");
  console.error("");
  console.error("CSV-mode options:");
  console.error("  --category <filter>   Filter by bank category (full name)");
  console.error("  --limit <n>           Process at most n banks");
  console.error("  --delay <sec>         Delay between banks (default: 2)");
  console.error("  --concurrency <n>     Run n banks in parallel (default: 1, max: 5)");
  console.error("  --resume              Skip succeeded banks; retry rate-limited ones");
  console.error("  --retry-failed        With --resume, also retry previously failed banks");
  console.error("  --banks <file|slugs>  Process only these banks");
  console.error("  --include-skipped     Include banks with skip status in bank-domains.json");
  console.error("  --extract-only        Skip LLM; deterministic extraction only");
  console.error("  --expand-nri          NRI expansion mode");
  console.error("  --rates-only          Re-extract mode");
  process.exit(1);
}

// ── CSV parsing ─────────────────────────────────────────────────────

const KNOWN_CATEGORIES = new Set([
  "Public Sector Bank",
  "Private Sector Bank (Indian)",
  "Private Sector Bank",
  "Small Finance Bank",
  "Payments Bank",
  "Foreign Bank",
  "Regional Rural Bank",
  "Scheduled Urban Co-operative Bank",
  "Non-Scheduled Urban Co-operative Bank",
  "Scheduled State Co-operative Bank",
  "Non-Scheduled State Co-operative Bank",
  "District Central Co-operative Bank",
  "Local Area Bank",
  "Financial Institution",
  "IFSC Banking Unit (IFSCA)",
  "Housing Finance Company",
]);

function parseCSVLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) {
      fields.push(field.trim());
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field.trim());
  return fields;
}

function findCategoryInRow(fields) {
  for (let i = 2; i < fields.length; i++) {
    const val = fields[i]?.trim();
    if (KNOWN_CATEGORIES.has(val)) {
      const nameParts = fields.slice(1, i).map((f) => f.trim());
      const name = nameParts.join(", ").replace(/,\s*$/, "").trim();
      const state = fields[i + 1]?.trim() || "";
      return { name, category: val, state };
    }
  }
  return null;
}



// Sprint 009 cloud-validation-2 (2026-06-04): Playwright pre-flight check.
// The first 12-bank cloud run burned 14 min on SBI's 7 consecutive Playwright
// spawn ETIMEDOUT failures before the per-bank 15-min timeout fired. A
// 5-second pre-flight here surfaces the same fault before any bank-budget
// is spent. Opt out via BIRD_SKIP_PLAYWRIGHT_PREFLIGHT=1 if Playwright is
// known-broken and the run should proceed anyway (non-Playwright extractors).
if (process.env.BIRD_SKIP_PLAYWRIGHT_PREFLIGHT !== '1') {
  const { preflightPlaywright } = require('./lib/playwright-preflight');
  console.log('[preflight] verifying Playwright chromium launch...');
  const pf = preflightPlaywright(__dirname);
  if (pf.ok) {
    console.log(`[preflight] Playwright OK (${pf.elapsedMs}ms)`);
  } else {
    console.error(`[preflight] Playwright FAILED reason=${pf.reason} elapsedMs=${pf.elapsedMs}`);
    console.error(`[preflight] detail: ${pf.detail}`);
    console.error('[preflight] aborting batch — set BIRD_SKIP_PLAYWRIGHT_PREFLIGHT=1 to force-run anyway.');
    process.exit(8);
  }
}

let banks = [];

if (invocationMode === "cohort") {
  // Cohort mode: bank_code + category + state from data/cohorts/<name>.json.
  // The slug is passed as `name`; run-discovery.js's slugify is idempotent
  // and the LLM prompts tolerate the slug-as-name pattern. Category/state
  // come from the cohort entry so the LLM gets bank context.
  banks = cohortEntries.map((e) => ({ name: e.bank_code, category: e.category, state: e.state }));
  // Cohort mode honors --category as a post-load filter: same semantic as the
  // CSV-mode check at line ~306 ("only include banks whose category matches").
  // Without this, --category was silently ignored when combined with --cohort
  // and the run walked the entire cohort top-to-bottom.
  if (categoryFilter) banks = banks.filter((b) => b.category === categoryFilter);
} else if (invocationMode === "slugs") {
  // Slug-list mode: positionals are bank slugs (lowercase-hyphenated, idempotent
  // through slugify). run-discovery.js expects a "bank name" — the slug works
  // because slugify is idempotent and the agent's prompt assembly tolerates a
  // missing pretty name. --category, if supplied, applies to all slugs so the
  // agent gets the right bankType (PSB→include NRI directives etc.). Without
  // this, slug-list reruns of a PSB silently lost the NRI prompt section and
  // shipped domestic-only data — Canara rerun on 2026-05-20.
  banks = positionals.map((slug) => ({ name: slug, category: categoryFilter || "", state: "" }));
} else {
  // CSV mode OR category mode (which sets csvFile = BUNDLED_CSV_PATH and reuses
  // the same parsing). Below this point the code reads `csvFile` and produces
  // `banks` exactly as before.
  let raw = fs.readFileSync(csvFile, "utf-8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  for (let i = 1; i < lines.length; i++) {
  const fields = parseCSVLine(lines[i]);
  let name = fields[1]?.trim();
  let category = fields[2]?.trim();
  let state = fields[3]?.trim() || "";

  if (!KNOWN_CATEGORIES.has(category)) {
    const found = findCategoryInRow(fields);
    if (found) {
      name = found.name;
      category = found.category;
      state = found.state;
    } else {
      continue;
    }
  }

  if (!name || !category) continue;
  if (categoryFilter && category !== categoryFilter) continue;

  banks.push({ name, category, state });
  }
}

// ── Bank slug filter (--banks flag) — CSV mode only ────────────────

if (invocationMode === "csv" && banksFilter) {
  let allowedSlugs;
  if (fs.existsSync(banksFilter)) {
    // File with one slug per line
    allowedSlugs = new Set(
      fs.readFileSync(banksFilter, "utf-8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    );
  } else {
    // Comma-separated slugs
    allowedSlugs = new Set(banksFilter.split(",").map((s) => s.trim()).filter(Boolean));
  }
  banks = banks.filter((b) => allowedSlugs.has(slugify(b.name)));
}

// ── Skip banks with status tags (bank-domains.json) — CSV / category modes ─
// Slug-list and cohort modes skip this filter: the caller named the slugs
// explicitly (via positional args or a cohort JSON), and we honor that even
// if some are tagged with skip statuses.

if (invocationMode !== "slugs" && invocationMode !== "cohort" && !includeSkipped) {
  // Sprint 009 Phase 9.4 (2026-06-05): foreign_currency_not_inr added —
  // banks whose site publishes BDT/USD/etc. (AB Bank PLC), not INR FD.
  // Excluded from the INR pack by operator decision; processing wastes
  // LLM budget. Note: cohort-mode bypasses this filter, so cohort runs
  // also need tier-router's TERMINAL_DISCOVERY_STATUSES (extended in
  // the same change) to honor this status.
  const SKIP_STATUSES = new Set(["no_retail_deposits", "no_website", "website_not_found", "wholesale_only", "rates_in_images", "rates_not_published", "site_unreachable", "foreign_currency_not_inr"]);
  try {
    const domainsFile = path.join(__dirname, "data", "bank-domains.json");
    if (fs.existsSync(domainsFile)) {
      const domains = JSON.parse(fs.readFileSync(domainsFile, "utf-8"));
      const beforeCount = banks.length;
      banks = banks.filter((b) => {
        const entry = domains[slugify(b.name)];
        return !entry || !SKIP_STATUSES.has(entry.status);
      });
      const skipped = beforeCount - banks.length;
      if (skipped > 0) console.log(`Skipped ${skipped} banks with skip status (use --include-skipped to override)`);
    }
  } catch {}
}

if (limit > 0) banks = banks.slice(0, limit);

// ── Dry-run: print resolved bank list and exit 0 ────────────────────

if (dryRun) {
  console.log(`Resolved ${banks.length} bank(s) [mode=${invocationMode}]:`);
  for (const b of banks) {
    const slug = slugify(b.name);
    const tail = b.category ? ` (${b.category})` : "";
    console.log(`  ${slug}${tail}`);
  }
  console.log("Dry run — no agent invocations performed.");
  process.exit(0);
}

// ── Rate-limit detection ────────────────────────────────────────────

/** User-facing rate-limit messages (not internal API events) */
const RATE_LIMIT_PATTERNS = [
  /you'?ve hit your limit/i,
  /too many requests/i,
  /HTTP\s+429/i,
];

/**
 * Scan text (log file contents) for rate-limit signals.
 * Only checks the first 2KB and last 2KB to avoid matching internal API
 * telemetry events (like rate_limit_event with status:"allowed") that
 * appear in large successful log files.
 * Returns { isRateLimit, message, resetTime } or { isRateLimit: false }.
 */
function detectRateLimit(text) {
  // For small logs (<5KB), check the whole thing — these are typically
  // immediate rate-limit failures. For large logs, check only head+tail.
  const sample = text.length < 5000
    ? text
    : text.slice(0, 2000) + "\n" + text.slice(-2000);

  for (const pattern of RATE_LIMIT_PATTERNS) {
    const match = sample.match(pattern);
    if (match) {
      const resetMatch = sample.match(
        /resets?\s+(\d{1,2}:\d{2}\s*(?:am|pm)?(?:\s*\([\w/]+\))?)/i,
      );
      return {
        isRateLimit: true,
        message: match[0],
        resetTime: resetMatch ? resetMatch[1] : null,
      };
    }
  }
  return { isRateLimit: false };
}

// ── Load previous batch results (for smart resume) ─────────────────

function loadPreviousResults(dir, categorySuffix) {
  const prevFile = path.join(dir, `_batch_results_${categorySuffix}.json`);
  if (!fs.existsSync(prevFile)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(prevFile, "utf-8"));
    const map = {};
    for (const r of data.results || []) {
      map[r.name] = r.status;
    }
    return map;
  } catch {
    return {};
  }
}

// ── Batch execution ─────────────────────────────────────────────────

const modeLabels = { "": "DISCOVER", "expand-nri": "EXPAND-NRI", "rates-only": "RE-EXTRACT" };
const modeDisplay = extractOnly ? "EXTRACT-ONLY (no LLM)" : (modeLabels[agentMode] || "DISCOVER");

console.log("============================================");
console.log(" Batch Rate Discovery");
console.log("============================================");
const sourceLabel = invocationMode === "cohort"
  ? `cohort:${cohortName}`
  : invocationMode === "slugs"
    ? `slugs (${positionals.length})`
    : path.basename(csvFile);
console.log(` Source:   ${sourceLabel}`);
console.log(` Filter:   ${categoryFilter || "All categories"}`);
console.log(` Mode:     ${modeDisplay}`);
console.log(` Limit:    ${limit || "No limit"}`);
console.log(` Banks:    ${banks.length}`);
console.log(` Delay:    ${delay}s between banks`);
console.log(` Timeout:  ${timeout / 1000}s per bank`);
if (concurrency > 1) console.log(` Parallel: ${concurrency} banks at a time`);
console.log(` Resume:   ${resume ? "ON (smart: skip succeeded, retry rate-limited)" : "OFF"}`);
if (retryFailed) console.log(` Retry:    Also retrying previously failed banks`);
console.log("============================================");
console.log();

if (banks.length === 0) {
  console.log("No banks matched the filter. Exiting.");
  process.exit(0);
}

const outputDir = path.join(__dirname, "output");
const latestDir = path.join(outputDir, "latest");
fs.mkdirSync(latestDir, { recursive: true });

const runDiscovery = path.join(__dirname, "run-discovery.js");

// G2 (2026-05-23): preload bank-domains.json once so buildDiscoveryArgs's
// IBU-path-routing gate can consult the registry without re-reading per
// bank. Stays null if the file is missing (the gate falls back to the
// blanket "force LLM for IBU" behaviour).
let bankDomainsForRouting = null;
try {
  const _bdPath = path.join(__dirname, 'data', 'bank-domains.json');
  if (fs.existsSync(_bdPath)) {
    bankDomainsForRouting = JSON.parse(fs.readFileSync(_bdPath, 'utf-8'));
  }
} catch (err) {
  console.warn(`run-batch: failed to preload bank-domains.json for routing (${err.message}); IBU banks will all force --path llm`);
}

let succeeded = 0;
let failed = 0;
let skipped = 0;
let rateLimited = 0;
const results = [];

const { slugify: toBankCode } = require("./scripts/utils/slugify");

// Load previous results for smart resume
const categorySuffix = categoryFilter
  ? categoryFilter.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  : "all";
const previousResults = resume ? loadPreviousResults(latestDir, categorySuffix) : {};

// Create a batch-level run folder
const batchTs = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
const modeSuffix = agentMode ? `-${agentMode}` : "";
const batchLabel = `${batchTs}_${categorySuffix}${modeSuffix}`;
const batchRunDir = path.join(outputDir, "runs", batchLabel);
fs.mkdirSync(batchRunDir, { recursive: true });
console.log(`  Run dir: ${batchRunDir}\n`);

process.env.RUN_LABEL = batchLabel;
process.env.RUN_STARTED_AT = new Date().toISOString();

const { emit: emitEvent, initBatch, completeBatch } = require("./lib/events");
const resultsFileName = "_batch_results.json";

initBatch({
  total: banks.length,
  cohort: typeof cohortName !== "undefined" ? cohortName : null,
  mode: agentMode || "discover",
  outputDir: latestDir,
});

let consecutiveRateLimits = 0;
const originalDelay = delay;
let abortBatch = false;

function summarizeResults() {
  return {
    total_banks: banks.length,
    succeeded,
    failed,
    rate_limited: rateLimited,
    skipped,
  };
}

function computeRunOutcome() {
  if (succeeded === 0 && failed === 0 && rateLimited === 0) return "no_work";
  if (failed === 0 && rateLimited === 0) return "success";
  if (succeeded > 0) return "partial_failure";
  return "failure";
}

/** Check resume status for a bank. Returns null to process, or a skip result. */
function checkResume(bank, bankCode, index, total) {
  const hasConfig = fs.existsSync(path.join(latestDir, `${bankCode}_config.json`));

  // Mode-based pre-filtering: --expand-nri and --rates-only require an existing config
  if (agentMode === "expand-nri" && !hasConfig) {
    console.log(`--- [${index}/${total}] SKIP ${bank.name} (no config — needs full discovery first)`);
    return { name: bank.name, status: "skipped", skip_reason: "no_config_for_expand_nri" };
  }
  if (agentMode === "rates-only" && !hasConfig) {
    console.log(`--- [${index}/${total}] SKIP ${bank.name} (no config — needs discovery first)`);
    return { name: bank.name, status: "skipped", skip_reason: "no_config_for_rates_only" };
  }

  // For --expand-nri, skip banks that already have NRI URLs
  if (agentMode === "expand-nri" && hasConfig) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(latestDir, `${bankCode}_config.json`), "utf-8"));
      const urls = config.rate_page_urls || {};
      if (urls.fd_nre || urls.fd_nro || urls.fd_fcnr || urls.fd_nri_combined) {
        console.log(`--- [${index}/${total}] SKIP ${bank.name} (already has NRI URLs)`);
        return { name: bank.name, status: "skipped", skip_reason: "expand_nri_already_present" };
      }
    } catch {}
  }

  if (!resume) return null;
  const prevStatus = previousResults[bank.name];

  if (prevStatus === "success" && hasConfig) {
    console.log(`--- [${index}/${total}] SKIP ${bank.name} (succeeded previously)`);
    return { name: bank.name, status: "skipped", skip_reason: "resume_already_succeeded" };
  }
  if (!prevStatus && hasConfig && !agentMode) {
    // Only skip for default discover mode — expand-nri/rates-only should re-process
    console.log(`--- [${index}/${total}] SKIP ${bank.name} (output exists)`);
    return { name: bank.name, status: "skipped", skip_reason: "output_exists" };
  }
  if (prevStatus === "rate_limited") {
    console.log(`--- [${index}/${total}] RETRY ${bank.name} (was rate-limited)`);
    return null;
  }
  if (prevStatus === "failed" && !retryFailed) {
    console.log(`--- [${index}/${total}] SKIP ${bank.name} (failed previously, use --retry-failed)`);
    return { name: bank.name, status: "skipped", skip_reason: "previous_failure_no_retry" };
  }
  return null;
}

/** Slugify a category name for use as a folder name. */
function categorySlug(cat) {
  return (cat || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Build args array for run-discovery.js with mode, log-level, and output-dir flags. */
function buildDiscoveryArgs(bank) {
  const discoveryArgs = [runDiscovery, bank.name, bank.category || "", bank.state || ""];
  if (agentMode) discoveryArgs.push(`--${agentMode}`);

  // Sprint 010 A1 (2026-06-09): orchestrator is the only path. The legacy
  // IBU forceIbuLlm logic is gone — IBUs with templates dispatch via
  // lib/extractors/dispatch.js, IBUs without templates fall through to
  // _generic-html-3col → _llm-fallback (Azure OpenAI).
  if (agentPath) discoveryArgs.push("--path", agentPath);

  if (logLevel !== "info") discoveryArgs.push("--log-level", logLevel);

  // When running all categories, group output by category subfolder
  let bankOutputDir;
  if (!categoryFilter) {
    bankOutputDir = path.join(batchRunDir, categorySlug(bank.category));
    fs.mkdirSync(bankOutputDir, { recursive: true });
  } else {
    bankOutputDir = batchRunDir;
  }
  discoveryArgs.push("--output-dir", bankOutputDir);
  return discoveryArgs;
}

/** Run discovery for one bank synchronously. Returns a result object. */
function runBankSync(bank, bankCode, index, total) {
  console.log();
  console.log(`>>> [${index}/${total}] ${bank.name} [${modeDisplay}]`);
  console.log(`    Category: ${bank.category}`);
  console.log(`    State:    ${bank.state}`);
  console.log();

  const bankStart = Date.now();
  try {
    const result = spawnSync(
      process.execPath,
      buildDiscoveryArgs(bank),
      { cwd: __dirname, stdio: "inherit", timeout, shell: false },
    );
    const elapsedSec = Math.round((Date.now() - bankStart) / 1000);
    return classifyResult(bank, bankCode, result.status, result.signal, elapsedSec);
  } catch (err) {
    const elapsedSec = Math.round((Date.now() - bankStart) / 1000);
    const status = err.killed ? "timeout" : "failed";
    console.error(`!!! ${status.toUpperCase()} for ${bank.name} — continuing`);
    return { name: bank.name, status, error: err.message, elapsed_sec: elapsedSec };
  }
}

/** Run discovery for one bank asynchronously. Returns a promise of result object. */
function runBankAsync(bank, bankCode, index, total) {
  return new Promise((resolve) => {
    console.log(`>>> [${index}/${total}] ${bank.name} [${modeDisplay}]`);
    const bankStart = Date.now();
    const child = spawn(
      process.execPath,
      buildDiscoveryArgs(bank),
      { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], shell: false },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeout);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const elapsedSec = Math.round((Date.now() - bankStart) / 1000);
      // Print buffered output summary
      if (stdout.trim()) {
        const lastLine = stdout.trim().split("\n").pop();
        console.log(`    [${bankCode}] ${lastLine}`);
      }
      const result = classifyResult(bank, bankCode, code, signal, elapsedSec);
      resolve(result);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const elapsedSec = Math.round((Date.now() - bankStart) / 1000);
      resolve({ name: bank.name, status: "failed", error: err.message, elapsed_sec: elapsedSec });
    });
  });
}

// Sprint 009 Phase 2.5 — zero-slab-failure detection. Lives in
// lib/extraction-inspector.js so the rule is testable against tmp-dir
// fixtures without booting the agent.
const { inspectExtractionOutput, isZeroSlabFailure } = require("./lib/extraction-inspector");

/** Classify a completed bank run result (shared by sync and async paths). */
function classifyResult(bank, bankCode, exitCode, signal, elapsedSec) {
  const logFile = path.join(latestDir, `${bankCode}.log`);
  let logContents = "";
  try { logContents = fs.readFileSync(logFile, "utf-8"); } catch {}

  const rl = detectRateLimit(logContents);

  if (rl.isRateLimit) {
    console.error(`!!! RATE LIMITED: ${bank.name} (${rl.message})`);
    if (rl.resetTime) console.error(`    Reset time: ${rl.resetTime}`);
    emitEvent("FAILED", { bank_code: bankCode, kind: "rate_limited", detail: rl.message, reset_time: rl.resetTime || null });
    return {
      name: bank.name, status: "rate_limited",
      rate_limit_message: rl.message, reset_time: rl.resetTime, elapsed_sec: elapsedSec,
    };
  }
  if (exitCode === 0) {
    // Sprint 009 Phase 2.5 — truthful classification of exit-0 runs.
    // The 2026-06-03 HDFC smoke produced exit 0 with zero slabs and
    // confidence `none`; pre-Phase-2.5 logic counted that as a success,
    // letting an empty refresh hide behind a green ARM status. Now: if
    // every produced rate file is empty AND the bare file's confidence
    // is `none`, treat as `failed`. Legitimate no-FD banks (Payments
    // Banks, etc.) carry failure_class=`no_rates_expected` and are
    // preserved as `success` — they're a different outcome, not a
    // missed extraction. See container-mgmt/doc/cloud-deploy-smoke-
    // operational-handoff.md item 2.
    const out = inspectExtractionOutput(bankCode, latestDir);
    if (isZeroSlabFailure(out)) {
      console.error(`!!! ZERO-SLAB EXTRACTION for ${bank.name} — reclassifying as failed (confidence=none across ${out.filesPresent} rate file(s))`);
      emitEvent("FAILED", {
        bank_code: bankCode,
        kind: "zero_slab_extraction",
        slab_count: 0,
        rate_files_present: out.filesPresent,
        extraction_confidence: out.bareConfidence,
        failure_class: out.failureClass,
      });
      return {
        name: bank.name,
        status: "failed",
        reason: "zero_slab_extraction",
        slab_count: 0,
        extraction_confidence: out.bareConfidence,
        failure_class: out.failureClass,
        elapsed_sec: elapsedSec,
      };
    }
    return { name: bank.name, status: "success", elapsed_sec: elapsedSec };
  }
  if (signal === "SIGTERM") {
    console.error(`!!! TIMEOUT for ${bank.name} — continuing`);
    emitEvent("FAILED", { bank_code: bankCode, kind: "timeout" });
    return { name: bank.name, status: "timeout", elapsed_sec: elapsedSec };
  }
  console.error(`!!! FAILED (exit ${exitCode}) for ${bank.name} — continuing`);
  emitEvent("FAILED", { bank_code: bankCode, kind: "exit_nonzero", exit_code: exitCode });
  return { name: bank.name, status: "failed", exitCode, elapsed_sec: elapsedSec };
}

/** Apply backoff logic after a result. Returns true if batch should abort. */
function applyBackoff(bankResult) {
  if (bankResult.status === "rate_limited") {
    consecutiveRateLimits++;
    if (consecutiveRateLimits === 1) {
      console.error(`    Increasing delay to 60s for next bank...`);
      delay = Math.max(delay, 60);
    } else if (consecutiveRateLimits === 2) {
      console.error(`    Two consecutive rate limits — pausing for 5 minutes...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300_000);
      console.log(`    Resuming after 5-minute pause.`);
    } else if (consecutiveRateLimits >= 3) {
      console.error(`\n!!! Three consecutive rate limits — aborting batch.`);
      if (bankResult.reset_time) console.error(`    API resets at: ${bankResult.reset_time}`);
      console.error(`    Re-run with --resume to continue later.\n`);
      return true;
    }
  } else {
    consecutiveRateLimits = 0;
    delay = originalDelay;
  }
  if (bankResult.status === "success") succeeded++;
  else if (bankResult.status === "rate_limited") rateLimited++;
  else if (bankResult.status !== "skipped") failed++;
  else skipped++;
  return false;
}

// ── Extract-only mode (no LLM) ──────────────────────────────────────
//
// Wrapped in an async IIFE (Sprint 009 Phase 2.5) so finalize() can be
// awaited — finalize() now publishes the final receipt directly and
// loud-logs on failure, which requires async.

if (extractOnly) {
  (async () => {
    const extractScript = path.join(__dirname, "scripts", "extract_rates.js");
    for (let i = 0; i < banks.length; i++) {
      const bank = banks[i];
      const bankCode = toBankCode(bank.name);
      const configFile = path.join(outputDir, `${bankCode}_config.json`);

      if (!fs.existsSync(configFile)) {
        skipped++;
        results.push({ name: bank.name, status: "skipped", skip_reason: "no_config_for_extract_only" });
        emitEvent("SKIPPED", { bank_code: bankCode, reason: "no_config_for_extract_only" });
        console.log(`--- [${i + 1}/${banks.length}] SKIP ${bank.name} (no config — needs LLM discovery first)`);
        continue;
      }

      console.log(`>>> [${i + 1}/${banks.length}] ${bank.name} (extract-only)`);
      emitEvent("ATTEMPT", { bank_code: bankCode, idx: i + 1, total: banks.length, mode: "extract_only" });
      const bankStart = Date.now();
      const result = spawnSync(
        process.execPath,
        [extractScript, bankCode],
        { cwd: __dirname, stdio: "inherit", timeout: 120_000 },
      );
      const elapsedSec = Math.round((Date.now() - bankStart) / 1000);

      if (result.status === 0) {
        succeeded++;
        results.push({ name: bank.name, status: "success", elapsed_sec: elapsedSec });
      } else {
        failed++;
        results.push({ name: bank.name, status: "failed", exitCode: result.status, elapsed_sec: elapsedSec });
        emitEvent("FAILED", { bank_code: bankCode, kind: "exit_nonzero", exit_code: result.status });
      }
    }
    process.exit(await finalize());
  })().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

// ── Sequential execution (concurrency = 1) ─────────────────────────
//
// Wrapped in an async IIFE so we can properly `await` the Sprint 4 / B2
// per-bank blob upload. Pre-Sprint-4 this was a top-level for-loop with
// blocking spawnSync calls; the upload turned the loop async, so we
// migrated delay handling from Atomics.wait to setTimeout-Promise too.
// finalize() runs from inside the IIFE so the order (loop → finalize) is
// preserved across the sync→async transition.

// Sprint 009 Phase 9.7 (2026-06-05) — cohort-level no-progress watchdog.
// The pm-refresh-2026-q2 cohort (execution 5kz1vm8) silently froze on
// bank #315 after ~7h of processing; ARM continued reporting Running for
// 4+ hours requiring a manual stop. spawnSync.timeout (15 min per-bank)
// didn't fire — the freeze was at a layer below Node's timeout handling
// (most likely kernel-level resource exhaustion in Container Apps
// Consumption). This watchdog gives the cohort a clean exit path so a
// silent hang becomes a fast partial-success receipt instead of a
// 20-hour wait for replicaTimeoutSec.
//
// Design: sdlc/sprints/sprint-009/design/phase-9-7-cohort-watchdog.md.
// Trigger: lastCohortProgressMs hasn't advanced in
//   BIRD_COHORT_NO_PROGRESS_TIMEOUT_MS (default 25 min = per-bank
//   timeout 15 min + a generous 10 min buffer).
// Action: flush receipt with outcome 'aborted_no_progress', push to
//   blob, process.exit(7).
// Limitation: if the Node event loop itself is frozen (the exact
//   failure we hit in 5kz1vm8), setInterval can't fire and only the
//   replicaTimeoutSec safety net catches it. The watchdog covers every
//   async-hang failure mode (storage SDK, LLM client, cloud-sync, etc.)
//   which is most of the future failure surface.
const COHORT_NO_PROGRESS_TIMEOUT_MS = parseInt(
  process.env.BIRD_COHORT_NO_PROGRESS_TIMEOUT_MS || String(25 * 60 * 1000),
  10,
);
let lastCohortProgressMs = Date.now();
let lastCohortProgressBank = '(pre-flight)';
let cohortWatchdogInterval = null;
let watchdogAborted = false;

function startCohortWatchdog() {
  if (cohortWatchdogInterval) return;
  cohortWatchdogInterval = setInterval(() => {
    if (watchdogAborted) return;
    const elapsed = Date.now() - lastCohortProgressMs;
    if (elapsed > COHORT_NO_PROGRESS_TIMEOUT_MS) {
      watchdogAborted = true;
      const seconds = Math.round(elapsed / 1000);
      console.error(`\n!!! COHORT WATCHDOG: no progress for ${seconds}s (limit ${COHORT_NO_PROGRESS_TIMEOUT_MS / 1000}s)`);
      console.error(`!!! Last completed bank index: ${lastCohortProgressBank}`);
      console.error(`!!! Aborting cohort to flush partial-success receipt instead of waiting for replicaTimeoutSec.`);
      emitEvent("FAILED", {
        bank_code: "_cohort_watchdog",
        kind: "cohort_no_progress",
        no_progress_seconds: seconds,
        last_progress_bank: lastCohortProgressBank,
      });
      // Best-effort receipt flush + push, then hard-exit. Don't await
      // the async chain because the very fault we're catching may
      // wedge it; race against a 30-second deadline and exit anyway.
      const hardExit = setTimeout(() => {
        console.error("!!! watchdog hard-exit after 30s; receipt may not have flushed");
        process.exit(7);
      }, 30_000);
      hardExit.unref();
      (async () => {
        clearTimeout(hardExit);
        process.exit(7);
      })();
    }
  }, 60_000);
  cohortWatchdogInterval.unref();
}

function markCohortProgress(bankRef) {
  lastCohortProgressMs = Date.now();
  if (bankRef) lastCohortProgressBank = String(bankRef);
}

if (concurrency <= 1) {
  (async () => {
    startCohortWatchdog();
    for (let i = 0; i < banks.length; i++) {
      if (watchdogAborted) break;
      const bank = banks[i];
      const bankCode = toBankCode(bank.name);

      const skipResult = checkResume(bank, bankCode, i + 1, banks.length);
      if (skipResult) {
        skipped++;
        results.push(skipResult);
        emitEvent("SKIPPED", { bank_code: bankCode, reason: skipResult.skip_reason || "pre_filter" });
        markCohortProgress(`${i + 1}/${banks.length} ${bankCode} (skipped)`);
        continue;
      }

      emitEvent("ATTEMPT", { bank_code: bankCode, idx: i + 1, total: banks.length, mode: "sequential" });
      const bankResult = runBankSync(bank, bankCode, i + 1, banks.length);
      results.push(bankResult);
      markCohortProgress(`${i + 1}/${banks.length} ${bankCode} (${bankResult.status})`);

      const shouldAbort = applyBackoff(bankResult);
      if (shouldAbort) break;

      if (i < banks.length - 1 && delay > 0 && consecutiveRateLimits < 3) {
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
    process.exit(await finalize());
  })().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

// ── Parallel execution (concurrency > 1) ────────────────────────────

if (concurrency > 1) {
  // Build work queue (skip resumed banks first)
  const workQueue = [];
  for (let i = 0; i < banks.length; i++) {
    const bank = banks[i];
    const bankCode = toBankCode(bank.name);
    const skipResult = checkResume(bank, bankCode, i + 1, banks.length);
    if (skipResult) {
      skipped++;
      results.push(skipResult);
      emitEvent("SKIPPED", { bank_code: bankCode, reason: skipResult.skip_reason || "pre_filter" });
      markCohortProgress(`${i + 1}/${banks.length} ${bankCode} (skipped)`);
    } else {
      workQueue.push({ bank, bankCode, index: i + 1 });
    }
  }

  // Sprint 009 Phase 9.7: same watchdog covers the parallel path.
  startCohortWatchdog();

  // Process work queue with concurrency pool
  const runParallel = async () => {
    let qi = 0;
    const active = new Set();

    while (qi < workQueue.length || active.size > 0) {
      // Check if batch should abort
      if (abortBatch || watchdogAborted) break;

      // Fill pool up to concurrency limit
      while (active.size < concurrency && qi < workQueue.length && !abortBatch && !watchdogAborted) {
        const { bank, bankCode, index } = workQueue[qi++];
        emitEvent("ATTEMPT", { bank_code: bankCode, idx: index, total: banks.length, mode: "parallel" });
        const p = runBankAsync(bank, bankCode, index, banks.length)
          .then(async (bankResult) => {
            results.push(bankResult);
            markCohortProgress(`${index}/${banks.length} ${bankCode} (${bankResult.status})`);
            abortBatch = applyBackoff(bankResult);
            active.delete(p);
          });
        active.add(p);
      }

      // Wait for any one to complete
      if (active.size > 0) {
        await Promise.race(active);
      }

      // Delay between launches
      if (delay > 0 && active.size > 0 && qi < workQueue.length) {
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  };

  // Run and wait (top-level await workaround for CommonJS)
  runParallel().then(async () => process.exit(await finalize())).catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

// ── Summary ─────────────────────────────────────────────────────────

function writeSummary() {
  console.log();
  console.log("============================================");
  const parts = [`${succeeded} succeeded`, `${failed} failed`];
  if (rateLimited > 0) parts.push(`${rateLimited} rate-limited`);
  parts.push(`${skipped} skipped`);
  console.log(` Batch complete: ${parts.join(", ")}`);
  if (rateLimited > 0) {
    console.log(` Rate-limited banks will be retried automatically with --resume`);
  }
  console.log("============================================");
  console.log();
  console.log("=== Output files (this batch) ===");

  for (const bank of banks) {
    const code = toBankCode(bank.name);
    const configFile = path.join(latestDir, `${code}_config.json`);
    if (fs.existsSync(configFile)) {
      const ratesFile = path.join(latestDir, `${code}_rates.json`);
      let hasRates = "No";
      if (fs.existsSync(ratesFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(ratesFile, "utf-8"));
          const slabCount = (data.rate_slabs || []).length;
          if (slabCount > 0) hasRates = `Yes (${slabCount} slabs)`;
        } catch {}
      }
      console.log(`  ✓ ${code}: rates=${hasRates}`);
    } else {
      console.log(`  ✗ ${code}: no output`);
    }
  }

  // Write batch results to both the run folder and latest/
  const resultsFile = path.join(batchRunDir, `_batch_results.json`);
  const latestResultsFile = path.join(latestDir, `_batch_results_${categorySuffix}.json`);
  // safe-write-exempt: batch results aggregator (_batch_results.json), not a per-bank artifact.
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      category: categoryFilter || "all",
      succeeded,
      failed,
      rate_limited: rateLimited,
      skipped,
      results,
    }, null, 2),
  );
  // Also save to latest/ for resume support
  // safe-write-exempt: batch results aggregator copy in latest/ (_batch_results_<category>.json), not a per-bank artifact.
  fs.writeFileSync(
    latestResultsFile,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      category: categoryFilter || "all",
      succeeded,
      failed,
      rate_limited: rateLimited,
      skipped,
      results,
    }, null, 2),
  );
  console.log(`\nBatch results saved to ${resultsFile}`);
  console.log(`  (also copied to ${latestResultsFile})`);
}

// finalize() is called from inside the sequential IIFE (above) and from
// runParallel().then() in the parallel path — no top-level invocation
// needed here.

// finalize() = writeSummary + cloud push + pack rebuild & publish + git publish.
// Used by sequential, extract-only, and parallel modes (parallel passes it to
// runParallel().then()).
//
// Pack and git publish failures are logged but do NOT fail the run — the blob
// push already succeeded, and the canonical artifacts are safe in agent-state.
// Operators get an alert via Sprint 003 dashboards on these failures.
//
// Order matters: pack rebuild + publish happens BEFORE git publish so the
// freshly-built pack/dist/rates-pack.json lands in the same git commit as the
// per-bank rate updates that fed it.
async function finalize() {
  // Sprint 009 Phase 1 — truthful exit. Receipt phase mirrors business
  // outcome: success → succeeded, no_work → no_work, others → failed.
  // The non-zero exit on partial_failure / failure / no_work makes ARM
  // surface "Failed" instead of hiding a bad refresh behind a green
  // control-plane status.
  //
  // Sprint 009 Phase 2.5 / handoff doc item 3 — publish the final
  // receipt DIRECTLY (separately from the bulk runCloudSync push
  // below). Two reasons: (1) the bulk push can fail or take seconds
  // longer than direct upload, leaving the receipt unobservable to
  // deploy-smoke's poller; (2) we want loud-log on failure here, which
  // requires an awaited direct upload, not a fire-and-forget that
  // disappears when process.exit hits. The bulk push still runs as
  // the durable belt-and-suspenders write — the receipt lands twice
  // by design.
  const outcome = computeRunOutcome();
  writeSummary();
  completeBatch();
  return outcome === "success" ? 0 : 1;
}

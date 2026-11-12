#!/usr/bin/env node

/**
 * run-discovery.js — Invoke the Rate Discovery Agent for a single bank.
 *
 * Three modes:
 *   Default:       Full discovery — find website, rate pages, extract rates
 *   --expand-nri:  NRI expansion — existing config, find NRE/NRO/FCNR pages, extract all rates
 *   --rates-only:  Re-extract — existing config with known URLs, fetch and extract fresh rates
 *
 * Usage:
 *   node run-discovery.js "State Bank of India" "Public Sector Bank" "Maharashtra"
 *   node run-discovery.js "HDFC Bank Limited" --expand-nri
 *   node run-discovery.js "Bank of Baroda" --rates-only
 *   node run-discovery.js "SBI" --category "Public Sector Bank" --log-level debug
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { slugify } = require("./scripts/utils/slugify");
const { createLogger } = require("./scripts/utils/logger");
const { normalizeRatesFile } = require("./scripts/utils/normalize-rates");
// Sprint 010 A1 (2026-06-09): lib/agent.js (runAgent) retired. Orchestrator
// is the only path; see lib/orchestrator.js + lib/extractors/dispatch.js.
const { createCostTracker } = require("./lib/cost-tracker");
const { buildSystemPrompt } = require("./lib/prompts/build-prompt");
const { selectInitialTier, selectDiscoveryAction, checkQuality } = require("./lib/tier-router");
const { expectedVariantsForBank } = require("./lib/orchestrator");
const { updateDomainEntry } = require("./lib/domain-cache");
const { classifyResult } = require("./lib/failure-classifier");
const { enforceSlug } = require("./lib/slug-guard");
const { writeSkipOutputs } = require("./lib/registry-skip");
const { safeWriteArtifact, safeCopyArtifact } = require("./lib/safe-write");

/**
 * Infer the safe-write `kind` from an artifact filename.
 * Returns one of 'config' | 'rates' | 'summary' | null (null = passthrough; not a per-bank artifact).
 */
function inferKindFromFilename(name) {
  if (name.endsWith("_config.json")) return "config";
  if (name.endsWith("_rates.json")) return "rates";
  if (name.endsWith(".summary.json")) return "summary";
  return null;
}

// ── Category → bank_type mapping (for prompt assembly) ─────────────

const CATEGORY_TO_TYPE = {
  "Public Sector Bank": "PSB",
  "Private Sector Bank (Indian)": "PVB",
  "Private Sector Bank": "PVB",
  "Small Finance Bank": "SFB",
  "Payments Bank": "PB",
  "Foreign Bank": "FB",
  "Regional Rural Bank": "RRB",
  "Scheduled Urban Co-operative Bank": "SUCB",
  "Non-Scheduled Urban Co-operative Bank": "NSUCB",
  "Scheduled State Co-operative Bank": "SSCB",
  "Non-Scheduled State Co-operative Bank": "NSSCB",
  "District Central Co-operative Bank": "DCCB",
  "Local Area Bank": "LAB",
  "Financial Institution": "FI",
  "IFSC Banking Unit (IFSCA)": "IBU",
  "IFSC Banking Unit": "IBU",
  "Housing Finance Company": "HFC",
};

// ── Parse arguments ─────────────────────────────────────────────────

const args = process.argv.slice(2);
let bankName = "";
let category = "";
let state = "";
let mode = "discover"; // "discover" | "expand-nri" | "rates-only"
let logLevel = process.env.LOG_LEVEL || "warn";
let outputDirOverride = ""; // --output-dir: use a specific run folder (for batch grouping)
// Sprint 010 A1 (2026-06-09): orchestrator is the only path. The legacy
// "llm" path (runAgent / open-ended Azure OpenAI chat loop in lib/agent.js)
// is retired per Sprint 6 Step 5 long-deferred plan. Orchestrator itself
// calls Azure OpenAI via the dispatch chain — _generic-html-3col + _llm-fallback
// (lib/extractors/) — so banks without templates still get LLM-driven extraction
// through the deterministic orchestrator pipeline. See
// sdlc/sprints/sprint-010/design/orchestrator-only-path-2026-06-09.md.
//
// The --path flag is preserved for back-compat (and `--path orchestrator` is
// a no-op now) but `--path llm` errors out with a deprecation message.
let agentPath = "orchestrator";
// Sprint 011 item 18 (2026-07-06): --variant <name> — targeted single-variant
// refresh. Maps to an orchestrator product allowlist (input.only_products) so
// only that product runs through the discovery/extraction loop. Operator
// recovery path for multi-URL banks (Axis/HDFC/ICICI/SBI FCNR refreshes).
let variantFilter = "";

const VARIANT_TO_PRODUCT = {
  regular: "fd",
  nre: "fd_nre",
  nro: "fd_nro",
  fcnr: "fd_fcnr",
  gift: "fd_gift",
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--category" && args[i + 1]) {
    category = args[++i];
  } else if (args[i] === "--state" && args[i + 1]) {
    state = args[++i];
  } else if (args[i] === "--expand-nri") {
    mode = "expand-nri";
  } else if (args[i] === "--rates-only") {
    mode = "rates-only";
  } else if (args[i] === "--variant" && args[i + 1]) {
    variantFilter = args[++i];
  } else if (args[i] === "--log-level" && args[i + 1]) {
    logLevel = args[++i];
  } else if (args[i] === "--output-dir" && args[i + 1]) {
    outputDirOverride = args[++i];
  } else if (args[i] === "--path" && args[i + 1]) {
    agentPath = args[++i];
  } else if (!args[i].startsWith("--")) {
    if (!bankName) bankName = args[i];
    else if (!category) category = args[i];
    else if (!state) state = args[i];
  }
}

if (!bankName) {
  console.error("Usage: node run-discovery.js <bank_name> [category] [state] [options]");
  console.error("");
  console.error("Modes:");
  console.error("  (default)        Full discovery — find website, rate pages, extract rates");
  console.error("  --expand-nri     NRI expansion — find NRE/NRO/FCNR pages for existing config");
  console.error("  --rates-only     Re-extract — fetch known URLs, extract fresh rates");
  console.error("");
  console.error("Options:");
  console.error("  --category <cat>  Bank category");
  console.error("  --state <state>   Bank state");
  console.error("  --variant <v>     Targeted single-variant refresh: regular|nre|nro|fcnr|gift");
  console.error("                    (runs only that product through the orchestrator loop)");
  console.error("  --log-level <lvl> Log level: error, warn (default), info, debug, trace");
  console.error("  --output-dir <dir> Write output to a specific folder (used by run-batch.js)");
  console.error("  --path orchestrator  (default — only path; lib/orchestrator.js with template dispatch + _llm-fallback)");
  process.exit(1);
}

// Sprint 011 item 18 (2026-07-06): validate --variant early, before any run
// folder or registry work happens.
if (variantFilter && !VARIANT_TO_PRODUCT[variantFilter]) {
  console.error(`Invalid --variant value "${variantFilter}". Must be one of: ${Object.keys(VARIANT_TO_PRODUCT).join(", ")}.`);
  process.exit(1);
}

if (agentPath === "llm") {
  console.error("--path llm has been retired (Sprint 010 A1, 2026-06-09). The orchestrator is the only path;");
  console.error("it covers all banks via template dispatch + _llm-fallback (Azure OpenAI). Re-run without --path.");
  process.exit(1);
}
if (agentPath !== "orchestrator") {
  console.error(`Invalid --path value "${agentPath}". Only "orchestrator" is accepted.`);
  process.exit(1);
}

// ── Derive bank code ────────────────────────────────────────────────

const bankCode = slugify(bankName);

// Sprint 010 A2 (2026-06-09): if --category wasn't passed (CLI shortcut OR
// cohort entry missing it), derive from data/bank-domains.json. Before A2
// the bare invocation `node run-discovery.js <slug>` died inside the
// orchestrator's pre-flight check with "input.bank_type is required" the
// moment any bank with a fulfills_product hint auto-routed to orchestrator.
// Registry-derivation makes the orchestrator universal in practice as well
// as in design.
if (!category) {
  try {
    const domainsPath = path.join(__dirname, "data", "bank-domains.json");
    const domains = JSON.parse(fs.readFileSync(domainsPath, "utf-8"));
    const entry = domains[bankCode];
    if (entry && entry.category) {
      category = entry.category;
      // log.info isn't available yet (logger created below) — defer to console
      console.log(`[A2] No --category passed; derived "${category}" from data/bank-domains.json`);
    }
  } catch (_) { /* best-effort */ }
}
let bankType = CATEGORY_TO_TYPE[category] || null;
// Sprint 011 item 18 (2026-07-06): registry entries don't carry `category`
// (0/1037 as of today), so the A2 derivation above never fires on a bare
// invocation. bank_type then collapsed to null → the orchestrator derived
// UNKNOWN → productsForBank returned ['fd'] and NRE/NRO/FCNR were silently
// skipped (root cause of the 2026-06-15 Axis FCNR refresh failure). The
// per-bank config in output/latest/ DOES carry category + bank_type — and
// --rates-only/--expand-nri already require it to exist — so fall back to
// it before giving up.
if (!bankType) {
  try {
    const cfgPath = path.join(__dirname, "output", "latest", `${bankCode}_config.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    if (!category && cfg.category && CATEGORY_TO_TYPE[cfg.category]) {
      category = cfg.category;
      bankType = CATEGORY_TO_TYPE[category];
      console.log(`[item-18] No --category passed; derived "${category}" from output/latest/${bankCode}_config.json`);
    } else if (cfg.bank_type && typeof cfg.bank_type === "string") {
      bankType = cfg.bank_type;
      console.log(`[item-18] No --category passed; derived bank_type "${bankType}" from output/latest/${bankCode}_config.json`);
    }
  } catch (_) { /* best-effort — config may not exist yet in discover mode */ }
}
const isIBU = bankType === "IBU";

// Sprint 010 A1 (2026-06-09): the M2.6 LLM→orchestrator auto-route logic
// is gone — orchestrator is universal. Banks with extraction hints are
// picked up by lib/extractors/dispatch.js; banks without templates fall
// through to _generic-html-3col → _llm-fallback (Azure OpenAI) deterministically.

// ── Create run folder ───────────────────────────────────────────────

let runDir;
let runLabel;
if (outputDirOverride) {
  runDir = path.resolve(outputDirOverride);
  runLabel = path.basename(runDir);
} else {
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  runLabel = `${ts}_${bankCode}`;
  runDir = path.join(__dirname, "output", "runs", runLabel);
}
const latestDir = path.join(__dirname, "output", "latest");

fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(latestDir, { recursive: true });

// ── Logger ──────────────────────────────────────────────────────────

const log = createLogger(logLevel);
log.setLogFile(path.join(runDir, `${bankCode}.log`));

// ── Timing ──────────────────────────────────────────────────────────

const startTime = Date.now();

function elapsed() {
  const sec = Math.floor((Date.now() - startTime) / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return min > 0 ? `${min}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

// ── Pre-flight checks ───────────────────────────────────────────────

const existingConfigPath = path.join(latestDir, `${bankCode}_config.json`);

if (mode !== "discover" && !fs.existsSync(existingConfigPath)) {
  log.error(`Mode --${mode} requires existing config at ${existingConfigPath}`);
  log.error("Run full discovery first (without --expand-nri or --rates-only)");
  log.flush();
  process.exit(1);
}

// ── Pre-lookup domain info from bank-domains.json ──────────────────

let domainContext = "";
let cachedEntry = null; // shared with orchestrator path (hints.cached_domain / cached_rate_pages)
try {
  const domainsFile = path.join(__dirname, "data", "bank-domains.json");
  if (fs.existsSync(domainsFile)) {
    const domains = JSON.parse(fs.readFileSync(domainsFile, "utf-8"));
    const entry = domains[bankCode];
    cachedEntry = entry || null;
    if (entry && entry.domain) {
      const lines = [];
      lines.push(`## Pre-looked-up Domain Info (skip website search)`);
      lines.push(``);
      lines.push(`The bank's domain is already known. **Skip website search.**`);
      lines.push(`- domain: \`${entry.domain}\``);
      if (entry.rate_pages) {
        for (const [key, val] of Object.entries(entry.rate_pages)) {
          if (val) lines.push(`- rate_pages.${key}: \`${val}\``);
        }
      }
      if (entry.scraper_type) {
        lines.push(`- scraper_type (hint): \`${entry.scraper_type}\``);
      }
      if (entry.notes) {
        lines.push(`- notes: ${entry.notes}`);
      }
      if (entry.parent_bank_code) {
        lines.push(`- parent_bank_code: \`${entry.parent_bank_code}\``);
      }
      lines.push(``);
      lines.push(`Construct the full URL as \`https://<domain><rate_page_path>\` and go directly to classification + extraction.`);
      domainContext = "\n\n" + lines.join("\n");
      log.info(`  Domain known: ${entry.domain} (${Object.keys(entry.rate_pages || {}).filter(k => entry.rate_pages[k]).length} rate pages cached)`);
    } else {
      domainContext = "\n\n## Domain Lookup\n\nNo entry found in bank-domains.json for `" + bankCode + "`. Proceed with full discovery.";
      log.info("  Domain: not in cache — full discovery needed");
    }
  }
} catch (err) {
  log.warn("Failed to pre-lookup bank-domains.json:", err.message);
}

// ── Build prompts ──────────────────────────────────────────────────

// System prompt: assembled from fragments based on mode + bank type
const systemPrompt = buildSystemPrompt(mode, { bankType, isIBU });

// User prompt: mode-specific template + domain context
let bankInput = `Bank Name: ${bankName}`;
if (category) bankInput += `, Category: ${category}`;
if (state) bankInput += `, State: ${state}`;

const promptFiles = {
  "discover": "prompts/discover.md",
  "expand-nri": "prompts/expand-nri.md",
  "rates-only": "prompts/extract.md",
};

let promptTemplate = fs.readFileSync(
  path.join(__dirname, promptFiles[mode]),
  "utf-8",
);

promptTemplate = promptTemplate.replace(/\$ARGUMENTS/g, bankInput);
promptTemplate = promptTemplate.replace(/\$OUTPUT_DIR/g, runDir.replace(/\\/g, "/"));
promptTemplate = promptTemplate.replace(/\$CONFIG_PATH/g, existingConfigPath.replace(/\\/g, "/"));
promptTemplate = promptTemplate.replace(/\$BANK_CODE/g, bankCode);

const userPrompt = promptTemplate + domainContext;

log.debug("Mode:", mode);
log.debug("Bank type:", bankType || "unknown");
log.debug("System prompt:", systemPrompt.length, "chars");
log.debug("User prompt:", userPrompt.length, "chars");
log.debug("Run folder:", runDir);

// ── Print header ────────────────────────────────────────────────────

const modeLabel = { "discover": "DISCOVER", "expand-nri": "EXPAND-NRI", "rates-only": "RE-EXTRACT" };
log.info("============================================");
log.info(` ${bankName} [${modeLabel[mode]}]${variantFilter ? ` [variant=${variantFilter}]` : ""}`);
log.info(` ${category || "N/A"} | ${state || "N/A"}`);
log.info(` Run: ${runLabel}`);
log.info(` Path: ${agentPath}${agentPath === "orchestrator" ? " (deterministic, Sprint 003 #1c)" : " (LLM, CLAUDE.md-driven)"}`);
log.info("============================================");

// ── Two-tier model selection ───────────────────────────────────────

const modelMini = process.env.AZURE_OPENAI_DEPLOYMENT_MINI || "gpt-4.1-mini";
const modelFull = process.env.AZURE_OPENAI_DEPLOYMENT_FULL || "gpt-4.1";
const maxToolCalls = parseInt(process.env.AGENT_MAX_TOOL_CALLS || "15", 10);
const domainWasKnown = domainContext.includes("domain is already known");

// Sprint 002 #5 (L6 codification): if the registry has a terminal
// discovery_status for this bank, skip the agent entirely — write a synthetic
// config+rates+summary from the registry and exit. Saves the AOAI cost for
// operator-confirmed dead-end banks.
const discoveryAction = selectDiscoveryAction({ mode, bankCode, bankType, isIBU, projectRoot: __dirname });
if (discoveryAction.skip) {
  log.warn(`  Skipping discovery: ${discoveryAction.reason}`);
  const skipOut = writeSkipOutputs({
    runDir,
    bankCode,
    bankName,
    bankType,
    category,
    runLabel,
    registryEntry: discoveryAction.registryEntry,
    discoveryStatus: discoveryAction.discovery_status,
  });

  // Classify the synthetic outputs and patch the summary so the aggregator
  // sees them with failure_class + phase_outcomes (same path the live agent
  // gets).
  try {
    const classification = classifyResult({
      agentResult: { success: true, finalText: `registry_skip:${discoveryAction.discovery_status}` },
      runDir,
      bankCode,
      domainWasKnown: !!(discoveryAction.registryEntry && discoveryAction.registryEntry.domain),
      initialTier: 1,
      retryAttempted: false,
    });
    const summary = JSON.parse(fs.readFileSync(skipOut.summaryPath, "utf-8"));
    summary.failure_class = classification.failure_class;
    summary.phase_outcomes = classification.phase_outcomes;
    summary.failure_signals = classification.failure_signals;
    safeWriteArtifact({
      path: skipOut.summaryPath,
      incoming: summary,
      kind: "summary",
      source: "classifier",
      logger: log,
    });
    log.warn(`  failure_class: ${classification.failure_class} (skip)`);
  } catch (err) {
    log.warn("Skip-path classification failed:", err.message);
  }

  // Copy synthetic files into output/latest/. safeCopyArtifact internally
  // preserves operator-curated _config.json / _rates.json (via the
  // CURATED_EXTRACTION_METHODS check), routing incoming to a pending sidecar
  // when needed. Non-JSON files (none expected here) pass through unchanged.
  for (const f of fs.readdirSync(runDir).filter((x) => x.endsWith(".json"))) {
    const src = path.join(runDir, f);
    const dst = path.join(latestDir, f);
    const kind = inferKindFromFilename(f);
    if (!kind) {
      // safe-write-exempt: non-per-bank JSON in skip-path copy loop (e.g., aggregator output) — defensive passthrough; no kind match.
      fs.copyFileSync(src, dst);
      continue;
    }
    safeCopyArtifact({
      sourcePath: src,
      targetPath: dst,
      kind,
      source: "skip-gate",
      logger: log,
    });
  }
  log.warn(`  Wrote synthetic config=${skipOut.wroteConfig}, rates, summary. Exiting.`);
  log.flush();
  process.exit(0);
}

const tierResult = selectInitialTier({ mode, bankCode, bankType, isIBU, projectRoot: __dirname });
log.info(`  Tier: ${tierResult.tier} (${tierResult.reason}) → ${tierResult.tier === 1 ? modelMini : modelFull}`);

// ── Run agent ──────────────────────────────────────────────────────

/** Run one orchestrator-path attempt and record traces. Returns the orchestrator result. */
async function runOrchestratorAttempt(tracker, attemptLabel) {
  log.info(`  [${attemptLabel}] Starting orchestrator path (Sprint 003 #1c)...`);
  const { orchestrate } = require("./lib/orchestrator");
  const domainsFile = path.join(__dirname, "data", "bank-domains.json");

  const hints = {};
  if (cachedEntry?.domain) hints.cached_domain = cachedEntry.domain;
  if (cachedEntry?.rate_pages) hints.cached_rate_pages = cachedEntry.rate_pages;
  if (cachedEntry?.scraper_type) hints.cached_scraper_type = cachedEntry.scraper_type;
  if (cachedEntry?.scraper_notes) hints.cached_scraper_notes = cachedEntry.scraper_notes;
  if (cachedEntry?.expected_slab_count) hints.cached_expected_slab_count = cachedEntry.expected_slab_count;
  if (cachedEntry?.notes) hints.cached_notes = cachedEntry.notes;
  // M2.6 (sprint-004 2026-05-21): pass the full extraction block (typically
  // small) so the orchestrator can prefer hinted PDF URLs over the HTML
  // landing page when looking up rate pages per product.
  if (cachedEntry?.extraction) hints.cached_extraction = cachedEntry.extraction;

  const result = await orchestrate({
    bank_name: bankName,
    bank_type: bankType,
    state,
    category,
    output_dir: runDir, // sandbox to run dir during dual-path period; promote later
    run_dir: runDir,
    domains_file: domainsFile,
    mode,
    // Sprint 011 item 18 (2026-07-06): --variant → single-product allowlist.
    ...(variantFilter ? { only_products: [VARIANT_TO_PRODUCT[variantFilter]] } : {}),
    hints,
    logger: log,
  });

  // Fold phase_events into the existing cost-tracker so trace/summary writing
  // is path-agnostic (recordToolCall expects: name, durationMs, isError, inputPreview, resultPreview).
  for (const ev of result.phase_events || []) {
    tracker.recordToolCall(
      ev.step,
      ev.ms || 0,
      !ev.ok,
      "",
      JSON.stringify(ev.summary || { error: ev.error }).slice(0, 300),
    );
  }
  // Roll LLM usages (extract_html_table fallback, extract_via_vision) into
  // the cost tracker so summary.json reports input_tokens/output_tokens/
  // total_cost_usd for the orchestrator path the same way the LLM-prompt
  // path does. Each usage record's model drives the per-1M price lookup
  // inside cost-tracker.js — set the model before recording so the cost
  // arithmetic uses the right rate.
  for (const u of result.llm_usages || []) {
    if (u?.model && typeof tracker.setModel === "function") {
      tracker.setModel(u.model);
    }
    if (u?.usage) {
      tracker.recordApiCall(u.usage);
    }
  }
  // Phase 2a (sprint-004 2026-05-22): drain Azure DI Layout page usage
  // from the orchestrator. Each extract_via_ocr call returns cost_pages;
  // the orchestrator sums them per-run into result.ocr_pages.
  if (Number.isFinite(result.ocr_pages) && result.ocr_pages > 0
      && typeof tracker.recordOcrPages === "function") {
    tracker.recordOcrPages(result.ocr_pages);
  }
  tracker.setFinalText(
    JSON.stringify(
      { ok: result.ok, signals: result.signals, variantSummary: result.variantSummary || {} },
      null,
      2,
    ),
  );
  // Phase 2c-followup (2026-05-22): map orchestrator's `ok` → `success` so
  // finalResult.success at the exit-code site (run-discovery.js:924) is
  // truthy on a successful orchestrator run. Without this mapping every
  // orchestrator-path bank exited with code 1, and run-batch counted
  // them all as failed (caught by the 12-bank smoke).
  return { ...result, success: !!result.ok };
}

/** Run a single orchestrator attempt. `model` is unused (orchestrator picks per-action). */
async function runAttempt(_model, tracker, attemptLabel) {
  return await runOrchestratorAttempt(tracker, attemptLabel);
}

/** Write trace/summary files and log the agent output. */
function writeTraceAndSummary(tracker, attempt) {
  const rawEvents = tracker.getRawEvents();
  const suffix = attempt > 1 ? `_attempt${attempt}` : "";
  const traceFile = path.join(runDir, `${bankCode}${suffix}.trace.jsonl`);
  const summaryFile = path.join(runDir, `${bankCode}${suffix}.summary.json`);

  if (rawEvents.length > 0) {
    // safe-write-exempt: trace.jsonl is an operational by-product, not a per-bank artifact (ADR-012 §"Spec being decided / NOT in scope").
    fs.writeFileSync(
      traceFile,
      rawEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const summary = tracker.getSummary();
    const summaryOut = {
      bank_code: bankCode,
      bank_name: bankName,
      category: category || null,
      mode,
      agent_path: agentPath, // "llm" or "orchestrator" — see two-path-architecture.md
      run_label: runLabel,
      ...summary,
      tool_calls: tracker.getToolCalls().map((t) => ({
        name: t.name,
        duration_ms: t.durationMs,
        is_error: t.isError,
        input_preview: t.inputPreview || "",
      })),
    };
    safeWriteArtifact({
      path: summaryFile,
      incoming: summaryOut,
      kind: "summary",
      source: "agent",
      logger: log,
    });
    log.debug(`Wrote trace: ${path.basename(traceFile)} (${rawEvents.length} events)`);
    log.debug(`Wrote summary: ${path.basename(summaryFile)}`);
  }

  if (tracker.getFinalText()) {
    log.appendRaw(`\n=== AGENT OUTPUT ===\n${tracker.getFinalText()}`);
  }

  if (rawEvents.length > 0) {
    const summary = tracker.getSummary();
    log.appendRaw(`\n=== TRACE SUMMARY ===`);
    log.appendRaw(`  Model: ${summary.model}`);
    log.appendRaw(`  Duration: ${summary.wall_clock_ms}ms`);
    log.appendRaw(`  Tokens: ${summary.input_tokens} in, ${summary.output_tokens} out`);
    log.appendRaw(`  Cost: $${summary.total_cost_usd.toFixed(4)}`);
    log.appendRaw(`  Tool calls: ${summary.tool_call_count}`);
  }
}

/** Collect results: normalize rate files, count slabs, extract metadata. */
function collectResults() {
  const configFile = path.join(runDir, `${bankCode}_config.json`);
  let scraperType = "?";
  let website = "?";
  const slabCounts = {};

  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      scraperType = config.scraper_type || "?";
      website = config.website || "?";
    } catch {}

    const variantSuffixes = ["", "_nre", "_nro", "_fcnr", "_gift"];
    for (const suffix of variantSuffixes) {
      const file = path.join(runDir, `${bankCode}${suffix}_rates.json`);
      if (!fs.existsSync(file)) continue;

      const norm = normalizeRatesFile(file);
      if (norm && norm.changed) {
        log.debug(`Normalized ${path.basename(file)}: ${norm.fieldsRenamed.join(", ")}`);
      }
      if (norm) {
        const variant = suffix ? suffix.slice(1) : "domestic";
        slabCounts[variant] = norm.slabCount;
      }
    }
  }

  return { scraperType, website, slabCounts, configExists: fs.existsSync(configFile) };
}

(async () => {
  // ── Snapshot prior slab counts from latestDir for drift detection ─
  // Sprint 4 Track A cloud smoke (2026-05-20): cloud AU SFB regressed
  // 23→12 slabs without firing checkQuality because the LLM self-reported
  // "high confidence". We snapshot the prior _rates.json slab counts here,
  // pass them to checkQuality, and use them to detect drift retries.
  function snapshotPriorSlabCounts() {
    const variantSuffixes = { regular: "", nre: "_nre", nro: "_nro", fcnr: "_fcnr", gift: "_gift" };
    const out = {};
    for (const [variant, suffix] of Object.entries(variantSuffixes)) {
      const f = path.join(latestDir, `${bankCode}${suffix}_rates.json`);
      if (!fs.existsSync(f)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(f, "utf-8"));
        const n = (data.rate_slabs || []).length;
        if (n > 0) out[variant] = n;
      } catch { /* skip unreadable */ }
    }
    return out;
  }
  const priorSlabCounts = snapshotPriorSlabCounts();
  if (Object.keys(priorSlabCounts).length > 0) {
    log.info(`  Prior slab counts (for drift check): ${JSON.stringify(priorSlabCounts)}`);
  }

  // ── Operator-curated floor counts from data/expected-slab-floors.json ──
  // Image-baked configuration: ships in the container, never blob-synced.
  // bank-domains.json is the wrong home for this — it round-trips through
  // blob and the agent's cloud-sync pull would overwrite operator-set
  // floors with whatever stale copy lives in blob (Sprint 4 Track A
  // 2026-05-20 cloud smoke regression). Keeping floors in their own file
  // means an operator change is just: edit → commit → rebuild → deploy.
  function loadExpectedFloors() {
    const file = path.join(__dirname, "data", "expected-slab-floors.json");
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      return (data && data.banks && data.banks[bankCode]) || null;
    } catch {
      return null;
    }
  }
  const floorSlabCounts = loadExpectedFloors();
  if (floorSlabCounts && Object.keys(floorSlabCounts).length > 0) {
    log.info(`  Floor slab counts (operator-curated): ${JSON.stringify(floorSlabCounts)}`);
  }

  // ── Default-required variants from bank type ──────────────────────────
  // The drift gate enforces "this bank type is expected to produce a slab
  // for each of these variants" by defaulting any variant without an
  // explicit prior/floor entry to a required floor of 1. PSB/PVB/FB/large-
  // SFB get {regular,nre,nro,fcnr}; IBU gets {gift}; everyone else {regular}.
  // Catches the silent-ship-domestic-only failure that bit BoM/IB/UCO/Canara
  // in the Sprint-004 PSB run (none of which had explicit floor entries).
  // bankType=null (slug-list mode without --category) yields just [regular]
  // — the drift gate then can only catch domestic-side gaps, not NRI gaps.
  // Sprint 011 item 18 (2026-07-06): under --variant the run only touches one
  // product, so the drift gate must not expect the others.
  const expectedVariants = variantFilter ? [variantFilter] : expectedVariantsForBank(bankType, bankCode);
  if (expectedVariants.length > 0) {
    log.info(`  Expected variants (bank-type defaults): ${expectedVariants.join(",")}`);
  }

  // ── Attempt 1 ─────────────────────────────────────────────────────

  const initialModel = tierResult.tier === 1 ? modelMini : modelFull;
  const tracker1 = createCostTracker(initialModel);
  const result1 = await runAttempt(initialModel, tracker1, "attempt 1");
  writeTraceAndSummary(tracker1, 1);

  let finalResult = result1;
  let finalTracker = tracker1;

  // Sprint 010 A1 (2026-06-09): orchestrator runs once, deterministically.
  // The legacy LLM retry loop is gone — retrying the same template against
  // the same page yields the same result, so model-flakiness mitigation
  // doesn't apply. We run checkQuality once for observability (drift signal
  // still feeds KQL) but no retry happens and no partial_silent marker is
  // ever written. Sprint 010 Phase 5's extraction_method carve-out in
  // tier-router#checkQuality remains in place defensively.
  let lastQualityReason = null;
  const retryAttempted = false;
  if (mode !== "rates-only") {
    try {
      const quality = checkQuality({
        agentResult: finalResult,
        runDir,
        bankCode,
        domainWasKnown,
        priorSlabCounts,
        floorSlabCounts,
        expectedVariants,
        driftThreshold: 0.8,
      });
      lastQualityReason = quality.reason;
      if (!quality.pass) {
        const driftMatch = /^slab drift on (\w+): (\d+) < ([\d.]+) \* (\d+) \(([^)]+)\)/.exec(quality.reason);
        if (driftMatch) {
          const [, variant, actual, , expected, source] = driftMatch;
          console.warn(`[METRIC] slab_drift bank=${bankCode} variant=${variant} actual=${actual} expected=${expected} source=${source} attempt=1`);
        }
        log.warn(`  quality check (observe-only): ${quality.reason}`);
      } else {
        log.debug(`  quality check passed: ${quality.reason}`);
      }
    } catch (err) {
      log.warn(`  quality check threw (non-fatal): ${err.message}`);
    }
  }

  // Sprint 010 A1 (2026-06-09): orchestrator never writes a partial_silent
  // marker — the marker was an LLM-flakiness signal. We DO still clear
  // stale markers from prior LLM-path runs so banks recover into the pack
  // once their next orchestrator run lands.
  if (mode !== "rates-only") {
    const markerInRunDir = path.join(runDir, `${bankCode}.partial_silent.json`);
    const markerInLatestDir = path.join(latestDir, `${bankCode}.partial_silent.json`);
    for (const p of [markerInRunDir, markerInLatestDir]) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
          log.info(`  Cleared stale partial_silent marker: ${path.basename(p)}`);
        } catch (err) {
          log.warn(`  Failed to clear stale partial_silent marker ${p}: ${err.message}`);
        }
      }
    }
  }

  // ── Enforce canonical slug (Sprint 002 #6) ──────────────────────
  // Catches LLM strays: ghost-suffixed rate files (`_current_rates.json`
  // etc.) and bank_code field drift inside JSON. Runs before result
  // collection so collectResults() walks the cleaned-up runDir.

  try {
    const guard = enforceSlug({ runDir, bankCode, logger: log });
    if (guard.rogueFilesMoved.length > 0) {
      log.warn(`  Moved ${guard.rogueFilesMoved.length} rogue product-variant file(s) to _rogue/`);
    }
    if (guard.slugCorrections.length > 0) {
      log.warn(`  Corrected bank_code in ${guard.slugCorrections.length} file(s)`);
    }
  } catch (err) {
    log.warn("Slug guard failed:", err.message);
  }

  // ── Collect results ─────────────────────────────────────────────

  const { scraperType, website, slabCounts, configExists } = collectResults();

  // Sprint 009 Phase 1.3 — structured EXTRACTED event for KQL reconciliation.
  // Emitted whether or not slabs landed (slabCounts may be empty); a missing
  // EXTRACTED for an attempted bank is itself the signal Phase 1.4 looks for.
  try {
    const { emit: emitEvent } = require("./lib/events");
    const totalSlabs = Object.values(slabCounts || {}).reduce((a, n) => a + (n || 0), 0);
    emitEvent("EXTRACTED", {
      bank_code: bankCode,
      slab_count: totalSlabs,
      variants: slabCounts || {},
      scraper_type: scraperType || null,
      config_exists: !!configExists,
      retried: retryAttempted,
    });
  } catch { /* observability never blocks the run */ }

  // ── Classify failure_class and append to final summary ───────────

  try {
    const classification = classifyResult({
      agentResult: finalResult,
      runDir,
      bankCode,
      domainWasKnown,
      initialTier: tierResult.tier,
      retryAttempted,
    });
    const finalSummaryFile = path.join(
      runDir,
      retryAttempted ? `${bankCode}_attempt2.summary.json` : `${bankCode}.summary.json`,
    );
    if (fs.existsSync(finalSummaryFile)) {
      const summary = JSON.parse(fs.readFileSync(finalSummaryFile, "utf-8"));
      summary.failure_class = classification.failure_class;
      summary.phase_outcomes = classification.phase_outcomes;
      summary.failure_signals = classification.failure_signals;
      safeWriteArtifact({
        path: finalSummaryFile,
        incoming: summary,
        kind: "summary",
        source: "classifier",
        logger: log,
      });
      const po = classification.phase_outcomes;
      log.info(`  failure_class: ${classification.failure_class}  (website=${po.website}, rate_page=${po.rate_page}, extraction=${po.extraction})`);
    }
  } catch (err) {
    log.warn("Failed to classify failure:", err.message);
  }

  // ── Update domain cache ──────────────────────────────────────────

  if (configExists) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(runDir, `${bankCode}_config.json`), "utf-8"));
      await updateDomainEntry({
        bankCode,
        config,
        domainsFile: path.join(__dirname, "data", "bank-domains.json"),
        logger: log,
      });
    } catch (err) {
      log.warn("Failed to update domain cache:", err.message);
    }
  }

  // ── Copy to latest/ ─────────────────────────────────────────────

  const runFiles = fs.readdirSync(runDir).filter((f) => f.endsWith(".json"));
  for (const f of runFiles) {
    const src = path.join(runDir, f);
    const dst = path.join(latestDir, f);
    const kind = inferKindFromFilename(f);
    if (!kind) {
      // safe-write-exempt: non-per-bank JSON in main copy-to-latest loop (e.g., aggregator output); defensive passthrough — no kind match.
      fs.copyFileSync(src, dst);
      continue;
    }
    safeCopyArtifact({
      sourcePath: src,
      targetPath: dst,
      kind,
      source: "agent",
      logger: log,
    });
  }
  log.debug("Copied", runFiles.length, "files to latest/");

  // ── Summary ─────────────────────────────────────────────────────

  const summary = finalTracker.getSummary();
  const costSuffix = summary.total_cost_usd != null
    ? ` | $${summary.total_cost_usd.toFixed(3)} | ${summary.tool_call_count} tool calls`
    : "";
  const modelTag = finalResult.model ? ` [${finalResult.model}]` : "";

  if (configExists) {
    const slabSummary = Object.entries(slabCounts)
      .map(([v, n]) => `${n} ${v}`)
      .join(", ") || "0 slabs";
    log.warn(`  OK ${elapsed()} | ${scraperType} | ${slabSummary} | ${website}${modelTag}${costSuffix}`);
  } else {
    log.warn(`  FAIL ${elapsed()} | No output files generated${modelTag}${costSuffix}`);
  }

  // ── Flush and copy log ──────────────────────────────────────────

  const logFile = path.join(runDir, `${bankCode}.log`);
  log.flush();

  if (fs.existsSync(logFile)) {
    // safe-write-exempt: .log files are operational by-products (ADR-012 §"NOT in scope").
    fs.copyFileSync(logFile, path.join(latestDir, `${bankCode}.log`));
  }

  log.info(`  Log: ${logFile}`);
  process.exit(finalResult.success ? 0 : 1);
})().catch((err) => {
  log.error("Fatal:", err.message);
  log.flush();
  process.exit(1);
});

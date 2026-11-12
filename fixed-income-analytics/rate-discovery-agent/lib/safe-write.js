'use strict';

/**
 * The single sanctioned write path for per-bank artifacts (ADR-012).
 *
 * Four jobs:
 *   1. Refuse destructive overwrites. Rejection rules (each routes the
 *      incoming payload to `<path>.pending.json` for operator review):
 *      curated existing (rule 1), empty-over-non-empty (rule 2),
 *      garbage-over-clean (rule 3), drastic shrink — incoming below 50%
 *      of an existing >=8-slab ladder (rule 4, Sprint 011 A6/F4).
 *   2. Validate `extraction_method` on incoming writes. Untagged writes
 *      default to `llm_inline_extraction` (matches today's exploratory-LLM
 *      behavior); invalid values throw.
 *   3. Run the deterministic rates-QC pass (Sprint 011 item 21) on every
 *      `kind: 'rates'` write — effective_date ISO normalisation for all
 *      methods; slab dedup + stale-date sanitisation + under-extraction
 *      warning for the LLM path. Cleaning only, never blocks; curated
 *      methods bypass. See lib/rates-qc.js.
 *   4. Write atomically — temp file + rename — so a crash mid-write can't
 *      leave a half-written JSON at the destination.
 *
 * Every writer that touches a per-bank artifact in `output/latest/`,
 * `output/runs/<label>/`, or `data/bank-domains.json` should route through
 * this helper. A pre-commit hook (15d) enforces the funnel.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  isCurated,
  isAllowed,
  ALLOWED_EXTRACTION_METHODS,
  CURATED_EXTRACTION_METHODS,
  AUTO_OVERWRITEABLE_METHODS,
} = require('./extraction-methods');

// Sprint 010 Phase K (2026-06-09): quality-aware rejection. Garbage-extraction
// signatures land here so every writer (agent, cloud-pull, skip-gate, etc.)
// gets the same protection — not just one-off recovery scripts.
const { classifyRatesFile } = require('./rate-quality/garbage-detector');

// Sprint 011 item 21 (2026-07-06): deterministic post-extraction QC — dedup
// + effective-date sanitisation for LLM writes, ISO date normalisation for
// every rates write. Runs before the rejection rules so they judge (and any
// pending sidecar carries) the cleaned payload.
const { qcRatesPayload } = require('./rates-qc');

// Phase 4 (production-pipeline-architecture): anomaly detection quality gates.
// Checks: (1) stale regression — incoming date is older than existing,
//         (2) rate variance — individual slab changes exceed threshold.
// Volume-drop (0 slabs) is already handled by Rejection rule 2 below,
// but diff-engine provides the structured reason string for the pending sidecar.
const { runDiffChecks } = require('./diff-engine');

// Cap on the per-file rejection-history array. Keep enough entries to see drift
// patterns over a few cohort cycles but bounded so files don't grow unboundedly.
const SAFE_WRITE_HISTORY_MAX = 20;

const VALID_KINDS = new Set([
  'config',          // <slug>_config.json
  'rates',           // <slug>_rates.json and variants (_nre_rates.json, etc.)
  'summary',         // <slug>.summary.json and _attempt2 variants
  'registry-file',   // data/bank-domains.json (whole-file atomic write)
  'quality-gate-accepts', // pack/quality-gate-accepts.json (operator-signed accepts; bin/approve-accept.js)
]);

const VALID_SOURCES = new Set([
  'agent',                 // LLM discovery / extraction
  'operator',              // operator transcription / manual edit
  'classifier',            // lib/failure-classifier.js patches summaries
  'skip-gate',             // lib/registry-skip.js synthetic outputs
  'slug-guard',            // lib/slug-guard.js bank_code corrections
  'aggregator',            // lib/run-aggregator.js report writes (rare path; usually out-of-scope)
  'cloud-block-detector',  // Sprint 009 Phase 3 — lib/cloud-block/registry-updater.js writes cloud_block_status into bank-domains.json entries based on cloud-side WAF/challenge observations.
  'cloud-capability-detector', // Sprint 010 Phase 2 — lib/cloud-capability/registry-updater.js writes cloud_capability into bank-domains.json entries based on cloud-side extraction outcomes (partial_silent / zero_slab / crash).
  'merger',                // Sprint 009 Phase 5 — lib/merge/run-merger.js reconciles cloud + local per-bank artifacts; the merged output carries source_runs[] provenance.
  'cloud-pull',            // Sprint 010 Phase K (2026-06-09) — cloud/sync.js#pull hydrates local fs from blob; goes through safe-write so blob-side corruption can't propagate destructive overwrites into local state. Empty-overwrite block fires the same way as for agent writes.
]);

/**
 * Write a per-bank artifact safely.
 *
 * @param {object} ctx
 * @param {string} ctx.path         — absolute target path
 * @param {object|string} ctx.incoming — payload (object → JSON.stringify; string → raw)
 * @param {'config'|'rates'|'summary'|'registry-file'} ctx.kind
 * @param {'agent'|'operator'|'classifier'|'skip-gate'|'slug-guard'|'aggregator'} ctx.source
 * @param {boolean} [ctx.force]     — explicit override; bypasses curated-check (use sparingly; for operator writes)
 * @param {object}  [ctx.logger]    — optional logger with .warn / .info
 * @returns {{ wrote: boolean, deferredToPending: boolean, pendingPath?: string, reason?: string, defaultedExtractionMethod?: string, qcChanges?: object }}
 */
function safeWriteArtifact(ctx) {
  const { path: targetPath, incoming, kind, source, force = false, logger } = ctx;

  if (!targetPath) throw new Error('safeWriteArtifact: path required');
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`safeWriteArtifact: unknown kind "${kind}" (allowed: ${[...VALID_KINDS].join(', ')})`);
  }
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`safeWriteArtifact: unknown source "${source}" (allowed: ${[...VALID_SOURCES].join(', ')})`);
  }

  let payload = incoming;
  let defaultedMethod = null;

  // For config/rates: validate / lazy-tag extraction_method on incoming
  if ((kind === 'config' || kind === 'rates') && payload && typeof payload === 'object') {
    if (!payload.extraction_method) {
      defaultedMethod = 'llm_inline_extraction';
      payload = { ...payload, extraction_method: defaultedMethod };
      if (logger && logger.warn) {
        logger.warn(`safe-write: incoming ${kind} for ${path.basename(targetPath)} lacks extraction_method; defaulted to "${defaultedMethod}"`);
      }
    } else if (!isAllowed(payload.extraction_method)) {
      throw new Error(
        `safeWriteArtifact: invalid extraction_method "${payload.extraction_method}" ` +
        `(allowed: ${ALLOWED_EXTRACTION_METHODS.join(', ')})`,
      );
    }
  }

  // ── Rates QC pass (Sprint 011 item 21) ──
  // Runs BEFORE the rejection rules so they judge the cleaned payload and
  // any pending sidecar carries it too. Cleaning only — this never rejects
  // a write on its own. Curated methods (manual_*, pending_*) bypass inside
  // qcRatesPayload: operator data is authoritative as entered.
  let qcChanges = null;
  if (kind === 'rates' && payload && typeof payload === 'object') {
    const prior = readJsonSafe(targetPath);
    const priorSlabCount = prior && Array.isArray(prior.rate_slabs) ? prior.rate_slabs.length : null;
    const qc = qcRatesPayload(payload, {
      extractionMethod: payload.extraction_method,
      priorSlabCount,
      logger,
    });
    payload = qc.payload;
    if (!qc.bypassed) qcChanges = qc.changes;
  }

  // ── Phase 4 Diff-Engine quality gates ────────────────────────────────────
  // Only applies to automated (agent / cloud-pull / merger) writes on rates.
  // Operator writes with force=true bypass entirely so manual patches always land.
  if (
    kind === 'rates'
    && !force
    && source !== 'operator'
    && payload
    && typeof payload === 'object'
  ) {
    const diffResult = runDiffChecks({
      incoming: payload,
      existingPath: targetPath,
      variant: path.basename(targetPath).replace(/_rates\.json$/, '').split('_').pop(),
      logger,
    });
    // Stale regression → hard reject (routes to pending sidecar)
    if (diffResult.reject) {
      return rejectAndRecordHistory({
        targetPath,
        existing: readJsonSafe(targetPath),
        payload,
        source,
        kind,
        reason: diffResult.rejectReason,
        attemptedVerdict: 'diff_engine_reject',
        defaultedMethod,
        qcChanges,
        logger,
        logMessage: `safe-write: diff-engine REJECTED ${path.basename(targetPath)} — ${diffResult.rejectReason}`,
      });
    }
    // Rate variance → warnings only (write still proceeds)
  }

  // Curated-overwrite check (only config + rates; summary is per-run and
  // expected to be overwritten by classifier patches; registry-file is
  // handled by domain-cache's per-entry merge upstream).
  if ((kind === 'config' || kind === 'rates') && !force && source !== 'operator') {
    const existing = readJsonSafe(targetPath);

    // ── Rejection rule 1: existing has curated extraction_method ──
    if (existing && existing.extraction_method && isCurated(existing.extraction_method)) {
      return rejectAndRecordHistory({
        targetPath,
        existing,
        payload,
        source,
        kind,
        reason: `curated:${existing.extraction_method}`,
        attemptedVerdict: null,
        defaultedMethod,
        qcChanges,
        logger,
        logMessage: `safe-write: preserving curated ${path.basename(targetPath)} (extraction_method=${existing.extraction_method}); incoming from source=${source} routed`,
      });
    }

    // ── Rejection rule 2: empty incoming over non-empty existing (Sprint 010 Phase J) ──
    // R1/R2/R4/R6 destructive-overwrite class from the n55y5dr cohort. Bypassed
    // when existing is tagged stale_needs_refresh (operator opt-in for refresh-or-clear).
    if (
      kind === 'rates'
      && existing
      && existing.extraction_method !== 'stale_needs_refresh'
      && Array.isArray(existing.rate_slabs)
      && existing.rate_slabs.length > 0
      && Array.isArray(payload.rate_slabs)
      && payload.rate_slabs.length === 0
    ) {
      return rejectAndRecordHistory({
        targetPath,
        existing,
        payload,
        source,
        kind,
        reason: 'empty_overwrite_blocked',
        attemptedVerdict: 'empty',
        defaultedMethod,
        qcChanges,
        logger,
        logMessage: `safe-write: empty-overwrite blocked for ${path.basename(targetPath)} (existing has ${existing.rate_slabs.length} slabs, incoming has 0); incoming from source=${source} routed`,
      });
    }

    // ── Rejection rule 3: garbage incoming over clean existing (Sprint 010 Phase K, this commit) ──
    // The chittoor / sbpp / kerala-state class — extractor pulled the wrong
    // table and emitted MORE slabs than HEAD but every one of them nonsense
    // (row indices as tenure_text, rates like 91179%). Catches systemically
    // what the recovery script caught after the fact. See
    // lib/rate-quality/garbage-detector.js for verdict rules.
    if (
      kind === 'rates'
      && existing
      && existing.extraction_method !== 'stale_needs_refresh'
    ) {
      const existingVerdict = classifyRatesFile(existing).verdict;
      const incomingVerdict = classifyRatesFile(payload).verdict;
      if (incomingVerdict === 'garbage' && existingVerdict === 'clean') {
        return rejectAndRecordHistory({
          targetPath,
          existing,
          payload,
          source,
          kind,
          reason: 'garbage_overwrite_blocked',
          attemptedVerdict: 'garbage',
          defaultedMethod,
          qcChanges,
          logger,
          logMessage: `safe-write: garbage-overwrite blocked for ${path.basename(targetPath)} (incoming garbage-verdict; existing clean); incoming from source=${source} routed`,
        });
      }
    }

    // ── Rejection rule 4: drastic shrink over substantial existing (Sprint 011 A6/F4) ──
    // The Axis 2026-07-07 class — hinted dated PDF rolled to 404, the fallback
    // landed on an HTML teaser table and 2 clean-looking slabs replaced a
    // 54-slab ladder. "Clean but fewer" is almost always under-extraction, not
    // a bank shrinking its ladder; route to pending for operator review.
    // Thresholds: existing >= 8 slabs (small ladders are covered by the
    // operator-curated floor counts), incoming non-empty (rule 2 owns empty)
    // but below 50% of existing — aligned with rates-qc's
    // under_extraction_suspected heuristic.
    if (
      kind === 'rates'
      && existing
      && existing.extraction_method !== 'stale_needs_refresh'
      && Array.isArray(existing.rate_slabs)
      && existing.rate_slabs.length >= 8
      && Array.isArray(payload.rate_slabs)
      && payload.rate_slabs.length > 0
      && payload.rate_slabs.length < Math.ceil(existing.rate_slabs.length * 0.5)
    ) {
      return rejectAndRecordHistory({
        targetPath,
        existing,
        payload,
        source,
        kind,
        reason: 'shrink_overwrite_blocked',
        attemptedVerdict: 'shrink',
        defaultedMethod,
        qcChanges,
        logger,
        logMessage: `safe-write: shrink-overwrite blocked for ${path.basename(targetPath)} (existing has ${existing.rate_slabs.length} slabs, incoming has ${payload.rate_slabs.length}); incoming from source=${source} routed`,
      });
    }
  }

  // Atomic write
  writeJsonAtomic(targetPath, payload);
  return { wrote: true, deferredToPending: false, defaultedExtractionMethod: defaultedMethod, qcChanges };
}

/**
 * Rejection helper — writes the incoming to a .pending.json sidecar AND appends
 * a history entry to the existing file's `_safe_write_history` array. The
 * retained file's slab data is unchanged; only the history grows.
 *
 * Provenance answer to "which run did the retained slabs come from?": every
 * rejection records (attempted_at, attempted_source, attempted_extraction_method,
 * attempted_slab_count, attempted_verdict, retained_extraction_method,
 * retained_scraped_at, retained_slab_count). Operators reading the file see
 * the full attempt history without consulting external logs.
 */
function rejectAndRecordHistory({
  targetPath, existing, payload, source, kind, reason, attemptedVerdict,
  defaultedMethod, qcChanges = null, logger, logMessage,
}) {
  const pendingPath = targetPath + '.pending.json';
  writeJsonAtomic(pendingPath, payload);

  // Append history entry to the retained file. Slab data is preserved; only the
  // _safe_write_history field grows.
  if (kind === 'rates' || kind === 'config') {
    const entry = {
      attempted_at: new Date().toISOString(),
      attempted_source: source,
      attempted_extraction_method: payload?.extraction_method || null,
      attempted_slab_count: Array.isArray(payload?.rate_slabs) ? payload.rate_slabs.length : null,
      attempted_verdict: attemptedVerdict,
      rejected_reason: reason,
      retained_extraction_method: existing?.extraction_method || null,
      retained_scraped_at: existing?.scraped_at || null,
      retained_slab_count: Array.isArray(existing?.rate_slabs) ? existing.rate_slabs.length : null,
    };
    const history = Array.isArray(existing._safe_write_history) ? [...existing._safe_write_history] : [];
    history.push(entry);
    // Drop oldest entries when capacity exceeded
    while (history.length > SAFE_WRITE_HISTORY_MAX) history.shift();
    const updatedExisting = { ...existing, _safe_write_history: history };
    writeJsonAtomic(targetPath, updatedExisting);
  }

  if (logger && logger.warn) {
    logger.warn(`${logMessage} to ${path.basename(pendingPath)}`);
  }
  return {
    wrote: false,
    deferredToPending: true,
    pendingPath,
    reason,
    defaultedExtractionMethod: defaultedMethod,
    qcChanges,
  };
}

/**
 * Copy an artifact from one path to another with the same curated-check
 * semantics as safeWriteArtifact. Used by run-discovery.js's copy-to-latest
 * step which previously did unconditional fs.copyFileSync.
 *
 * Read source, validate, then call safeWriteArtifact at the destination.
 */
function safeCopyArtifact(ctx) {
  const { sourcePath, targetPath, kind, source, force = false, logger } = ctx;
  if (!fs.existsSync(sourcePath)) {
    if (logger && logger.warn) logger.warn(`safe-copy: source missing ${sourcePath}`);
    return { wrote: false, deferredToPending: false, reason: 'source-missing' };
  }
  const incoming = readJsonSafe(sourcePath);
  if (incoming === null) {
    // Non-JSON file (.log, .trace.jsonl). Out of scope for the curated check;
    // copy as-is.
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    return { wrote: true, deferredToPending: false, reason: 'non-json-passthrough' };
  }
  return safeWriteArtifact({ path: targetPath, incoming, kind, source, force, logger });
}

function writeJsonAtomic(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = {
  safeWriteArtifact,
  safeCopyArtifact,
  // Re-exported so callers don't have to depend on extraction-methods.js too:
  ALLOWED_EXTRACTION_METHODS,
  CURATED_EXTRACTION_METHODS,
  AUTO_OVERWRITEABLE_METHODS,
  VALID_KINDS,
  VALID_SOURCES,
};

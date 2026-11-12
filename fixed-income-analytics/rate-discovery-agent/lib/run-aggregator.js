'use strict';

/**
 * Run-end aggregator: walks a run's per-bank summary files and produces
 * `_run_analysis.json` — the machine-readable source of truth for that run.
 *
 * Spec: sdlc/sprints/sprint-002/design/failure-class-taxonomy.md
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  FAILURE_CLASSES,
  WEBSITE_OUTCOMES,
  RATE_PAGE_OUTCOMES,
  EXTRACTION_OUTCOMES,
} = require('./failure-classifier');

const EXEMPLARS_PER_CLASS = 5;

/**
 * Build the analysis JSON for a finished run.
 *
 * @param {object} ctx
 * @param {string} ctx.runDir              - directory holding per-bank artifacts for this run
 * @param {string} ctx.runLabel            - e.g. "2026-05-10T1230_dccb"
 * @param {string} [ctx.category]          - optional category label
 * @param {string} [ctx.startedAt]         - ISO-8601 string for run start
 * @param {string} [ctx.endedAt]           - ISO-8601 string for run end (defaults to now)
 * @param {string[]} [ctx.bankCodes]       - if set, restrict analysis to these slugs
 *                                           (used by run-pipeline.js since it shares output/latest/
 *                                            across runs)
 * @param {string} [ctx.pendingChangesFile] - path to bank-domains-pending.json (optional)
 * @returns {object} analysis JSON
 */
function buildRunAnalysis(ctx) {
  const {
    runDir,
    runLabel,
    category = null,
    startedAt = null,
    endedAt = new Date().toISOString(),
    bankCodes = null,
    pendingChangesFile = null,
  } = ctx;

  const finalSummaries = collectFinalSummaries(runDir, bankCodes);
  const byClass = bucketByClass(finalSummaries);
  const totals = computeTotals(byClass);
  const phaseTotals = computePhaseTotals(finalSummaries);
  const costTotal = sumCost(finalSummaries);

  const conflicts = readPendingConflicts({ pendingChangesFile, runLabel });

  return {
    run_label: runLabel,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs(startedAt, endedAt),
    category,
    totals,
    by_failure_class: byClass,
    by_phase_outcome: phaseTotals,
    registry_conflicts_surfaced: conflicts.surfacedThisRun,
    registry_conflicts_unresolved_total: conflicts.totalUnresolved,
    cost_usd_total: costTotal,
  };
}

/**
 * Walk runDir, pick the final summary per bank (prefer _attempt2 over base).
 * If bankCodes is provided, only those banks are returned.
 */
function collectFinalSummaries(runDir, bankCodes) {
  if (!fs.existsSync(runDir)) return [];
  const filter = bankCodes ? new Set(bankCodes) : null;
  const entries = fs.readdirSync(runDir);
  const byBank = new Map();
  const SUMMARY_RE = /^(.+?)(_attempt2)?\.summary\.json$/;

  for (const f of entries) {
    if (f.startsWith('_')) continue;
    const m = f.match(SUMMARY_RE);
    if (!m) continue;
    const bank = m[1];
    if (filter && !filter.has(bank)) continue;
    const isAttempt2 = !!m[2];
    const cur = byBank.get(bank);
    if (!cur || (isAttempt2 && !cur.isAttempt2)) {
      byBank.set(bank, { file: f, isAttempt2 });
    }
  }

  const out = [];
  for (const [bank, info] of byBank) {
    const data = readJsonSafe(path.join(runDir, info.file));
    if (data) out.push({ bank_code: bank, summary: data });
  }
  return out;
}

function bucketByClass(finalSummaries) {
  const buckets = {};
  for (const cls of FAILURE_CLASSES) {
    buckets[cls] = { count: 0, exemplars: [] };
  }

  const sorted = [...finalSummaries].sort((a, b) =>
    a.bank_code.localeCompare(b.bank_code),
  );

  for (const { bank_code, summary } of sorted) {
    const cls = summary.failure_class || 'unclassified';
    if (!buckets[cls]) buckets[cls] = { count: 0, exemplars: [] };
    buckets[cls].count += 1;
    if (buckets[cls].exemplars.length < EXEMPLARS_PER_CLASS) {
      buckets[cls].exemplars.push(bank_code);
    }
  }
  return buckets;
}

function computeTotals(byClass) {
  const get = (k) => (byClass[k] ? byClass[k].count : 0);
  const succeeded = get('success');
  const partial = get('partial_success');
  const noRatesExpected = get('no_rates_expected');
  const dispatched = Object.values(byClass).reduce((s, b) => s + b.count, 0);
  const completed = dispatched;
  const failed = dispatched - succeeded - partial - noRatesExpected;
  return {
    dispatched,
    completed,
    succeeded,
    partial_success: partial,
    no_rates_expected: noRatesExpected,
    failed,
  };
}

function computePhaseTotals(finalSummaries) {
  const init = (values) => Object.fromEntries(values.map((v) => [v, 0]));
  const phase = {
    website: init(WEBSITE_OUTCOMES),
    rate_page: init(RATE_PAGE_OUTCOMES),
    extraction: init(EXTRACTION_OUTCOMES),
  };
  for (const { summary } of finalSummaries) {
    const po = summary.phase_outcomes;
    if (!po) continue;
    if (po.website && phase.website[po.website] !== undefined) phase.website[po.website] += 1;
    if (po.rate_page && phase.rate_page[po.rate_page] !== undefined) phase.rate_page[po.rate_page] += 1;
    if (po.extraction && phase.extraction[po.extraction] !== undefined) phase.extraction[po.extraction] += 1;
  }
  return phase;
}

function sumCost(finalSummaries) {
  let total = 0;
  for (const { summary } of finalSummaries) {
    if (typeof summary.total_cost_usd === 'number') total += summary.total_cost_usd;
  }
  return Math.round(total * 10000) / 10000;
}

function durationMs(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const s = Date.parse(startedAt);
  const e = Date.parse(endedAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return e - s;
}

function readPendingConflicts({ pendingChangesFile, runLabel }) {
  const empty = { surfacedThisRun: [], totalUnresolved: 0 };
  if (!pendingChangesFile) return empty;
  const data = readJsonSafe(pendingChangesFile);
  if (!data || !Array.isArray(data.entries)) return empty;

  const unresolved = data.entries.filter((e) => e && e.status === 'pending');
  const surfaced = unresolved
    .filter((e) => e.proposed_run_id === runLabel)
    .map((e) => ({
      bank_code: e.bank_code,
      field: e.field,
      cached_value: e.cached_value,
      proposed_value: e.proposed_value,
      proposed_confidence: e.proposed_confidence || null,
    }));
  return { surfacedThisRun: surfaced, totalUnresolved: unresolved.length };
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Convenience: build the analysis and write _run_analysis.json into a target dir
 * (defaults to runDir). Returns the analysis JSON and the write path.
 */
function writeRunAnalysis(ctx) {
  const analysis = buildRunAnalysis(ctx);
  const targetDir = ctx.outputDir || ctx.runDir;
  const outFile = path.join(targetDir, '_run_analysis.json');
  // safe-write-exempt: aggregator output (_run_analysis.json), not a per-bank artifact
  fs.writeFileSync(outFile, JSON.stringify(analysis, null, 2) + '\n');
  return { analysis, outFile };
}

module.exports = { buildRunAnalysis, writeRunAnalysis };

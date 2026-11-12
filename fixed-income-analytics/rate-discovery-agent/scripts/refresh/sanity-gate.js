#!/usr/bin/env node
'use strict';

/**
 * Phase 3a — sanity gate over candidate diffs.
 *
 * Walks every `diffs/<slug>__<variant>.diff.json` in the run dir and flags
 * candidates whose rate moves look implausible relative to what banks
 * actually do in a single revision. Flagged candidates are NOT promoted by
 * default — they go to `_suspicious.json` for LLM verification (verify-with-llm.js)
 * or operator review.
 *
 * Heuristics (any one triggers the flag):
 *   - LARGE_MOVE: any single slab's general or senior rate moved > 75bps.
 *     Real rate revisions almost never exceed 50bps; cuts past 75bps would
 *     make headlines.
 *   - GEN_SR_COLLAPSE: candidate has >= 50% of slabs with
 *     rate_general_pct === rate_senior_pct (and prior had distinct values).
 *     This is the PNB-style "comparison column read as senior" trap.
 *   - ALL_SR_NULL: candidate has >= 50% of slabs with rate_senior_pct === null
 *     when the prior had populated senior rates. This is the Unity SFB-style
 *     column-mapping miss.
 *   - IMPLAUSIBLE_RATE: any INR-denominated (regular/nre/nro) candidate slab
 *     with rate_general_pct > 9.5% or < 1.0%. Indian FD rates have been in
 *     2.5%–8% for years; outside that band is almost certainly an extraction
 *     artifact (a Sweep / Premium / Vishesh callout being mistaken for a
 *     headline slab).
 *   - SLAB_COUNT_DRIFT: candidate slab count differs from prior by > 50%
 *     (added many phantom rows, or lost most of the table).
 *
 * No LLM, no network, no fresh fetches — pure analysis over existing diffs.
 *
 * Run:
 *   node scripts/refresh/sanity-gate.js
 *   node scripts/refresh/sanity-gate.js --run-ts 2026-05-13T17-29-11
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REFRESH_ROOT = path.join(REPO_ROOT, 'output', 'refresh');
const LATEST_DIR = path.join(REPO_ROOT, 'output', 'latest');

const THRESHOLDS = {
  LARGE_MOVE_BPS: 75,
  GEN_SR_COLLAPSE_RATIO: 0.5,
  ALL_SR_NULL_RATIO: 0.5,
  IMPLAUSIBLE_RATE_MAX: 9.5,
  IMPLAUSIBLE_RATE_MIN: 1.0,
  SLAB_COUNT_DRIFT_RATIO: 0.5,
};

const INR_VARIANTS = new Set(['regular', 'nre', 'nro']);

function parseArgs(argv) {
  const args = { runTs: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--run-ts') args.runTs = argv[++i];
  }
  return args;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // safe-write-exempt: refresh-pipeline run-meta artifact (_suspicious.json) under runs/<ts>/; not a per-bank canonical write.
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function resolveRunTs(explicit) {
  if (explicit) return explicit;
  const pointer = path.join(REFRESH_ROOT, 'latest', '_run_ts.txt');
  if (fs.existsSync(pointer)) return fs.readFileSync(pointer, 'utf-8').trim();
  throw new Error('No run-ts and no latest pointer.');
}

function ratesFileName(bankCode, variant) {
  return variant === 'regular' ? `${bankCode}_rates.json` : `${bankCode}_${variant}_rates.json`;
}

function loadPriorRates(bankCode, variant) {
  return readJsonSafe(path.join(LATEST_DIR, ratesFileName(bankCode, variant)));
}

function loadCandidate(extractedDir, bankCode, variant) {
  return readJsonSafe(path.join(extractedDir, ratesFileName(bankCode, variant)));
}

function checkLargeMove(diff) {
  const offenders = [];
  for (const c of (diff.diff && diff.diff.changed) || []) {
    for (const field of ['rate_general_pct', 'rate_senior_pct', 'rate_super_senior_pct']) {
      const ch = c.changes && c.changes[field];
      if (!ch || ch.delta_bps == null) continue;
      if (Math.abs(ch.delta_bps) > THRESHOLDS.LARGE_MOVE_BPS) {
        offenders.push({
          tenure_text: c.tenure_text,
          currency: c.currency,
          field,
          delta_bps: ch.delta_bps,
          old: ch.old,
          new: ch.new,
        });
      }
    }
  }
  return offenders;
}

function checkGenSrCollapse(candidate, prior) {
  const cSlabs = (candidate && candidate.rate_slabs) || [];
  const pSlabs = (prior && prior.rate_slabs) || [];
  if (cSlabs.length === 0) return null;
  // Count rows in candidate where gen == sr (and both non-null).
  let collapseCount = 0;
  let comparable = 0;
  for (const s of cSlabs) {
    if (s.rate_general_pct != null && s.rate_senior_pct != null) {
      comparable++;
      if (s.rate_general_pct === s.rate_senior_pct) collapseCount++;
    }
  }
  if (comparable === 0) return null;
  const ratio = collapseCount / comparable;
  if (ratio < THRESHOLDS.GEN_SR_COLLAPSE_RATIO) return null;
  // Only flag if prior had distinct gen/sr values — otherwise this might just
  // be a bank that doesn't offer senior premium (rare but valid).
  let priorDistinct = 0;
  let priorComparable = 0;
  for (const s of pSlabs) {
    if (s.rate_general_pct != null && s.rate_senior_pct != null) {
      priorComparable++;
      if (s.rate_general_pct !== s.rate_senior_pct) priorDistinct++;
    }
  }
  if (priorComparable > 0 && priorDistinct / priorComparable < 0.5) return null;
  return { ratio, collapseCount, comparable };
}

function checkAllSrNull(candidate, prior) {
  const cSlabs = (candidate && candidate.rate_slabs) || [];
  const pSlabs = (prior && prior.rate_slabs) || [];
  if (cSlabs.length === 0) return null;
  const nullCount = cSlabs.filter((s) => s.rate_senior_pct == null).length;
  const ratio = nullCount / cSlabs.length;
  if (ratio < THRESHOLDS.ALL_SR_NULL_RATIO) return null;
  // Only flag if prior had >50% populated senior rates.
  const priorPopulated = pSlabs.filter((s) => s.rate_senior_pct != null).length;
  if (pSlabs.length === 0 || priorPopulated / pSlabs.length < 0.5) return null;
  return { ratio, nullCount, total: cSlabs.length };
}

function checkImplausibleRate(candidate, variant) {
  if (!INR_VARIANTS.has(variant)) return null;
  const offenders = [];
  for (const s of (candidate && candidate.rate_slabs) || []) {
    const g = s.rate_general_pct;
    if (g == null) continue;
    if (g > THRESHOLDS.IMPLAUSIBLE_RATE_MAX || g < THRESHOLDS.IMPLAUSIBLE_RATE_MIN) {
      offenders.push({ tenure_text: s.tenure_text, rate_general_pct: g });
    }
  }
  return offenders.length > 0 ? offenders : null;
}

function checkSlabCountDrift(diff, candidate, prior) {
  const cN = (candidate && candidate.rate_slabs) ? candidate.rate_slabs.length : 0;
  const pN = (prior && prior.rate_slabs) ? prior.rate_slabs.length : 0;
  if (pN === 0) return null;
  const drift = Math.abs(cN - pN) / pN;
  if (drift < THRESHOLDS.SLAB_COUNT_DRIFT_RATIO) return null;
  return { prior_count: pN, candidate_count: cN, drift_ratio: drift };
}

function classify(diff, candidate, prior) {
  const reasons = {};
  const largeMove = checkLargeMove(diff);
  if (largeMove.length > 0) reasons.LARGE_MOVE = largeMove;
  const genSr = checkGenSrCollapse(candidate, prior);
  if (genSr) reasons.GEN_SR_COLLAPSE = genSr;
  const srNull = checkAllSrNull(candidate, prior);
  if (srNull) reasons.ALL_SR_NULL = srNull;
  const implaus = checkImplausibleRate(candidate, diff.variant);
  if (implaus) reasons.IMPLAUSIBLE_RATE = implaus;
  const drift = checkSlabCountDrift(diff, candidate, prior);
  if (drift) reasons.SLAB_COUNT_DRIFT = drift;
  return Object.keys(reasons).length > 0 ? reasons : null;
}

function main() {
  const args = parseArgs(process.argv);
  const runTs = resolveRunTs(args.runTs);
  const runDir = path.join(REFRESH_ROOT, runTs);
  const diffsDir = path.join(runDir, 'diffs');
  const extractedDir = path.join(runDir, 'extracted');
  if (!fs.existsSync(diffsDir)) throw new Error(`No diffs dir at ${diffsDir}`);

  const files = fs.readdirSync(diffsDir).filter((f) => f.endsWith('.diff.json'));
  const suspicious = [];
  const clean = [];

  for (const f of files) {
    const diff = readJsonSafe(path.join(diffsDir, f));
    if (!diff) continue;
    const candidate = loadCandidate(extractedDir, diff.bank_code, diff.variant);
    const prior = loadPriorRates(diff.bank_code, diff.variant);
    const reasons = classify(diff, candidate, prior);
    if (reasons) {
      suspicious.push({
        bank_code: diff.bank_code,
        bank_name: diff.bank_name,
        bank_type: diff.bank_type,
        variant: diff.variant,
        source_url: diff.source_url,
        body_cache_path: bodyCachePathFor(runDir, diff.bank_code, diff.variant, diff.detection_status),
        reasons,
      });
    } else {
      clean.push({ bank_code: diff.bank_code, variant: diff.variant });
    }
  }

  // Reason-distribution
  const reasonCounts = {};
  for (const s of suspicious) {
    for (const k of Object.keys(s.reasons)) {
      reasonCounts[k] = (reasonCounts[k] || 0) + 1;
    }
  }

  const out = {
    run_ts: runTs,
    generated_at: new Date().toISOString(),
    thresholds: THRESHOLDS,
    counts: {
      total_diffs: files.length,
      suspicious: suspicious.length,
      clean: clean.length,
    },
    reason_counts: reasonCounts,
    suspicious,
    clean,
  };

  writeJson(path.join(runDir, '_suspicious.json'), out);
  console.log(`sanity-gate: total=${files.length}  suspicious=${suspicious.length}  clean=${clean.length}`);
  console.log(`  reasons: ${JSON.stringify(reasonCounts)}`);
  console.log(`  wrote ${path.join(runDir, '_suspicious.json')}`);
}

function bodyCachePathFor(runDir, bankCode, variant, status) {
  // Phase 2 cache uses <slug>__<variant>.{html,pdf}. Caller will resolve which.
  return path.join(path.relative(REPO_ROOT, runDir), 'fetched', `${bankCode}__${variant}`);
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error('sanity-gate: FAILED', err); process.exit(1); }
}

module.exports = { classify, THRESHOLDS };

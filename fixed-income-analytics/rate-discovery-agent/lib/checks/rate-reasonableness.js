'use strict';
//
// Multi-reference rate-reasonableness detector (Sprint 008, Phase 7).
//
// Flags a bank's rate when it deviates implausibly from three INDEPENDENT
// reference anchors: (1) the peer/category median for that tenure, (2) the RBI
// repo rate (operator-approved macro metadata), (3) the bank's own recent
// history. One anchor firing = WARN; >=2 = a blocking ANOMALY (agreement is
// the signal). Catches plausible-but-wrong values that pass bounds / structural
// / vs-baseline-count checks. See design/rate-reasonableness.md + ADR-017.
//
// Pure functions; the gate supplies the precomputed peer medians, the approved
// macro object, and the bank's prior-pack rates.

const { median, quantile, round2, issue } = require('./structural-checks.js');

// Canonical, universally-comparable rungs (regular variant). FCNR/GIFT excluded.
const BUCKETS = { '1y': [365, 365], '2-3y': [730, 1095], '5y': [1825, 1825] };

// Is a deposit_range a BULK (large-amount) tier? Bulk tiers carry higher rates
// at some co-ops and would mis-flag against retail peers, so we exclude them
// from the peer-comparable bucket rate.
function isBulkRange(dr) {
  if (!dr) return false;
  const s = String(dr).toLowerCase();
  return /^above_|_and_above\b|_to_\d|_to_[0-9a-z]*cr|\babove\b/.test(s);
}

// The general (RETAIL) rate for a bucket: among slabs covering the bucket's
// representative day, prefer the retail tier (deposit_range null / below_*),
// taking the max within it. Only if there are no retail slabs do we fall back
// to the lowest bulk rate. This keeps peer/repo comparisons on the retail rate
// (the Sprint-008 tier lesson: bulk tiers — e.g. model-coop's 9.5% Rs.10L+ —
// must not be compared against retail peers).
function bucketRate(slabs, bucket) {
  if (!Array.isArray(slabs) || !BUCKETS[bucket]) return null;
  const [lo, hi] = BUCKETS[bucket];
  const day = Math.round((lo + hi) / 2);
  const covering = slabs.filter((s) => typeof s.rate_general_pct === 'number'
    && s.tenure_min_days != null && s.tenure_max_days != null
    && s.tenure_min_days <= day && day <= s.tenure_max_days);
  if (covering.length === 0) return null;
  const retail = covering.filter((s) => !isBulkRange(s.deposit_range));
  const pool = retail.length ? retail : covering;
  return pool.reduce((m, s) => (s.rate_general_pct > m ? s.rate_general_pct : m), -Infinity);
}

// { [bank_type]: { [bucket]: { n, median, p25, p75 } } } over the pack's banks.
function medianRateByCategoryTenure(banks) {
  const acc = {};
  for (const b of banks || []) {
    const t = (b && b.bank_type) || '(unknown)';
    const reg = b && b.products && b.products.fd && b.products.fd.regular;
    if (!reg || !Array.isArray(reg.slabs)) continue;
    for (const bucket of Object.keys(BUCKETS)) {
      const r = bucketRate(reg.slabs, bucket);
      if (r == null || !Number.isFinite(r)) continue;
      (acc[t] ||= {});
      (acc[t][bucket] ||= []).push(r);
    }
  }
  const out = {};
  for (const [t, byBucket] of Object.entries(acc)) {
    out[t] = {};
    for (const [bucket, arr] of Object.entries(byBucket)) {
      const sorted = [...arr].sort((a, b) => a - b);
      out[t][bucket] = { n: sorted.length, median: round2(median(sorted)), p25: round2(quantile(sorted, 0.25)), p75: round2(quantile(sorted, 0.75)) };
    }
  }
  return out;
}

// Anchor 1 — peer/category median (+ IQR fence).
function peerDeviation(rate, peerStat, opts = {}) {
  const { bpsThreshold = 200, minN = 8 } = opts;
  if (rate == null || !peerStat || peerStat.n < minN || peerStat.median == null) return null;
  const devBps = Math.round(Math.abs(rate - peerStat.median) * 100);
  let outFence = false;
  if (peerStat.p25 != null && peerStat.p75 != null) {
    const iqr = peerStat.p75 - peerStat.p25;
    outFence = rate < peerStat.p25 - 1.5 * iqr || rate > peerStat.p75 + 1.5 * iqr;
  }
  if (devBps > bpsThreshold || outFence) {
    return issue('rate_deviation_peer', 'WARN',
      `rate ${rate}% is ${devBps}bps from the ${peerStat.bankType || ''} peer median ${peerStat.median}% (n=${peerStat.n}${outFence ? '; outside IQR fence' : ''})`,
      { rate, peerMedian: peerStat.median, devBps, n: peerStat.n, outFence });
  }
  return null;
}

// Anchor 2 — RBI repo band. Returns null (anchor INACTIVE) when the macro file
// is missing/unapproved (no approved_by) — never fabricate a macro default.
function repoDeviation(rate, bankType, macro) {
  if (rate == null || !macro || !macro.approved_by || typeof macro.repo_rate !== 'number') return null;
  const spreads = macro.spreads_by_bank_type || {};
  const sp = spreads[bankType] || spreads.default || { low: 2.0, high: 2.5 };
  const lo = macro.repo_rate - sp.low;
  const hi = macro.repo_rate + sp.high;
  if (rate < lo || rate > hi) {
    return issue('rate_deviation_repo', 'WARN',
      `rate ${rate}% outside plausible band [${round2(lo)}, ${round2(hi)}] around repo ${macro.repo_rate}% for ${bankType || 'default'}`,
      { rate, repo: macro.repo_rate, band: [round2(lo), round2(hi)], bankType });
  }
  return null;
}

// Anchor 3 — the bank's own recent history (nearest of the last N prior rates).
function historicalDeviation(rate, priorRates, opts = {}) {
  const { bpsThreshold = 150 } = opts;
  if (rate == null || !Array.isArray(priorRates)) return null;
  const priors = priorRates.filter((r) => typeof r === 'number' && Number.isFinite(r));
  if (priors.length === 0) return null;
  let nearest = priors[0];
  for (const p of priors) if (Math.abs(p - rate) < Math.abs(nearest - rate)) nearest = p;
  const devBps = Math.round(Math.abs(rate - nearest) * 100);
  if (devBps > bpsThreshold) {
    return issue('rate_deviation_historical', 'WARN',
      `rate ${rate}% deviates ${devBps}bps from nearest recent history ${nearest}% (last ${priors.length}: ${priors.join('/')}%)`,
      { rate, nearest, devBps, history: priors });
  }
  return null;
}

// Combine the three anchors for one (bank, bucket). 0 -> []; 1 -> [WARN];
// >=2 -> one blocking ANOMALY listing the failed anchors.
function rateReasonableness(ctx = {}) {
  const { rate, bankType, bucket, peerStat, macro, priorRates, thresholds = {} } = ctx;
  if (rate == null) return [];
  const fired = [];
  const p = peerDeviation(rate, peerStat ? { ...peerStat, bankType } : null,
    { bpsThreshold: thresholds.peerBps ?? 200, minN: thresholds.minN ?? 8 });
  if (p) fired.push(p);
  const r = repoDeviation(rate, bankType, macro);
  if (r) fired.push(r);
  const h = historicalDeviation(rate, priorRates, { bpsThreshold: thresholds.histBps ?? 150 });
  if (h) fired.push(h);
  if (fired.length >= 2) {
    return [issue('rate_reasonableness_outlier', 'ANOMALY',
      `${bankType}/${bucket} rate ${rate}% failed ${fired.length} reference anchors (${fired.map((f) => f.check.replace('rate_deviation_', '')).join('+')})`,
      { rate, bucket, bankType, anchors: fired.map((f) => ({ check: f.check, value: f.value })) })];
  }
  return fired;
}

module.exports = {
  BUCKETS,
  bucketRate,
  medianRateByCategoryTenure,
  peerDeviation,
  repoDeviation,
  historicalDeviation,
  rateReasonableness,
};

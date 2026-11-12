'use strict';

// Sprint 008, Phase 7 — multi-reference rate-reasonableness detector.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUCKETS, bucketRate, medianRateByCategoryTenure,
  peerDeviation, repoDeviation, historicalDeviation, rateReasonableness,
} = require('../../lib/checks/rate-reasonableness.js');

function slab(min, max, g, dr) { return { tenure_min_days: min, tenure_max_days: max, rate_general_pct: g, deposit_range: dr || null }; }
const APPROVED_MACRO = { repo_rate: 6.5, approved_by: 'op', spreads_by_bank_type: { PSB: { low: 1.0, high: 1.0 }, default: { low: 2.0, high: 2.5 } } };

test('bucketRate picks the retail (max) tier covering the bucket day', () => {
  const slabs = [slab(365, 730, 6.0, 'below_1cr'), slab(365, 730, 5.0, 'above_1cr')];
  assert.equal(bucketRate(slabs, '1y'), 6.0); // retail, not the bulk 5.0
  assert.equal(bucketRate([slab(7, 90, 4.0)], '1y'), null); // no covering slab
});

test('bucketRate prefers retail tier even when a bulk tier is higher', () => {
  // model-coop case: retail 2-3y 8.5% (below_10l) vs bulk 9.5% (above_10l)
  const slabs = [slab(731, 1095, 8.5, 'below_10l'), slab(731, 1095, 9.5, 'above_10l')];
  assert.equal(bucketRate(slabs, '2-3y'), 8.5);
});

test('bucketRate falls back to bulk when no retail tier exists', () => {
  assert.equal(bucketRate([slab(365, 365, 7.0, 'above_1cr')], '1y'), 7.0);
});

test('medianRateByCategoryTenure groups by bank_type x bucket', () => {
  const banks = [
    { bank_type: 'PSB', products: { fd: { regular: { slabs: [slab(365, 365, 6.5)] } } } },
    { bank_type: 'PSB', products: { fd: { regular: { slabs: [slab(365, 365, 6.7)] } } } },
    { bank_type: 'SFB', products: { fd: { regular: { slabs: [slab(365, 365, 7.5)] } } } },
  ];
  const m = medianRateByCategoryTenure(banks);
  assert.equal(m.PSB['1y'].n, 2);
  assert.equal(m.PSB['1y'].median, 6.6);
  assert.equal(m.SFB['1y'].n, 1);
});

test('peerDeviation fires beyond bps threshold; respects minN', () => {
  const stat = { n: 30, median: 6.6, p25: 6.4, p75: 6.8 };
  assert.ok(peerDeviation(2.0, stat)); // way off
  assert.equal(peerDeviation(6.7, stat), null); // close
  assert.equal(peerDeviation(2.0, { n: 3, median: 6.6 }), null); // too few peers
});

test('peerDeviation fires on IQR fence even within bps threshold', () => {
  const stat = { n: 30, median: 6.6, p25: 6.55, p75: 6.65 }; // tight IQR=0.1, fence ~[6.40,6.80]
  const out = peerDeviation(6.5, stat); // 10bps from median (< 200) but below fence 6.40? 6.5>6.40 -> inside
  assert.equal(out, null);
  const out2 = peerDeviation(6.35, stat); // below fence 6.40
  assert.ok(out2 && out2.value.outFence);
});

test('repoDeviation: inactive when macro unapproved; fires outside band when approved', () => {
  assert.equal(repoDeviation(2.0, 'PSB', null), null); // no macro
  assert.equal(repoDeviation(2.0, 'PSB', { repo_rate: 6.5, approved_by: null }), null); // unapproved
  assert.ok(repoDeviation(2.0, 'PSB', APPROVED_MACRO)); // 2.0 outside [5.5,7.5]
  assert.equal(repoDeviation(6.6, 'PSB', APPROVED_MACRO), null); // inside band
  assert.ok(repoDeviation(9.5, 'SFB', APPROVED_MACRO)); // SFB uses default [4.5,9.0]; 9.5 outside
});

test('historicalDeviation fires on a jump from nearest prior', () => {
  assert.ok(historicalDeviation(9.0, [6.5, 6.6, 6.7])); // +230bps jump
  assert.equal(historicalDeviation(6.55, [6.5, 6.6, 6.7]), null); // within 150bps
  assert.equal(historicalDeviation(9.0, []), null); // no history -> skip
});

test('rateReasonableness: 1 anchor => WARN, >=2 => blocking ANOMALY', () => {
  // only peer fires (no macro, no history)
  const one = rateReasonableness({ rate: 2.0, bankType: 'PSB', bucket: '1y', peerStat: { n: 30, median: 6.6, p25: 6.4, p75: 6.8 } });
  assert.equal(one.length, 1);
  assert.equal(one[0].severity, 'WARN');
  // peer + repo + history all fire => single ANOMALY
  const many = rateReasonableness({ rate: 2.0, bankType: 'PSB', bucket: '1y', peerStat: { n: 30, median: 6.6, p25: 6.4, p75: 6.8 }, macro: APPROVED_MACRO, priorRates: [6.5, 6.6] });
  assert.equal(many.length, 1);
  assert.equal(many[0].severity, 'ANOMALY');
  assert.equal(many[0].check, 'rate_reasonableness_outlier');
  assert.ok(many[0].value.anchors.length >= 2);
});

test('rateReasonableness: a normal rate fires nothing', () => {
  const out = rateReasonableness({ rate: 6.6, bankType: 'PSB', bucket: '1y', peerStat: { n: 30, median: 6.6, p25: 6.4, p75: 6.8 }, macro: APPROVED_MACRO, priorRates: [6.5, 6.6, 6.7] });
  assert.deepEqual(out, []);
});

test('rate-reasonableness stays inactive on repo but works on peer+history when macro absent', () => {
  const out = rateReasonableness({ rate: 9.5, bankType: 'PSB', bucket: '1y', peerStat: { n: 30, median: 6.6, p25: 6.4, p75: 6.8 }, priorRates: [6.5, 6.6] });
  // peer fires + historical fires => ANOMALY even with no macro
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'ANOMALY');
});

'use strict';

// Sprint 008, Phase 3 — semantic correctness checks.
// Each test maps to a Sprint-007 bug class, plus a negative control to assert
// no false positives. See sdlc/sprints/sprint-008/design/semantic-checks.md.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyTableType,
  seniorPremiumPeerOutlier,
  ladderPlausibility,
  fcnrCurrencySanity,
  computePeerStats,
  runStructuralChecks,
} = require('../../lib/checks/structural-checks.js');

// A well-formed regular FD ladder (short + long bands, senior premium).
function goodLadder() {
  return [
    { tenure_text: '7-14 days', tenure_min_days: 7, tenure_max_days: 14, rate_general_pct: 3.0, rate_senior_pct: 3.5 },
    { tenure_text: '15-45 days', tenure_min_days: 15, tenure_max_days: 45, rate_general_pct: 3.5, rate_senior_pct: 4.0 },
    { tenure_text: '46-90 days', tenure_min_days: 46, tenure_max_days: 90, rate_general_pct: 4.5, rate_senior_pct: 5.0 },
    { tenure_text: '91-180 days', tenure_min_days: 91, tenure_max_days: 180, rate_general_pct: 5.5, rate_senior_pct: 6.0 },
    { tenure_text: '6m-1y', tenure_min_days: 181, tenure_max_days: 364, rate_general_pct: 6.5, rate_senior_pct: 7.0 },
    { tenure_text: '1y-2y', tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 7.0, rate_senior_pct: 7.5 },
    { tenure_text: '2y-5y', tenure_min_days: 731, tenure_max_days: 1825, rate_general_pct: 6.75, rate_senior_pct: 7.25 },
  ];
}

test('classifyTableType: header naming loan/MCLR without FD => wrong_table_suspected', () => {
  const out = classifyTableType(goodLadder(), { headerTokens: 'Loan Type | MCLR | Effective Rate', variant: 'regular' });
  assert.ok(out, 'should flag');
  assert.equal(out.check, 'wrong_table_suspected');
  assert.equal(out.severity, 'ANOMALY');
});

test('classifyTableType: header naming FD is fine even if it also says deposit', () => {
  const out = classifyTableType(goodLadder(), { headerTokens: 'Fixed Deposit Tenure | General | Senior Citizen', variant: 'regular' });
  assert.equal(out, null);
});

test('classifyTableType: intrinsic — no short and no long band => flag', () => {
  const midOnly = [
    { tenure_min_days: 120, tenure_max_days: 180, rate_general_pct: 6.0 },
    { tenure_min_days: 181, tenure_max_days: 270, rate_general_pct: 6.2 },
    { tenure_min_days: 200, tenure_max_days: 300, rate_general_pct: 6.4 },
  ];
  const out = classifyTableType(midOnly, { variant: 'regular' });
  assert.ok(out && out.check === 'wrong_table_suspected');
});

test('classifyTableType: unparsed Devanagari tenures (mostly null) => no false fire', () => {
  const unparsed = [
    { tenure_text: '१ वर्ष', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 6.5 },
    { tenure_text: '२ वर्ष', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 6.75 },
    { tenure_text: '३ वर्ष', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 7.0 },
  ];
  assert.equal(classifyTableType(unparsed, { variant: 'regular' }), null);
});

test('classifyTableType: good ladder, no header => no flag', () => {
  assert.equal(classifyTableType(goodLadder(), { variant: 'regular' }), null);
});

test('seniorPremiumPeerOutlier: zero/negative premium vs peers expecting +50bps => WARN', () => {
  const swapped = goodLadder().map((s) => ({ ...s, rate_senior_pct: s.rate_general_pct })); // premium 0
  const peerStats = { bankType: 'SUCB', n: 30, median: 0.5, p25: 0.4, p75: 0.6 };
  const out = seniorPremiumPeerOutlier(swapped, { peerStats, variant: 'regular' });
  assert.ok(out, 'should flag');
  assert.equal(out.check, 'senior_premium_peer_outlier');
  assert.equal(out.severity, 'WARN');
});

test('seniorPremiumPeerOutlier: genuine premium => no flag', () => {
  const peerStats = { bankType: 'SUCB', n: 30, median: 0.5 };
  assert.equal(seniorPremiumPeerOutlier(goodLadder(), { peerStats, variant: 'regular' }), null);
});

test('seniorPremiumPeerOutlier: peers have no premium tradition => skip (no flag)', () => {
  const swapped = goodLadder().map((s) => ({ ...s, rate_senior_pct: s.rate_general_pct }));
  assert.equal(seniorPremiumPeerOutlier(swapped, { peerStats: { n: 30, median: 0.0 }, variant: 'regular' }), null);
});

test('seniorPremiumPeerOutlier: non-regular variant => skip', () => {
  const swapped = goodLadder().map((s) => ({ ...s, rate_senior_pct: s.rate_general_pct }));
  assert.equal(seniorPremiumPeerOutlier(swapped, { peerStats: { n: 30, median: 0.5 }, variant: 'nre' }), null);
});

test('ladderPlausibility: 1 slab, no long band, PSB floor 6 => truncated_ladder ANOMALY', () => {
  const one = [{ tenure_text: '7-45 days', tenure_min_days: 7, tenure_max_days: 45, rate_general_pct: 4.0 }];
  const out = ladderPlausibility(one, { bankType: 'PSB', variant: 'regular' });
  assert.ok(out);
  assert.equal(out.check, 'truncated_ladder');
  assert.equal(out.severity, 'ANOMALY');
});

test('ladderPlausibility: single headline rate with no parsed tenure => exempt (no flag)', () => {
  // thanjavur-central: publishes one "Fixed Deposit 8.25%" with null tenure days.
  const single = [{ tenure_text: 'Fixed Deposit', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 8.25 }];
  assert.equal(ladderPlausibility(single, { bankType: 'DCCB' }), null);
});

test('ladderPlausibility: full ladder => no flag', () => {
  assert.equal(ladderPlausibility(goodLadder(), { bankType: 'PSB' }), null);
});

test('ladderPlausibility: few slabs but has long band => no flag (could be legit)', () => {
  const few = [
    { tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 7.0 },
    { tenure_min_days: 731, tenure_max_days: 1825, rate_general_pct: 6.75 },
  ];
  assert.equal(ladderPlausibility(few, { bankType: 'PSB' }), null);
});

test('fcnrCurrencySanity: unknown currency => WARN', () => {
  const slabs = [{ currency: 'INR', tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 5.0 }];
  const out = fcnrCurrencySanity(slabs, { variant: 'fcnr' });
  assert.equal(out.length, 1);
  assert.equal(out[0].check, 'fcnr_currency_anomaly');
});

test('fcnrCurrencySanity: single USD across long sub-year ladder => mislabel WARN', () => {
  const slabs = [];
  for (let i = 0; i < 12; i++) {
    slabs.push({ currency: 'USD', tenure_min_days: 7 + i * 30, tenure_max_days: 30 + i * 30, rate_general_pct: 6.0 + i * 0.1 });
  }
  const out = fcnrCurrencySanity(slabs, { variant: 'fcnr' });
  assert.ok(out.some((i) => /mislabeled|domestic table/.test(i.detail)));
});

test('fcnrCurrencySanity: same currency+tenure across amount tiers => no flag', () => {
  const slabs = [
    { currency: 'USD', tenure_min_days: 365, tenure_max_days: 730, deposit_range: 'below_1m', rate_general_pct: 4.0 },
    { currency: 'USD', tenure_min_days: 365, tenure_max_days: 730, deposit_range: 'above_1m', rate_general_pct: 4.25 },
  ];
  assert.deepEqual(fcnrCurrencySanity(slabs, { variant: 'fcnr' }), []);
});

test('fcnrCurrencySanity: null-days distinct tenure_text => no false collision', () => {
  const slabs = [
    { currency: 'USD', tenure_min_days: null, tenure_max_days: null, tenure_text: '1 Yr < 15 Months', rate_general_pct: 4.5 },
    { currency: 'USD', tenure_min_days: null, tenure_max_days: null, tenure_text: '15 Months < 2 Yrs', rate_general_pct: 4.25 },
  ];
  assert.deepEqual(fcnrCurrencySanity(slabs, { variant: 'fcnr' }), []);
});

test('fcnrCurrencySanity: same currency+tenure_text+tier with conflicting rate => WARN', () => {
  const slabs = [
    { currency: 'USD', tenure_min_days: null, tenure_max_days: null, tenure_text: '1 Yr < 15 Months', rate_general_pct: 4.5 },
    { currency: 'USD', tenure_min_days: null, tenure_max_days: null, tenure_text: '1 Yr < 15 Months', rate_general_pct: 4.0 },
  ];
  const out = fcnrCurrencySanity(slabs, { variant: 'fcnr' });
  assert.equal(out.length, 1);
  assert.match(out[0].detail, /differing rate/);
});

test('fcnrCurrencySanity: GIFT single-currency sub-year ladder => no flag (gift has no 1y floor)', () => {
  const slabs = [];
  for (let i = 0; i < 12; i++) {
    slabs.push({ currency: 'USD', tenure_min_days: 7 + i * 30, tenure_max_days: 30 + i * 30, deposit_range: 'below_3cr', rate_general_pct: 4.0 + i * 0.05 });
  }
  // distinct tenures + distinct rates, single currency, but variant=gift => not the FCNR mislabel heuristic
  assert.deepEqual(fcnrCurrencySanity(slabs, { variant: 'gift' }), []);
});

test('fcnrCurrencySanity: legit multi-currency FCNR (>=1y) => no flag', () => {
  const slabs = [
    { currency: 'USD', tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 4.0 },
    { currency: 'GBP', tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 3.5 },
    { currency: 'EUR', tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 2.0 },
  ];
  assert.deepEqual(fcnrCurrencySanity(slabs, { variant: 'fcnr' }), []);
});

test('fcnrCurrencySanity: non-fcnr variant => empty', () => {
  assert.deepEqual(fcnrCurrencySanity(goodLadder(), { variant: 'regular' }), []);
});

test('computePeerStats: groups median premium by bank_type', () => {
  const banks = [
    { bank_type: 'SUCB', products: { fd: { regular: { slabs: goodLadder() } } } },
    { bank_type: 'SUCB', products: { fd: { regular: { slabs: goodLadder() } } } },
    { bank_type: 'PSB', products: { fd: { regular: { slabs: goodLadder() } } } },
  ];
  const stats = computePeerStats(banks);
  assert.equal(stats.SUCB.n, 2);
  assert.equal(stats.PSB.n, 1);
  assert.ok(stats.SUCB.median > 0);
});

test('runStructuralChecks: aggregates and is empty for a clean regular ladder', () => {
  const issues = runStructuralChecks(goodLadder(), { bankType: 'PSB', variant: 'regular', peerStats: { n: 30, median: 0.5 } });
  assert.deepEqual(issues, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifySlab, classifyRatesFile, recoverHeadPreferred } = require('../../../lib/rate-quality/garbage-detector');

// ── classifySlab ────────────────────────────────────────────────────

test('classifySlab: clean slab → no flags', () => {
  assert.deepEqual(classifySlab({ tenure_text: '7 days to 14 days', rate_general_pct: 4 }), []);
});

test('classifySlab: G1 fires on impossibly-high rate', () => {
  assert.deepEqual(classifySlab({ tenure_text: '1 year', rate_general_pct: 91179 }), ['G1']);
  assert.deepEqual(classifySlab({ tenure_text: '1 year', rate_general_pct: 26 }), ['G1']);
  assert.deepEqual(classifySlab({ tenure_text: '1 year', rate_general_pct: 25 }), []); // boundary
});

test('classifySlab: G2 fires on pure-number tenure_text (row index / rate-as-tenure)', () => {
  assert.deepEqual(classifySlab({ tenure_text: '2.', rate_general_pct: 5 }), ['G2']);
  assert.deepEqual(classifySlab({ tenure_text: '11.45', rate_general_pct: 5 }), ['G2']);
  assert.deepEqual(classifySlab({ tenure_text: '1', rate_general_pct: 5 }), ['G2']);
});

test('classifySlab: G3 fires on loan-product keywords', () => {
  assert.deepEqual(classifySlab({ tenure_text: 'KB MICRO FINANCE JLG', rate_general_pct: 10 }), ['G3']);
  assert.deepEqual(classifySlab({ tenure_text: 'Housing Loan - Fixed', rate_general_pct: 8 }), ['G3']);
  assert.deepEqual(classifySlab({ tenure_text: 'Cash Credit', rate_general_pct: 3.1 }), ['G3']);
});

test('classifySlab: multiple flags compose', () => {
  // Pure number + rate>25 + nothing else
  assert.deepEqual(classifySlab({ tenure_text: '5.', rate_general_pct: 91179 }).sort(), ['G1', 'G2']);
});

test('classifySlab: legitimate FD tenure patterns remain clean', () => {
  assert.deepEqual(classifySlab({ tenure_text: '444 days', rate_general_pct: 7.5 }), []);
  assert.deepEqual(classifySlab({ tenure_text: 'Overnight', rate_general_pct: 7.7 }), []);
  assert.deepEqual(classifySlab({ tenure_text: '2 year and above', rate_general_pct: 7 }), []);
});

// ── classifyRatesFile ───────────────────────────────────────────────

test('classifyRatesFile: empty rate_slabs → empty verdict', () => {
  assert.equal(classifyRatesFile({ rate_slabs: [] }).verdict, 'empty');
});

test('classifyRatesFile: null input → empty verdict', () => {
  assert.equal(classifyRatesFile(null).verdict, 'empty');
});

test('classifyRatesFile: all-clean slabs → clean verdict', () => {
  const r = classifyRatesFile({ rate_slabs: [
    { tenure_text: '7 days to 14 days', rate_general_pct: 4 },
    { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
  ]});
  assert.equal(r.verdict, 'clean');
  assert.equal(r.garbage_count, 0);
});

test('classifyRatesFile: >=50% garbage → garbage verdict (the chittoor/sbpp pattern)', () => {
  const r = classifyRatesFile({ rate_slabs: [
    { tenure_text: '2.', rate_general_pct: 714 },
    { tenure_text: '3.', rate_general_pct: 1545 },
    { tenure_text: '4.', rate_general_pct: 4690 },
    { tenure_text: '5.', rate_general_pct: 91179 },
  ]});
  assert.equal(r.verdict, 'garbage');
  assert.equal(r.garbage_count, 4);
  assert.equal(r.garbage_pct, 1.0);
});

test('classifyRatesFile: 20-50% garbage → suspect verdict', () => {
  // 2 of 5 = 40% garbage
  const r = classifyRatesFile({ rate_slabs: [
    { tenure_text: '7 days to 14 days', rate_general_pct: 4 },
    { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
    { tenure_text: '46 days to 90 days', rate_general_pct: 6 },
    { tenure_text: '1', rate_general_pct: 3.25 }, // G2
    { tenure_text: 'Housing Loan', rate_general_pct: 8 }, // G3
  ]});
  assert.equal(r.verdict, 'suspect');
  assert.equal(r.garbage_count, 2);
});

test('classifyRatesFile: kerala-state cohort output → garbage verdict', () => {
  const r = classifyRatesFile({ rate_slabs: [
    { tenure_text: '12.45', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 10 },
    { tenure_text: 'KB MICRO FINANCE JLG', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 10.95 },
    { tenure_text: '11.95', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 5 },
  ]});
  assert.equal(r.verdict, 'garbage');
  assert.equal(r.garbage_count, 3);
});

// ── recoverHeadPreferred ────────────────────────────────────────────

test('recoverHeadPreferred: current empty, HEAD non-empty → restore HEAD', () => {
  const d = recoverHeadPreferred(
    { rate_slabs: [] },
    { rate_slabs: [{ tenure_text: '1 year', rate_general_pct: 7 }] },
  );
  assert.equal(d.prefer, 'head');
  assert.equal(d.reason, 'current_empty_head_nonempty');
});

test('recoverHeadPreferred: HEAD empty → keep current', () => {
  const d = recoverHeadPreferred(
    { rate_slabs: [{ tenure_text: '1 year', rate_general_pct: 7 }] },
    { rate_slabs: [] },
  );
  assert.equal(d.prefer, 'current');
});

test('recoverHeadPreferred: current garbage, HEAD clean → restore HEAD (the kerala-state case)', () => {
  const d = recoverHeadPreferred(
    { rate_slabs: [
      { tenure_text: '12.45', rate_general_pct: 510 },
      { tenure_text: 'KB MICRO FINANCE JLG', rate_general_pct: 10.95 },
      { tenure_text: '11.95', rate_general_pct: 510 },
    ]},
    { rate_slabs: [
      { tenure_text: '7 to 14 days', rate_general_pct: 4 },
      { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
      { tenure_text: '46 to 90 days', rate_general_pct: 6 },
    ]},
  );
  assert.equal(d.prefer, 'head');
  assert.equal(d.reason, 'current_low_quality_head_clean');
});

test('recoverHeadPreferred: current suspect, HEAD clean → restore HEAD', () => {
  const d = recoverHeadPreferred(
    { rate_slabs: [
      { tenure_text: '7 days to 14 days', rate_general_pct: 4 },
      { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
      { tenure_text: '46 days to 90 days', rate_general_pct: 6 },
      { tenure_text: '1', rate_general_pct: 3.25 },        // G2
      { tenure_text: 'Housing Loan', rate_general_pct: 8 }, // G3
    ]},
    { rate_slabs: [
      { tenure_text: '7 to 14 days', rate_general_pct: 4 },
      { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
    ]},
  );
  assert.equal(d.prefer, 'head');
  assert.equal(d.reason, 'current_low_quality_head_clean');
});

test('recoverHeadPreferred: both clean, HEAD has more → restore HEAD (the legitimate Phase K rule)', () => {
  const d = recoverHeadPreferred(
    { rate_slabs: [
      { tenure_text: '7 to 14 days', rate_general_pct: 4 },
    ]},
    { rate_slabs: [
      { tenure_text: '7 to 14 days', rate_general_pct: 4 },
      { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
      { tenure_text: '1 year', rate_general_pct: 7 },
    ]},
  );
  assert.equal(d.prefer, 'head');
  assert.equal(d.reason, 'both_clean_head_has_more');
});

test('recoverHeadPreferred: both clean, current has same or more → keep current', () => {
  const d = recoverHeadPreferred(
    { rate_slabs: [
      { tenure_text: '7 to 14 days', rate_general_pct: 4 },
      { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
      { tenure_text: '1 year', rate_general_pct: 7 },
    ]},
    { rate_slabs: [
      { tenure_text: '7 to 14 days', rate_general_pct: 4 },
      { tenure_text: '15 to 45 days', rate_general_pct: 5.5 },
    ]},
  );
  assert.equal(d.prefer, 'current');
});

test('recoverHeadPreferred: both garbage → either (no recovery benefit, flag for Sprint 011)', () => {
  const d = recoverHeadPreferred(
    { rate_slabs: [
      { tenure_text: '2.', rate_general_pct: 91179 },
      { tenure_text: '3.', rate_general_pct: 1545 },
    ]},
    { rate_slabs: [
      { tenure_text: 'Housing Loan', rate_general_pct: 8 },
      { tenure_text: 'MSME', rate_general_pct: 3 },
    ]},
  );
  assert.equal(d.prefer, 'either');
  assert.equal(d.reason, 'both_low_quality_no_recovery_available');
});

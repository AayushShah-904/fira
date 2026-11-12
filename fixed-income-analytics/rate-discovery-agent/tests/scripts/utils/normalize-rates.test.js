'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRatesObject } = require('../../../scripts/utils/normalize-rates');

test('canonical fields are left alone (no-op)', () => {
  const data = {
    bank_code: 'foo',
    rate_slabs: [
      { tenure_text: '7 days to 14 days', tenure_min_days: 7, tenure_max_days: 14, rate_general_pct: 4.0 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(r.changed, false);
});

test('top-level alias slabs→rate_slabs', () => {
  const data = { slabs: [{ tenure_text: 'x', tenure_min_days: 1, tenure_max_days: 30 }] };
  const r = normalizeRatesObject(data);
  assert.equal(r.changed, true);
  assert.ok(Array.isArray(data.rate_slabs));
});

test('per-slab alias min_days→tenure_min_days', () => {
  const data = { rate_slabs: [{ tenure_text: 'x', min_days: 7, max_days: 14, rate_general_pct: 4.0 }] };
  const r = normalizeRatesObject(data);
  assert.equal(r.changed, true);
  assert.equal(data.rate_slabs[0].tenure_min_days, 7);
  assert.equal(data.rate_slabs[0].tenure_max_days, 14);
});

// Sprint 010 C (2026-06-09) — tenure_min_below_1 fix.
test('Sprint 010 C: "Up to 30 Days" pattern → tenure_min_days clamped to 1', () => {
  const data = {
    rate_slabs: [
      { tenure_text: 'Up to 30 Days', tenure_min_days: 0, tenure_max_days: 30, rate_general_pct: 4.0 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(r.changed, true);
  assert.equal(data.rate_slabs[0].tenure_min_days, 1);
  assert.equal(data.rate_slabs[0].tenure_max_days, 30); // untouched
});

test('Sprint 010 C: "UPTO 24 MONTHS" pattern → min clamped to 1', () => {
  const data = {
    rate_slabs: [
      { tenure_text: 'UPTO 24 MONTHS', tenure_min_days: 0, tenure_max_days: 730, rate_general_pct: 5.5 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(data.rate_slabs[0].tenure_min_days, 1);
});

test('Sprint 010 C: "<= 30 days" pattern → min clamped to 1', () => {
  const data = {
    rate_slabs: [
      { tenure_text: '<= 30 days', tenure_min_days: 0, tenure_max_days: 30, rate_general_pct: 4.0 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(data.rate_slabs[0].tenure_min_days, 1);
});

test('Sprint 010 C: slabs WITHOUT up-to pattern are unchanged (no false positives)', () => {
  const data = {
    rate_slabs: [
      { tenure_text: '7 days to 14 days', tenure_min_days: 0, tenure_max_days: 14, rate_general_pct: 4.0 },
    ],
  };
  const r = normalizeRatesObject(data);
  // tenure_min_days=0 with tenure_text NOT starting with "up to" is left alone.
  // The fix is intentionally conservative — it only patches the known LLM bug,
  // not every min=0 case (which could be legitimate special-scheme placeholders).
  assert.equal(data.rate_slabs[0].tenure_min_days, 0);
});

test('Sprint 010 C: slabs with null tenure_min_days are unchanged', () => {
  const data = {
    rate_slabs: [
      { tenure_text: 'Special scheme — no tenure', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 4.0 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(data.rate_slabs[0].tenure_min_days, null);
});

// Sprint 010 Phase K (2026-06-09) — null tenure recompute from text.

test('Phase K: null tenure_min/max_days recomputed from parseable tenure_text', () => {
  const data = {
    rate_slabs: [
      { tenure_text: 'Overnight', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 7.7 },
      { tenure_text: '1Y to <2Y', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 3.75 },
      { tenure_text: '7 days to 14 days', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 3.0 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(r.changed, true);
  assert.equal(data.rate_slabs[0].tenure_min_days, 1);
  assert.equal(data.rate_slabs[0].tenure_max_days, 1);
  assert.equal(data.rate_slabs[1].tenure_min_days, 365);
  assert.equal(data.rate_slabs[1].tenure_max_days, 729);
  assert.equal(data.rate_slabs[2].tenure_min_days, 7);
  assert.equal(data.rate_slabs[2].tenure_max_days, 14);
});

test('Phase K: existing non-null tenure days are not overwritten', () => {
  const data = {
    rate_slabs: [
      // tenure_min_days already set (e.g. by upstream extractor); recompute should skip.
      { tenure_text: 'Overnight', tenure_min_days: 7, tenure_max_days: 14, rate_general_pct: 7.7 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(data.rate_slabs[0].tenure_min_days, 7);
  assert.equal(data.rate_slabs[0].tenure_max_days, 14);
});

test('Phase K: unparseable tenure_text leaves null/null alone (no false-positive zeros)', () => {
  const data = {
    rate_slabs: [
      { tenure_text: 'Long Loan', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 12 },
      { tenure_text: 'Consumer loans for domestic appliances', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 13 },
    ],
  };
  normalizeRatesObject(data);
  assert.equal(data.rate_slabs[0].tenure_min_days, null);
  assert.equal(data.rate_slabs[1].tenure_min_days, null);
});

test('Phase K: empty or missing tenure_text is a no-op', () => {
  const data = {
    rate_slabs: [
      { tenure_text: '', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 5 },
      { tenure_min_days: null, tenure_max_days: null, rate_general_pct: 5 }, // no tenure_text at all
    ],
  };
  normalizeRatesObject(data);
  assert.equal(data.rate_slabs[0].tenure_min_days, null);
  assert.equal(data.rate_slabs[1].tenure_min_days, null);
});

test('Sprint 010 C: slabs with tenure_max_days=0 are NOT touched (would create min>max)', () => {
  const data = {
    rate_slabs: [
      // surat-peoples-style malformed special-scheme slab; we don't touch
      // anything where max_days is itself <=0 since correcting min upward
      // would create min > max. The slab is malformed; let downstream gates flag it.
      { tenure_text: 'Vasudhara scheme (85 Months term deposit)', tenure_min_days: 0, tenure_max_days: 0, rate_general_pct: 7.0 },
    ],
  };
  const r = normalizeRatesObject(data);
  assert.equal(data.rate_slabs[0].tenure_min_days, 0);
  assert.equal(data.rate_slabs[0].tenure_max_days, 0);
});

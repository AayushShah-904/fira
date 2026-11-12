'use strict';

/**
 * Tests for scripts/utils/validate-rates.js#filterInvalidSlabs — Sprint 004
 * cohort #3 Phase C1+C3 (tight validation-band filter used by commit_rates).
 *
 * Distinct from lib/rate-bounds.js (loose pack-builder sanity band):
 *   - filterInvalidSlabs uses VARIANT_BOUNDS — the same tight band that
 *     drives validateSlabs warnings — so floor/ceiling violations are
 *     dropped at commit time rather than warned about and shipped.
 *   - It also enforces RBI variant-tenure invariants (FCNR/GIFT 365d min)
 *     and dedupes (tenure_text, general, senior, currency) tuples.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterInvalidSlabs, validateSlabs } = require('../../../scripts/utils/validate-rates');

test('filterInvalidSlabs: empty / non-array input returns zero counts', () => {
  const r = filterInvalidSlabs([], 'regular');
  assert.deepEqual(r.filteredSlabs, []);
  assert.equal(r.droppedBelowFloor, 0);
  assert.equal(r.droppedAboveCeiling, 0);
  assert.equal(r.droppedDuplicate, 0);
  assert.equal(r.droppedTenureOutOfBand, 0);

  const r2 = filterInvalidSlabs(null, 'regular');
  assert.deepEqual(r2.filteredSlabs, []);
});

test('filterInvalidSlabs: drops Kotak-class below-floor slabs (regular variant)', () => {
  // Regular floor is 1.5%. Kotak cohort #3 emitted 0.5-1% slabs.
  const slabs = [
    { tenure_text: '180-364d', rate_general_pct: 0.5 },
    { tenure_text: '365+',    rate_general_pct: 1.0 },
    { tenure_text: '7d',      rate_general_pct: 3.5 },  // valid
  ];
  const r = filterInvalidSlabs(slabs, 'regular');
  assert.equal(r.droppedBelowFloor, 2);
  assert.equal(r.filteredSlabs.length, 1);
  assert.equal(r.filteredSlabs[0].rate_general_pct, 3.5);
});

test('filterInvalidSlabs: above-ceiling slabs are KEPT (warnings only, not drops)', () => {
  // The tight ceiling (9.5% regular) is for warnings, not drops. Garbage
  // extraction values (>15%) are filtered out at pack-build time by the
  // loose sanity band in lib/rate-bounds.js — by design, this layer only
  // drops below-floor noise.
  const slabs = [
    { tenure_text: '1y', rate_general_pct: 12.5 },  // above ceiling but plausible
    { tenure_text: '2y', rate_general_pct: 7.0 },   // in band
  ];
  const r = filterInvalidSlabs(slabs, 'regular');
  assert.equal(r.droppedAboveCeiling, 0);
  assert.equal(r.filteredSlabs.length, 2);
});

test('filterInvalidSlabs: dedupes identical (tenure_text, general, senior, currency) tuples', () => {
  // Kotak cohort #3 emitted 2 pairs of identical slabs.
  const slabs = [
    { tenure_text: 'Greater than 180 days', rate_general_pct: 5.0, rate_senior_pct: null },
    { tenure_text: 'Greater than 180 days', rate_general_pct: 5.0, rate_senior_pct: null },
    { tenure_text: 'Greater than 365 days', rate_general_pct: 6.0, rate_senior_pct: null },
    { tenure_text: 'Greater than 365 days', rate_general_pct: 6.0, rate_senior_pct: null },
  ];
  const r = filterInvalidSlabs(slabs, 'regular');
  assert.equal(r.droppedDuplicate, 2);
  assert.equal(r.filteredSlabs.length, 2);
});

test('filterInvalidSlabs: drops FCNR slabs with tenure entirely below 365d (RBI minimum)', () => {
  // ICICI cohort #3 emitted Call Deposit short-tenor rows (0-30d, 30-180d,
  // 180-365d) under FCNR variant. RBI rule: FCNR min tenure is 1 year.
  const slabs = [
    { tenure_text: 'Overnight to 30d', tenure_min_days: 0,    tenure_max_days: 30,   rate_general_pct: 0.75, currency: 'USD' },
    { tenure_text: '30d to <6mo',      tenure_min_days: 30,   tenure_max_days: 180,  rate_general_pct: 0.75, currency: 'USD' },
    { tenure_text: '6mo to <1y',       tenure_min_days: 180,  tenure_max_days: 365,  rate_general_pct: 1.00, currency: 'USD' },
    { tenure_text: '12mo to <24mo',    tenure_min_days: 365,  tenure_max_days: 730,  rate_general_pct: 3.85, currency: 'USD' },
    { tenure_text: '>=24mo to <36mo',  tenure_min_days: 730,  tenure_max_days: 1095, rate_general_pct: 3.35, currency: 'USD' },
  ];
  const r = filterInvalidSlabs(slabs, 'fcnr');
  // The 6mo-1y slab has tenure_max_days exactly at 365 (border). The filter
  // drops slabs whose tenure_max < min — `< 365` drops 0-30d (max=30) and
  // 30-180d (max=180). 6mo-1y (max=365) is at the boundary and KEPT.
  assert.equal(r.droppedTenureOutOfBand, 2);
  assert.equal(r.filteredSlabs.length, 3);
});

test('filterInvalidSlabs: GIFT tenure floor is 7 days, not 365 (offshore IBU short tenors)', () => {
  // GIFT-City IBU deposits are OFFSHORE — RBL-ibu's GIFT page publishes 7-day,
  // 1-month, etc. FCY FDs that the old 365d floor wrongly dropped. Only rows
  // entirely below the 7-day floor (garbage) are dropped.
  const slabs = [
    { tenure_text: '3d',      tenure_min_days: 1,   tenure_max_days: 3,   rate_general_pct: 4.0, currency: 'USD' }, // garbage: max<7 → dropped
    { tenure_text: '7-30d',   tenure_min_days: 7,   tenure_max_days: 30,  rate_general_pct: 4.1, currency: 'USD' }, // short-tenor → KEPT
    { tenure_text: '30-180d', tenure_min_days: 30,  tenure_max_days: 180, rate_general_pct: 4.3, currency: 'USD' }, // short-tenor → KEPT
    { tenure_text: '>1y',     tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 4.5, currency: 'USD' }, // long → KEPT
  ];
  const r = filterInvalidSlabs(slabs, 'gift');
  assert.equal(r.droppedTenureOutOfBand, 1, 'only the sub-7-day garbage row is dropped');
  assert.equal(r.filteredSlabs.length, 3, 'both short-tenor slabs plus the >1y slab are kept');
  const kept = r.filteredSlabs.map((s) => s.tenure_text).sort();
  assert.deepEqual(kept, ['30-180d', '7-30d', '>1y']);
});

test('filterInvalidSlabs: FCNR short-tenor STILL dropped at 365d (RBI + Call-Deposit guard unchanged)', () => {
  // Regression guard: the gift relaxation must NOT leak to fcnr. Domestic
  // FCNR(B) keeps min 365 — short-tenor slabs (from a conflated Call Deposit
  // table) must still be filtered out under the fcnr variant.
  const slabs = [
    { tenure_text: '7-30d',   tenure_min_days: 7,   tenure_max_days: 30,  rate_general_pct: 4.1, currency: 'USD' }, // dropped (max<365)
    { tenure_text: '30-180d', tenure_min_days: 30,  tenure_max_days: 180, rate_general_pct: 4.3, currency: 'USD' }, // dropped (max<365)
    { tenure_text: '>1y',     tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 4.5, currency: 'USD' }, // KEPT
  ];
  const r = filterInvalidSlabs(slabs, 'fcnr');
  assert.equal(r.droppedTenureOutOfBand, 2, 'both short-tenor FCNR slabs dropped');
  assert.equal(r.filteredSlabs.length, 1);
  assert.equal(r.filteredSlabs[0].tenure_text, '>1y');
});

test('filterInvalidSlabs: regular variant has no tenure floor (short FDs allowed)', () => {
  const slabs = [
    { tenure_text: '7-14d', tenure_min_days: 7,  tenure_max_days: 14,  rate_general_pct: 3.5 },
    { tenure_text: '1y',    tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.5 },
  ];
  const r = filterInvalidSlabs(slabs, 'regular');
  assert.equal(r.droppedTenureOutOfBand, 0);
  assert.equal(r.filteredSlabs.length, 2);
});

// --- Currency-aware FCNR/GIFT floor (Sprint 011, 2026-07-07) -------------
// Axis publishes real JPY FCNR(B) rates at 0.00–0.01%; the flat fcnr floor
// (0.5%) dropped ALL JPY slabs ("collapsed FCNR currencies" error class).
// LOW_YIELD_CURRENCIES (JPY/CHF → { min: 0, max: 3.0 }) overrides the
// variant band per-slab by currency; other currencies keep the fcnr band.

test('filterInvalidSlabs: keeps near-zero JPY FCNR slabs (Axis 0.00/0.01%)', () => {
  const slabs = [
    { tenure_text: '1 year < 2 years',  tenure_min_days: 365,  tenure_max_days: 729,  rate_general_pct: 0.01, currency: 'JPY' },
    { tenure_text: '4 years < 5 years', tenure_min_days: 1460, tenure_max_days: 1824, rate_general_pct: 0.0,  currency: 'JPY' },
    { tenure_text: '1 year < 2 years',  tenure_min_days: 365,  tenure_max_days: 729,  rate_general_pct: 4.5,  currency: 'USD' },
  ];
  const r = filterInvalidSlabs(slabs, 'fcnr');
  assert.equal(r.droppedBelowFloor, 0);
  assert.equal(r.filteredSlabs.length, 3);
});

test('filterInvalidSlabs: still drops NEGATIVE JPY FCNR rates (floor is 0, not open-ended)', () => {
  const slabs = [
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: -0.1, currency: 'JPY' },
    { tenure_text: '2y', tenure_min_days: 730, tenure_max_days: 1094, rate_general_pct: 0.0, currency: 'JPY' },
  ];
  const r = filterInvalidSlabs(slabs, 'fcnr');
  assert.equal(r.droppedBelowFloor, 1);
  assert.equal(r.filteredSlabs.length, 1);
  assert.equal(r.filteredSlabs[0].rate_general_pct, 0.0);
});

test('filterInvalidSlabs: non-low-yield currencies keep the default fcnr floor (USD 0.3 dropped)', () => {
  const slabs = [
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: 0.3, currency: 'USD' },
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: 5.1, currency: 'USD' },
  ];
  const r = filterInvalidSlabs(slabs, 'fcnr');
  assert.equal(r.droppedBelowFloor, 1);
  assert.equal(r.filteredSlabs.length, 1);
  assert.equal(r.filteredSlabs[0].rate_general_pct, 5.1);
});

test('filterInvalidSlabs: currency override does not apply to regular variant', () => {
  // A regular-variant slab that happens to carry currency JPY (should not
  // happen, but the override must be scoped to fcnr/gift) still uses the
  // regular 1.5% floor.
  const slabs = [
    { tenure_text: '1y', rate_general_pct: 0.01, currency: 'JPY' },
    { tenure_text: '1y', rate_general_pct: 6.5 },
  ];
  const r = filterInvalidSlabs(slabs, 'regular');
  assert.equal(r.droppedBelowFloor, 1);
  assert.equal(r.filteredSlabs.length, 1);
  assert.equal(r.filteredSlabs[0].rate_general_pct, 6.5);
});

test('validateSlabs: no below-floor warning for near-zero JPY FCNR, but USD below fcnr floor still warns', () => {
  const slabs = [
    { tenure_text: '1 year < 2 years', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: 0.01, currency: 'JPY' },
    { tenure_text: '1 year < 2 years', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: 0.3,  currency: 'USD' },
  ];
  const r = validateSlabs(slabs, 'fcnr');
  const belowFloor = r.warnings.filter((w) => w.includes('below floor'));
  assert.equal(belowFloor.length, 1);
  assert.match(belowFloor[0], /USD|0\.3/);
});

test('validateSlabs: negative JPY FCNR rate warns below floor (0%)', () => {
  const slabs = [
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: -0.1, currency: 'JPY' },
  ];
  const r = validateSlabs(slabs, 'fcnr');
  assert.equal(r.warnings.filter((w) => w.includes('below floor (0%)')).length, 1);
});

test('filterInvalidSlabs: combines below-floor + duplicate drops in one pass', () => {
  const slabs = [
    { tenure_text: 'A', rate_general_pct: 0.1 },                    // below floor
    { tenure_text: 'B', rate_general_pct: 50 },                     // above ceiling — kept (warned elsewhere)
    { tenure_text: 'C', rate_general_pct: 6.0 },                    // good
    { tenure_text: 'C', rate_general_pct: 6.0 },                    // dup of C
  ];
  const r = filterInvalidSlabs(slabs, 'regular');
  assert.equal(r.droppedBelowFloor, 1);
  assert.equal(r.droppedAboveCeiling, 0);  // above-ceiling is no longer a drop
  assert.equal(r.droppedDuplicate, 1);
  // C (kept once) + B (kept) = 2 slabs survive.
  assert.equal(r.filteredSlabs.length, 2);
});

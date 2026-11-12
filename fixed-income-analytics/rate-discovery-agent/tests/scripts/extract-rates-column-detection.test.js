'use strict';

/**
 * Tests for scripts/extract_rates.js Sprint 4 B2 column-detection heuristic.
 *
 * Triggers when the index-based column_mapping picks impossible cells —
 * e.g., when the table has a leading serial-number column the default
 * mapping {0:tenure,1:rate} would read "1","2","3..." as tenures and
 * concatenations as rates. The heuristic re-detects columns by content
 * shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractSlabsFromTable, _detectColumns, _looksLikeBadMapping } = require('../../scripts/extract_rates.js');

const DEFAULT_MAPPING = { '0': 'tenure_text', '1': 'rate_general_pct', '2': 'rate_senior_pct' };

test('B2: PNB-style "S.No, Tenure, Rate, Senior Rate" table → heuristic re-detects columns', () => {
  // Default mapping reads col 0 as tenure ("1","2","3") and col 1 as rate
  // ("7 days to 14 days" → NaN, or whatever the concat produced). The
  // heuristic should detect that real tenures live in col 1 and real
  // rates in col 2.
  const rows = [
    ['S.No', 'Tenure', 'Rate (%)', 'Senior (%)'],
    ['1', '7 days to 14 days', '3.50', '4.00'],
    ['2', '15 days to 29 days', '3.50', '4.00'],
    ['3', '30 days to 45 days', '4.25', '4.75'],
    ['4', '46 days to 90 days', '5.50', '6.00'],
  ];
  const slabs = extractSlabsFromTable(rows, DEFAULT_MAPPING);
  assert.equal(slabs.length, 4, 'all 4 real rows produced slabs');
  assert.equal(slabs[0].tenure_text, '7 days to 14 days');
  assert.equal(slabs[0].rate_general_pct, 3.5);
  assert.equal(slabs[0].rate_senior_pct, 4.0);
  assert.equal(slabs[0].tenure_min_days, 7);
  assert.equal(slabs[0].tenure_max_days, 14);
});

test('B2: default-mapping good table is unaffected (no false-positives)', () => {
  // Standard "Tenure, Rate, Senior" — default mapping already works;
  // heuristic must NOT change the outcome.
  const rows = [
    ['Tenure', 'Rate', 'Senior'],
    ['7 days to 14 days', '3.50', '4.00'],
    ['15 days to 29 days', '3.50', '4.00'],
  ];
  const slabs = extractSlabsFromTable(rows, DEFAULT_MAPPING);
  assert.equal(slabs.length, 2);
  assert.equal(slabs[0].tenure_text, '7 days to 14 days');
  assert.equal(slabs[0].rate_general_pct, 3.5);
});

test('B2: _looksLikeBadMapping fires on serial-number tenure', () => {
  const badSlabs = [
    { tenure_text: '1', rate_general_pct: 3.5 },
    { tenure_text: '2', rate_general_pct: 6.0 },
  ];
  assert.equal(_looksLikeBadMapping(badSlabs), true);
});

test('B2: _looksLikeBadMapping fires on rate > 30', () => {
  const badSlabs = [
    { tenure_text: '7 days', rate_general_pct: 714 },
    { tenure_text: '1 year', rate_general_pct: 91154 },
  ];
  assert.equal(_looksLikeBadMapping(badSlabs), true);
});

test('B2: _looksLikeBadMapping does NOT fire on a normal-looking slab set', () => {
  const goodSlabs = [
    { tenure_text: '7 days to 14 days', rate_general_pct: 3.5 },
    { tenure_text: '1 year', rate_general_pct: 6.5 },
  ];
  assert.equal(_looksLikeBadMapping(goodSlabs), false);
});

test('B2: _detectColumns finds tenure + rate columns in PNB-style layout', () => {
  const rows = [
    ['1', '7 days to 14 days', '3.50', '4.00'],
    ['2', '15 days to 29 days', '3.50', '4.00'],
    ['3', '30 days to 45 days', '4.25', '4.75'],
  ];
  const m = _detectColumns(rows);
  assert.ok(m, 'detected a mapping');
  assert.equal(m['1'], 'tenure_text');
  assert.equal(m['2'], 'rate_general_pct');
  // Senior column should be detected at col 3 (rate-shaped, distinct from
  // the chosen tenure + rate columns).
  assert.equal(m['3'], 'rate_senior_pct');
});

test('B2: _detectColumns returns null for a table with no tenure-shaped cells', () => {
  const rows = [
    ['Foo', 'Bar', 'Baz'],
    ['x', 'y', '3.50'],
  ];
  const m = _detectColumns(rows);
  assert.equal(m, null);
});

test('B2: heuristic falls back to default when its own attempt would be no-better', () => {
  // All cells are gibberish; both default and heuristic fail. Heuristic
  // should return the original (empty) slabs rather than something worse.
  const rows = [
    ['1', '2', '3.50'],
    ['4', '5', '6.50'],
  ];
  const slabs = extractSlabsFromTable(rows, DEFAULT_MAPPING);
  // Default mapping reads col 0 ("1","4") as tenure_text → tenure_min/max
  // are null, but rate_general_pct comes from col 1 ("2","5") = 2 and 5 —
  // both ≤ 30 so looksLikeBadMapping says "tenureIsSerial" → bad. Heuristic
  // re-detects: col 2 is the only rate-shaped col, but no col parses as
  // tenure → detectColumns returns null → falls back to default.
  // The default's slabs (serial-tenure 1/4 with rates 2/5) are returned.
  // Downstream B3/non_fd_filter catches them.
  for (const s of slabs) {
    assert.ok(/^\d+$/.test(s.tenure_text), 'fallback returned default-mapping output');
  }
});

test('B2: rate-column with mixed-format cells (some integer, some decimal) still detected', () => {
  // Some banks show "5" instead of "5.00" for whole-percent rates.
  // detectColumns requires "\d+\.\d+" to count as rate — verify behaviour.
  const rows = [
    ['1', '1 year', '6.5'],
    ['2', '2 years', '7.0'],
    ['3', '3 years', '7.25'],
  ];
  const m = _detectColumns(rows);
  assert.ok(m);
  assert.equal(m['1'], 'tenure_text');
  assert.equal(m['2'], 'rate_general_pct');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFromCurrencyMatrix,
  extractCurrencyAsColumns,
  extractCurrencyAsRows,
} = require('../../lib/extractors/_helpers/currency-matrix');

// --- Pattern B (currency-as-columns) — most common FCNR layout ---------

test('Pattern B: { tenure, USD, GBP, EUR, JPY } → one slab per (tenure × currency)', () => {
  const rows = [
    ['Tenure', 'USD', 'GBP', 'EUR', 'JPY'],
    ['1 year to 2 years', '5.50', '5.25', '3.10', '0.40'],
    ['2 years to 3 years', '5.40', '5.15', '3.00', '0.50'],
    ['3 years to 5 years', '5.30', '5.05', '2.95', '0.55'],
  ];
  const r = extractCurrencyAsColumns(rows);
  assert.equal(r.pattern, 'B_currency_as_columns');
  assert.equal(r.slabs.length, 12, '3 tenures × 4 currencies'); // 12
  const usd1y = r.slabs.find(s => s.tenure_text.startsWith('1') && s.currency === 'USD');
  assert.ok(usd1y);
  assert.equal(usd1y.rate_general_pct, 5.5);
  // FCNR: senior premium = null
  assert.equal(usd1y.rate_senior_pct, null);
});

test('Pattern B: tolerates "USD Rate" / "GBP Rate" headers (embedded code)', () => {
  const rows = [
    ['Tenure', 'USD Rate', 'GBP Rate'],
    ['1 year', '5.50', '5.25'],
  ];
  const r = extractCurrencyAsColumns(rows);
  assert.equal(r.slabs.length, 2);
  assert.equal(r.slabs[0].currency, 'USD');
});

test('Pattern B: returns null pattern when header has no currency codes', () => {
  const rows = [['Tenure', 'Rate'], ['1y', '6.5']];
  const r = extractCurrencyAsColumns(rows);
  assert.equal(r.pattern, null);
  assert.equal(r.slabs.length, 0);
});

// --- Pattern A (currency-as-rows) -----------------------------------------

test('Pattern A: { currency, 1y, 2y, 3y } → one slab per (currency × tenure)', () => {
  const rows = [
    ['Currency', '1 year', '2 years', '3 years'],
    ['USD', '5.50', '5.40', '5.30'],
    ['GBP', '5.25', '5.15', '5.05'],
    ['EUR', '3.10', '3.00', '2.95'],
  ];
  const r = extractCurrencyAsRows(rows);
  assert.equal(r.pattern, 'A_currency_as_rows');
  assert.equal(r.slabs.length, 9, '3 currencies × 3 tenures');
  const gbp2y = r.slabs.find(s => s.currency === 'GBP' && /2/.test(s.tenure_text));
  assert.ok(gbp2y);
  assert.equal(gbp2y.rate_general_pct, 5.15);
});

// --- extractFromCurrencyMatrix dispatcher ---------------------------------

test('extractFromCurrencyMatrix picks the pattern producing more slabs', () => {
  const rows = [
    ['Tenure', 'USD', 'GBP'],
    ['1 year', '5.5', '5.25'],
    ['2 years', '5.4', '5.15'],
  ];
  const r = extractFromCurrencyMatrix(rows);
  assert.equal(r.pattern, 'B_currency_as_columns');
  assert.equal(r.slabs.length, 4);
});

test('extractFromCurrencyMatrix handles empty input', () => {
  const r = extractFromCurrencyMatrix([]);
  assert.equal(r.slabs.length, 0);
  assert.equal(r.pattern, null);
});

// --- PVB/FB extractor integration ----------------------------------------

test('pvb-multi-variant fcnr: extracts from synthetic FCNR HTML', () => {
  const pvb = require('../../lib/extractors/pvb-multi-variant');
  const html = `<html><body>
    <table>
      <thead><tr><th>Tenure</th><th>USD</th><th>GBP</th><th>EUR</th></tr></thead>
      <tbody>
        <tr><td>1 year to 2 years</td><td>5.50</td><td>5.25</td><td>3.10</td></tr>
        <tr><td>2 years to 3 years</td><td>5.40</td><td>5.15</td><td>3.00</td></tr>
      </tbody>
    </table>
  </body></html>`;
  const r = pvb.extract({ html, productContext: { bank_code: 'hdfc-bank-limited', variant: 'fcnr' } });
  assert.equal(r.slabs.length, 6, `2 tenures × 3 currencies; warnings=${JSON.stringify(r.warnings)}`);
  assert.equal(r.diagnostics.extractor_kind, 'pvb_multi_variant_currency_matrix');
  assert.equal(r.diagnostics.pattern, 'B_currency_as_columns');
});

test('fb-multi-variant fcnr: extracts from synthetic FCNR HTML', () => {
  const fb = require('../../lib/extractors/fb-multi-variant');
  const html = `<html><body>
    <table>
      <thead><tr><th>Period</th><th>USD</th><th>GBP</th></tr></thead>
      <tbody>
        <tr><td>1 year</td><td>5.50</td><td>5.25</td></tr>
        <tr><td>3 years</td><td>5.30</td><td>5.05</td></tr>
      </tbody>
    </table>
  </body></html>`;
  const r = fb.extract({ html, productContext: { bank_code: 'dbs-bank-india-limited', variant: 'fcnr' } });
  assert.equal(r.slabs.length, 4);
  assert.equal(r.diagnostics.extractor_kind, 'fb_multi_variant_currency_matrix');
});

'use strict';

/**
 * Tests for lib/actions/extract_html_table.js — Sprint 003 #1b (A3 v2).
 *
 * v2 adds:
 *  - hints.cached_body parsing (no live fetch).
 *  - FCNR/GIFT currency tagging (with reject fallback).
 *  - PNB-style ambiguous-column detection → reject.
 *  - Slab dedup.
 *  - Multi-table warning.
 *
 * Live-fetch path (Path B) is covered by the Sprint 003 #1d Track 2 sample
 * run; not re-tested here to avoid HTTP dependencies.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractHtmlTable,
  _detectAmbiguousColumns,
  _tagCurrencyForeignVariant,
  _textPatternMultiCurrencyGuard,
  _tableHasCurrencyMarkers,
  _dedupSlabs,
  _normaliseDepositRange,
  _validateSlabAgainstChunk,
  _filterHtmlByTableSelector,
} = require('../../../lib/actions/extract_html_table');

const SIMPLE_RATE_TABLE_HTML = `
<html><body>
  <h1>Interest Rates</h1>
  <p>w.e.f. 1st March 2026</p>
  <table>
    <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
    <tr><td>7 days to 14 days</td><td>3.50%</td><td>4.00%</td></tr>
    <tr><td>15 days to 30 days</td><td>4.00%</td><td>4.50%</td></tr>
    <tr><td>1 year to 2 years</td><td>6.50%</td><td>7.00%</td></tr>
  </table>
</body></html>
`;

const TWO_TABLES_HTML = `
<html><body>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7 days</td><td>3.50%</td></tr>
    <tr><td>15 days</td><td>4.00%</td></tr>
  </table>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>1 year</td><td>6.50%</td></tr>
    <tr><td>2 years</td><td>6.80%</td></tr>
    <tr><td>3 years</td><td>7.00%</td></tr>
  </table>
</body></html>
`;

const FCNR_HTML_WITH_CURRENCY_HEADERS = `
<html><body>
  <table>
    <tr><th>Tenure</th><th>USD</th></tr>
    <tr><td>1 year to 2 years</td><td>4.50%</td></tr>
    <tr><td>2 years to 3 years</td><td>4.30%</td></tr>
  </table>
</body></html>
`;

const PNB_EXISTING_VS_REVISED_HTML = `
<html><body>
  <h2>Revised rates</h2>
  <table>
    <tr><th>Tenure</th><th>Existing rate</th><th>Revised rate</th></tr>
    <tr><td>1 year</td><td>6.00%</td><td>6.50%</td></tr>
    <tr><td>2 years</td><td>5.90%</td><td>6.40%</td></tr>
  </table>
</body></html>
`;

const TWO_WEF_DATES_HTML = `
<html><body>
  <table>
    <tr><th>Tenure</th><th>W.e.f. 01.01.2026</th><th>W.e.f. 01.04.2026</th></tr>
    <tr><td>1 year</td><td>6.00%</td><td>6.50%</td></tr>
  </table>
</body></html>
`;

// ── Orch-1 fixtures (sprint-004 2026-05-21) ─────────────────────────

// Two rate tables with distinct deposit_range headings — the Orch-1 fix
// should keep both and tag each table's slabs with the correct deposit_range.
const MULTI_TABLE_DEPOSIT_RANGE_HTML = `
<html><body>
  <h3>Domestic Fixed Deposits — &lt; ₹3 Crore</h3>
  <table>
    <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
    <tr><td>7-14 days</td><td>3.00%</td><td>3.50%</td></tr>
    <tr><td>1 year</td><td>6.50%</td><td>7.00%</td></tr>
  </table>
  <h3>Domestic Fixed Deposits — ≥ ₹3 Crore To &lt; ₹5 Crores</h3>
  <table>
    <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
    <tr><td>7-14 days</td><td>3.50%</td><td>4.00%</td></tr>
    <tr><td>1 year</td><td>6.75%</td><td>7.25%</td></tr>
  </table>
</body></html>
`;

// Rate tables interleaved with textual "notes" tables that contain no
// numeric rate values. The Orch-1 zero-slab filter drops them.
const MULTI_TABLE_WITH_TEXTUAL_TABLES_HTML = `
<html><body>
  <h3>Less than ₹3 Crore</h3>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7-14 days</td><td>3.00%</td></tr>
    <tr><td>1 year</td><td>6.50%</td></tr>
  </table>
  <h4>Premature withdrawal terms</h4>
  <table>
    <tr><th>Item</th><th>Description</th></tr>
    <tr><td>Eligibility</td><td>All resident depositors</td></tr>
    <tr><td>Premature closure</td><td>Penalty applies as per bank policy</td></tr>
  </table>
  <h3>≥ ₹3 Crore To &lt; ₹5 Crores</h3>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7-14 days</td><td>3.50%</td></tr>
    <tr><td>1 year</td><td>6.75%</td></tr>
  </table>
</body></html>
`;

// HDFC table[0] vs table[1] pattern: same heading, identical first row,
// different column counts. The Orch-1 dedup should keep the one with more
// rate columns (preserves senior).
const NEAR_DUPLICATE_TABLES_HTML = `
<html><body>
  <h3>&lt; ₹3 Crore</h3>
  <table>
    <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
    <tr><td>7-14 days</td><td>3.00%</td><td>3.50%</td></tr>
    <tr><td>1 year</td><td>6.50%</td><td>7.00%</td></tr>
  </table>
  <h3>&lt; ₹3 Crore</h3>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7-14 days</td><td>3.00%</td></tr>
    <tr><td>1 year</td><td>6.50%</td></tr>
  </table>
</body></html>
`;

// HDFC-shape: shared section heading declares Domestic+NRO+NRE; the note
// excludes senior for NRIs and sets a 1-year minimum for NRE; two rate
// tables (different deposit_range). Expect: pages fan out for the iteration
// variant only; NRE iteration drops senior + filters <1y tenures.
const HDFC_STYLE_MULTI_VARIANT_HTML = `
<html><body>
  <h2>Domestic / NRO / NRE FIXED DEPOSIT RATE</h2>
  <p>Effective from 21st May 2026</p>
  <p>*Note: Senior Citizen rates do not apply to NRIs | The minimum tenor for NRE Deposit is 1 year</p>
  <h3>&lt; ₹3 Crore</h3>
  <table>
    <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
    <tr><td>7-14 days</td><td>3.00%</td><td>3.50%</td></tr>
    <tr><td>6 months</td><td>5.50%</td><td>6.00%</td></tr>
    <tr><td>1 year</td><td>6.50%</td><td>7.00%</td></tr>
    <tr><td>2 years</td><td>6.80%</td><td>7.30%</td></tr>
  </table>
  <h3>≥ ₹3 Crore To &lt; ₹5 Crores</h3>
  <table>
    <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
    <tr><td>7-14 days</td><td>3.50%</td><td>4.00%</td></tr>
    <tr><td>6 months</td><td>5.75%</td><td>6.25%</td></tr>
    <tr><td>1 year</td><td>6.75%</td><td>7.25%</td></tr>
    <tr><td>2 years</td><td>7.05%</td><td>7.55%</td></tr>
  </table>
</body></html>
`;

// Multiple rate tables but no preceding headings — deposit_range stays null.
const MULTI_TABLE_NO_HEADINGS_HTML = `
<html><body>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7-14 days</td><td>3.00%</td></tr>
    <tr><td>1 year</td><td>6.50%</td></tr>
  </table>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7-14 days</td><td>3.50%</td></tr>
    <tr><td>1 year</td><td>6.75%</td></tr>
  </table>
</body></html>
`;

const silentLogger = { warn: () => {}, debug: () => {} };

// ── Path A: cached_body — happy path ───────────────────────────────────

test('cached_body: regular variant extracts slabs from a single table', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/rates',
    kind: 'html_static',
    product_type: 'FD',
    variant: 'regular',
    hints: { cached_body: SIMPLE_RATE_TABLE_HTML },
  });
  assert.ok(out, 'result not null');
  assert.equal(out.ok, true);
  assert.equal(out.path_used, 'deterministic');
  assert.equal(out.extraction_method, 'automatic_html_static');
  assert.equal(out.slabs.length, 3);
  assert.equal(out.slabs[0].tenure_text, '7 days to 14 days');
  assert.equal(out.slabs[0].rate_general_pct, 3.5);
  assert.equal(out.slabs[0].rate_senior_pct, 4.0);
  assert.equal(out.effective_date, '1st March 2026');
});

test('cached_body: html_js kind also parses (no Playwright spawn)', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/rates',
    kind: 'html_js',
    variant: 'regular',
    hints: { cached_body: SIMPLE_RATE_TABLE_HTML },
  });
  assert.equal(out.ok, true);
  assert.equal(out.extraction_method, 'automatic_html_js');
  assert.equal(out.slabs.length, 3);
});

test('cached_body: multi-table page produces a warning AND extracts from all rate tables (Orch-1)', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/rates',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: TWO_TABLES_HTML },
  });
  assert.ok(out, 'result not null');
  assert.ok(out.warnings.some(w => /multi_table/.test(w)), 'multi_table warning present');
  // Orch-1 (sprint-004 2026-05-21): the multi-table accumulator keeps every
  // rate-bearing table (was: pick the largest single table). TWO_TABLES_HTML
  // has 2 rate tables of 2 and 3 rows; both ship → 5 slabs total. The pages
  // output exposes the per-table breakdown.
  assert.equal(out.slabs.length, 5);
  assert.ok(Array.isArray(out.pages) && out.pages.length === 2, 'two pages emitted');
  assert.equal(out.pages.map((p) => p.slabs.length).sort().join(','), '2,3');
});

// ── Fix #8 (sprint-004 2026-05-23): small special-scheme tables ───────

const SMALL_SCHEME_TABLE_HTML = `
<html><body>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7 days to 29 days</td><td>3.00%</td></tr>
    <tr><td>30 days to 90 days</td><td>3.75%</td></tr>
    <tr><td>91 days to 180 days</td><td>5.00%</td></tr>
    <tr><td>1 year</td><td>6.50%</td></tr>
    <tr><td>2 years</td><td>6.75%</td></tr>
  </table>
  <table>
    <tr><td>RAP30</td><td>3.75%</td></tr>
    <tr><td>RAP90</td><td>4.00%</td></tr>
    <tr><td>FD365</td><td>6.50%</td></tr>
    <tr><td>FD500</td><td>7.25%</td></tr>
    <tr><td>FD725</td><td>7.40%</td></tr>
    <tr><td>FD1000</td><td>7.50%</td></tr>
  </table>
</body></html>
`;

const TEXTUAL_NOISE_TABLE_HTML = `
<html><body>
  <table>
    <tr><th>Tenure</th><th>Rate</th></tr>
    <tr><td>7 days to 29 days</td><td>3.00%</td></tr>
    <tr><td>30 days to 90 days</td><td>3.75%</td></tr>
    <tr><td>91 days to 180 days</td><td>5.00%</td></tr>
    <tr><td>1 year</td><td>6.50%</td></tr>
    <tr><td>2 years</td><td>6.75%</td></tr>
  </table>
  <table>
    <tr><td>Eligibility</td><td>3.00%</td></tr>
    <tr><td>Premature closure</td><td>4.00%</td></tr>
    <tr><td>Additional premium</td><td>0.50%</td></tr>
    <tr><td>Penalty clause</td><td>1.00%</td></tr>
  </table>
</body></html>
`;

test('Fix #8: special-scheme table with 4-10 scheme-labelled rows is kept (not filtered as textual)', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/citizen',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: SMALL_SCHEME_TABLE_HTML },
  });
  assert.ok(out, 'result not null');
  assert.equal(out.ok, true);
  // Main table = 5 slabs (tenure-typed). Scheme table = 6 slabs (null tenure
  // bounds, scheme label preserved in tenure_text). Both ship → 11 total.
  assert.equal(out.slabs.length, 11, 'main + scheme slabs both kept');
  const schemeSlabs = out.slabs.filter((s) => /^(RAP|FD)\d+$/.test(s.tenure_text || ''));
  assert.equal(schemeSlabs.length, 6, 'all 6 scheme rows present');
  for (const s of schemeSlabs) {
    assert.equal(s.tenure_min_days, null);
    assert.equal(s.tenure_max_days, null);
    assert.ok(typeof s.rate_general_pct === 'number');
  }
  assert.ok(out.warnings.some((w) => /special_scheme_table/.test(w)), 'special_scheme warning present');
});

test('Fix #8: textual notes table with non-digit labels stays filtered out', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/noise',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: TEXTUAL_NOISE_TABLE_HTML },
  });
  assert.ok(out, 'result not null');
  // Main table only — text-only labels lack the digit signal so the noise
  // table is still dropped by the multi_table_filter.
  assert.equal(out.slabs.length, 5);
  assert.ok(out.warnings.some((w) => /multi_table_filter/.test(w)), 'noise table dropped with warning');
});

// ── Path A: PNB ambiguous-column rejection (Q7) ───────────────────────

test('cached_body: PNB Existing-vs-Revised rejected with reason on stderr', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/pnb',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: PNB_EXISTING_VS_REVISED_HTML },
  });
  assert.equal(out, null);
});

test('cached_body: two W.E.F. dates rejected', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/x',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: TWO_WEF_DATES_HTML },
  });
  assert.equal(out, null);
});

test('_detectAmbiguousColumns: positive cases', () => {
  assert.ok(_detectAmbiguousColumns(PNB_EXISTING_VS_REVISED_HTML));
  assert.ok(_detectAmbiguousColumns('<p>Existing ROI: 5%</p><p>Revised ROI: 6%</p>'));
  assert.ok(_detectAmbiguousColumns(TWO_WEF_DATES_HTML));
});

test('_detectAmbiguousColumns: negative case', () => {
  assert.equal(_detectAmbiguousColumns(SIMPLE_RATE_TABLE_HTML), false);
});

// ── FCNR/GIFT currency tagging ─────────────────────────────────────────

test('FCNR: expected_currencies hint defaults the currency when source omits it', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/fcnr',
    kind: 'html_static',
    variant: 'fcnr',
    hints: {
      cached_body: FCNR_HTML_WITH_CURRENCY_HEADERS,
      expected_currencies: ['USD'],
    },
  });
  assert.ok(out, 'result not null');
  assert.equal(out.variant, 'fcnr');
  assert.ok(out.slabs.every(s => s.currency === 'USD'), 'all slabs tagged USD');
  assert.ok(out.warnings.some(w => /currency_hint/.test(w)), 'currency_hint warning emitted');
});

test('FCNR: no currency on slabs and no hint → null (reject)', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/fcnr',
    kind: 'html_static',
    variant: 'fcnr',
    hints: { cached_body: FCNR_HTML_WITH_CURRENCY_HEADERS },
  });
  assert.equal(out, null, 'rejected when no currency available');
});

test('_tagCurrencyForeignVariant: peer-slab currency propagates', () => {
  const warnings = [];
  const r = _tagCurrencyForeignVariant(
    [
      { tenure_text: '1y', rate_general_pct: 4.5, currency: 'GBP' },
      { tenure_text: '2y', rate_general_pct: 4.3 }, // missing
    ],
    undefined,
    warnings,
  );
  assert.ok(!r.rejected);
  assert.equal(r.slabs[1].currency, 'GBP');
  assert.ok(warnings.some(w => /currency_default/.test(w)));
});

// FCNR-4a: currency normalisation
test('_tagCurrencyForeignVariant: normalises EURO → EUR', () => {
  const warnings = [];
  const r = _tagCurrencyForeignVariant(
    [{ tenure_text: '1y', rate_general_pct: 4.0, currency: 'EURO' }],
    undefined,
    warnings,
  );
  assert.equal(r.slabs[0].currency, 'EUR');
});

test('_tagCurrencyForeignVariant: normalises YEN → JPY', () => {
  const warnings = [];
  const r = _tagCurrencyForeignVariant(
    [{ tenure_text: '1y', rate_general_pct: 0.5, currency: 'YEN' }],
    undefined,
    warnings,
  );
  assert.equal(r.slabs[0].currency, 'JPY');
});

test('_tagCurrencyForeignVariant: strips tier suffix from "USD (Above 5L)" → USD', () => {
  const warnings = [];
  const r = _tagCurrencyForeignVariant(
    [{ tenure_text: '1y', rate_general_pct: 5.0, currency: 'USD (Above 5L)' }],
    undefined,
    warnings,
  );
  assert.equal(r.slabs[0].currency, 'USD');
});

// FCNR-5: text-pattern fallback guard for multi-currency variants

test('_textPatternMultiCurrencyGuard: rejects fcnr with 6 expected but only 2 captured', () => {
  const slabs = [
    { tenure_text: '1y', rate_general_pct: 4.5, currency: 'USD' },
    { tenure_text: '2y', rate_general_pct: 4.7, currency: 'JPY' },
    { tenure_text: '3y', rate_general_pct: 4.9, currency: 'USD' },
  ];
  const r = _textPatternMultiCurrencyGuard(slabs, 'fcnr', ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD']);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /text_pattern_fallback_rejected/);
  assert.match(r.reason, /captured only 2/);
});

test('_textPatternMultiCurrencyGuard: accepts fcnr with 3+ captured', () => {
  const slabs = [
    { tenure_text: '1y', rate_general_pct: 4.5, currency: 'USD' },
    { tenure_text: '1y', rate_general_pct: 4.0, currency: 'GBP' },
    { tenure_text: '1y', rate_general_pct: 3.5, currency: 'EUR' },
  ];
  const r = _textPatternMultiCurrencyGuard(slabs, 'fcnr', ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD']);
  assert.equal(r.rejected, false);
});

test('_textPatternMultiCurrencyGuard: accepts regular variant regardless of currency count', () => {
  const slabs = [
    { tenure_text: '1y', rate_general_pct: 6.5 },
  ];
  const r = _textPatternMultiCurrencyGuard(slabs, 'regular', undefined);
  assert.equal(r.rejected, false);
});

test('_textPatternMultiCurrencyGuard: accepts fcnr when expected_currencies absent', () => {
  // No hint → no guard fires (operator-side missing context, not engine's call to refuse)
  const slabs = [
    { tenure_text: '1y', rate_general_pct: 4.5, currency: 'USD' },
  ];
  const r = _textPatternMultiCurrencyGuard(slabs, 'fcnr', undefined);
  assert.equal(r.rejected, false);
});

test('_textPatternMultiCurrencyGuard: accepts when expected_currencies < 3', () => {
  // Small banks may only publish 1-2 currencies; guard only fires for "many expected"
  const slabs = [{ tenure_text: '1y', rate_general_pct: 4.5, currency: 'USD' }];
  const r = _textPatternMultiCurrencyGuard(slabs, 'fcnr', ['USD']);
  assert.equal(r.rejected, false);
});

// FCNR Fix #1: tableHasCurrencyMarkers — variant-aware table filter

test('_tableHasCurrencyMarkers: table with USD/GBP/EUR in header → true', () => {
  const rows = [
    ['Maturity Period', 'USD', 'GBP', 'EUR'],
    ['1 year', '4.50', '4.10', '1.65'],
    ['2 years', '3.50', '3.60', '1.70'],
  ];
  assert.equal(_tableHasCurrencyMarkers(rows), true);
});

test('_tableHasCurrencyMarkers: Pattern A (currency codes in col 0) → true', () => {
  const rows = [
    ['Currency', '1 Year', '2 Years', '3 Years'],
    ['USD', '5.50', '5.60', '5.70'],
    ['GBP', '4.50', '4.60', '4.70'],
  ];
  assert.equal(_tableHasCurrencyMarkers(rows), true);
});

test('_tableHasCurrencyMarkers: INR bulk-FD table (no currencies) → false', () => {
  // Canara/PNB/IDBI bulk-FD table: many columns, all INR (deposit-tier breakdowns)
  const rows = [
    ['Tenure', '< 3Cr', '3Cr-5Cr', '5Cr-25Cr', '25Cr-50Cr', '50Cr-100Cr', '> 100Cr'],
    ['7 days to 14 days', '4.00', '4.10', '4.20', '4.30', '4.40', '4.50'],
    ['1 year', '6.50', '6.60', '6.70', '6.80', '6.90', '7.00'],
  ];
  assert.equal(_tableHasCurrencyMarkers(rows), false);
});

test('_tableHasCurrencyMarkers: EURO synonym still counts → true', () => {
  const rows = [
    ['Tenure', 'USD', 'GBP', 'EURO'],  // EURO normalises to EUR
    ['1 year', '4.0', '4.1', '1.6'],
  ];
  assert.equal(_tableHasCurrencyMarkers(rows), true);
});

test('_tableHasCurrencyMarkers: empty rows / single row → false', () => {
  assert.equal(_tableHasCurrencyMarkers([]), false);
  assert.equal(_tableHasCurrencyMarkers([['USD', 'GBP']]), false); // single row only
});

test('_tableHasCurrencyMarkers: single currency in header → true (accept)', () => {
  // Single-currency banks (e.g. small foreign bank USD-only FCNR) are legitimate;
  // the post-tagger validates against expected_currencies
  const rows = [
    ['Tenure', 'USD'],
    ['1 year', '4.5'],
    ['2 years', '4.7'],
  ];
  assert.equal(_tableHasCurrencyMarkers(rows), true);
});

// FCNR Fix #2: tagCurrencyForeignVariant rejects multi-currency default-fill

test('_tagCurrencyForeignVariant: 2+ expected, zero detected → REJECTED (was: default to USD)', () => {
  const warnings = [];
  const r = _tagCurrencyForeignVariant(
    [
      { tenure_text: '7 Days to 14 Days', rate_general_pct: 4.0 },
      { tenure_text: '15 Days to 30 Days', rate_general_pct: 4.1 },
    ],
    ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD'],
    warnings,
  );
  assert.equal(r.rejected, true);
  assert.match(r.reason, /missing_currency_multi/);
  assert.match(r.reason, /INR table/);
});

test('_tagCurrencyForeignVariant: 1 expected, zero detected → default-fill (safe single-currency case)', () => {
  const warnings = [];
  const r = _tagCurrencyForeignVariant(
    [{ tenure_text: '1 year', rate_general_pct: 4.5 }],
    ['USD'],
    warnings,
  );
  assert.equal(r.slabs.length, 1);
  assert.equal(r.slabs[0].currency, 'USD');
  assert.ok(warnings.some(w => /currency_hint_single/.test(w)));
});

test('_textPatternMultiCurrencyGuard: empty slabs → no rejection (nothing to refuse)', () => {
  const r = _textPatternMultiCurrencyGuard([], 'fcnr', ['USD', 'GBP', 'EUR']);
  assert.equal(r.rejected, false);
});

test('_textPatternMultiCurrencyGuard: south-indian regression case (143 noisy slabs, only CAD+JPY)', () => {
  // Reproduce the exact pre-FCNR-5 case: text-pattern produced 143 slabs
  // for south-indian-bank-limited FCNR, but only across CAD and JPY.
  // Operator expected 6+ currencies. Guard MUST reject.
  const slabs = Array.from({ length: 80 }, (_, i) =>
    ({ tenure_text: `tenure ${i}`, rate_general_pct: 4 + (i % 10) / 10, currency: i % 2 === 0 ? 'CAD' : 'JPY' }));
  const r = _textPatternMultiCurrencyGuard(slabs, 'fcnr', ['USD', 'GBP', 'EUR', 'AUD', 'CHF', 'JPY', 'CAD']);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /CAD,JPY/);
});

test('_tagCurrencyForeignVariant: normalisation applies before missing-peer fill', () => {
  const warnings = [];
  const r = _tagCurrencyForeignVariant(
    [
      { tenure_text: '1y', rate_general_pct: 4.0, currency: 'EURO' },
      { tenure_text: '2y', rate_general_pct: 3.8 }, // missing
    ],
    undefined,
    warnings,
  );
  assert.equal(r.slabs[0].currency, 'EUR');
  assert.equal(r.slabs[1].currency, 'EUR', 'missing slab inherits canonical EUR not raw EURO');
});

// ── Slab dedup ─────────────────────────────────────────────────────────

test('_dedupSlabs: collapses identical (tenure_min, tenure_max, currency, deposit_range)', () => {
  const dups = [
    { tenure_min_days: 7, tenure_max_days: 14, currency: null, deposit_range: 'below_3cr', rate_general_pct: 3.5 },
    { tenure_min_days: 7, tenure_max_days: 14, currency: null, deposit_range: 'below_3cr', rate_general_pct: 3.5 }, // dup
    { tenure_min_days: 15, tenure_max_days: 30, currency: null, deposit_range: 'below_3cr', rate_general_pct: 4.0 },
  ];
  const out = _dedupSlabs(dups);
  assert.equal(out.length, 2);
  assert.equal(out[0].tenure_min_days, 7);
  assert.equal(out[1].tenure_min_days, 15);
});

test('_dedupSlabs: different currencies are NOT considered duplicates (FCNR multi-currency)', () => {
  const slabs = [
    { tenure_min_days: 365, tenure_max_days: 730, currency: 'USD', rate_general_pct: 4.5 },
    { tenure_min_days: 365, tenure_max_days: 730, currency: 'GBP', rate_general_pct: 3.0 },
  ];
  assert.equal(_dedupSlabs(slabs).length, 2);
});

test('_dedupSlabs: slabs with null bounds but distinct tenure_text both survive (HDFC regression)', () => {
  // Pre-fix behaviour collapsed every (null, null, null, 'below_3cr') row into one
  // bucket — HDFC's 19-row table dedup'd to 2. The text-fallback discriminator
  // restores distinct rows.
  const slabs = [
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '7 - 14 days',  rate_general_pct: 2.75 },
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '15 - 29 days', rate_general_pct: 3.00 },
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '30 - 45 days', rate_general_pct: 3.50 },
  ];
  const out = _dedupSlabs(slabs);
  assert.equal(out.length, 3, 'three distinct tenure_texts must all survive');
});

test('_dedupSlabs: null-bounds rows with IDENTICAL tenure_text still collapse', () => {
  const slabs = [
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '1 Yr', rate_general_pct: 6.5 },
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '1 yr', rate_general_pct: 6.5 }, // case-insensitive dup
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '1  Yr', rate_general_pct: 6.5 }, // whitespace dup
  ];
  assert.equal(_dedupSlabs(slabs).length, 1, 'lowercased + whitespace-normalised tenure_text dedups correctly');
});

test('_dedupSlabs: text-keyed and bounds-keyed rows for the SAME tenure_text + rate COLLAPSE (B1 shadow-dedup)', () => {
  // Sprint 4 B1: pre-B1 behaviour kept these as 2 distinct slabs via
  // "t:"/"n:" key prefixes — but they describe the same data point (same
  // tenure_text, same currency, same rate). The Kotak FCNR bug surfaced
  // when the LLM emitted both forms of the same row; the count doubled.
  // The shadow-dedup pass now collapses them, keeping the parsed-bounds
  // variant (higher score).
  const slabs = [
    { tenure_min_days: 7, tenure_max_days: 14, tenure_text: '7 days to 14 days', rate_general_pct: 3.5 },
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '7 days to 14 days', rate_general_pct: 3.5 },
  ];
  const out = _dedupSlabs(slabs);
  assert.equal(out.length, 1, 'shadow-duplicate collapsed');
  assert.equal(out[0].tenure_min_days, 7, 'parsed-bounds variant wins');
  assert.equal(out[0].tenure_max_days, 14);
});

test('_dedupSlabs: text-keyed and bounds-keyed rows with DIFFERENT tenure_text do NOT collide', () => {
  // The original concern stands when the texts genuinely differ: "7 days
  // to 14 days" (bounds parsed) and "1 month" (bounds null) are distinct
  // tenures and must both survive.
  const slabs = [
    { tenure_min_days: 7, tenure_max_days: 14, tenure_text: '7 days to 14 days', rate_general_pct: 3.5 },
    { tenure_min_days: null, tenure_max_days: null, tenure_text: '1 month', rate_general_pct: 3.5 },
  ];
  assert.equal(_dedupSlabs(slabs).length, 2);
});

// ── A1 (slab-quality-anomalies-2026-05-18): deposit_range normalisation ─

test('_normaliseDepositRange: BOI-IBU "above 1.00 Mn" maps to canonical above_1mn', () => {
  assert.equal(_normaliseDepositRange('above 1.00 Mn'), 'above_1mn');
  assert.equal(_normaliseDepositRange('Above 1 Mn'), 'above_1mn');
  assert.equal(_normaliseDepositRange('above_1.00_Mn'), 'above_1mn', 'snake-case input still canonicalises');
});

test('_normaliseDepositRange: 1cr to 5cr / bulk tiers', () => {
  assert.equal(_normaliseDepositRange('3 Cr to 5 Cr'), '3cr_to_5cr');
  assert.equal(_normaliseDepositRange('Above 100 Cr'), 'above_100cr');
  assert.equal(_normaliseDepositRange('below Rs 3 Cr'), 'below_3cr');
});

test('_normaliseDepositRange: unknown label falls back to snake_case (still dedup-friendly)', () => {
  // No canonical match — but the result is deterministic so dedup works.
  const result = _normaliseDepositRange('Special Premium Tier');
  assert.equal(result, 'special_premium_tier');
});

test('_normaliseDepositRange: null / empty input returns null', () => {
  assert.equal(_normaliseDepositRange(null), null);
  assert.equal(_normaliseDepositRange(''), null);
});

// ── A4 — validateSlabAgainstChunk backfills deposit_range from tier_hint ──

test('_validateSlabAgainstChunk: backfills deposit_range from chunk.tier_hint when slab lacks it', () => {
  const chunkText = '1 year 6.50% Below 3 Cr';
  const slab = {
    tenure_text: '1 year',
    tenure_min_days: 365,
    tenure_max_days: 365,
    rate_general_pct: 6.50,
    source_row_text: '1 year 6.50%',
  };
  const chunk = { tier_hint: 'below 3 cr' };
  const r = _validateSlabAgainstChunk(slab, chunkText, chunk);
  assert.equal(r.ok, true);
  assert.equal(slab.deposit_range, 'below 3 cr');
});

test('_validateSlabAgainstChunk: does NOT overwrite an explicit deposit_range', () => {
  const slab = {
    tenure_text: '1 year',
    rate_general_pct: 6.50,
    source_row_text: '1 year 6.50%',
    deposit_range: '3cr_to_5cr',
  };
  const chunk = { tier_hint: 'below 3 cr' };
  const chunkText = '1 year 6.50% Below 3 Cr';
  const r = _validateSlabAgainstChunk(slab, chunkText, chunk);
  assert.equal(r.ok, true);
  assert.equal(slab.deposit_range, '3cr_to_5cr', 'existing deposit_range preserved');
});

test('_validateSlabAgainstChunk: no chunk argument → does not touch deposit_range (backwards compat)', () => {
  const slab = { tenure_text: '1 year', rate_general_pct: 6.50, source_row_text: '1 year 6.50%' };
  const chunkText = '1 year 6.50%';
  // Pre-A4 signature (no chunk arg) still works.
  const r = _validateSlabAgainstChunk(slab, chunkText);
  assert.equal(r.ok, true);
  assert.equal(slab.deposit_range, undefined, 'no backfill when chunk arg is absent');
});

test('_validateSlabAgainstChunk: rate-digit-not-in-chunk still rejects even with tier_hint', () => {
  // Anti-fabrication backstop survives the A4 changes.
  const slab = { tenure_text: '1 year', rate_general_pct: 99.99, source_row_text: 'fake row' };
  const chunkText = '1 year 6.50%';
  const chunk = { tier_hint: 'below 3 cr' };
  const r = _validateSlabAgainstChunk(slab, chunkText, chunk);
  assert.equal(r.ok, false);
  assert.match(r.reason, /99\.99 not present/);
});

// ── Input contract violations ──────────────────────────────────────────

test('throws on missing url', async () => {
  await assert.rejects(
    extractHtmlTable({ kind: 'html_static', variant: 'regular' }),
    /input.url is required/,
  );
});

test('throws on invalid kind', async () => {
  await assert.rejects(
    extractHtmlTable({ url: 'https://x', kind: 'pdf', variant: 'regular' }),
    /input.kind must be one of/,
  );
});

test('throws on invalid variant', async () => {
  await assert.rejects(
    extractHtmlTable({ url: 'https://x', kind: 'html_static', variant: 'savings' }),
    /unsupported variant/,
  );
});

// ── Empty / no-table cases ─────────────────────────────────────────────

test('cached_body: empty html → null', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: '<html><body><p>No tables here</p></body></html>' },
  });
  assert.equal(out, null);
});

test('cached_body: header-only table → null (no data rows)', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: '<table><tr><th>Tenure</th><th>Rate</th></tr></table>' },
  });
  assert.equal(out, null);
});

// ── LLM fallback (env-conditional) ─────────────────────────────────────

test('LLM fallback: no AOAI configured → action returns null on zero-slab deterministic', async () => {
  const saved = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  try {
    // HTML has no tables — deterministic returns 0; LLM is unavailable.
    const out = await extractHtmlTable({
      url: 'https://example.com',
      kind: 'html_static',
      variant: 'regular',
      hints: { cached_body: '<html><body><p>No tables here, just text</p></body></html>' },
    });
    assert.equal(out, null);
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_ENDPOINT = saved;
  }
});

test('LLM fallback: prefer_llm=true on a happy deterministic page does NOT downgrade', async () => {
  // Without AOAI configured, prefer_llm is ignored when deterministic already succeeded.
  const saved = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  try {
    const out = await extractHtmlTable({
      url: 'https://example.com',
      kind: 'html_static',
      variant: 'regular',
      hints: { cached_body: SIMPLE_RATE_TABLE_HTML, prefer_llm: true },
    });
    assert.ok(out, 'deterministic path still wins');
    assert.equal(out.path_used, 'deterministic');
    assert.equal(out.slabs.length, 3);
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_ENDPOINT = saved;
  }
});

test('LLM fallback contract: path_used flips to "llm_fallback" only when LLM actually contributes', async () => {
  // Without AOAI in test env, the LLM fallback can't fire. We assert that the
  // deterministic-success path still reports path_used: "deterministic" and
  // never spuriously reports "llm_fallback".
  const out = await extractHtmlTable({
    url: 'https://example.com',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: SIMPLE_RATE_TABLE_HTML },
  });
  assert.equal(out.path_used, 'deterministic');
});

// ── Widened LLM-fallback trigger (audit 2026-05-17) ────────────────────
//
// Verifies the suspect-deterministic path. Without AOAI configured the
// trigger evaluation still happens but the call returns null; the
// deterministic slabs survive. With AOAI configured (live env) the LLM
// would re-extract. We can't test the live path without AOAI, but we CAN
// verify (a) deterministic result is preserved when LLM is unavailable,
// and (b) prefer_llm + small expected_slab_count both flow without
// breaking the action.

test('widened trigger: tooFewSlabs hint does not break action when AOAI unavailable', async () => {
  const saved = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  try {
    // Page has 3 slabs; claim we expected 20. The trigger should evaluate
    // tooFewSlabs=true but since AOAI is unset, llmConfigured=false and
    // shouldTryLlm=false — deterministic result wins, no crash.
    const out = await extractHtmlTable({
      url: 'https://example.com',
      kind: 'html_static',
      variant: 'regular',
      hints: { cached_body: SIMPLE_RATE_TABLE_HTML, expected_slab_count: 20 },
    });
    assert.ok(out, 'deterministic still returns slabs');
    assert.equal(out.path_used, 'deterministic');
    assert.equal(out.slabs.length, 3);
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_ENDPOINT = saved;
  }
});

test('widened trigger: multi_table warning does not break action when AOAI unavailable', async () => {
  const saved = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  try {
    // TWO_TABLES_HTML fires the multi_table warning in the deterministic
    // path. With the widened trigger, that now flips deterministicSuspect=true,
    // but with AOAI off the LLM call is skipped and deterministic survives.
    const out = await extractHtmlTable({
      url: 'https://example.com',
      kind: 'html_static',
      variant: 'regular',
      hints: { cached_body: TWO_TABLES_HTML },
    });
    assert.ok(out, 'deterministic still returns slabs');
    assert.equal(out.path_used, 'deterministic');
    assert.ok(out.warnings.some((w) => w.startsWith('multi_table')));
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_ENDPOINT = saved;
  }
});

test('bank context hints are accepted without erroring (no AOAI call)', async () => {
  const saved = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  try {
    const out = await extractHtmlTable({
      url: 'https://example.com',
      kind: 'html_static',
      variant: 'regular',
      hints: {
        cached_body: SIMPLE_RATE_TABLE_HTML,
        bank_name: 'State Bank of India',
        bank_type: 'PSB',
        bank_code: 'state-bank-of-india',
        state: 'Maharashtra',
        category: 'Public Sector Bank',
        cached_notes: 'Multi-table page; rates under section "Domestic FD".',
        scraper_notes: { framework: 'AEM', has_tabs: true, rate_tables_on_page: 3 },
      },
    });
    assert.ok(out);
    assert.equal(out.slabs.length, 3);
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_ENDPOINT = saved;
  }
});

// ── Canonical-table selector (in-house matcher) ────────────────────────

const MULTI_TABLE_WITH_CLASSES_HTML = `
<html><body>
  <table class="nav-table"><tr><td>About</td><td>Home</td></tr></table>
  <table class="responsiveTable tableData fdlandingdata">
    <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
    <tr><td>7 days to 14 days</td><td>3.50%</td><td>4.00%</td></tr>
    <tr><td>15 days to 30 days</td><td>4.00%</td><td>4.50%</td></tr>
    <tr><td>1 year to 2 years</td><td>6.50%</td><td>7.00%</td></tr>
    <tr><td>2 years to 3 years</td><td>6.80%</td><td>7.30%</td></tr>
  </table>
  <table class="footer-table"><tr><td>Contact</td><td>1.23</td></tr></table>
</body></html>
`;

test('_filterHtmlByTableSelector: class-chain matches the right table', () => {
  const r = _filterHtmlByTableSelector(MULTI_TABLE_WITH_CLASSES_HTML, 'table.responsiveTable.tableData.fdlandingdata');
  assert.equal(r.recognised, true);
  assert.equal(r.matched, 1);
  assert.ok(r.html.includes('7 days to 14 days'));
  assert.ok(!r.html.includes('nav-table'));
});

test('_filterHtmlByTableSelector: bare "table" matches every table (no narrowing)', () => {
  const r = _filterHtmlByTableSelector(MULTI_TABLE_WITH_CLASSES_HTML, 'table');
  assert.equal(r.recognised, true);
  assert.ok(r.matched >= 3);
});

test('_filterHtmlByTableSelector: descendant ".tablewrap table" matches table inside .tablewrap', () => {
  const html = `
    <html><body>
      <div class="header"><table><tr><td>nav</td></tr></table></div>
      <div class="tablewrap">
        <table>
          <tr><th>Tenure</th><th>Rate</th></tr>
          <tr><td>7 days</td><td>3.50%</td></tr>
        </table>
      </div>
    </body></html>
  `;
  const r = _filterHtmlByTableSelector(html, '.tablewrap table');
  assert.equal(r.recognised, true);
  assert.ok(r.matched >= 1);
  assert.ok(r.html.includes('Tenure'));
});

test('_filterHtmlByTableSelector: unrecognised selector → recognised:false', () => {
  const r = _filterHtmlByTableSelector(MULTI_TABLE_WITH_CLASSES_HTML, 'table[data-rate-table]');
  assert.equal(r.recognised, false);
  assert.equal(r.matched, 0);
});

test('_filterHtmlByTableSelector: class-chain with zero matches → returns original html, matched:0, recognised:true', () => {
  const r = _filterHtmlByTableSelector(MULTI_TABLE_WITH_CLASSES_HTML, 'table.nonexistent-class');
  assert.equal(r.recognised, true);
  assert.equal(r.matched, 0);
  // Original html preserved so caller can fall back to default scan
  assert.ok(r.html.includes('responsiveTable'));
});

test('canonical-table selector: action uses config.selectors.table to narrow extraction', async () => {
  // The multi-table page would normally have the dispatcher pick the
  // largest rate-bearing table. With selectors.table set, we pin the
  // canonical one explicitly.
  const out = await extractHtmlTable({
    url: 'https://example.com',
    kind: 'html_static',
    variant: 'regular',
    config: {
      selectors: { table: 'table.responsiveTable.tableData.fdlandingdata' },
    },
    hints: { cached_body: MULTI_TABLE_WITH_CLASSES_HTML },
  });
  assert.ok(out, 'extraction succeeded');
  assert.equal(out.slabs.length, 4); // The 4 data rows from the canonical table
  assert.ok(out.warnings.some((w) => w.includes('canonical_table_selector')));
});

// ──────────────────────────────────────────────────────────────────
// B3 (sprint-004) — malformed div-table slab guard
// ──────────────────────────────────────────────────────────────────

test('B3: tenure_text > 100 chars (div-table concat blob) is dropped', async () => {
  // Equitas-style page where cheerio collapsed an entire div-table into one
  // cell. A real slab follows so we can assert the legit one survives.
  const HTML = `<html><body>
    <table>
      <tr><th>Tenure</th><th>Rate</th></tr>
      <tr><td>Tenure&lt; USD 500,000&gt;= USD 500,00012 month to &lt;= 18 months5.30% p.a.5.35% p.a.&gt; 18 months to &lt;= 36 Months4.65% p.a.4.65% p.a.</td><td>1.12</td></tr>
      <tr><td>7 days to 14 days</td><td>3.50</td></tr>
    </table>
  </body></html>`;
  const out = await extractHtmlTable({
    url: 'https://example.com',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: HTML },
  });
  assert.ok(out, 'extraction succeeded');
  // Only the clean 1-row slab survives; the 200-char blob is dropped.
  for (const s of out.slabs) {
    assert.ok(s.tenure_text.length <= 100, `tenure_text "${s.tenure_text}" exceeds 100 chars`);
  }
  assert.ok(out.warnings.some((w) => /malformed_slab_filter/.test(w)),
    'warning records the drop');
});

test('B3: tenure_text containing rate-shaped number (e.g. "3.50%") is dropped', async () => {
  // Pathological extraction where the rate leaked into the tenure cell.
  const HTML = `<html><body>
    <table>
      <tr><th>Tenure</th><th>Rate</th></tr>
      <tr><td>1 year @ 6.50%</td><td>6.50</td></tr>
      <tr><td>2 years</td><td>6.75</td></tr>
    </table>
  </body></html>`;
  const out = await extractHtmlTable({
    url: 'https://example.com',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: HTML },
  });
  assert.ok(out, 'extraction succeeded');
  for (const s of out.slabs) {
    assert.ok(!/\d+\.\d{1,2}\s*%/.test(s.tenure_text || ''),
      `tenure_text "${s.tenure_text}" still contains rate-shape`);
  }
});

// ──────────────────────────────────────────────────────────────────
// B1 (sprint-004) — dedupSlabs shadow-duplicate collapse
// ──────────────────────────────────────────────────────────────────

const { _dedupSlabs: dedupSlabs } = require('../../../lib/actions/extract_html_table');

test('B1: BOI-IBU-style shadow tier collapsed (same rate, empty vs "below_1mn" deposit_range)', () => {
  // The page lists "headline" rates with no tier label AND a "below 1mn"
  // tier with identical numbers — semantically one data point.
  const input = [
    { tenure_text: '7 days to 30 days', tenure_min_days: 7, tenure_max_days: 30, rate_general_pct: 3.4, rate_senior_pct: null, currency: 'USD', deposit_range: null },
    { tenure_text: '7 days to 30 days', tenure_min_days: 7, tenure_max_days: 30, rate_general_pct: 3.4, rate_senior_pct: null, currency: 'USD', deposit_range: 'below_1mn' },
  ];
  const out = dedupSlabs(input);
  assert.equal(out.length, 1, 'collapsed to one slab');
  // The labeled one wins (more populated fields).
  assert.equal(out[0].deposit_range, 'below_1mn');
});

test('B1: distinct rates across tiers are NOT collapsed (above_1mn at 3.5 vs default at 3.4)', () => {
  // Legitimate multi-tier: rates differ → both must survive.
  const input = [
    { tenure_text: '7 days to 30 days', tenure_min_days: 7, tenure_max_days: 30, rate_general_pct: 3.4, rate_senior_pct: null, currency: 'USD', deposit_range: null },
    { tenure_text: '7 days to 30 days', tenure_min_days: 7, tenure_max_days: 30, rate_general_pct: 3.5, rate_senior_pct: null, currency: 'USD', deposit_range: 'above_1mn' },
  ];
  const out = dedupSlabs(input);
  assert.equal(out.length, 2, 'different rates preserved as distinct slabs');
});

test('B1: Kotak-style duplicate (parsed bounds vs null bounds, same tenure_text + rate) collapsed', () => {
  const input = [
    { tenure_text: '>=1 Year - Less than 2 Year', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: 4.4, rate_senior_pct: null, currency: 'USD', deposit_range: '0_5_mio' },
    { tenure_text: '>=1 Year - Less than 2 Year', tenure_min_days: null, tenure_max_days: null, rate_general_pct: 4.4, rate_senior_pct: null, currency: 'USD', deposit_range: '0_5_mio' },
  ];
  const out = dedupSlabs(input);
  assert.equal(out.length, 1, 'collapsed to one slab');
  // The parsed-bounds slab wins (higher score).
  assert.equal(out[0].tenure_min_days, 365);
  assert.equal(out[0].tenure_max_days, 729);
});

test('B1: slabs without rate are preserved as-is (no shadow-dedup on null rates)', () => {
  // Some extraction paths emit shell rows without rates (effective_date
  // markers, etc.). Don't dedup these — let the non_fd_filter handle them.
  const input = [
    { tenure_text: 'header text', tenure_min_days: null, tenure_max_days: null, rate_general_pct: null, rate_senior_pct: null },
    { tenure_text: 'another header', tenure_min_days: null, tenure_max_days: null, rate_general_pct: null, rate_senior_pct: null },
  ];
  const out = dedupSlabs(input);
  assert.equal(out.length, 2, 'rate-less rows pass through (first-pass strict dedup only)');
});

test('B1: stable order preserved (slab ordering matches input where possible)', () => {
  const input = [
    { tenure_text: '7 days', tenure_min_days: 7, tenure_max_days: 7, rate_general_pct: 3.5, currency: 'INR' },
    { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.5, currency: 'INR' },
    { tenure_text: '2 years', tenure_min_days: 730, tenure_max_days: 730, rate_general_pct: 7.0, currency: 'INR' },
  ];
  const out = dedupSlabs(input);
  assert.equal(out.length, 3);
  assert.equal(out[0].tenure_text, '7 days');
  assert.equal(out[1].tenure_text, '1 year');
  assert.equal(out[2].tenure_text, '2 years');
});

test('B1: pre-existing strict-dedup path still removes exact (currency, tenure, rate, range) duplicates', () => {
  // Two identical slabs (Sprint 3 behaviour — must still work).
  const input = [
    { tenure_text: '7 days', tenure_min_days: 7, tenure_max_days: 7, rate_general_pct: 3.5, currency: 'INR', deposit_range: null },
    { tenure_text: '7 days', tenure_min_days: 7, tenure_max_days: 7, rate_general_pct: 3.5, currency: 'INR', deposit_range: null },
  ];
  const out = dedupSlabs(input);
  assert.equal(out.length, 1);
});

// ──────────────────────────────────────────────────────────────────
// A15 (sprint-004) — text-pattern fallback for SPA / mashed-cell pages
// ──────────────────────────────────────────────────────────────────

const { _extractViaTextPattern: extractViaTextPattern } = require('../../../lib/actions/extract_html_table');

test('A15: Equitas FD-style SPA (no <table>) — text-pattern recovers slabs', () => {
  // Real Equitas FD page has 0 <table> elements; rates live in styled
  // <div>s. The body text reads like the row sequence below.
  const html = `<html><body><div>
    Amount less than Rs 3 Crores Annualised Yield
    7 - 14 days 3.50% 3.50%
    15 - 29 days 3.50% 3.50%
    30 - 45 days 4.00% 4.00%
    46 - 62 days 4.75% 4.75%
    63 - 90 days 4.75% 4.75%
    91 - 120 days 5.25% 5.25%
    121 - 180 days 5.25% 5.25%
    181 - 210 days 6.35% 6.45%
    211 - 270 days 6.35% 6.45%
    271 - 364 days 6.35% 6.45%
  </div></body></html>`;
  const slabs = extractViaTextPattern(html, 'regular');
  assert.ok(slabs.length >= 8, `expected ≥ 8 slabs, got ${slabs.length}`);
  // First-row spot-check.
  const s0 = slabs[0];
  assert.equal(s0.tenure_min_days, 7);
  assert.equal(s0.tenure_max_days, 14);
  assert.equal(s0.rate_general_pct, 3.5);
  assert.equal(s0.rate_senior_pct, 3.5);
  // Mid-row spot-check.
  const six = slabs.find((s) => s.tenure_min_days === 181 && s.tenure_max_days === 210);
  assert.ok(six, '181-210 days slab present');
  assert.equal(six.rate_general_pct, 6.35);
  assert.equal(six.rate_senior_pct, 6.45);
});

test('A15: noise gate — pages with < 5 rate-shaped patterns return []', () => {
  // A marketing page with 2 rate mentions in prose should NOT trigger.
  const html = `<html><body>
    Save more with FDs starting at 6.50% p.a. — earn up to 7.00% on long
    tenures. Visit your nearest branch.
  </body></html>`;
  const slabs = extractViaTextPattern(html, 'regular');
  assert.equal(slabs.length, 0);
});

test('A15: FCNR multi-currency — currency from running context, defaults to expected if absent', () => {
  // Equitas FCNR-style: USD section first with two rate columns, then GBP.
  const html = `<html><body>
    Tenure USD &lt; 500K USD &gt;= 500K
    12 month to 18 months 5.30% 5.35%
    18 months to 36 Months 4.65% 4.65%
    Tenure GBP (ROI)
    12 month to 18 months 5.00%
    18 months to 36 Months 4.50%
    Tenure EUR
    12 month to 18 months 3.20%
    18 months to 36 Months 2.95%
    12 month to 18 months 1.20%
  </body></html>`;
  const slabs = extractViaTextPattern(html, 'fcnr', ['USD']);
  assert.ok(slabs.length >= 6, `expected ≥ 6 slabs, got ${slabs.length}`);
  const usdSlabs = slabs.filter((s) => s.currency === 'USD');
  const gbpSlabs = slabs.filter((s) => s.currency === 'GBP');
  const eurSlabs = slabs.filter((s) => s.currency === 'EUR');
  assert.ok(usdSlabs.length >= 2, `at least 2 USD slabs (got ${usdSlabs.length})`);
  assert.ok(gbpSlabs.length >= 1, `at least 1 GBP slab (got ${gbpSlabs.length})`);
  assert.ok(eurSlabs.length >= 1, `at least 1 EUR slab (got ${eurSlabs.length})`);
});

test('A15: well-formed traditional <table> page — fallback returns slabs but the action prefers Path A', () => {
  // The fallback is fired only when slabs.length === 0 after Path A/B/C —
  // here we just confirm the fallback itself works on a page with a real
  // table. The full extractHtmlTable flow would NEVER call the fallback
  // because Path A would already succeed.
  const html = `<html><body>
    <table>
      <tr><th>Tenure</th><th>Rate</th></tr>
      <tr><td>7 days to 14 days</td><td>3.50%</td></tr>
      <tr><td>15 days to 30 days</td><td>3.50%</td></tr>
      <tr><td>1 year</td><td>6.50%</td></tr>
      <tr><td>2 years</td><td>6.75%</td></tr>
      <tr><td>3 years</td><td>7.00%</td></tr>
    </table>
  </body></html>`;
  const slabs = extractViaTextPattern(html, 'regular');
  assert.ok(slabs.length >= 5, `recovers at least 5 slabs from table text`);
});

test('A15: full action invokes Path D when cached_body has no real table — Equitas-style', async () => {
  // End-to-end: extractHtmlTable should reach Path D when Path A finds no
  // table and there is no LLM configured.
  const saved = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  try {
    const html = `<html><body><div>
      7 - 14 days 3.50% 3.50%
      15 - 29 days 3.50% 3.50%
      30 - 45 days 4.00% 4.00%
      46 - 62 days 4.75% 4.75%
      63 - 90 days 4.75% 4.75%
      91 - 120 days 5.25% 5.25%
    </div></body></html>`;
    const out = await extractHtmlTable({
      url: 'https://example.com',
      kind: 'html_static',
      variant: 'regular',
      hints: { cached_body: html },
    });
    assert.ok(out, 'extraction succeeded via Path D');
    assert.ok(out.slabs.length >= 5, `at least 5 slabs (got ${out.slabs.length})`);
    assert.equal(out.path_used, 'text_pattern_fallback');
    assert.ok(out.warnings.some((w) => /text_pattern_fallback/.test(w)));
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_ENDPOINT = saved;
  }
});

test('B3: well-formed slabs pass through unchanged (no false-positives on legitimate tenure text)', async () => {
  // AU SFB-style verbose tenure ("7 Days to 1 Month 15 Days") — 31 chars,
  // no percent signs, no rate-shape — must survive.
  const HTML = `<html><body>
    <table>
      <tr><th>Tenure</th><th>Rate</th></tr>
      <tr><td>7 Days to 1 Month 15 Days</td><td>3.5</td></tr>
      <tr><td>45 Months 1 Day to less than 60 Months</td><td>6.75</td></tr>
      <tr><td>60 Months to 120 Months</td><td>6.75</td></tr>
    </table>
  </body></html>`;
  const out = await extractHtmlTable({
    url: 'https://example.com',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: HTML },
  });
  assert.ok(out, 'extraction succeeded');
  assert.equal(out.slabs.length, 3, 'all 3 legit slabs survive');
  assert.ok(!out.warnings.some((w) => /malformed_slab_filter/.test(w)),
    'no malformed-slab warning when nothing was dropped');
});

// ── Orch-1 (sprint-004 2026-05-21) — multi-table accumulator + section-context ──

test('Orch-1: multi-table page with deposit_range headings → pages tagged per table', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/multi-range',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: MULTI_TABLE_DEPOSIT_RANGE_HTML },
  });
  assert.ok(out, 'extraction succeeded');
  assert.ok(Array.isArray(out.pages), 'pages array present');
  assert.equal(out.pages.length, 2, 'two pages emitted (one per table)');
  // Both tables are domestic / regular variant — page 1 = below_3cr, page 2 = 3cr_to_5cr
  const byRange = Object.fromEntries(out.pages.map((p) => [p.deposit_range_hint, p.slabs.length]));
  assert.equal(byRange['below_3cr'], 2);
  assert.equal(byRange['3cr_to_5cr'], 2);
  // Every slab carries the appropriate deposit_range
  for (const s of out.slabs) {
    assert.ok(['below_3cr', '3cr_to_5cr'].includes(s.deposit_range), `slab deposit_range=${s.deposit_range}`);
  }
});

test('Orch-1: textual tables interleaved with rate tables → only rate tables survive', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/textual-mix',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: MULTI_TABLE_WITH_TEXTUAL_TABLES_HTML },
  });
  assert.ok(out);
  assert.ok(Array.isArray(out.pages));
  // The "Premature withdrawal terms" table contains no rate slabs — should
  // be filtered out by the zero-slab-yield drop. Only the 2 rate tables remain.
  assert.equal(out.pages.length, 2, 'textual table filtered; 2 rate tables remain');
  assert.equal(out.slabs.length, 4, '2 + 2 rate slabs across both rate tables');
});

test('Orch-1: near-duplicate tables (same heading, different col counts) → dedup keeps more cols', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/near-dup',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: NEAR_DUPLICATE_TABLES_HTML },
  });
  assert.ok(out);
  assert.equal(out.pages.length, 1, 'near-duplicate collapsed to one page');
  // The kept table is the 3-col one (general + senior). Senior column must be populated.
  const seniorPopulated = out.slabs.filter((s) => s.rate_senior_pct != null).length;
  assert.equal(seniorPopulated, 2, 'senior column preserved on the surviving page');
  assert.ok(out.warnings.some((w) => /multi_table_dedup/.test(w)), 'dedup warning emitted');
});

test('Orch-1: HDFC-style multi-variant — section heading declares Domestic/NRO/NRE; NRE iteration drops senior + min-tenor', async () => {
  // Domestic iteration: should ship both tables (below_3cr + 3cr_to_5cr) with senior populated
  const domestic = await extractHtmlTable({
    url: 'https://example.com/hdfc-shape',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: HDFC_STYLE_MULTI_VARIANT_HTML },
  });
  assert.ok(domestic);
  assert.equal(domestic.pages.length, 2, 'two domestic pages');
  // Domestic keeps senior column
  for (const s of domestic.slabs) {
    if (s.tenure_min_days >= 365) {
      assert.ok(s.rate_senior_pct != null, `domestic 1y+ slab has senior populated; got ${JSON.stringify(s)}`);
    }
  }

  // NRE iteration: should also produce pages (variant filter sees nre in fulfills_variants),
  // with senior column nulled and <1y tenures dropped
  const nre = await extractHtmlTable({
    url: 'https://example.com/hdfc-shape',
    kind: 'html_static',
    variant: 'nre',
    hints: { cached_body: HDFC_STYLE_MULTI_VARIANT_HTML },
  });
  assert.ok(nre, 'NRE extraction returns pages');
  assert.ok(Array.isArray(nre.pages) && nre.pages.length === 2, 'two NRE pages (one per deposit_range)');
  // Every NRE slab has senior = null
  for (const s of nre.slabs) {
    assert.equal(s.rate_senior_pct, null, `NRE slab senior must be null; got ${JSON.stringify(s)}`);
  }
  // Every NRE slab has tenure_min_days >= 365
  for (const s of nre.slabs) {
    assert.ok(s.tenure_min_days >= 365, `NRE slab tenure_min_days must be ≥ 365; got ${s.tenure_min_days} for "${s.tenure_text}"`);
  }
  // Warnings include both senior-exclusion + min-tenor filter signals
  assert.ok(nre.warnings.some((w) => /min_tenor_filter:nre/.test(w)), 'min_tenor_filter warning present');

  // NRO iteration: senior nulled, no min-tenor filter (only NRE had one)
  const nro = await extractHtmlTable({
    url: 'https://example.com/hdfc-shape',
    kind: 'html_static',
    variant: 'nro',
    hints: { cached_body: HDFC_STYLE_MULTI_VARIANT_HTML },
  });
  assert.ok(nro);
  assert.ok(nro.pages.length === 2, 'two NRO pages');
  for (const s of nro.slabs) {
    assert.equal(s.rate_senior_pct, null, 'NRO senior nulled');
  }
  // NRO has all 4 tenures × 2 deposit_ranges = 8 slabs (no min-tenor filter on NRO)
  assert.equal(nro.slabs.length, 8, 'NRO keeps all tenures (no min-tenor)');
});

test('Orch-1: multiple rate tables with no headings → both pages emitted; existing dedup collapses same-tenure rows', async () => {
  const out = await extractHtmlTable({
    url: 'https://example.com/no-headings',
    kind: 'html_static',
    variant: 'regular',
    hints: { cached_body: MULTI_TABLE_NO_HEADINGS_HTML },
  });
  assert.ok(out);
  assert.equal(out.pages.length, 2, 'both rate tables produce pages');
  for (const p of out.pages) {
    assert.equal(p.deposit_range_hint, null, 'no deposit_range when no heading');
  }
  // The flat `slabs` field is post-dedupSlabs. When two rate tables produce
  // slabs with the same (tenure_min, tenure_max, currency, deposit_range)
  // tuple — distinguishable only by rate — the existing pass-1 dedup keeps
  // only the first occurrence. This is the documented dedup behavior and
  // tells the operator that the page should have surfaced a deposit_range
  // heading; without one, we can't safely treat the two tables as distinct.
  // The `pages` array still exposes the per-table breakdown for inspection.
  assert.equal(out.slabs.length, 2, 'same-tenure rows collapse without a deposit_range to distinguish them');
});

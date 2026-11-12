'use strict';

/**
 * Tests for M3 OCR action — `lib/actions/extract_via_ocr.js`.
 *
 * Uses a stub `_analyze` injection (the action's input accepts a custom
 * `_analyze(url)` function) so the tests run without hitting the live
 * Azure Document Intelligence endpoint. The stub returns a hand-built
 * AnalyzeResult-shaped object — same shape the DI SDK returns.
 *
 * Coverage:
 *   - cellsToGrid: cell-merge → grid expansion
 *   - classifyColumns: header-keyword recognition
 *   - detectCurrencyKeyedTable: FCNR-shape recognition
 *   - parseRate / cleanTenureText helpers
 *   - tableToSlabs: end-to-end with realistic table shapes
 *   - extractViaOcr top-level: pages/slabs structure + warnings + nulls
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractViaOcr, _internals } = require('../../../lib/actions/extract_via_ocr');
const {
  cellsToGrid,
  classifyColumns,
  detectCurrencyKeyedTable,
  detectCurrencyColumnsLayout,
  amountTierToDepositRange,
  normaliseCurrency,
  parseRate,
  cleanTenureText,
  tableToSlabs,
} = _internals;

// ── Helpers to build DI-shaped fixtures ─────────────────────────────

function makeCell(rowIndex, columnIndex, content, rowSpan = 1, columnSpan = 1) {
  return { rowIndex, columnIndex, content, rowSpan, columnSpan };
}

function makeTable(rows, cols, cells) {
  return { rowCount: rows, columnCount: cols, cells };
}

function makeAnalyzeResult({ tables = [], pages = [{}] } = {}) {
  return { tables, pages };
}

// ── cellsToGrid ─────────────────────────────────────────────────────

test('cellsToGrid: simple 2×2 table', () => {
  const t = makeTable(2, 2, [
    makeCell(0, 0, 'Tenure'),
    makeCell(0, 1, 'Rate'),
    makeCell(1, 0, '7 days'),
    makeCell(1, 1, '4.5%'),
  ]);
  const g = cellsToGrid(t);
  assert.deepEqual(g, [['Tenure', 'Rate'], ['7 days', '4.5%']]);
});

test('cellsToGrid: merged header cell spans 2 columns', () => {
  const t = makeTable(2, 2, [
    makeCell(0, 0, 'Header', 1, 2),
    makeCell(1, 0, 'A'),
    makeCell(1, 1, 'B'),
  ]);
  const g = cellsToGrid(t);
  assert.deepEqual(g, [['Header', 'Header'], ['A', 'B']]);
});

// ── classifyColumns ─────────────────────────────────────────────────

test('classifyColumns: Tenure | General | Senior', () => {
  const cls = classifyColumns(['Tenure', 'Interest Rate', 'Senior Citizen Rate']);
  assert.equal(cls.tenureCol, 0);
  assert.equal(cls.generalCol, 1);
  assert.equal(cls.seniorCol, 2);
});

test('classifyColumns: Period | Rate of Interest', () => {
  const cls = classifyColumns(['Period', 'Rate of Interest']);
  assert.equal(cls.tenureCol, 0);
  assert.equal(cls.generalCol, 1);
});

test('classifyColumns: super-senior recognized separately from senior', () => {
  const cls = classifyColumns(['Tenure', 'General Rate', 'Senior Citizen', 'Super Senior Citizen']);
  assert.equal(cls.tenureCol, 0);
  assert.equal(cls.generalCol, 1);
  assert.equal(cls.seniorCol, 2);
  assert.equal(cls.superSeniorCol, 3);
});

// ── detectCurrencyKeyedTable ────────────────────────────────────────

test('detectCurrencyKeyedTable: FCNR shape with "Currency" header', () => {
  const grid = [
    ['Currency', '1 Year', '2 Years', '3 Years'],
    ['USD', '5.5', '5.6', '5.7'],
    ['GBP', '4.5', '4.6', '4.7'],
  ];
  const r = detectCurrencyKeyedTable(grid);
  assert.ok(r);
  assert.equal(r.layout, 'currency_rows_tenure_cols');
  assert.deepEqual(r.tenureCols, [1, 2, 3]);
});

test('detectCurrencyKeyedTable: detects via first-data-row currency code (no header keyword)', () => {
  const grid = [
    ['', '1 Year', '2 Years'],
    ['USD', '5.5', '5.6'],
    ['EUR', '4.0', '4.1'],
  ];
  const r = detectCurrencyKeyedTable(grid);
  assert.ok(r);
});

test('detectCurrencyKeyedTable: non-FCNR table → null', () => {
  const grid = [
    ['Tenure', 'Rate'],
    ['7 days', '4.5%'],
    ['30 days', '5.0%'],
  ];
  assert.equal(detectCurrencyKeyedTable(grid), null);
});

// ── parseRate ───────────────────────────────────────────────────────

test('parseRate: "5.5%" → 5.5', () => assert.equal(parseRate('5.5%'), 5.5));
test('parseRate: "5.50 p.a." → 5.5', () => assert.equal(parseRate('5.50 p.a.'), 5.5));
test('parseRate: "—" → null', () => assert.equal(parseRate('—'), null));
test('parseRate: "N/A" → null', () => assert.equal(parseRate('N/A'), null));
test('parseRate: "" → null', () => assert.equal(parseRate(''), null));
test('parseRate: out-of-range "50%" → null', () => assert.equal(parseRate('50%'), null));
test('parseRate: integer "5" → 5', () => assert.equal(parseRate('5'), 5));

// ── cleanTenureText ─────────────────────────────────────────────────

test('cleanTenureText strips trailing asterisks', () => {
  assert.equal(cleanTenureText('1 year*'), '1 year');
});
test('cleanTenureText collapses whitespace', () => {
  assert.equal(cleanTenureText('  7   days  '), '7 days');
});

// ── tableToSlabs: standard tenure-keyed shape ───────────────────────

test('tableToSlabs: regular variant, 3-row table with general + senior', () => {
  const t = makeTable(4, 3, [
    makeCell(0, 0, 'Tenure'),
    makeCell(0, 1, 'Rate of Interest'),
    makeCell(0, 2, 'Senior Citizen Rate'),
    makeCell(1, 0, '7 days to 14 days'),
    makeCell(1, 1, '4.50%'),
    makeCell(1, 2, '5.00%'),
    makeCell(2, 0, '15 days to 29 days'),
    makeCell(2, 1, '4.75%'),
    makeCell(2, 2, '5.25%'),
    makeCell(3, 0, '1 year to less than 2 years'),
    makeCell(3, 1, '6.50%'),
    makeCell(3, 2, '7.00%'),
  ]);
  const slabs = tableToSlabs(t, 'regular');
  assert.equal(slabs.length, 3);
  assert.equal(slabs[0].tenure_text, '7 days to 14 days');
  assert.equal(slabs[0].tenure_min_days, 7);
  assert.equal(slabs[0].tenure_max_days, 14);
  assert.equal(slabs[0].rate_general_pct, 4.5);
  assert.equal(slabs[0].rate_senior_pct, 5.0);
  assert.equal(slabs[0].deposit_range, 'below_3cr');
  // last row tenure parsing
  assert.equal(slabs[2].tenure_min_days, 365);
});

test('tableToSlabs: drops row with unparseable rate', () => {
  const t = makeTable(3, 2, [
    makeCell(0, 0, 'Tenure'),
    makeCell(0, 1, 'Rate'),
    makeCell(1, 0, '7 days'),
    makeCell(1, 1, '4.5%'),
    makeCell(2, 0, '14 days'),
    makeCell(2, 1, '—'),
  ]);
  const slabs = tableToSlabs(t, 'regular');
  assert.equal(slabs.length, 1);
});

test('tableToSlabs: tenure-keyed table emitted as fcnr variant → dropped (would be wrong)', () => {
  const t = makeTable(2, 2, [
    makeCell(0, 0, 'Tenure'),
    makeCell(0, 1, 'Rate'),
    makeCell(1, 0, '1 year'),
    makeCell(1, 1, '6.5%'),
  ]);
  // FCNR slabs MUST have currency — emitting INR rate as FCNR is incorrect
  const slabs = tableToSlabs(t, 'fcnr');
  assert.equal(slabs.length, 0);
});

// ── normaliseCurrency ──────────────────────────────────────────────

test('normaliseCurrency: EURO → EUR', () => assert.equal(normaliseCurrency('EURO'), 'EUR'));
test('normaliseCurrency: YEN → JPY', () => assert.equal(normaliseCurrency('YEN'), 'JPY'));
test('normaliseCurrency: USD → USD', () => assert.equal(normaliseCurrency('USD'), 'USD'));
test('normaliseCurrency: USD (Above 5L) → USD', () => assert.equal(normaliseCurrency('USD (Above 5L)'), 'USD'));
test('normaliseCurrency: Sterling → GBP', () => assert.equal(normaliseCurrency('Sterling'), 'GBP'));
test('normaliseCurrency: unknown XYZ → null', () => assert.equal(normaliseCurrency('XYZ'), null));
test('normaliseCurrency: empty → null', () => assert.equal(normaliseCurrency(''), null));

// ── detectCurrencyColumnsLayout (Pattern B) ─────────────────────────

test('detectCurrencyColumnsLayout: Maturity | USD | GBP | EUR row layout', () => {
  const grid = [
    ['Maturity Period', 'USD', 'GBP', 'EURO'],
    ['1 year', '4.00', '4.10', '4.20'],
    ['2 years', '3.50', '3.60', '3.70'],
  ];
  const r = detectCurrencyColumnsLayout(grid);
  assert.ok(r);
  assert.equal(r.tenureCol, 0);
  assert.deepEqual(r.currencyCols.map((c) => c.currency), ['USD', 'GBP', 'EUR']);
});

test('detectCurrencyColumnsLayout: declines when only one currency col', () => {
  const grid = [
    ['Tenure', 'USD', 'Rate'],
    ['1 year', '4.0', '4.0'],
  ];
  const r = detectCurrencyColumnsLayout(grid);
  assert.equal(r, null);
});

// FCNR-2: amount-tier sub-header support

test('amountTierToDepositRange: "Below 1 million" → below_1mn', () => {
  assert.equal(amountTierToDepositRange('Below 1 million'), 'below_1mn');
});
test('amountTierToDepositRange: "1 million & above" → above_1mn', () => {
  assert.equal(amountTierToDepositRange('1 million & above'), 'above_1mn');
});
test('amountTierToDepositRange: ">= 1 million" → above_1mn', () => {
  assert.equal(amountTierToDepositRange('>= 1 million'), 'above_1mn');
});
test('amountTierToDepositRange: random text → null', () => {
  assert.equal(amountTierToDepositRange('GBP'), null);
  assert.equal(amountTierToDepositRange('Maturity Period'), null);
});

test('detectCurrencyColumnsLayout: Axis-shape USD subtier sub-header → deposit_range', () => {
  // Axis FCNR pattern: row 1 currency header (USD spans 2 cols), row 2
  // amount-tier sub-header under USD cols, row 3 onwards is data.
  const grid = [
    ['Interest Rates', 'w.e.f.', 'w.e.f.', 'w.e.f.', 'w.e.f.', 'w.e.f.', 'w.e.f.'],
    ['Maturity Period', 'USD', 'USD', 'GBP', 'EURO', 'AUD', 'CAD'],
    ['Maturity Period', 'Below 1 million', '1 million & above', 'GBP', 'EURO', 'AUD', 'CAD'],
    ['1 year < 2 years', '4.00', '4.10', '4.20', '1.65', '3.75', '2.30'],
  ];
  const r = detectCurrencyColumnsLayout(grid);
  assert.ok(r);
  assert.equal(r.headerRow, 1);
  assert.equal(r.dataStart, 3, 'sub-header at row 2 should bump dataStart');
  const usd1 = r.currencyCols.find((c) => c.col === 1);
  const usd2 = r.currencyCols.find((c) => c.col === 2);
  assert.equal(usd1.deposit_range, 'below_1mn');
  assert.equal(usd2.deposit_range, 'above_1mn');
});

test('tableToSlabs: Axis-shape USD subtier produces below_1mn / above_1mn slabs', () => {
  const t = makeTable(4, 7, [
    makeCell(0, 0, 'Interest Rates'),
    makeCell(0, 1, 'w.e.f.', 1, 6),
    makeCell(1, 0, 'Maturity Period', 2, 1),
    makeCell(1, 1, 'USD', 1, 2),
    makeCell(1, 3, 'GBP', 2, 1),
    makeCell(1, 4, 'EURO', 2, 1),
    makeCell(1, 5, 'AUD', 2, 1),
    makeCell(1, 6, 'CAD', 2, 1),
    makeCell(2, 1, 'Below 1 million'),
    makeCell(2, 2, '1 million & above'),
    makeCell(3, 0, '1 year < 2 years'),
    makeCell(3, 1, '4.00'),
    makeCell(3, 2, '4.10'),
    makeCell(3, 3, '4.20'),
    makeCell(3, 4, '1.65'),
    makeCell(3, 5, '3.75'),
    makeCell(3, 6, '2.30'),
  ]);
  const slabs = tableToSlabs(t, 'fcnr');
  // Need ≥ 2 tenure rows for the table to be accepted; this fixture has 1
  // (we add another below_1mn check on table with 2 rows). For 1 data row,
  // the table is rejected by the FCNR-2a guard. Use the 2-tenure variant
  // below for the slab assertions.
  // This test asserts the rejection-on-1-tenure-row behaviour.
  assert.equal(slabs.length, 0, 'single-tenure table should be rejected by FCNR-2a guard');
});

test('tableToSlabs: Axis-shape USD subtier with 2 tenures produces 12 properly-tagged slabs', () => {
  const t = makeTable(5, 7, [
    makeCell(0, 0, 'Interest Rates'),
    makeCell(0, 1, 'w.e.f.', 1, 6),
    makeCell(1, 0, 'Maturity Period', 2, 1),
    makeCell(1, 1, 'USD', 1, 2),
    makeCell(1, 3, 'GBP', 2, 1),
    makeCell(1, 4, 'EURO', 2, 1),
    makeCell(1, 5, 'AUD', 2, 1),
    makeCell(1, 6, 'CAD', 2, 1),
    makeCell(2, 1, 'Below 1 million'),
    makeCell(2, 2, '1 million & above'),
    makeCell(3, 0, '1 year < 2 years'),
    makeCell(3, 1, '4.00'),
    makeCell(3, 2, '4.10'),
    makeCell(3, 3, '4.20'),
    makeCell(3, 4, '1.65'),
    makeCell(3, 5, '3.75'),
    makeCell(3, 6, '2.30'),
    makeCell(4, 0, '2 years < 3 years'),
    makeCell(4, 1, '3.50'),
    makeCell(4, 2, '3.60'),
    makeCell(4, 3, '3.70'),
    makeCell(4, 4, '1.45'),
    makeCell(4, 5, '3.65'),
    makeCell(4, 6, '2.15'),
  ]);
  const slabs = tableToSlabs(t, 'fcnr');
  // 2 tenures × 6 currency-cols = 12 slabs
  assert.equal(slabs.length, 12);
  // USD <1M and ≥1M get separate deposit_range
  const usd1y_below = slabs.find((s) => s.currency === 'USD' && /1 year/i.test(s.tenure_text) && s.deposit_range === 'below_1mn');
  const usd1y_above = slabs.find((s) => s.currency === 'USD' && /1 year/i.test(s.tenure_text) && s.deposit_range === 'above_1mn');
  assert.ok(usd1y_below, 'USD below_1mn slab present');
  assert.ok(usd1y_above, 'USD above_1mn slab present');
  assert.equal(usd1y_below.rate_general_pct, 4.0);
  assert.equal(usd1y_above.rate_general_pct, 4.1);
  // Other currencies use default below_3cr
  const eur1y = slabs.find((s) => s.currency === 'EUR' && /1 year/i.test(s.tenure_text));
  assert.equal(eur1y.deposit_range, 'below_3cr');
});

test('tableToSlabs FCNR-2a guard: RFC-shape strip (1 data row of rate cells) yields 0 slabs', () => {
  // Axis Table[2] shape: 3 rows, last row is rate cells like "0.15%".
  // Pattern B detector triggers (5 currencies in row 1) but the guard
  // rejects the table because col-0 of every data row parses as a rate.
  const t = makeTable(3, 5, [
    makeCell(0, 0, 'Interest Rates w.e.f. ...'),
    makeCell(0, 1, 'Interest Rates w.e.f. ...'),
    makeCell(0, 2, 'Interest Rates w.e.f. ...'),
    makeCell(0, 3, 'Interest Rates w.e.f. ...'),
    makeCell(0, 4, 'Interest Rates w.e.f. ...'),
    makeCell(1, 0, 'USD'),
    makeCell(1, 1, 'GBP'),
    makeCell(1, 2, 'EUR'),
    makeCell(1, 3, 'AUD'),
    makeCell(1, 4, 'CAD'),
    makeCell(2, 0, '0.15%'),
    makeCell(2, 1, '0.15%'),
    makeCell(2, 2, '0.01%'),
    makeCell(2, 3, '0.30%'),
    makeCell(2, 4, '0.35%'),
  ]);
  const slabs = tableToSlabs(t, 'fcnr');
  assert.equal(slabs.length, 0, 'single-tenure rate-strip should not produce FCNR slabs');
});

// ── tableToSlabs Pattern B (cols=currencies) ────────────────────────

test('tableToSlabs: Axis-shape FCNR — cols=USD/GBP/EUR, rows=tenures, FCNR variant', () => {
  const t = makeTable(3, 4, [
    makeCell(0, 0, 'Maturity Period'),
    makeCell(0, 1, 'USD'),
    makeCell(0, 2, 'GBP'),
    makeCell(0, 3, 'EURO'),
    makeCell(1, 0, '1 year'),
    makeCell(1, 1, '4.00'),
    makeCell(1, 2, '4.10'),
    makeCell(1, 3, '4.20'),
    makeCell(2, 0, '2 years'),
    makeCell(2, 1, '3.50'),
    makeCell(2, 2, '3.60'),
    makeCell(2, 3, '3.70'),
  ]);
  const slabs = tableToSlabs(t, 'fcnr');
  // 2 tenures × 3 currencies = 6 slabs; EURO must be normalised to EUR
  assert.equal(slabs.length, 6);
  const eur1y = slabs.find((s) => s.currency === 'EUR' && /1 year/i.test(s.tenure_text));
  assert.ok(eur1y, 'EUR currency code normalised from EURO');
  assert.equal(eur1y.rate_general_pct, 4.2);
  const usd2y = slabs.find((s) => s.currency === 'USD' && /2 year/i.test(s.tenure_text));
  assert.equal(usd2y.rate_general_pct, 3.5);
});

// ── tableToSlabs: currency-keyed (FCNR) shape ───────────────────────

test('tableToSlabs: FCNR-shape, 2 currencies × 3 tenures = 6 slabs', () => {
  const t = makeTable(3, 4, [
    makeCell(0, 0, 'Currency'),
    makeCell(0, 1, '1 year'),
    makeCell(0, 2, '2 years'),
    makeCell(0, 3, '3 years'),
    makeCell(1, 0, 'USD'),
    makeCell(1, 1, '5.50%'),
    makeCell(1, 2, '5.60%'),
    makeCell(1, 3, '5.70%'),
    makeCell(2, 0, 'GBP'),
    makeCell(2, 1, '4.50%'),
    makeCell(2, 2, '4.60%'),
    makeCell(2, 3, '4.70%'),
  ]);
  const slabs = tableToSlabs(t, 'fcnr');
  assert.equal(slabs.length, 6);
  // Spot-check: USD at 2 years
  const usd2y = slabs.find((s) => s.currency === 'USD' && /2 year/i.test(s.tenure_text));
  assert.ok(usd2y);
  assert.equal(usd2y.rate_general_pct, 5.6);
  assert.equal(usd2y.rate_senior_pct, null);
  // GBP at 1 year
  const gbp1y = slabs.find((s) => s.currency === 'GBP' && /1 year/i.test(s.tenure_text));
  assert.ok(gbp1y);
  assert.equal(gbp1y.rate_general_pct, 4.5);
});

// ── extractViaOcr top-level ─────────────────────────────────────────

test('extractViaOcr: returns pages with slabs when tables present', async () => {
  const stubTable = makeTable(3, 2, [
    makeCell(0, 0, 'Tenure'),
    makeCell(0, 1, 'Rate'),
    makeCell(1, 0, '7 days'),
    makeCell(1, 1, '4.0%'),
    makeCell(2, 0, '14 days'),
    makeCell(2, 1, '4.5%'),
  ]);
  const out = await extractViaOcr({
    url: 'https://example.com/rate.jpg',
    variant: 'regular',
    _analyze: async () => makeAnalyzeResult({ tables: [stubTable] }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.extraction_method, 'automatic_ocr');
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].slabs.length, 2);
  assert.equal(out.pages[0].variant, 'regular');
});

test('extractViaOcr: returns empty pages with warning when no tables', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/marketing-banner.jpg',
    variant: 'regular',
    _analyze: async () => makeAnalyzeResult({ tables: [], pages: [{}] }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.pages.length, 0);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /no tables/i);
});

test('extractViaOcr: returns null when no url', async () => {
  const out = await extractViaOcr({ variant: 'regular' });
  assert.equal(out, null);
});

test('extractViaOcr: returns null when _analyze throws', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/x.jpg',
    variant: 'regular',
    _analyze: async () => { throw new Error('DI 429 rate limit'); },
  });
  assert.equal(out, null);
});

test('extractViaOcr: cost_pages reflects analyzed page count', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/rate.pdf',
    variant: 'regular',
    _analyze: async () => makeAnalyzeResult({ tables: [], pages: [{}, {}, {}] }),
  });
  assert.equal(out.cost_pages, 3);
});

test('extractViaOcr: only tables with extractable slabs become pages', async () => {
  const ratesTable = makeTable(2, 2, [
    makeCell(0, 0, 'Tenure'), makeCell(0, 1, 'Rate'),
    makeCell(1, 0, '1 year'), makeCell(1, 1, '6.5%'),
  ]);
  const textTable = makeTable(2, 2, [
    makeCell(0, 0, 'Note'), makeCell(0, 1, 'Description'),
    makeCell(1, 0, 'A'),    makeCell(1, 1, 'Some explanation'),
  ]);
  const out = await extractViaOcr({
    url: 'https://example.com/mixed.pdf',
    variant: 'regular',
    _analyze: async () => makeAnalyzeResult({ tables: [ratesTable, textTable] }),
  });
  assert.equal(out.pages.length, 1, 'only the rate-bearing table becomes a page');
});

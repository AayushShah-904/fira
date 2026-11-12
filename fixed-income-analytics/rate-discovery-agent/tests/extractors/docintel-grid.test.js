'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cellsToGrid,
  classifyColumns,
  parseRateCell,
  findHeaderRowIndex,
} = require('../../lib/extractors/_helpers/docintel-grid');

// --- cellsToGrid ---------------------------------------------------------

test('cellsToGrid: builds a 2D grid from cells with rowIndex/columnIndex', () => {
  const table = {
    rowCount: 2, columnCount: 3,
    cells: [
      { rowIndex: 0, columnIndex: 0, content: 'A' },
      { rowIndex: 0, columnIndex: 1, content: 'B' },
      { rowIndex: 0, columnIndex: 2, content: 'C' },
      { rowIndex: 1, columnIndex: 0, content: 'D' },
      { rowIndex: 1, columnIndex: 1, content: 'E' },
      { rowIndex: 1, columnIndex: 2, content: 'F' },
    ],
  };
  assert.deepEqual(cellsToGrid(table), [['A', 'B', 'C'], ['D', 'E', 'F']]);
});

test('cellsToGrid: spans copy content to every covered position', () => {
  const table = {
    rowCount: 2, columnCount: 3,
    cells: [
      { rowIndex: 0, columnIndex: 0, content: 'span', rowSpan: 2, columnSpan: 2 },
      { rowIndex: 0, columnIndex: 2, content: 'X' },
      { rowIndex: 1, columnIndex: 2, content: 'Y' },
    ],
  };
  assert.deepEqual(cellsToGrid(table), [['span', 'span', 'X'], ['span', 'span', 'Y']]);
});

test('cellsToGrid: empty/invalid input returns empty array', () => {
  assert.deepEqual(cellsToGrid(null), []);
  assert.deepEqual(cellsToGrid({}), []);
  assert.deepEqual(cellsToGrid({ rowCount: 0, columnCount: 0, cells: [] }), []);
});

// --- classifyColumns -----------------------------------------------------

test('classifyColumns: 3-col tenure/general/senior header', () => {
  const r = classifyColumns(['Period', 'Rate of Interest', 'Senior Citizen']);
  assert.equal(r.tenureCol, 0);
  assert.equal(r.generalCol, 1);
  assert.equal(r.seniorCol, 2);
});

test('classifyColumns: super-senior is classified BEFORE senior regex claims it', () => {
  const r = classifyColumns(['Tenure', 'General', 'Senior', 'Super Senior']);
  assert.equal(r.superSeniorCol, 3);
  assert.equal(r.seniorCol, 2);
});

test('classifyColumns: currency column detected', () => {
  const r = classifyColumns(['Tenure', 'USD', 'GBP', 'EUR']);
  assert.equal(r.tenureCol, 0);
  assert.ok(r.currencyCol >= 0);  // some currency col detected
});

test('classifyColumns: missing tenure or general returns -1', () => {
  const r = classifyColumns(['X', 'Y', 'Z']);
  assert.equal(r.tenureCol, -1);
  assert.equal(r.generalCol, -1);
});

// --- parseRateCell -------------------------------------------------------

test('parseRateCell: numeric strings parse correctly', () => {
  assert.equal(parseRateCell('6.50'), 6.5);
  assert.equal(parseRateCell('6.50%'), 6.5);
  assert.equal(parseRateCell('  7.25 % '), 7.25);
  assert.equal(parseRateCell('7'), 7);
});

test('parseRateCell: null / "-" / "n/a" return null', () => {
  assert.equal(parseRateCell(null), null);
  assert.equal(parseRateCell(''), null);
  assert.equal(parseRateCell('-'), null);
  assert.equal(parseRateCell('n/a'), null);
  assert.equal(parseRateCell('N/A'), null);
});

test('parseRateCell: non-numeric strings return null', () => {
  assert.equal(parseRateCell('see below'), null);
  assert.equal(parseRateCell('6.5 to 7.0'), null);
});

// --- findHeaderRowIndex --------------------------------------------------

test('findHeaderRowIndex: first non-percent row is the header', () => {
  const grid = [
    ['Period', 'Rate', 'Senior'],
    ['1y', '6.5%', '7.0%'],
    ['2y', '6.75%', '7.25%'],
  ];
  assert.equal(findHeaderRowIndex(grid), 0);
});

test('findHeaderRowIndex: skips an empty row 0 if it has no percent', () => {
  const grid = [
    ['Heading text', '', ''],   // no percent → header
    ['1y', '6.5%', '7.0%'],
  ];
  assert.equal(findHeaderRowIndex(grid), 0);
});

test('findHeaderRowIndex: defaults to 0 when every row has percent', () => {
  const grid = [['1y', '6.5%'], ['2y', '6.75%']];
  assert.equal(findHeaderRowIndex(grid), 0);
});

// --- IBU DocIntel integration via the IBU extractor ----------------------

test('IBU extractor DocIntel: USD-only PDF tags every slab with USD currency', () => {
  const ibu = require('../../lib/extractors/ibu-static-pdf-quarterly');
  const layout = {
    tables: [{
      rowCount: 4, columnCount: 2,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Tenure' },
        { rowIndex: 0, columnIndex: 1, content: 'USD Rate' },
        { rowIndex: 1, columnIndex: 0, content: '1 year to 2 years' },
        { rowIndex: 1, columnIndex: 1, content: '5.50' },
        { rowIndex: 2, columnIndex: 0, content: '2 years to 3 years' },
        { rowIndex: 2, columnIndex: 1, content: '5.40' },
        { rowIndex: 3, columnIndex: 0, content: '3 years to 5 years' },
        { rowIndex: 3, columnIndex: 1, content: '5.30' },
      ],
    }],
  };
  const r = ibu.extract({ docintelLayout: layout, productContext: { bank_code: 'hdfc-bank-ibu' } });
  assert.ok(r.slabs.length >= 2, `warnings=${JSON.stringify(r.warnings)}, diagnostics=${JSON.stringify(r.diagnostics)}`);
  for (const s of r.slabs) assert.equal(s.currency, 'USD');
  // "USD Rate" is now a currency column → handled by the matrix path.
  assert.equal(r.diagnostics.extractor_kind, 'ibu_static_pdf_docintel_matrix');
});

test('IBU extractor DocIntel: multi-currency PDF emits one slab per (tenure × currency)', () => {
  const ibu = require('../../lib/extractors/ibu-static-pdf-quarterly');
  const layout = {
    tables: [{
      rowCount: 2, columnCount: 4,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Tenure' },
        { rowIndex: 0, columnIndex: 1, content: 'USD' },
        { rowIndex: 0, columnIndex: 2, content: 'GBP' },
        { rowIndex: 0, columnIndex: 3, content: 'EUR' },
        { rowIndex: 1, columnIndex: 0, content: '1 year to 2 years' },
        { rowIndex: 1, columnIndex: 1, content: '5.50' },
        { rowIndex: 1, columnIndex: 2, content: '5.25' },
        { rowIndex: 1, columnIndex: 3, content: '3.10' },
      ],
    }],
  };
  const r = ibu.extract({ docintelLayout: layout, productContext: { bank_code: 'hdfc-bank-ibu' } });
  // 1 tenure × 3 currency columns → 3 slabs, each currency-tagged.
  assert.equal(r.slabs.length, 3, `diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.deepEqual(r.slabs.map((s) => s.currency).sort(), ['EUR', 'GBP', 'USD']);
  const usd = r.slabs.find((s) => s.currency === 'USD');
  assert.equal(usd.rate_general_pct, 5.5);
  assert.equal(r.diagnostics.extractor_kind, 'ibu_static_pdf_docintel_matrix');
});

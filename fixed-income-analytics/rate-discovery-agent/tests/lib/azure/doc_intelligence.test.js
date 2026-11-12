'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClient,
  analyzeUrl,
  analyzeBuffer,
  previewMetrics,
  isConfigured,
} = require('../../../lib/azure/doc_intelligence');

// --- isConfigured ---------------------------------------------------------

test('isConfigured returns true when both env vars are set', () => {
  const prevE = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const prevK = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  try {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = 'https://x.example';
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = 'k';
    assert.equal(isConfigured(), true);
  } finally {
    setOrDelete('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', prevE);
    setOrDelete('AZURE_DOCUMENT_INTELLIGENCE_KEY', prevK);
  }
});

test('isConfigured returns false when either env var is missing', () => {
  const prevE = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const prevK = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  try {
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    assert.equal(isConfigured(), false);
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = 'https://x.example';
    assert.equal(isConfigured(), false);
  } finally {
    setOrDelete('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', prevE);
    setOrDelete('AZURE_DOCUMENT_INTELLIGENCE_KEY', prevK);
  }
});

// --- buildClient ----------------------------------------------------------

test('buildClient throws DOCINTEL_NOT_CONFIGURED when env vars missing', () => {
  const prevE = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const prevK = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  try {
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    let caught = null;
    try { buildClient(); } catch (err) { caught = err; }
    assert.ok(caught, 'should have thrown');
    assert.equal(caught.code, 'DOCINTEL_NOT_CONFIGURED');
  } finally {
    setOrDelete('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', prevE);
    setOrDelete('AZURE_DOCUMENT_INTELLIGENCE_KEY', prevK);
  }
});

// --- analyzeUrl / analyzeBuffer with injected client ----------------------

test('analyzeUrl with injected client invokes beginAnalyzeDocumentFromUrl', async () => {
  let captured = null;
  const fakeClient = {
    beginAnalyzeDocumentFromUrl: async (model, url) => {
      captured = { model, url };
      return { pollUntilDone: async () => ({ tables: [], pages: [{ pageNumber: 1 }] }) };
    },
  };
  const r = await analyzeUrl({ url: 'https://x.example/rates.pdf', client: fakeClient });
  assert.deepEqual(captured, { model: 'prebuilt-layout', url: 'https://x.example/rates.pdf' });
  assert.deepEqual(r.pages, [{ pageNumber: 1 }]);
});

test('analyzeUrl rejects missing url', async () => {
  await assert.rejects(analyzeUrl({}), /url is required/);
});

test('analyzeBuffer with injected client invokes beginAnalyzeDocument', async () => {
  let captured = null;
  const fakeClient = {
    beginAnalyzeDocument: async (model, buf) => {
      captured = { model, bufLength: buf.length };
      return { pollUntilDone: async () => ({ tables: [{ rowCount: 3, columnCount: 3, cells: [] }], pages: [] }) };
    },
  };
  const buf = Buffer.from('FAKE_PDF_BYTES');
  const r = await analyzeBuffer({ pdfBuffer: buf, client: fakeClient });
  assert.deepEqual(captured, { model: 'prebuilt-layout', bufLength: buf.length });
  assert.equal(r.tables.length, 1);
});

test('analyzeBuffer rejects non-Buffer / empty input', async () => {
  await assert.rejects(analyzeBuffer({ pdfBuffer: null }), /non-empty Buffer/);
  await assert.rejects(analyzeBuffer({ pdfBuffer: Buffer.alloc(0) }), /non-empty Buffer/);
  await assert.rejects(analyzeBuffer({ pdfBuffer: 'not a buffer' }), /non-empty Buffer/);
});

// --- previewMetrics -------------------------------------------------------

test('previewMetrics returns zero counts for missing/malformed input', () => {
  assert.deepEqual(previewMetrics(null), { table_count: 0, total_rows: 0, total_cells: 0, page_count: 0 });
  assert.deepEqual(previewMetrics({}), { table_count: 0, total_rows: 0, total_cells: 0, page_count: 0 });
  assert.deepEqual(previewMetrics('not an object'), { table_count: 0, total_rows: 0, total_cells: 0, page_count: 0 });
});

test('previewMetrics tallies tables, rows, cells, pages correctly', () => {
  const m = previewMetrics({
    tables: [
      { rowCount: 5, columnCount: 3, cells: new Array(15).fill({}) },
      { rowCount: 7, columnCount: 4, cells: new Array(28).fill({}) },
    ],
    pages: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }],
  });
  assert.equal(m.table_count, 2);
  assert.equal(m.total_rows, 12);
  assert.equal(m.total_cells, 43);
  assert.equal(m.page_count, 3);
});

// --- helpers ---

function setOrDelete(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

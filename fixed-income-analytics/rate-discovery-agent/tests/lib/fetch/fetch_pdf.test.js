'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { fetchPdf, DEFAULT_MIN_SLABS_FOR_PDFJS, _internal } = require('../../../lib/fetch/fetch_pdf');

// --- Test helpers ---------------------------------------------------------

function mockHttp(body, statusCode = 200) {
  return {
    httpRequest: async () => ({
      statusCode,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from(body),
    }),
  };
}

/**
 * Mock spawn: returns an EventEmitter that emits 'data' on stdout with the
 * scripted text, then 'close' with the scripted exit code.
 */
function mockSpawn(stdoutText, exitCode = 0, stderrText = '') {
  return () => {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    setImmediate(() => {
      if (stdoutText) child.stdout.push(stdoutText);
      if (stderrText) child.stderr.push(stderrText);
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit('close', exitCode);
    });
    return child;
  };
}

function mockDocIntel({ isConfigured = true, layout = null, throws = false } = {}) {
  return {
    isConfigured: () => isConfigured,
    analyzeBuffer: async () => {
      if (throws) throw new Error('mock_docintel_error');
      return layout || {
        tables: [{ rowCount: 12, columnCount: 3, cells: new Array(36).fill({ content: 'x' }) }],
        pages: [{ pageNumber: 1 }],
      };
    },
    previewMetrics: (l) => ({
      table_count: (l.tables || []).length,
      total_rows: 12,
      total_cells: 36,
      page_count: (l.pages || []).length,
    }),
  };
}

// Build a realistic extract_rates_pdf.mjs stdout: a diagnostic text block, then
// the `=== JSON_OUTPUT ===` marker, then the pretty-printed JSON envelope.
function makeStdout(slabs, { effective_date = '2026-05-01', legacyMarker = false } = {}) {
  const diag = [
    'Reading: /tmp/foo.pdf (12345 bytes)',
    'Extracted text from 1 page(s)',
    '',
    '=== RESULTS ===',
    `Rate slabs parsed: ${slabs.length} across 1 page(s)`,
    '',
    '--- Parsed Rate Slabs ---',
    ...slabs.map((s) => `  p1 | ${s.tenure_text} | ${s.rate_general_pct}%`),
  ].join('\n');
  const envelope = {
    source: '/tmp/foo.pdf',
    bank_code: null,
    scraped_at: new Date().toISOString(),
    effective_date,
    rate_slabs: slabs,
    warnings: [],
    pages_data: [{ page_number: 1, variant_inferred: 'regular', slabs }],
    pages_count: 1,
  };
  const marker = legacyMarker ? 'JSON_OUTPUT:' : '=== JSON_OUTPUT ===';
  return `${diag}\n\n${marker}\n${JSON.stringify(envelope, null, 2)}\n`;
}

const RICH_SLABS = [
  { tenure_text: '7 days to 14 days', tenure_min_days: 7, tenure_max_days: 14, rate_general_pct: 3.50, rate_senior_pct: 4.00, rate_super_senior_pct: null },
  { tenure_text: '15 days to 30 days', tenure_min_days: 15, tenure_max_days: 30, rate_general_pct: 4.00, rate_senior_pct: 4.50, rate_super_senior_pct: null },
  { tenure_text: '31 days to 90 days', tenure_min_days: 31, tenure_max_days: 90, rate_general_pct: 5.00, rate_senior_pct: 5.50, rate_super_senior_pct: null },
  { tenure_text: '91 days to 180 days', tenure_min_days: 91, tenure_max_days: 180, rate_general_pct: 6.00, rate_senior_pct: 6.50, rate_super_senior_pct: null },
  { tenure_text: '181 days to 1 year', tenure_min_days: 181, tenure_max_days: 365, rate_general_pct: 6.50, rate_senior_pct: 7.00, rate_super_senior_pct: null },
  { tenure_text: '1 year to 2 years', tenure_min_days: 366, tenure_max_days: 730, rate_general_pct: 6.75, rate_senior_pct: 7.25, rate_super_senior_pct: null },
];

// Realistic stdout strings (diagnostic text + marker + JSON envelope).
const SAMPLE_RICH_PDFTEXT = makeStdout(RICH_SLABS);
const SAMPLE_THIN_PDFTEXT = makeStdout([]);

// --- Tests ----------------------------------------------------------------

test('pdfjs happy path: enough slabs → method=pdfjs, no DocIntel call', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(SAMPLE_RICH_PDFTEXT, 0),
    _docIntel: mockDocIntel({ isConfigured: true }),
  });
  assert.equal(r.method, 'pdfjs');
  assert.ok(r.slabsPreview >= DEFAULT_MIN_SLABS_FOR_PDFJS, `expected ≥${DEFAULT_MIN_SLABS_FOR_PDFJS} slabs, got ${r.slabsPreview}`);
  assert.equal(r.docIntelLayout, null);
  // Structured slabs surfaced from the JSON envelope (NOT re-parsed from text).
  assert.ok(Array.isArray(r.slabs));
  assert.equal(r.slabs.length, RICH_SLABS.length);
  assert.equal(r.slabsPreview, RICH_SLABS.length);
  assert.equal(r.effective_date, '2026-05-01');
  assert.ok(Array.isArray(r.pages_data));
  // pdfText is the clean PRE-marker diagnostic text (no JSON envelope leakage).
  assert.ok(!r.pdfText.includes('=== JSON_OUTPUT ==='));
  assert.ok(!r.pdfText.includes('scraped_at'));
});

test('pdfjs marker fix: 6 structured slabs → method=pdfjs, slabs length 6, slabsPreview 6', async () => {
  const six = RICH_SLABS.slice(0, 6);
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(makeStdout(six, { effective_date: '2026-04-01' }), 0),
    _docIntel: mockDocIntel({ isConfigured: true }),
  });
  assert.equal(r.method, 'pdfjs');
  assert.equal(r.slabs.length, 6);
  assert.equal(r.slabsPreview, 6);
  assert.equal(r.effective_date, '2026-04-01');
});

test('back-compat: legacy JSON_OUTPUT: marker still parsed', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(makeStdout(RICH_SLABS, { legacyMarker: true }), 0),
    _docIntel: mockDocIntel({ isConfigured: true }),
  });
  assert.equal(r.method, 'pdfjs');
  assert.equal(r.slabs.length, RICH_SLABS.length);
});

test('tolerance: no marker in stdout → slabs:[] and does not throw', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn('just some diagnostic text with no marker at all\n', 0),
    _docIntel: mockDocIntel({ isConfigured: false }),
  });
  // No marker → no structured slabs → too-few-slabs routing, but never throws.
  assert.deepEqual(r.slabs, []);
  assert.equal(r.slabsPreview, 0);
});

test('tolerance: marker present but malformed JSON → slabs:[], no throw', () => {
  const out = _internal.parseSubprocessStdout('diag\n=== JSON_OUTPUT ===\n{not valid json', { warn() {} });
  assert.equal(out.parsed, null);
  assert.equal(out.text, 'diag\n');
});

test('pdfjs too few slabs → DocIntel fallback fires', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(SAMPLE_THIN_PDFTEXT, 0),
    _docIntel: mockDocIntel({ isConfigured: true }),
  });
  assert.equal(r.method, 'doc_intelligence');
  assert.ok(r.docIntelLayout);
  assert.match(r.fallback_reason, /too_few_slabs/);
  assert.equal(r.doc_intel_metrics.table_count, 1);
});

test('multi_column hint forces DocIntel even with enough pdfjs slabs', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    hints: { multi_column: true },
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(SAMPLE_RICH_PDFTEXT, 0),
    _docIntel: mockDocIntel({ isConfigured: true }),
  });
  assert.equal(r.method, 'doc_intelligence');
  assert.match(r.fallback_reason, /multi_column/);
});

test('DocIntel not configured + too-few-slabs → returns pdfjs result with would_have_used note', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(SAMPLE_THIN_PDFTEXT, 0),
    _docIntel: mockDocIntel({ isConfigured: false }),
  });
  assert.equal(r.method, 'pdfjs');
  assert.match(r.fallback_reason, /would_have_used_doc_intel/);
});

test('DocIntel call throws → falls back to pdfjs result with chained reason', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(SAMPLE_THIN_PDFTEXT, 0),
    _docIntel: mockDocIntel({ isConfigured: true, throws: true }),
  });
  assert.equal(r.method, 'pdfjs');
  assert.match(r.fallback_reason, /doc_intel_then_failed/);
});

test('empty download → method=failed with error code', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/missing.pdf',
    _http: { httpRequest: async () => ({ statusCode: 200, body: '' }) },
    _spawn: mockSpawn('', 0),
    _docIntel: mockDocIntel(),
  });
  assert.equal(r.method, 'failed');
  assert.equal(r.error.code, 'empty_download');
});

test('http 404 → method=failed with http_error', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/missing.pdf',
    _http: mockHttp('FAKE_PDF_BYTES', 404),
    _spawn: mockSpawn('', 0),
    _docIntel: mockDocIntel(),
  });
  assert.equal(r.method, 'failed');
  assert.equal(r.error.code, 'http_error');
});

test('pdfjs subprocess crashes → DocIntel rescue path fires', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn('', 1, 'pdfjs internal error'),
    _docIntel: mockDocIntel({ isConfigured: true }),
  });
  assert.equal(r.method, 'doc_intelligence');
  assert.match(r.fallback_reason, /pdfjs_failed/);
});

test('forceDocIntel skips pdfjs entirely', async () => {
  const r = await fetchPdf({
    url: 'https://example.com/rates.pdf',
    forceDocIntel: true,
    _http: mockHttp('FAKE_PDF_BYTES'),
    _spawn: mockSpawn(SAMPLE_RICH_PDFTEXT, 0),  // would have worked if called
    _docIntel: mockDocIntel({ isConfigured: true }),
  });
  assert.equal(r.method, 'doc_intelligence');
  assert.match(r.fallback_reason, /force_doc_intel/);
});

test('missing url throws', async () => {
  await assert.rejects(fetchPdf({}), /url is required/);
  await assert.rejects(fetchPdf({ url: null }), /url is required/);
});

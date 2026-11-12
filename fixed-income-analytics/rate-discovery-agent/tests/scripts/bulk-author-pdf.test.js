'use strict';

/**
 * bulk-author PDF branch tests.
 *
 * Exercises processOne's PDF rate-card path (Sprint 006 wiring): a registry
 * entry whose rate_pages URL ends in .pdf takes the fetch_pdf → extractor →
 * quality-gate flow instead of HTML fetch/fingerprint/propose. fetchPdf is
 * mocked (via the _fetchPdf injection hook) so no network/DocIntel call fires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bulkAuthor = require('../../scripts/bulk-author');
const { processOne, persistEntry, targetTemplateKey, DEFAULT_GATES } = bulkAuthor;

// --- Synthetic DocIntel layouts -------------------------------------------

// A GIFT/IBU-style USD rate card. Header row carries the currency ("USD Rate")
// and a tenure column; six data rows of 1y+ tenures (FCNR/GIFT min is 1 year).
function giftLayout() {
  const cells = [];
  const push = (r, c, content) => cells.push({ rowIndex: r, columnIndex: c, content });
  // header
  push(0, 0, 'Tenure');
  push(0, 1, 'USD Rate');
  const rows = [
    ['1 year to 2 years', '5.25'],
    ['2 years to 3 years', '5.10'],
    ['3 years to 4 years', '4.90'],
    ['4 years to 5 years', '4.75'],
    ['5 years', '4.60'],
    ['1 year', '5.30'],
  ];
  rows.forEach((row, i) => {
    push(i + 1, 0, row[0]);
    push(i + 1, 1, row[1]);
  });
  return { tables: [{ rowCount: rows.length + 1, columnCount: 2, cells }], pages: [{ pageNumber: 1 }] };
}

// A domestic (PSB-style) 3-column rate card: tenure / general / senior.
function psbLayout() {
  const cells = [];
  const push = (r, c, content) => cells.push({ rowIndex: r, columnIndex: c, content });
  push(0, 0, 'Period');
  push(0, 1, 'General Rate');
  push(0, 2, 'Senior Citizen');
  const rows = [
    ['7 days to 45 days', '3.50', '4.00'],
    ['46 days to 179 days', '4.50', '5.00'],
    ['180 days to 1 year', '6.00', '6.50'],
    ['1 year to 2 years', '6.75', '7.25'],
    ['2 years to 3 years', '6.50', '7.00'],
    ['3 years to 5 years', '6.25', '6.75'],
  ];
  rows.forEach((row, i) => {
    push(i + 1, 0, row[0]);
    push(i + 1, 1, row[1]);
    push(i + 1, 2, row[2]);
  });
  return { tables: [{ rowCount: rows.length + 1, columnCount: 3, cells }], pages: [{ pageNumber: 1 }] };
}

function mockFetchPdf(layout) {
  return async () => ({
    method: 'doc_intelligence',
    pdfText: null,
    docIntelLayout: layout,
    slabsPreview: 0,
    fallback_reason: 'multi_column_hint_set',
  });
}

// --- Tests ----------------------------------------------------------------

test('PDF branch: -ibu slug + gift variant routes to ibu-static-pdf-quarterly with currency-tagged slabs', async () => {
  const registry = {
    'hdfc-bank-ibu': {
      domain: 'hdfcbank.com',
      rate_pages: { fd_gift: '/content/rates/gift-usd-rates.pdf' },
    },
  };
  const r = await processOne({
    bankInfo: { slug: 'hdfc-bank-ibu', name: 'HDFC Bank IBU', category: 'IFSC Banking Unit' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'gift',
    aggressiveFetch: true,
    gates: { ...DEFAULT_GATES, rate_min_pct: 0.0 }, // gift floor relaxed
    _fetchPdf: mockFetchPdf(giftLayout()),
  });

  assert.equal(r.is_pdf, true);
  assert.equal(r.pdf_extractor, 'ibu-static-pdf-quarterly');
  assert.equal(r.template_id, 'ibu-static-pdf-quarterly');
  assert.equal(r.pdf_method, 'doc_intelligence');
  assert.ok(typeof r.verdict === 'string', 'returns a verdict');
  assert.ok(r.slab_count >= 1, `expected currency slabs, got ${r.slab_count}`);
  // currency tagging asserted via the extractor diagnostics
  assert.equal(r.extract_diagnostics.dominant_currency, 'USD');
});

test('PDF branch: non-ibu regular PDF routes to psb-pdf-rate-card-3col', async () => {
  const registry = {
    'bank-of-baroda': {
      domain: 'bankofbaroda.in',
      rate_pages: { fd: 'https://bankofbaroda.in/rates/domestic-rate-card.pdf' },
    },
  };
  const r = await processOne({
    bankInfo: { slug: 'bank-of-baroda', name: 'Bank of Baroda', category: 'Public Sector Bank' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'regular',
    aggressiveFetch: true,
    gates: DEFAULT_GATES,
    _fetchPdf: mockFetchPdf(psbLayout()),
  });

  assert.equal(r.is_pdf, true);
  assert.equal(r.pdf_extractor, 'psb-pdf-rate-card-3col');
  assert.equal(r.template_id, 'psb-pdf-rate-card-3col');
  assert.ok(r.slab_count >= 5, `expected PSB slabs, got ${r.slab_count}`);
  // 6 in-range slabs, long tenure present → gates green (PASS) or yellow
  // (REVIEW, e.g. baseline-drop vs a captured baseline) but never FAIL.
  assert.notEqual(r.verdict, 'FAIL');
  assert.ok(['PASS', 'REVIEW'].includes(r.verdict));
  assert.match(r.template_hash, /^pdf:[0-9a-f]{40}$/);
});

test('PDF branch: structured .mjs slabs used directly for non-ibu regular bank', async () => {
  const registry = {
    'citibank-na': {
      domain: 'citigroup.com',
      rate_pages: { fd: 'https://citigroup.com/deposit-rate.pdf' },
    },
  };
  // Six valid domestic slabs as extract_rates_pdf.mjs would emit them: parsed
  // tenure bounds + general/senior rates, but NO source_row_text (the .mjs
  // doesn't emit it — processPdf must synthesize it to pass the anti-fab gate).
  const structuredSlabs = [
    { tenure_text: '7 days to 14 days', tenure_min_days: 7, tenure_max_days: 14, rate_general_pct: 3.50, rate_senior_pct: 4.00, rate_super_senior_pct: null },
    { tenure_text: '15 days to 45 days', tenure_min_days: 15, tenure_max_days: 45, rate_general_pct: 4.00, rate_senior_pct: 4.50, rate_super_senior_pct: null },
    { tenure_text: '46 days to 90 days', tenure_min_days: 46, tenure_max_days: 90, rate_general_pct: 5.00, rate_senior_pct: 5.50, rate_super_senior_pct: null },
    { tenure_text: '91 days to 180 days', tenure_min_days: 91, tenure_max_days: 180, rate_general_pct: 6.00, rate_senior_pct: 6.50, rate_super_senior_pct: null },
    { tenure_text: '181 days to 1 year', tenure_min_days: 181, tenure_max_days: 365, rate_general_pct: 6.50, rate_senior_pct: 7.00, rate_super_senior_pct: null },
    { tenure_text: '1 year to 2 years', tenure_min_days: 366, tenure_max_days: 730, rate_general_pct: 6.75, rate_senior_pct: 7.25, rate_super_senior_pct: null },
  ];
  const r = await processOne({
    bankInfo: { slug: 'citibank-na', name: 'Citibank N.A.', category: 'Foreign Bank' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'regular',
    aggressiveFetch: true,
    gates: DEFAULT_GATES,
    _fetchPdf: async () => ({
      method: 'pdfjs',
      slabs: structuredSlabs,
      slabsPreview: structuredSlabs.length,
      pdfText: 'diagnostic text',
      docIntelLayout: null,
      effective_date: '2026-05-01',
      pages_data: null,
    }),
  });

  assert.equal(r.is_pdf, true);
  // Structured fast-path: NOT routed to psb/ibu extractor.
  assert.equal(r.pdf_extractor, 'extract_rates_pdf.mjs');
  assert.equal(r.template_id, 'extract_rates_pdf.mjs');
  assert.equal(r.pdf_method, 'pdfjs');
  assert.equal(r.slab_count, 6);
  assert.equal(r.effective_date, '2026-05-01');
  assert.ok(typeof r.verdict === 'string', 'returns a verdict');
  assert.notEqual(r.verdict, 'FAIL', `expected non-FAIL, got ${r.verdict} (${(r.failures || []).join(',')})`);
  assert.match(r.template_hash, /^pdf:[0-9a-f]{40}$/);
});

test('PDF branch: gift variant still routes to ibu extractor even when .mjs returned slabs', async () => {
  const registry = {
    'hdfc-bank-ibu': {
      domain: 'hdfcbank.com',
      rate_pages: { fd_gift: 'https://hdfcbank.com/gift-usd.pdf' },
    },
  };
  // .mjs returned some INR-shaped slabs, but gift must use the currency-aware
  // ibu extractor over the DocIntel layout — NOT the structured fast-path.
  const r = await processOne({
    bankInfo: { slug: 'hdfc-bank-ibu', name: 'HDFC Bank IBU', category: 'IFSC Banking Unit' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'gift',
    aggressiveFetch: true,
    gates: { ...DEFAULT_GATES, rate_min_pct: 0.0 },
    _fetchPdf: async () => ({
      method: 'doc_intelligence',
      slabs: [{ tenure_text: '1 year', tenure_min_days: 366, tenure_max_days: null, rate_general_pct: 5.3, rate_senior_pct: null, rate_super_senior_pct: null }],
      slabsPreview: 1,
      pdfText: null,
      docIntelLayout: giftLayout(),
      effective_date: null,
    }),
  });
  assert.equal(r.pdf_extractor, 'ibu-static-pdf-quarterly');
  assert.equal(r.extract_diagnostics.dominant_currency, 'USD');
});

test('PDF branch: gift fallback uses .mjs slabs + currency tag when ibu extractor yields 0', async () => {
  // axis/hdfc/idfc IBU layouts: the ibu extractor's column classifier returns
  // 0 slabs (modelled here by a layout with no readable rate table), but
  // extract_rates_pdf.mjs (via fetch_pdf) parsed 6 USD-range slabs. The gift
  // fallback must recover them, detect USD from the layout content, tag every
  // slab, and gate non-FAIL.
  const registry = {
    'axis-bank-ibu': { domain: 'axisbank.com', rate_pages: { fd_gift: 'https://axisbank.com/gift-usd.pdf' } },
  };
  // No tables → ibu DocIntel path yields 0; .mjs slabs carry the real data.
  const noTableLayout = {
    content: 'Axis Bank GIFT City IBU Deposit Rates (USD) w.e.f. 01-May-2026',
    tables: [],
    pages: [],
  };
  const mjsSlabs = [
    { tenure_text: '1 year to 18 months', tenure_min_days: 366, tenure_max_days: 547, rate_general_pct: 3.80, rate_senior_pct: null, rate_super_senior_pct: null },
    { tenure_text: '18 months to 2 years', tenure_min_days: 548, tenure_max_days: 730, rate_general_pct: 3.70, rate_senior_pct: null, rate_super_senior_pct: null },
    { tenure_text: '2 years to 3 years', tenure_min_days: 731, tenure_max_days: 1095, rate_general_pct: 3.60, rate_senior_pct: null, rate_super_senior_pct: null },
    { tenure_text: '3 years to 4 years', tenure_min_days: 1096, tenure_max_days: 1460, rate_general_pct: 3.50, rate_senior_pct: null, rate_super_senior_pct: null },
    { tenure_text: '4 years to 5 years', tenure_min_days: 1461, tenure_max_days: 1825, rate_general_pct: 3.40, rate_senior_pct: null, rate_super_senior_pct: null },
    { tenure_text: '5 years', tenure_min_days: 1826, tenure_max_days: null, rate_general_pct: 3.30, rate_senior_pct: null, rate_super_senior_pct: null },
  ];
  const r = await processOne({
    bankInfo: { slug: 'axis-bank-ibu', name: 'Axis Bank IBU', category: 'IFSC Banking Unit' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'gift',
    aggressiveFetch: true,
    gates: { ...DEFAULT_GATES, rate_min_pct: 0.0 },
    _fetchPdf: async () => ({
      method: 'doc_intelligence',
      slabs: mjsSlabs,
      slabsPreview: mjsSlabs.length,
      pdfText: '(diagnostics)',
      docIntelLayout: noTableLayout,
      effective_date: '2026-05-01',
    }),
  });

  assert.equal(r.is_pdf, true);
  assert.equal(r.pdf_extractor, 'extract_rates_pdf.mjs+currency', 'fallback path used');
  assert.equal(r.slab_count, 6);
  assert.equal(r.effective_date, '2026-05-01');
  assert.equal(r.extract_diagnostics.dominant_currency, 'USD');
  assert.notEqual(r.verdict, 'FAIL', `expected non-FAIL, got ${r.verdict} (${(r.failures || []).join(',')})`);
});

test('PDF branch: gift fallback with NO currency token → currency null + currency_undetected warning (REVIEW)', async () => {
  const registry = {
    'mystery-bank-ibu': { domain: 'mystery.com', rate_pages: { fd_gift: 'https://mystery.com/gift.pdf' } },
  };
  const noCcyLayout = { content: 'Offshore Deposit Rates w.e.f. 01-May-2026 (rates in percent)', tables: [], pages: [] };
  const mjsSlabs = [
    { tenure_text: '1 year to 2 years', tenure_min_days: 366, tenure_max_days: 730, rate_general_pct: 3.80, rate_senior_pct: null, rate_super_senior_pct: null },
    { tenure_text: '2 years to 3 years', tenure_min_days: 731, tenure_max_days: 1095, rate_general_pct: 3.60, rate_senior_pct: null, rate_super_senior_pct: null },
    { tenure_text: '3 years to 5 years', tenure_min_days: 1096, tenure_max_days: 1825, rate_general_pct: 3.40, rate_senior_pct: null, rate_super_senior_pct: null },
  ];
  const r = await processOne({
    bankInfo: { slug: 'mystery-bank-ibu', name: 'Mystery Bank IBU', category: 'IFSC Banking Unit' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'gift',
    aggressiveFetch: true,
    gates: { ...DEFAULT_GATES, rate_min_pct: 0.0 },
    _fetchPdf: async () => ({
      method: 'doc_intelligence',
      slabs: mjsSlabs,
      slabsPreview: mjsSlabs.length,
      pdfText: '(diagnostics)',
      docIntelLayout: noCcyLayout,
      effective_date: '2026-05-01',
    }),
  });

  assert.equal(r.pdf_extractor, 'extract_rates_pdf.mjs+currency', 'fallback path used');
  assert.equal(r.slab_count, 3);
  assert.equal(r.extract_diagnostics.dominant_currency, null);
  assert.ok(r.warnings.some((w) => /currency_undetected/.test(w)), `expected currency_undetected warning, got ${JSON.stringify(r.warnings)}`);
  assert.equal(r.verdict, 'REVIEW');
});

test('PDF branch: failed fetch returns FAIL with pdf_fetch_failed error', async () => {
  const registry = {
    'some-bank': { domain: 'x.com', rate_pages: { fd: 'https://x.com/rates.pdf' } },
  };
  const r = await processOne({
    bankInfo: { slug: 'some-bank' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'regular',
    aggressiveFetch: true,
    gates: DEFAULT_GATES,
    _fetchPdf: async () => ({ method: 'failed', pdfText: null, docIntelLayout: null, error: { code: 'http_error' } }),
  });
  assert.equal(r.is_pdf, true);
  assert.equal(r.verdict, 'FAIL');
  assert.match(r.error, /pdf_fetch_failed: http_error/);
});

test('PDF branch: zero-cell DocIntel (image PDF / OCR gap) FAILs gracefully with zero_slabs', async () => {
  const registry = {
    'axis-bank-ibu': { domain: 'axisbank.com', rate_pages: { fd_gift: 'https://axisbank.com/gift.pdf' } },
  };
  const emptyLayout = { tables: [{ rowCount: 0, columnCount: 0, cells: [] }], pages: [{ pageNumber: 1 }] };
  const r = await processOne({
    bankInfo: { slug: 'axis-bank-ibu' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    variant: 'gift',
    aggressiveFetch: true,
    gates: { ...DEFAULT_GATES, rate_min_pct: 0.0 },
    _fetchPdf: mockFetchPdf(emptyLayout),
  });
  assert.equal(r.is_pdf, true);
  assert.equal(r.pdf_extractor, 'ibu-static-pdf-quarterly');
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.failures.includes('zero_slabs'));
});

test('persistEntry branches on is_pdf → scraper_type=pdf template block', () => {
  const registry = { 'hdfc-bank-ibu': { domain: 'hdfcbank.com', rate_pages: { fd_gift: '/g.pdf' } } };
  const result = {
    is_pdf: true,
    variant: 'gift',
    template_id: 'ibu-static-pdf-quarterly',
    template_hash: 'pdf:abc123',
    slab_count: 6,
    pdf_method: 'doc_intelligence',
  };
  persistEntry(registry, 'hdfc-bank-ibu', registry['hdfc-bank-ibu'], result);
  const tmpl = registry['hdfc-bank-ibu'].template;
  assert.equal(tmpl.scraper_type, 'pdf');
  assert.equal(tmpl.template_id, 'ibu-static-pdf-quarterly');
  assert.equal(tmpl.extract.extractor, 'ibu-static-pdf-quarterly');
  assert.equal(tmpl.extract.column_map, undefined); // no column_map for PDF
  assert.equal(tmpl.audit.source, 'pdf');
  assert.equal(tmpl.audit.pdf_method, 'doc_intelligence');
  assert.equal(tmpl.audit.persisted_by, 'bulk-author');
  assert.ok(tmpl.variants.gift, 'gift variant key present');
});

test('persistEntry: fcnr on a domestic-template bank writes template_fcnr and leaves template byte-intact', () => {
  // A bank that already has a DOMESTIC (regular) template — exactly the clobber
  // hazard. Persisting an fcnr result must NOT touch entry.template.
  const domesticTemplate = {
    template_id: 'fb-3col-regular-general-senior',
    template_hash: 'domestichash',
    fingerprinted_at: '2026-05-01',
    fetch: { expand_accordions: false },
    extract: { extractor: '_generic-html-3col', extracts: [{ table: 'table.dom', rows: 'tr' }] },
    variants: { regular: { rate_page_key: 'fd' } },
    audit: { persisted_by: 'bulk-author', verdict_at: '2026-05-01T00:00:00Z', gates_passed: 'PASS', slab_count: 11 },
  };
  const registry = {
    'federal-bank-limited': {
      domain: 'federalbank.co.in',
      rate_pages: { fd: '/fd-rates', fd_fcnr: '/fcnr-b-deposits' },
      template: domesticTemplate,
    },
  };
  // Snapshot the domestic template byte-for-byte BEFORE persisting fcnr.
  const before = JSON.stringify(registry['federal-bank-limited'].template);

  const fcnrResult = {
    variant: 'fcnr',
    template_id: 'fcnr-currency-crossproduct',
    template_hash: 'fcnrhash',
    extracts: [{ table: 'table.fcnr', rows: 'tr' }],
    slab_count: 20,
    fetch_used: { wait_for_network_idle: true },
  };
  const key = persistEntry(registry, 'federal-bank-limited', registry['federal-bank-limited'], fcnrResult);

  assert.equal(key, 'template_fcnr', 'persistEntry returns the routed key');
  const entry = registry['federal-bank-limited'];
  // Domestic template untouched, byte-identical.
  assert.equal(JSON.stringify(entry.template), before, 'domestic template clobbered!');
  // New fcnr block exists under template_fcnr.
  assert.ok(entry.template_fcnr, 'template_fcnr block present');
  assert.equal(entry.template_fcnr.template_id, 'fcnr-currency-crossproduct');
  assert.equal(entry.template_fcnr.audit.persisted_by, 'bulk-author');
  // The fcnr block's variants map describes ONLY fcnr — it did NOT inherit
  // the domestic {regular} map.
  assert.deepEqual(entry.template_fcnr.variants, { fcnr: { rate_page_key: 'fd_fcnr' } });
  assert.equal(entry.template_fcnr.variants.regular, undefined);
});

test('persistEntry: gift on a gift-only entry (no regular template) still writes template', () => {
  // A gift-only IBU with no pre-existing regular template — the foreign-currency
  // product IS the primary template here, so it must land on `template`.
  const registry = {
    'hdfc-bank-ibu': {
      domain: 'hdfcbank.com',
      rate_pages: { fd_gift: '/gift-usd-rates' },
    },
  };
  const giftResult = {
    variant: 'gift',
    template_id: 'gift-currency-crossproduct',
    template_hash: 'gifthash',
    extracts: [{ table: 'table.gift', rows: 'tr' }],
    slab_count: 12,
    fetch_used: {},
  };
  const key = persistEntry(registry, 'hdfc-bank-ibu', registry['hdfc-bank-ibu'], giftResult);

  assert.equal(key, 'template', 'gift-only entry routes to template');
  const entry = registry['hdfc-bank-ibu'];
  assert.ok(entry.template, 'template block present');
  assert.equal(entry.template_gift, undefined, 'no separate template_gift for a gift-only bank');
  assert.equal(entry.template.template_id, 'gift-currency-crossproduct');
  assert.deepEqual(entry.template.variants, { gift: { rate_page_key: 'fd_gift' } });
});

test('targetTemplateKey: routing matrix', () => {
  const domestic = { template: { variants: { regular: { rate_page_key: 'fd' } } } };
  assert.equal(targetTemplateKey(domestic, 'fcnr'), 'template_fcnr');
  assert.equal(targetTemplateKey(domestic, 'gift'), 'template_gift');
  assert.equal(targetTemplateKey(domestic, 'regular'), 'template');
  // gift-only / fcnr-primary (no regular) → template
  assert.equal(targetTemplateKey({}, 'gift'), 'template');
  assert.equal(targetTemplateKey({ template: { variants: { fcnr: {} } } }, 'fcnr'), 'template');
  // entry with no template at all
  assert.equal(targetTemplateKey({ rate_pages: {} }, 'fcnr'), 'template');
});

test('persistEntry HTML path unchanged (no scraper_type, has column extracts)', () => {
  const registry = { 'foo-bank': { domain: 'foo.com', rate_pages: { fd: '/r' } } };
  const result = {
    template_id: 'generic-3col',
    template_hash: 'deadbeef',
    extracts: [{ table: 'table', rows: 'tr' }],
    slab_count: 7,
    fetch_used: {},
  };
  persistEntry(registry, 'foo-bank', registry['foo-bank'], result);
  const tmpl = registry['foo-bank'].template;
  assert.equal(tmpl.scraper_type, undefined);
  assert.equal(tmpl.extract.extractor, '_generic-html-3col');
  assert.ok(Array.isArray(tmpl.extract.extracts));
});

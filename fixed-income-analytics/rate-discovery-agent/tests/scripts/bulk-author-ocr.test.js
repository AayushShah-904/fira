'use strict';

/**
 * bulk-author OCR (image) branch tests.
 *
 * Exercises processOne's image rate-card path: a registry entry whose
 * rate_pages URL ends in .jpg/.png (or whose scraper_type is 'image') takes the
 * extract_via_ocr → DocIntel Layout → quality-gate flow instead of HTML
 * fetch/fingerprint/propose. extractViaOcr is mocked (via the _extractViaOcr
 * injection hook) so no network/DocIntel call fires. Pattern mirrors
 * bulk-author-pdf.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bulkAuthor = require('../../scripts/bulk-author');
const { processOne, processOcr, persistEntry, IMG_RE, DEFAULT_GATES } = bulkAuthor;

// Five valid domestic FD slabs, shaped as extract_via_ocr emits them inside
// pages[].slabs (no source_row_text — processOcr must synthesize it for the
// strict anti-fab gate).
function fiveSlabs() {
  return [
    { tenure_text: '15 to 45 days', tenure_min_days: 15, tenure_max_days: 45, rate_general_pct: 3.75, rate_senior_pct: null, rate_super_senior_pct: null, deposit_range: 'below_3cr' },
    { tenure_text: '46 to 179 days', tenure_min_days: 46, tenure_max_days: 179, rate_general_pct: 5.75, rate_senior_pct: null, rate_super_senior_pct: null, deposit_range: 'below_3cr' },
    { tenure_text: '180 to 364 days', tenure_min_days: 180, tenure_max_days: 364, rate_general_pct: 6.25, rate_senior_pct: null, rate_super_senior_pct: null, deposit_range: 'below_3cr' },
    { tenure_text: '1 year to 2 years', tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 7.05, rate_senior_pct: null, rate_super_senior_pct: null, deposit_range: 'below_3cr' },
    { tenure_text: '2 years to 3 years', tenure_min_days: 730, tenure_max_days: 1095, rate_general_pct: 7.25, rate_senior_pct: null, rate_super_senior_pct: null, deposit_range: 'below_3cr' },
  ];
}

function mockOcr(slabs, extra = {}) {
  return async () => ({
    ok: true,
    pages: [{ page_number: 1, product_type: 'FD', variant: 'regular', effective_date: null, slabs, warnings: [], confidence: 'medium' }],
    extraction_method: 'automatic_ocr',
    cost_pages: 1,
    ...extra,
  });
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

// --- IMG_RE -----------------------------------------------------------------

test('IMG_RE matches image extensions, not html/pdf', () => {
  assert.ok(IMG_RE.test('https://x.bank.in/rates.jpg'));
  assert.ok(IMG_RE.test('https://x.bank.in/rates.JPEG'));
  assert.ok(IMG_RE.test('https://x.bank.in/a/b/gallery_248.png'));
  assert.ok(IMG_RE.test('https://x.bank.in/r.webp?v=2'));
  assert.equal(IMG_RE.test('https://x.bank.in/rates.pdf'), false);
  assert.equal(IMG_RE.test('https://x.bank.in/interest-rate'), false);
});

// --- processOcr -------------------------------------------------------------

test('OCR branch: image URL flattens pages[].slabs, gates, is_ocr + slab_count 5', async () => {
  const registry = {
    'janalaxmi-co-operative-bank-ltd-nashik': {
      domain: 'janalaxmi.bank.in',
      rate_pages: { fd: 'https://janalaxmi.bank.in/assets/uploads/gallery/gallery_248.jpg' },
    },
  };
  const r = await processOne({
    bankInfo: { slug: 'janalaxmi-co-operative-bank-ltd-nashik', name: 'Janalaxmi Co-op Bank', category: 'Non-Scheduled Urban Co-operative Bank' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: quietLog,
    variant: 'regular',
    aggressiveFetch: true,
    gates: DEFAULT_GATES,
    _extractViaOcr: mockOcr(fiveSlabs()),
  });

  assert.equal(r.is_ocr, true);
  assert.equal(r.template_id, 'extract_via_ocr');
  assert.match(r.template_hash, /^ocr:[0-9a-f]{40}$/);
  assert.equal(r.slab_count, 5);
  assert.equal(r.extraction_method, 'automatic_ocr');
  // 5 in-range slabs, long tenure present → never FAIL.
  assert.notEqual(r.verdict, 'FAIL', `expected non-FAIL, got ${r.verdict} (${(r.failures || []).join(',')})`);
  assert.ok(['PASS', 'REVIEW'].includes(r.verdict));
});

test('OCR branch: scraper_type:image entry on a non-image URL still takes OCR path', async () => {
  const registry = {
    'some-image-bank': {
      domain: 'x.bank.in',
      scraper_type: 'image',
      rate_pages: { fd: 'https://x.bank.in/interest-rate' }, // NOT an image extension
    },
  };
  const r = await processOne({
    bankInfo: { slug: 'some-image-bank' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: quietLog,
    variant: 'regular',
    aggressiveFetch: true,
    gates: DEFAULT_GATES,
    _extractViaOcr: mockOcr(fiveSlabs()),
  });
  assert.equal(r.is_ocr, true);
  assert.equal(r.slab_count, 5);
});

test('OCR branch: null result (DI failed) → FAIL ocr_no_slabs', async () => {
  const registry = {
    'broken-img-bank': { domain: 'x.bank.in', rate_pages: { fd: 'https://x.bank.in/rate.jpg' } },
  };
  const r = await processOne({
    bankInfo: { slug: 'broken-img-bank' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: quietLog,
    variant: 'regular',
    aggressiveFetch: true,
    gates: DEFAULT_GATES,
    _extractViaOcr: async () => null,
  });
  assert.equal(r.is_ocr, true);
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.error, 'ocr_no_slabs');
  assert.equal(r.slab_count, 0);
});

test('OCR branch: empty pages (no rate table on image) → FAIL ocr_no_slabs', async () => {
  const registry = {
    'no-table-bank': { domain: 'x.bank.in', rate_pages: { fd: 'https://x.bank.in/banner.jpg' } },
  };
  const r = await processOne({
    bankInfo: { slug: 'no-table-bank' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: quietLog,
    variant: 'regular',
    aggressiveFetch: true,
    gates: DEFAULT_GATES,
    _extractViaOcr: async () => ({ ok: true, pages: [], extraction_method: 'automatic_ocr', cost_pages: 1, warnings: ['No tables detected'] }),
  });
  assert.equal(r.is_ocr, true);
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.error, 'ocr_no_slabs');
});

test('OCR branch: currency carried through for gift/fcnr image slabs', async () => {
  const registry = {
    'some-ibu': { domain: 'x.bank.in', rate_pages: { fd_gift: 'https://x.bank.in/gift-usd.png' } },
  };
  const giftSlabs = fiveSlabs().map((s) => ({ ...s, rate_senior_pct: null, currency: 'USD' }));
  const r = await processOne({
    bankInfo: { slug: 'some-ibu', category: 'IFSC Banking Unit' },
    registry,
    clusterCache: new Map(),
    llmCallCounter: { count: 0, ms: 0 },
    log: quietLog,
    variant: 'gift',
    aggressiveFetch: true,
    gates: { ...DEFAULT_GATES, rate_min_pct: 0.0 },
    _extractViaOcr: mockOcr(giftSlabs),
  });
  assert.equal(r.is_ocr, true);
  assert.equal(r.slab_count, 5);
});

// --- persistOcrEntry --------------------------------------------------------

test('persistEntry branches on is_ocr → scraper_type=image template block', () => {
  const registry = { 'img-bank': { domain: 'x.bank.in', rate_pages: { fd: '/rate.jpg' } } };
  const result = {
    is_ocr: true,
    variant: 'regular',
    template_id: 'extract_via_ocr',
    template_hash: 'ocr:abc123',
    slab_count: 9,
    ocr_confidence: 'medium',
  };
  const key = persistEntry(registry, 'img-bank', registry['img-bank'], result);
  assert.equal(key, 'template');
  const tmpl = registry['img-bank'].template;
  assert.equal(tmpl.scraper_type, 'image');
  assert.equal(tmpl.template_id, 'extract_via_ocr');
  assert.equal(tmpl.extract.extractor, 'extract_via_ocr');
  assert.equal(tmpl.extract.column_map, undefined); // no column_map for image
  assert.equal(tmpl.extraction_method, 'automatic_ocr');
  assert.equal(tmpl.audit.source, 'ocr');
  assert.equal(tmpl.audit.persisted_by, 'bulk-author');
  assert.ok(tmpl.variants.regular, 'regular variant key present');
  assert.equal(tmpl.variants.regular.rate_page_key, 'fd');
});

test('persistEntry: gift image on a domestic-template bank writes template_gift, leaves template intact', () => {
  const domesticTemplate = {
    template_id: 'fb-3col', template_hash: 'domhash', fingerprinted_at: '2026-05-01',
    extract: { extractor: '_generic-html-3col', extracts: [{ table: 'table.dom', rows: 'tr' }] },
    variants: { regular: { rate_page_key: 'fd' } },
    audit: { persisted_by: 'bulk-author', gates_passed: 'PASS', slab_count: 11 },
  };
  const registry = {
    'big-ibu': { domain: 'x.bank.in', rate_pages: { fd: '/fd', fd_gift: '/gift.jpg' }, template: domesticTemplate },
  };
  const before = JSON.stringify(registry['big-ibu'].template);
  const key = persistEntry(registry, 'big-ibu', registry['big-ibu'], {
    is_ocr: true, variant: 'gift', template_id: 'extract_via_ocr', template_hash: 'ocr:def', slab_count: 6, ocr_confidence: 'medium',
  });
  assert.equal(key, 'template_gift');
  assert.equal(JSON.stringify(registry['big-ibu'].template), before, 'domestic template clobbered!');
  assert.equal(registry['big-ibu'].template_gift.scraper_type, 'image');
  assert.deepEqual(registry['big-ibu'].template_gift.variants, { gift: { rate_page_key: 'fd_gift' } });
});

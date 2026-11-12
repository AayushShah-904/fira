'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldReattempt, reattemptOne, FLAG_NAME } = require('../../../lib/orchestrator/reattempt');

// --- shouldReattempt ------------------------------------------------------

function withFlag(value, fn) {
  const prev = process.env[FLAG_NAME];
  process.env[FLAG_NAME] = value;
  try { return fn(); }
  finally { if (prev == null) delete process.env[FLAG_NAME]; else process.env[FLAG_NAME] = prev; }
}

test('shouldReattempt: flag off → ineligible regardless of state', () => {
  const r = shouldReattempt({
    config: { scraper_type: null, rate_pages: { fd: '/x' } },
    rates: { rate_slabs: [] },
    env: '0',
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /not set/);
});

test('shouldReattempt: flag on + null scraper_type + empty rates + config has rate_page → eligible', () => {
  const r = shouldReattempt({
    config: { scraper_type: null, rate_pages: { fd: '/x' } },
    rates: { rate_slabs: [] },
    env: '1',
  });
  assert.equal(r.eligible, true);
  assert.match(r.reason, /re-attempt/);
  assert.equal(r.signals.flag_on, true);
});

test('shouldReattempt: flag on + scraper_type=unknown → eligible', () => {
  const r = shouldReattempt({
    config: { scraper_type: 'unknown', rate_pages: { fd: '/x' } },
    rates: { rate_slabs: [] },
    env: '1',
  });
  assert.equal(r.eligible, true);
});

test('shouldReattempt: flag on + bank already has rates → ineligible (do not re-overwrite)', () => {
  const r = shouldReattempt({
    config: { scraper_type: null, rate_pages: { fd: '/x' } },
    rates: { rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }] },
    env: '1',
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /rates already extracted/);
});

test('shouldReattempt: no config → ineligible (never attempted; needs full discovery)', () => {
  const r = shouldReattempt({ config: null, rates: null, env: '1' });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no config/);
});

test('shouldReattempt: no rate_pages declared → ineligible', () => {
  const r = shouldReattempt({
    config: { scraper_type: null, rate_pages: {} },
    rates: { rate_slabs: [] },
    env: '1',
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no rate_pages/);
});

test('shouldReattempt: scraper_type=manual → ineligible (operator-curated; do not auto-rerun)', () => {
  const r = shouldReattempt({
    config: { scraper_type: 'manual', rate_pages: { fd: '/x' } },
    rates: { rate_slabs: [] },
    env: '1',
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /scraper_type="manual"/);
});

test('shouldReattempt: scraper_type=html_js with no rates → ineligible (use author-template.js)', () => {
  const r = shouldReattempt({
    config: { scraper_type: 'html_js', rate_pages: { fd: '/x' } },
    rates: { rate_slabs: [] },
    env: '1',
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /author-template/);
});

test('shouldReattempt: respects FLAG_NAME env var when env not passed', () => {
  withFlag('1', () => {
    const r = shouldReattempt({
      config: { scraper_type: null, rate_pages: { fd: '/x' } },
      rates: { rate_slabs: [] },
    });
    assert.equal(r.eligible, true);
  });
  withFlag('0', () => {
    const r = shouldReattempt({
      config: { scraper_type: null, rate_pages: { fd: '/x' } },
      rates: { rate_slabs: [] },
    });
    assert.equal(r.eligible, false);
  });
});

// --- reattemptOne ---------------------------------------------------------

test('reattemptOne: fetch succeeds + extractor produces slabs → status=recovered', async () => {
  const fakeFetch = async () => ({
    status: 'success',
    html: '<html><body><table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1y</td><td>6.5%</td></tr></table></body></html>',
    final_strategy: 'default',
  });
  const fakeDispatch = () => ({
    extractor: () => ({ slabs: [{ tenure_text: '1y', rate_general_pct: 6.5, source_row_text: '1y 6.5%' }], diagnostics: {}, warnings: [] }),
    template_id: 'mock',
    resolution: 'registry',
  });
  const r = await reattemptOne({
    bank_code: 'test-bank',
    config: { rate_page_urls: { fd: 'https://test.example/rates' } },
    _fetchHtml: fakeFetch,
    _pickExtractor: fakeDispatch,
  });
  assert.equal(r.status, 'recovered');
  assert.equal(r.slabs.length, 1);
});

test('reattemptOne: fetch fails → status=fetch_failed', async () => {
  const fakeFetch = async () => ({ status: 'failed', html: null, final_strategy: 'llm-fallback' });
  const r = await reattemptOne({
    bank_code: 'test-bank',
    config: { rate_page_urls: { fd: 'https://test.example/rates' } },
    _fetchHtml: fakeFetch,
    _pickExtractor: () => ({ extractor: () => ({ slabs: [] }) }),
  });
  assert.equal(r.status, 'fetch_failed');
  assert.equal(r.slabs.length, 0);
});

test('reattemptOne: no extractor matched → status=no_extractor', async () => {
  const fakeFetch = async () => ({ status: 'success', html: '<html></html>' });
  const fakeDispatch = () => ({ extractor: null, resolution: 'unresolved', reason: 'no template_id' });
  const r = await reattemptOne({
    bank_code: 'test-bank',
    config: { rate_page_urls: { fd: 'https://test.example/rates' } },
    _fetchHtml: fakeFetch,
    _pickExtractor: fakeDispatch,
  });
  assert.equal(r.status, 'no_extractor');
});

test('reattemptOne: extractor returns 0 slabs → status=no_slabs', async () => {
  const fakeFetch = async () => ({ status: 'success', html: '<html></html>' });
  const fakeDispatch = () => ({ extractor: () => ({ slabs: [], diagnostics: {}, warnings: [] }), resolution: 'registry' });
  const r = await reattemptOne({
    bank_code: 'test-bank',
    config: { rate_page_urls: { fd: 'https://test.example/rates' } },
    _fetchHtml: fakeFetch,
    _pickExtractor: fakeDispatch,
  });
  assert.equal(r.status, 'no_slabs');
});

test('reattemptOne: missing rate_page_urls → status=no_rate_page', async () => {
  const r = await reattemptOne({
    bank_code: 'test-bank',
    config: { rate_page_urls: {} },
    _fetchHtml: async () => ({ status: 'success', html: 'x' }),
    _pickExtractor: () => ({ extractor: () => ({ slabs: [] }) }),
  });
  assert.equal(r.status, 'no_rate_page');
});

test('reattemptOne: missing bank_code throws', async () => {
  await assert.rejects(reattemptOne({ config: {} }), /bank_code and config are required/);
});

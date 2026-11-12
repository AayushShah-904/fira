'use strict';

/**
 * Tests for M2.2 (sprint-004 2026-05-21) — per-bank HTML extraction hints.
 *
 * Verifies that:
 *   1. resolveExtractionHint matches the requested URL against
 *      bank-domains.json#<bank>.rate_pages.* and returns the matching
 *      extraction.<key> object.
 *   2. buildPlaywrightCmdArgs threads the hint fields (wait-for-selector,
 *      click-to-reveal, extract-selector, tab-selector) onto the child
 *      script's argv.
 *   3. No hint match → no extra CLI args (no regression for the 500+
 *      banks without hints).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _buildPlaywrightCmdArgs, _resolveExtractionHint } = require('../../lib/tools');
const { findHintedPdfUrl, findHintedHtmlUrl } = require('../../lib/extraction-hint');

const SCRIPT = '/proj/scripts/fetch_rates_playwright.js';

// ── resolveExtractionHint ────────────────────────────────────────────

test('resolveExtractionHint returns null when no bank entry', () => {
  assert.equal(_resolveExtractionHint(null, 'https://example.com/x'), null);
  assert.equal(_resolveExtractionHint({}, 'https://example.com/x'), null);
});

test('resolveExtractionHint returns null when extraction block absent', () => {
  const entry = { domain: 'example.bank.in', rate_pages: { fd: '/fd' } };
  assert.equal(_resolveExtractionHint(entry, 'https://example.bank.in/fd'), null);
});

test('resolveExtractionHint matches relative path under bank domain', () => {
  const entry = {
    domain: 'hdfcbank.com',
    rate_pages: { fd: '/personal/save/deposits/fd', fd_nre: '/nri/deposits/nre' },
    extraction: {
      fd_nre: { type: 'html', extract_selector: '.nri-rates-table' },
    },
  };
  const hint = _resolveExtractionHint(entry, 'https://hdfcbank.com/nri/deposits/nre');
  assert.ok(hint, 'should match NRE URL');
  assert.equal(hint.key, 'fd_nre');
  assert.equal(hint.type, 'html');
  assert.equal(hint.extract_selector, '.nri-rates-table');
});

test('resolveExtractionHint matches absolute URL in rate_pages', () => {
  const entry = {
    domain: 'axis.bank.in',
    rate_pages: {
      fd_pdf_domestic: 'https://axis.bank.in/docs/x.pdf',
    },
    extraction: {
      fd_pdf_domestic: { type: 'pdf', pages: [{ page: 1 }] },
    },
  };
  const hint = _resolveExtractionHint(entry, 'https://axis.bank.in/docs/x.pdf');
  assert.ok(hint);
  assert.equal(hint.key, 'fd_pdf_domestic');
  assert.equal(hint.type, 'pdf');
});

test('resolveExtractionHint ignores trailing slash on URL', () => {
  const entry = {
    domain: 'tmb.bank.in',
    rate_pages: { fd: '/pages/deposit-interest-rates' },
    extraction: { fd: { type: 'html', wait_for_selector: 'table.rates' } },
  };
  const hint1 = _resolveExtractionHint(entry, 'https://tmb.bank.in/pages/deposit-interest-rates');
  const hint2 = _resolveExtractionHint(entry, 'https://tmb.bank.in/pages/deposit-interest-rates/');
  assert.ok(hint1);
  assert.ok(hint2);
  assert.equal(hint1.wait_for_selector, 'table.rates');
  assert.equal(hint2.wait_for_selector, 'table.rates');
});

test('resolveExtractionHint returns null when URL matches a key without an extraction entry', () => {
  const entry = {
    domain: 'hdfcbank.com',
    rate_pages: { fd: '/fd', fd_nre: '/nre' },
    extraction: { fd_nre: { type: 'html' } }, // only NRE hinted
  };
  const hint = _resolveExtractionHint(entry, 'https://hdfcbank.com/fd');
  assert.equal(hint, null, 'fd has no extraction.fd entry → null');
});

test('resolveExtractionHint malformed URL → null (no crash)', () => {
  const entry = {
    domain: 'x.bank.in',
    rate_pages: { fd: '/fd' },
    extraction: { fd: { type: 'html' } },
  };
  assert.equal(_resolveExtractionHint(entry, 'not-a-url'), null);
});

// ── buildPlaywrightCmdArgs threads hint fields ──────────────────────

const URL = 'https://hdfcbank.com/nri/deposits/nre';

test('M2.2 no hint → cmdArgs unchanged from M1 behavior', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL });
  assert.deepEqual(argv, [SCRIPT, URL, '--scroll', '--tabs', '--selects']);
});

test('M2.2 extract_selector hint appends --extract-selector', () => {
  const hint = { type: 'html', extract_selector: '.nri-rates' };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, {}, hint);
  assert.ok(argv.includes('--extract-selector'));
  assert.equal(argv[argv.indexOf('--extract-selector') + 1], '.nri-rates');
});

test('M2.2 wait_for_selector hint appends --wait-for-selector', () => {
  const hint = { type: 'html', wait_for_selector: 'table.fd-rates tbody tr' };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, {}, hint);
  assert.ok(argv.includes('--wait-for-selector'));
  assert.equal(argv[argv.indexOf('--wait-for-selector') + 1], 'table.fd-rates tbody tr');
});

test('M2.2 click_to_reveal hint appends --click-to-reveal', () => {
  const hint = { type: 'html', click_to_reveal: '#view-rates-btn' };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, {}, hint);
  assert.ok(argv.includes('--click-to-reveal'));
  assert.equal(argv[argv.indexOf('--click-to-reveal') + 1], '#view-rates-btn');
});

test('M2.2 tab_selector hint appends --tab-selector', () => {
  const hint = { type: 'html', tab_selector: '.deposit-tabs .tab' };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, {}, hint);
  assert.ok(argv.includes('--tab-selector'));
  assert.equal(argv[argv.indexOf('--tab-selector') + 1], '.deposit-tabs .tab');
});

test('M2.2 multiple hints all threaded simultaneously', () => {
  const hint = {
    type: 'html',
    wait_for_selector: '.rates',
    click_to_reveal: '.expand',
    extract_selector: '#rate-container',
    tab_selector: '.tabs li',
  };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, {}, hint);
  for (const flag of ['--wait-for-selector', '--click-to-reveal', '--extract-selector', '--tab-selector']) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
});

test('M2.2 pdf-type hint does NOT add HTML flags', () => {
  const hint = { type: 'pdf', pages: [{ page: 1, columns: [] }] };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, {}, hint);
  // PDF hints belong to fetch_pdf, not run_playwright; the playwright cmd
  // builder must not paste pdf-shaped fields onto its argv.
  assert.ok(!argv.includes('--wait-for-selector'));
  assert.ok(!argv.includes('--extract-selector'));
});

test('M2.2 hint coexists with default scroll/tabs/selects', () => {
  const hint = { type: 'html', extract_selector: '.rates' };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, {}, hint);
  // Defaults still on
  assert.ok(argv.includes('--scroll'));
  assert.ok(argv.includes('--tabs'));
  assert.ok(argv.includes('--selects'));
  // Hint also applied
  assert.ok(argv.includes('--extract-selector'));
});

test('M2.2 hint coexists with playwright_skip / browser / stealth overrides', () => {
  const overrides = {
    playwright_skip: ['tabs'],
    playwright_browser: 'firefox',
    playwright_stealth: true,
  };
  const hint = { type: 'html', extract_selector: '.rates' };
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, undefined, overrides, hint);
  assert.ok(!argv.includes('--tabs'), 'skip should still suppress tabs');
  assert.ok(argv.includes('--browser') && argv.includes('firefox'));
  assert.ok(argv.includes('--stealth'));
  assert.ok(argv.includes('--extract-selector'));
});

// ── M2.6 findHintedPdfUrl: orchestrator URL-preference helper ───────

test('M2.6 findHintedPdfUrl: returns null when no extraction block', () => {
  assert.equal(findHintedPdfUrl(null, 'fd'), null);
  assert.equal(findHintedPdfUrl({}, 'fd'), null);
  assert.equal(findHintedPdfUrl({ domain: 'x.bank.in', rate_pages: { fd: '/fd' } }, 'fd'), null);
});

test('M2.6 findHintedPdfUrl: returns the hinted PDF URL for the declared product', () => {
  const entry = {
    domain: 'axis.bank.in',
    rate_pages: {
      fd: '/deposits/fixed-deposits/fd-interest-rates',
      fd_pdf_domestic: '/docs/.../domestic-fixed-deposits-21-may-26.pdf',
    },
    extraction: {
      fd_pdf_domestic: {
        type: 'pdf',
        fulfills_product: 'fd',
        pages: [{ page: 1, columns: [] }],
      },
    },
  };
  const hit = findHintedPdfUrl(entry, 'fd');
  assert.ok(hit);
  assert.equal(hit.key, 'fd_pdf_domestic');
  assert.equal(hit.url, 'https://axis.bank.in/docs/.../domestic-fixed-deposits-21-may-26.pdf');
  assert.equal(hit.hint.type, 'pdf');
});

test('M2.6 findHintedPdfUrl: returns null when product does not match', () => {
  const entry = {
    domain: 'axis.bank.in',
    rate_pages: { fd_pdf_domestic: '/docs/x.pdf' },
    extraction: { fd_pdf_domestic: { type: 'pdf', fulfills_product: 'fd' } },
  };
  assert.equal(findHintedPdfUrl(entry, 'fd_nre'), null);
  assert.equal(findHintedPdfUrl(entry, 'fd_fcnr'), null);
});

test('M2.6 findHintedPdfUrl: fulfills_product as array supports multi-variant PDFs', () => {
  const entry = {
    domain: 'axis.bank.in',
    rate_pages: { fd_pdf_nri: '/docs/nri-deposits.pdf' },
    extraction: {
      fd_pdf_nri: {
        type: 'pdf',
        fulfills_product: ['fd_nre', 'fd_nro'],
        pages: [{ page: 1, columns: [] }],
      },
    },
  };
  // Same PDF should fulfill both NRE and NRO products
  const nre = findHintedPdfUrl(entry, 'fd_nre');
  const nro = findHintedPdfUrl(entry, 'fd_nro');
  assert.ok(nre);
  assert.ok(nro);
  assert.equal(nre.url, nro.url);
  // Other products should NOT match
  assert.equal(findHintedPdfUrl(entry, 'fd_fcnr'), null);
});

test('M2.6 findHintedPdfUrl: ignores html-type hints', () => {
  const entry = {
    domain: 'hdfcbank.com',
    rate_pages: { fd_nre: '/nri/deposits/nre' },
    extraction: {
      fd_nre: { type: 'html', extract_selector: '.rates', fulfills_product: 'fd_nre' },
    },
  };
  // HTML hints don't unlock orchestrator-path PDF routing
  assert.equal(findHintedPdfUrl(entry, 'fd_nre'), null);
});

test('M2.6 findHintedPdfUrl: ignores hint without fulfills_product', () => {
  const entry = {
    domain: 'axis.bank.in',
    rate_pages: { fd_pdf_domestic: '/docs/x.pdf' },
    extraction: { fd_pdf_domestic: { type: 'pdf', pages: [{ page: 1, columns: [] }] } },
  };
  // No fulfills_product → not authoritative for any product
  assert.equal(findHintedPdfUrl(entry, 'fd'), null);
});

test('M2.6 findHintedPdfUrl: absolute URL in rate_pages preserved', () => {
  const entry = {
    domain: 'axis.bank.in',
    rate_pages: { fd_pdf_domestic: 'https://cdn.example.com/rates.pdf' },
    extraction: { fd_pdf_domestic: { type: 'pdf', fulfills_product: 'fd' } },
  };
  const hit = findHintedPdfUrl(entry, 'fd');
  assert.equal(hit.url, 'https://cdn.example.com/rates.pdf');
});

// ── Orch-2 findHintedHtmlUrl: HTML companion of findHintedPdfUrl ────

test('Orch-2 findHintedHtmlUrl: returns null when no extraction block', () => {
  assert.equal(findHintedHtmlUrl(null, 'fd'), null);
  assert.equal(findHintedHtmlUrl({}, 'fd'), null);
  assert.equal(findHintedHtmlUrl({ domain: 'x.bank.in', rate_pages: { fd: '/fd' } }, 'fd'), null);
});

test('Orch-2 findHintedHtmlUrl: returns the hinted HTML URL for the declared product', () => {
  const entry = {
    domain: 'hdfc.bank.in',
    rate_pages: {
      fd: '/fixed-deposit/fd-interest-rate',
    },
    extraction: {
      fd: { type: 'html', fulfills_product: 'fd' },
    },
  };
  const hit = findHintedHtmlUrl(entry, 'fd');
  assert.ok(hit);
  assert.equal(hit.key, 'fd');
  assert.equal(hit.url, 'https://hdfc.bank.in/fixed-deposit/fd-interest-rate');
  assert.equal(hit.hint.type, 'html');
});

test('Orch-2 findHintedHtmlUrl: returns null when product does not match', () => {
  const entry = {
    domain: 'hdfc.bank.in',
    rate_pages: { fd: '/fd' },
    extraction: { fd: { type: 'html', fulfills_product: 'fd' } },
  };
  assert.equal(findHintedHtmlUrl(entry, 'fd_nre'), null);
  assert.equal(findHintedHtmlUrl(entry, 'fd_fcnr'), null);
});

test('Orch-2 findHintedHtmlUrl: fulfills_product as array supports multi-variant HTML pages', () => {
  const entry = {
    domain: 'hdfc.bank.in',
    rate_pages: {
      fd: '/fixed-deposit/fd-interest-rate',
      fd_nre: '/nri/nre-fd/rates',
      fd_nro: '/nri/nro-fd/rates',
    },
    extraction: {
      fd: {
        type: 'html',
        fulfills_product: ['fd', 'fd_nre', 'fd_nro'],
      },
    },
  };
  const dom = findHintedHtmlUrl(entry, 'fd');
  const nre = findHintedHtmlUrl(entry, 'fd_nre');
  const nro = findHintedHtmlUrl(entry, 'fd_nro');
  assert.ok(dom);
  assert.ok(nre);
  assert.ok(nro);
  assert.equal(dom.url, nre.url);
  assert.equal(nre.url, nro.url);
  assert.equal(dom.url, 'https://hdfc.bank.in/fixed-deposit/fd-interest-rate');
  assert.equal(findHintedHtmlUrl(entry, 'fd_fcnr'), null);
});

test('Orch-2 findHintedHtmlUrl: ignores pdf-type hints', () => {
  const entry = {
    domain: 'axis.bank.in',
    rate_pages: { fd_pdf_domestic: '/docs/x.pdf' },
    extraction: {
      fd_pdf_domestic: { type: 'pdf', fulfills_product: 'fd' },
    },
  };
  assert.equal(findHintedHtmlUrl(entry, 'fd'), null);
});

test('Orch-2 findHintedHtmlUrl: ignores hint without fulfills_product', () => {
  const entry = {
    domain: 'hdfc.bank.in',
    rate_pages: { fd: '/fd' },
    extraction: { fd: { type: 'html', extract_selector: '.rates' } },
  };
  assert.equal(findHintedHtmlUrl(entry, 'fd'), null);
});

test('Orch-2 findHintedHtmlUrl: absolute URL in rate_pages preserved', () => {
  const entry = {
    domain: 'hdfc.bank.in',
    rate_pages: { fd: 'https://www.hdfc.bank.in/fixed-deposit/fd-interest-rate' },
    extraction: { fd: { type: 'html', fulfills_product: 'fd' } },
  };
  const hit = findHintedHtmlUrl(entry, 'fd');
  assert.equal(hit.url, 'https://www.hdfc.bank.in/fixed-deposit/fd-interest-rate');
});

test('Orch-2 findHintedHtmlUrl: relative path joined to domain', () => {
  const entry = {
    domain: 'hdfc.bank.in',
    rate_pages: { fd: 'fixed-deposit/fd-interest-rate' },
    extraction: { fd: { type: 'html', fulfills_product: 'fd' } },
  };
  const hit = findHintedHtmlUrl(entry, 'fd');
  assert.equal(hit.url, 'https://hdfc.bank.in/fixed-deposit/fd-interest-rate');
});

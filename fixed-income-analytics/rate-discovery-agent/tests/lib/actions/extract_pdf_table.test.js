'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');

const { extractPdfTable, _inferVariantFromHeading, _groupSlabsByPage } = require('../../../lib/actions/extract_pdf_table');

test('throws on missing url', async () => {
  await assert.rejects(
    extractPdfTable({}),
    /input.url is required/,
  );
});

test('_inferVariantFromHeading: FCNR/GIFT/NRE/NRO detected', () => {
  assert.equal(_inferVariantFromHeading('FCNR-B Deposit Rates'), 'fcnr');
  assert.equal(_inferVariantFromHeading('GIFT City IBU Rates'), 'gift');
  assert.equal(_inferVariantFromHeading('NRE Term Deposit'), 'nre');
  assert.equal(_inferVariantFromHeading('NRO Term Deposit'), 'nro');
  assert.equal(_inferVariantFromHeading('Domestic FD Rates'), null);
});

test('_groupSlabsByPage: explicit _page field groups correctly', () => {
  const slabs = [
    { tenure_text: '7d', rate_general_pct: 3.5, _page: 1 },
    { tenure_text: '14d', rate_general_pct: 4.0, _page: 1 },
    { tenure_text: '1y', rate_general_pct: 6.5, _page: 2, currency: 'USD' },
  ];
  const pages = _groupSlabsByPage(slabs, {}, {});
  assert.equal(pages.length, 2);
  assert.equal(pages[0].page_number, 1);
  assert.equal(pages[0].slabs.length, 2);
  assert.equal(pages[1].page_number, 2);
  // FCNR inference from currency cue
  assert.equal(pages[1].variant, 'fcnr');
});

test('_groupSlabsByPage: heading-based grouping when no page numbers', () => {
  const slabs = [
    { tenure_text: '7d', rate_general_pct: 3.5, section_label: 'Domestic FD' },
    { tenure_text: '1y USD', rate_general_pct: 4.5, section_label: 'FCNR-B Rates', currency: 'USD' },
    { tenure_text: '1y GBP', rate_general_pct: 3.0, section_label: 'FCNR-B Rates', currency: 'GBP' },
  ];
  const pages = _groupSlabsByPage(slabs, {}, {});
  assert.equal(pages.length, 2);
  // FCNR page should be detected
  assert.ok(pages.some((p) => p.variant === 'fcnr'));
  // Regular page should be detected (default since heading "Domestic FD" doesn't match an NRI pattern)
  assert.ok(pages.some((p) => p.variant === 'regular'));
});

test('_groupSlabsByPage: single-page fallback when no per-slab pagination', () => {
  const slabs = [
    { tenure_text: '7d', rate_general_pct: 3.5 },
    { tenure_text: '14d', rate_general_pct: 4.0 },
  ];
  const pages = _groupSlabsByPage(slabs, { effective_date: '2026-05-01' }, { variants: ['regular'] });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].variant, 'regular');
  assert.equal(pages[0].effective_date, '2026-05-01');
  assert.equal(pages[0].slabs.length, 2);
});

// Note: tests for the script-side per-page output (pages_data path in
// extract_rates_pdf.mjs) require spawning the actual script with a fixture
// PDF, which is out of scope for unit tests. The action's preference for
// pages_data over flat rate_slabs is exercised by an integration test when
// the orchestrator runs against a real PDF-based bank.

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

test('Sprint 4 A6: remote URL is pre-downloaded with browser UA before subprocess spawn', async () => {
  // The subprocess used to bare-fetch URLs itself with no User-Agent,
  // which hung on Citi-style WAFs and timed out the whole 60s spawn
  // budget. Verify the orchestrator-side pre-download now sends a
  // browser User-Agent (matching every other action's WAF-tolerant
  // path) so the subprocess only sees a local path.
  let seenUA = null;
  let hits = 0;
  // Not-quite-valid PDF (no xref) is fine — pdfjs-dist will reject it,
  // the subprocess will exit non-zero, and extractPdfTable returns null.
  // What we want to verify is the *download* happened with browser UA.
  const fakePdf = Buffer.from('%PDF-1.4\n%fake\n');
  const srv = await startServer((req, res) => {
    hits++;
    seenUA = req.headers['user-agent'] || null;
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(fakePdf);
  });
  try {
    const result = await extractPdfTable({ url: srv.url + '/rates.pdf' });
    // pdfjs will fail on this stub → action returns null. That's expected.
    assert.equal(result, null);
    assert.equal(hits, 1, 'pre-download fetched the PDF exactly once');
    assert.ok(seenUA && /Mozilla|Chrome/.test(seenUA), `User-Agent should look like a browser, got "${seenUA}"`);
  } finally { await srv.close(); }
});

test('Sprint 4 A6 / Sprint 011 hint-fallback: download failure (HTTP 403) returns a fetch-class envelope without spawning subprocess', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  try {
    const result = await extractPdfTable({ url: srv.url + '/blocked.pdf' });
    // Sprint 011 hint-fallback (2026-07-07): FETCH-class failures return a
    // structured envelope (was null) so the orchestrator can fall back to
    // the un-hinted rate page when a hinted dated PDF URL has rolled.
    assert.deepEqual(result, {
      ok: false,
      failure_class: 'fetch',
      http_status: 403,
      error_message: 'download HTTP 403',
    });
  } finally { await srv.close(); }
});

test('Sprint 011 hint-fallback: rolled dated PDF (HTTP 404) returns fetch-class envelope with the status', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>not found</html>');
  });
  try {
    const result = await extractPdfTable({ url: srv.url + '/docs/domestic-fixed-deposits-13-june-26.pdf' });
    assert.equal(result.ok, false);
    assert.equal(result.failure_class, 'fetch');
    assert.equal(result.http_status, 404);
  } finally { await srv.close(); }
});

test('Sprint 4 A6: temp file is cleaned up after subprocess exits', async () => {
  const before = fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith('pdf-')).length;
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(Buffer.from('%PDF-1.4\nfake\n'));
  });
  try {
    await extractPdfTable({ url: srv.url + '/x.pdf' });
    const after = fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith('pdf-')).length;
    assert.equal(after, before, 'no leaked pdf-* temp files');
  } finally { await srv.close(); }
});

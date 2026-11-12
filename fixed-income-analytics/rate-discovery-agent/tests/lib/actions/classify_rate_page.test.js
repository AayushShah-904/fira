'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyRatePage, _sniffHtml, _cachedKindMatchesContentType } = require('../../../lib/actions/classify_rate_page');

test('URL ends with .pdf → kind: pdf, high confidence, no fetch', async () => {
  const r = await classifyRatePage({ url: 'https://example.com/rates.pdf', mode: 'discover' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'pdf');
  assert.equal(r.confidence, 'high');
});

test('URL has image extension → kind: image, no fetch', async () => {
  const r = await classifyRatePage({ url: 'https://example.com/rates.jpg', mode: 'discover' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'image');
});

test('throws on invalid mode', async () => {
  await assert.rejects(
    classifyRatePage({ url: 'https://example.com', mode: 'bogus' }),
    /mode must be one of/,
  );
});

test('_sniffHtml: static rate table → html_static high', () => {
  const html = '<html><body><table><tr><td>7 days</td><td>3.50%</td></tr></table></body></html>';
  const v = _sniffHtml(html);
  assert.equal(v.kind, 'html_static');
  assert.equal(v.confidence, 'high');
});

test('_sniffHtml: React root → html_js medium', () => {
  const html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const v = _sniffHtml(html);
  assert.equal(v.kind, 'html_js');
});

// Sprint 005 Phase A.4 — verify the existing resilience to unrecognised cached_kind.
// Per Phase 0.2 failure inventory, ~31 NSUCB/DCCB banks have scraper_type='unknown' in
// their configs. The orchestrator passes this through as hints.cached_kind; the
// VALID_KINDS guard in classify_rate_page must drop the bogus hint and proceed with
// a live sniff rather than aborting the whole step. These tests are the regression
// gate that protects the resilience under future refactors.

test('Phase A.4 resilience: unrecognised cached_kind is dropped, proceeds with cached_body sniff', async () => {
  const html = '<html><body><table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1 year</td><td>6.50%</td></tr></table></body></html>';
  const r = await classifyRatePage({
    url: 'https://example.bank.in/rates',
    mode: 'recheck',
    hints: { cached_kind: 'unknown', cached_body: html, cached_content_type: 'text/html' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'html_static', 'should classify from cached_body, not the bogus cached_kind');
});

test('Phase A.4 resilience: unrecognised cached_kind values like "mixed" / "government" / null are tolerated', async () => {
  // Any cached_kind not in VALID_KINDS should be dropped (lib/actions/classify_rate_page.js:61-63).
  // This test covers the bank-level rollups ("mixed", "government", "manual") that exist in
  // bank-domains.json but aren't valid per-URL kinds.
  const html = '<html><body><table><tr><th>Period</th><th>Rate</th></tr><tr><td>1y</td><td>7.00%</td></tr></table></body></html>';
  for (const cachedKind of ['mixed', 'government', 'manual', 'unknown', null, '']) {
    const r = await classifyRatePage({
      url: 'https://example.bank.in/rates',
      mode: 'recheck',
      hints: { cached_kind: cachedKind, cached_body: html, cached_content_type: 'text/html' },
    });
    assert.equal(r.ok, true, `should not abort on cached_kind=${JSON.stringify(cachedKind)}`);
    assert.equal(r.kind, 'html_static');
  }
});

test('_sniffHtml: Next.js __next root → html_js', () => {
  const html = '<html><body><div id="__next"></div></body></html>';
  const v = _sniffHtml(html);
  assert.equal(v.kind, 'html_js');
});

test('_sniffHtml: no tables + many scripts → low-confidence html_js', () => {
  const html = '<html><body><script>1</script><script>2</script><script>3</script><script>4</script></body></html>';
  const v = _sniffHtml(html);
  assert.equal(v.kind, 'html_js');
  assert.equal(v.confidence, 'low');
});

test('_sniffHtml: empty page → inconclusive', () => {
  const html = '<html><body><p>nothing here</p></body></html>';
  const v = _sniffHtml(html);
  assert.equal(v.kind, undefined);
});

test('_cachedKindMatchesContentType: html_static + text/html → true', () => {
  assert.equal(_cachedKindMatchesContentType('html_static', 'text/html; charset=utf-8'), true);
});

test('_cachedKindMatchesContentType: pdf + text/html → false', () => {
  assert.equal(_cachedKindMatchesContentType('pdf', 'text/html'), false);
});

test('_cachedKindMatchesContentType: image + image/png → true', () => {
  assert.equal(_cachedKindMatchesContentType('image', 'image/png'), true);
});

// ── Phase 4: cached_body path ───────────────────────────────────────────

test('cached_body with table → html_static, no live fetch', async () => {
  const html = '<html><body><table><tr><td>7 days</td><td>3.50%</td></tr></table></body></html>';
  const r = await classifyRatePage({
    url: 'https://example.bank.in/fd',
    mode: 'discover',
    hints: { cached_body: html, cached_content_type: 'text/html' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'html_static');
  assert.match(r.evidence, /^cached_body:/);
});

test('cached_body with React root → html_js', async () => {
  const html = '<html><body><div id="root"></div></body></html>';
  const r = await classifyRatePage({
    url: 'https://example.bank.in/fd',
    mode: 'discover',
    hints: { cached_body: html, cached_content_type: 'text/html' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'html_js');
});

test('cached_body + content_type application/pdf → kind: pdf (overrides body sniff)', async () => {
  const r = await classifyRatePage({
    url: 'https://example.bank.in/rate-card',
    mode: 'discover',
    hints: { cached_body: 'irrelevant', cached_content_type: 'application/pdf' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'pdf');
});

test('cached_body inconclusive + cached_kind present → trust cached_kind, medium confidence', async () => {
  const r = await classifyRatePage({
    url: 'https://example.bank.in/fd',
    mode: 'discover',
    hints: {
      cached_body: '<html><body><p>placeholder</p></body></html>',
      cached_content_type: 'text/html',
      cached_kind: 'html_js',
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'html_js');
  assert.equal(r.confidence, 'medium');
  assert.match(r.evidence, /trusting cached_kind/);
});

test('cached_body inconclusive + no cached_kind → falls through to live-fetch path', async () => {
  // Use a URL that won't resolve so the live fetch fails fast — proves
  // we did NOT short-circuit on inconclusive cached_body.
  const r = await classifyRatePage({
    url: 'http://127.0.0.1:1/never-listens',
    mode: 'discover',
    hints: {
      cached_body: '<html><body><p>placeholder</p></body></html>',
      cached_content_type: 'text/html',
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error_class, 'fetch_failed');
});

test('bank-level cached_kind ("mixed", "government", "manual") is dropped — falls through, does NOT throw', async () => {
  // Sprint 4 A5: bank-domains.json stores per-bank `scraper_type` like
  // "mixed" (Axis), "government" (India Post), "manual" (no-website).
  // classify_rate_page is per-URL, so these labels are not useful hints —
  // they used to throw and abort the whole variant. Now we drop them.
  for (const kind of ['mixed', 'government', 'manual', 'whatever-future-label']) {
    const r = await classifyRatePage({
      url: 'http://127.0.0.1:1/never-listens',
      mode: 'discover',
      hints: { cached_kind: kind },
    });
    // Falls through to live-fetch which fails on a closed port.
    assert.equal(r.ok, false, `cached_kind="${kind}" should not throw`);
    assert.equal(r.error_class, 'fetch_failed');
  }
});

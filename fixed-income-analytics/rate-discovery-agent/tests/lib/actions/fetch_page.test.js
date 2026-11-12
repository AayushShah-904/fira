'use strict';

/**
 * Tests for lib/actions/fetch_page.js — Phase 4 of option A+C.
 *
 * fetch_page wraps the per-bank Playwright session in a typed action so the
 * orchestrator can prefetch the rate page once and pass the body downstream
 * (classify, extract). Tests cover:
 *   - session.fetch happy path → returns body + content_type + status_code
 *   - session.fetch throws → falls back to Node HTTP
 *   - no session provided → uses Node HTTP directly
 *   - both fail → returns { ok: false, error_class: 'fetch_failed' }
 *   - extraction-quality opts are passed to session.fetch (networkidle,
 *     scroll, accordions, 2 MB cap)
 *   - input validation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { fetchPage } = require('../../../lib/actions/fetch_page');
const { mockSession } = require('../../_helpers/mock_session');

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

test('fetchPage: throws when url missing', async () => {
  await assert.rejects(() => fetchPage({}), /input\.url is required/);
});

test('fetchPage: session present → returns body + content_type lowercased + fetched_via=session', async () => {
  const session = mockSession({
    responses: {
      'https://hdfc.bank.in/fd': {
        statusCode: 200,
        headers: { 'content-type': 'TEXT/HTML; charset=utf-8' },
        body: '<html><body><table><tr><td>6.5%</td></tr></table></body></html>',
        finalUrl: 'https://hdfc.bank.in/fd',
      },
    },
  });
  const r = await fetchPage({ url: 'https://hdfc.bank.in/fd', session });
  assert.equal(r.ok, true);
  assert.equal(r.status_code, 200);
  assert.equal(r.content_type, 'text/html; charset=utf-8');
  assert.equal(r.final_url, 'https://hdfc.bank.in/fd');
  assert.equal(r.fetched_via, 'session');
  assert.match(r.body, /<table>/);
});

test('fetchPage: session.fetch receives extraction-quality opts', async () => {
  const session = mockSession();
  await fetchPage({ url: 'https://example.bank.in/x', session });
  const call = session._internals.calls[0];
  // domcontentloaded (not networkidle) matches the rest of the session-routed
  // sniffs after Step 1G; networkidle times out on tracker-heavy hosts. scroll
  // + accordions still give the extractor a fully-rendered DOM.
  assert.equal(call.opts.waitFor, 'domcontentloaded');
  assert.equal(call.opts.scroll, true);
  assert.equal(call.opts.accordions, true);
  assert.equal(call.opts.maxBytes, 2 * 1024 * 1024);
});

test('fetchPage: session throws → falls back to Node HTTP and logs warn', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>fallback-body</body></html>');
  });
  const warnCalls = [];
  const session = mockSession({
    responses: { [srv.url + '/']: () => { throw new Error('playwright_navigation_failed: timeout'); } },
  });
  try {
    const r = await fetchPage({
      url: srv.url + '/',
      session,
      logger: { warn: (m) => warnCalls.push(m) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.fetched_via, 'node_http');
    assert.match(r.body, /fallback-body/);
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0], /session\.fetch threw/);
  } finally {
    await srv.close();
  }
});

test('fetchPage: no session → uses Node HTTP directly', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>direct</html>');
  });
  try {
    const r = await fetchPage({ url: srv.url + '/' });
    assert.equal(r.ok, true);
    assert.equal(r.fetched_via, 'node_http');
    assert.equal(r.status_code, 200);
    assert.match(r.body, /direct/);
  } finally {
    await srv.close();
  }
});

test('fetchPage: Node HTTP returns 4xx → ok=false with error_class fetch_failed', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('forbidden');
  });
  try {
    const r = await fetchPage({ url: srv.url + '/' });
    assert.equal(r.ok, false);
    assert.equal(r.error_class, 'fetch_failed');
    assert.match(r.error_message, /403/);
  } finally {
    await srv.close();
  }
});

test('fetchPage: both session and Node HTTP fail → ok=false', async () => {
  const session = mockSession({
    responses: { 'http://127.0.0.1:1/dead': () => { throw new Error('nav fail'); } },
  });
  const r = await fetchPage({ url: 'http://127.0.0.1:1/dead', session, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error_class, 'fetch_failed');
});

test('fetchPage: truncated session response surfaces truncated=true', async () => {
  const session = mockSession({
    responses: {
      'https://x.bank.in/big': {
        statusCode: 200,
        body: 'xx',
        truncated: true,
      },
    },
  });
  const r = await fetchPage({ url: 'https://x.bank.in/big', session });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
});

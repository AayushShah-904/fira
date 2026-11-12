'use strict';

/**
 * Unit tests for lib/actions/_http.js — the shared HTTP helper.
 *
 * Uses a local in-process http server so the tests are deterministic and
 * don't touch the network. No live bank sites are hit here; the integration
 * smoke test exercises real URLs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { httpRequest, headCheck } = require('../../../lib/actions/_http');
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

test('httpRequest: GET 200 returns status, headers, body', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  try {
    const r = await httpRequest(srv.url + '/', 'GET');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'hello');
    assert.equal(r.headers['content-type'], 'text/plain');
  } finally { await srv.close(); }
});

test('httpRequest: HEAD returns status without body', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(200);
      res.end('full-body');
    }
  });
  try {
    const r = await httpRequest(srv.url + '/', 'HEAD');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, '');
  } finally { await srv.close(); }
});

test('httpRequest: follows 301 redirect chain up to maxRedirects', async () => {
  let hops = 0;
  const srv = await startServer((req, res) => {
    hops++;
    if (req.url === '/start') {
      res.writeHead(301, { Location: '/middle' });
      res.end();
    } else if (req.url === '/middle') {
      res.writeHead(302, { Location: '/end' });
      res.end();
    } else if (req.url === '/end') {
      res.writeHead(200);
      res.end('done');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const r = await httpRequest(srv.url + '/start', 'GET');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'done');
    assert.equal(hops, 3);
  } finally { await srv.close(); }
});

test('httpRequest: refuses redirects beyond maxRedirects', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(301, { Location: req.url + '0' });
    res.end();
  });
  try {
    await assert.rejects(httpRequest(srv.url + '/', 'GET', { maxRedirects: 3 }), /Too many redirects/);
  } finally { await srv.close(); }
});

test('httpRequest: byte-cap overflow returns truncated body (partial-body recovery)', async () => {
  // Send 64 KB; cap at 1 KB.
  const big = Buffer.alloc(64 * 1024, 'x');
  const srv = await startServer((req, res) => {
    res.writeHead(200);
    res.write(big);
    setTimeout(() => res.end(), 50);
  });
  try {
    const r = await httpRequest(srv.url + '/', 'GET', { maxBytes: 1024 });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.length, 1024, 'body trimmed to exactly maxBytes');
    assert.equal(r.truncated, true, 'truncated flag set');
  } finally { await srv.close(); }
});

test('httpRequest: truncation fires logger.warn', async () => {
  const big = Buffer.alloc(64 * 1024, 'x');
  const srv = await startServer((req, res) => {
    res.writeHead(200); res.write(big); setTimeout(() => res.end(), 50);
  });
  const warnCalls = [];
  const logger = { warn: (msg) => warnCalls.push(msg) };
  try {
    const r = await httpRequest(srv.url + '/', 'GET', { maxBytes: 1024, logger });
    assert.equal(r.truncated, true);
    assert.equal(warnCalls.length, 1, 'warn called once');
    assert.match(warnCalls[0], /truncated response/);
    assert.match(warnCalls[0], /at 1024 bytes/);
  } finally { await srv.close(); }
});

test('httpRequest: non-truncated response sets truncated=false and skips warn', async () => {
  const srv = await startServer((req, res) => { res.writeHead(200); res.end('small'); });
  const warnCalls = [];
  const logger = { warn: (msg) => warnCalls.push(msg) };
  try {
    const r = await httpRequest(srv.url + '/', 'GET', { maxBytes: 1024, logger });
    assert.equal(r.truncated, false);
    assert.equal(warnCalls.length, 0);
  } finally { await srv.close(); }
});

test('httpRequest: timeout rejects after timeoutMs', async () => {
  // Server holds the connection without responding.
  const srv = await startServer(() => { /* never call res.end */ });
  try {
    await assert.rejects(
      httpRequest(srv.url + '/', 'GET', { timeoutMs: 200 }),
      /Timeout after/,
    );
  } finally { await srv.close(); }
});

test('headCheck: 200 HEAD → true', async () => {
  const srv = await startServer((req, res) => { res.writeHead(200); res.end(); });
  try { assert.equal(await headCheck(srv.url + '/'), true); }
  finally { await srv.close(); }
});

test('headCheck: 405 HEAD → falls back to GET → 200 → true', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); }
    else { res.writeHead(200); res.end('body'); }
  });
  try { assert.equal(await headCheck(srv.url + '/'), true); }
  finally { await srv.close(); }
});

test('headCheck: 403 HEAD → falls back to GET → 200 → true (WAF rejecting HEAD pattern)', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(403); res.end(); }
    else { res.writeHead(200); res.end('body'); }
  });
  try { assert.equal(await headCheck(srv.url + '/'), true); }
  finally { await srv.close(); }
});

test('headCheck: 404 → false', async () => {
  const srv = await startServer((req, res) => { res.writeHead(404); res.end(); });
  try { assert.equal(await headCheck(srv.url + '/'), false); }
  finally { await srv.close(); }
});

test('headCheck: connection error → false (not throw)', async () => {
  // Point at a port nothing listens on. headCheck swallows the error and
  // returns false rather than throwing — callers (e.g., find_website) rely
  // on this for graceful candidate fallthrough.
  const r = await headCheck('http://127.0.0.1:1/');
  assert.equal(r, false);
});

test('httpRequest: custom headers are merged with defaults', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ua: req.headers['user-agent'], custom: req.headers['x-custom'] }));
  });
  try {
    const r = await httpRequest(srv.url + '/', 'GET', { headers: { 'X-Custom': 'hi' } });
    const got = JSON.parse(r.body);
    assert.ok(got.ua.includes('Chrome'), 'default UA preserved');
    assert.equal(got.custom, 'hi', 'custom header forwarded');
  } finally { await srv.close(); }
});

// ── Phase 3 (option A+C): session delegation ─────────────────────────────

test('httpRequest with session: delegates to session.fetch and returns compatible shape', async () => {
  const session = mockSession({
    responses: {
      'https://waf-blocked/': { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<html>via-session</html>' },
    },
  });
  const r = await httpRequest('https://waf-blocked/', 'GET', { session });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, '<html>via-session</html>');
  assert.equal(r.truncated, false);
  // finalUrl is dropped to preserve _http.js's existing return contract.
  assert.equal(r.finalUrl, undefined);
  assert.equal(session._internals.calls.length, 1);
  assert.equal(session._internals.calls[0].url, 'https://waf-blocked/');
  // _http.js asks session.fetch to skip scroll/accordions (cheap delegated fetch).
  assert.equal(session._internals.calls[0].opts.scroll, false);
  assert.equal(session._internals.calls[0].opts.accordions, false);
});

test('httpRequest with session: session.fetch throw → falls back to Node HTTP and logs warn', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('node-http-fallback');
  });
  try {
    const session = mockSession({
      responses: { [srv.url + '/']: () => { throw new Error('nav timeout'); } },
    });
    const warnCalls = [];
    const r = await httpRequest(srv.url + '/', 'GET', { session, logger: { warn: (m) => warnCalls.push(m) } });
    assert.equal(r.statusCode, 200, 'fell back to local Node HTTP server');
    assert.equal(r.body, 'node-http-fallback');
    assert.equal(session._internals.calls.length, 1, 'session.fetch was attempted once');
    assert.equal(warnCalls.length, 1, 'fallback warned exactly once');
    assert.match(warnCalls[0], /session\.fetch failed/);
    assert.match(warnCalls[0], /falling back to Node HTTP/);
  } finally { await srv.close(); }
});

test('httpRequest with session AND custom headers: skips session, uses Node HTTP (preserves headers)', async () => {
  // Custom headers (Bing API key, AOAI auth) target non-WAF endpoints and
  // Playwright can't carry per-request headers without a routing layer we
  // don't have. _http.js's rule: skip session when headers is non-empty.
  const srv = await startServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ apiKey: req.headers['x-api-key'] || null }));
  });
  try {
    const session = mockSession();
    const r = await httpRequest(srv.url + '/', 'GET', {
      session,
      headers: { 'X-Api-Key': 'secret123' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.body).apiKey, 'secret123', 'header reached Node HTTP target');
    assert.equal(session._internals.calls.length, 0, 'session was not invoked');
  } finally { await srv.close(); }
});

test('headCheck with session: passes session through; 2xx from session → true', async () => {
  const session = mockSession({
    responses: { 'https://example/': { statusCode: 200 } },
  });
  const ok = await headCheck('https://example/', { session });
  assert.equal(ok, true);
  assert.equal(session._internals.calls.length, 1);
  // headCheck uses HEAD; _http.js routes HEAD via session.fetch as the WAF
  // circumvention is the whole point of having a session.
});

test('httpRequest: responseType="buffer" returns raw bytes (PDF download path)', async () => {
  // Sprint 4 A6: pre-download for extract_pdf_table needs binary bytes,
  // not utf-8-coerced strings. The default "text" mode would mangle a PDF
  // by replacing invalid UTF-8 sequences. Verify the binary path preserves
  // exact bytes — even non-ASCII payloads.
  const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0xFF, 0xFE, 0x00]); // %PDF-1.4 + binary
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(payload.length) });
    res.end(payload);
  });
  try {
    const r = await httpRequest(srv.url + '/rates.pdf', 'GET', { responseType: 'buffer' });
    assert.equal(r.statusCode, 200);
    assert.ok(Buffer.isBuffer(r.body), 'body must be a Buffer');
    assert.equal(r.body.length, payload.length);
    assert.deepEqual(r.body, payload);
  } finally { await srv.close(); }
});

test('httpRequest: responseType="buffer" bypasses session.fetch (Playwright cannot serve binary)', async () => {
  // session.fetch returns rendered HTML via page.content(); for binaries
  // (PDF, image) it's useless or actively harmful. Verify the binary path
  // skips the session and goes straight to Node HTTP.
  const payload = Buffer.from('%PDF-1.4 binary');
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(payload);
  });
  try {
    const session = mockSession({ responses: { [srv.url + '/x.pdf']: { body: 'WRONG' } } });
    const r = await httpRequest(srv.url + '/x.pdf', 'GET', { session, responseType: 'buffer' });
    assert.equal(r.statusCode, 200);
    assert.ok(Buffer.isBuffer(r.body));
    assert.equal(session._internals.calls.length, 0, 'session must not be invoked for binary fetches');
  } finally { await srv.close(); }
});

'use strict';

/**
 * Tests for lib/actions/_playwright_session.js.
 *
 * Gated on env: set SKIP_PLAYWRIGHT_TESTS=1 to skip (CI without browsers).
 * Uses a local in-process http server so the suite is deterministic and
 * doesn't touch real bank sites.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const SKIP = process.env.SKIP_PLAYWRIGHT_TESTS === '1';
const testOrSkip = SKIP ? test.skip : test;

let createSession;
try {
  // require lazily so SKIP path doesn't need playwright installed
  ({ createSession } = require('../../../lib/actions/_playwright_session'));
} catch (e) {
  // Playwright not installed; tests gated by SKIP env will still skip cleanly
}

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

testOrSkip('createSession.fetch: returns rendered HTML body + status', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>hello</h1></body></html>');
  });
  let session;
  try {
    session = await createSession({ headless: true });
    const r = await session.fetch(srv.url + '/', { scroll: false, accordions: false });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /<h1>hello<\/h1>/);
    assert.equal(r.truncated, false);
    assert.equal(r.finalUrl, srv.url + '/');
  } finally {
    if (session) await session.close();
    await srv.close();
  }
});

testOrSkip('createSession.fetch: follows server-side redirects, finalUrl reflects landing page', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/end' });
      res.end();
    } else if (req.url === '/end') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>landed</body></html>');
    } else {
      res.writeHead(404); res.end();
    }
  });
  let session;
  try {
    session = await createSession({ headless: true });
    const r = await session.fetch(srv.url + '/start', { scroll: false, accordions: false });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /landed/);
    assert.ok(r.finalUrl.endsWith('/end'));
  } finally {
    if (session) await session.close();
    await srv.close();
  }
});

testOrSkip('createSession.fetch: throws on navigation failure', async () => {
  let session;
  try {
    session = await createSession({ headless: true });
    await assert.rejects(
      session.fetch('http://127.0.0.1:1/never-listens', { timeoutMs: 2000, scroll: false, accordions: false }),
      /playwright_navigation_failed/,
    );
  } finally {
    if (session) await session.close();
  }
});

testOrSkip('createSession.close: idempotent', async () => {
  const session = await createSession({ headless: true });
  await session.close();
  await session.close(); // second close should not throw
});

testOrSkip('createSession.fetch: throws after close', async () => {
  const session = await createSession({ headless: true });
  await session.close();
  await assert.rejects(session.fetch('http://127.0.0.1/'), /session is closed/);
});

testOrSkip('createSession.fetch: truncated flag set + warn logged when body > maxBytes', async () => {
  // Send a large HTML document (~80 KB body).
  const big = 'x'.repeat(80 * 1024);
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>${big}</body></html>`);
  });
  const warnCalls = [];
  let session;
  try {
    session = await createSession({ headless: true, logger: { warn: (m) => warnCalls.push(m) } });
    const r = await session.fetch(srv.url + '/', { scroll: false, accordions: false, maxBytes: 4096 });
    assert.equal(r.truncated, true);
    assert.ok(r.body.length <= 4096);
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0], /truncated body/);
  } finally {
    if (session) await session.close();
    await srv.close();
  }
});

testOrSkip('createSession.fetch: expandAccordions reveals collapsed content', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`
      <html><body>
        <details><summary>visible</summary><span id="hidden-detail">DETAIL_CONTENT</span></details>
        <div class="accordion-collapse">
          <span id="hidden-accordion">ACCORDION_CONTENT</span>
        </div>
      </body></html>`);
  });
  let session;
  try {
    session = await createSession({ headless: true });
    const r = await session.fetch(srv.url + '/', { scroll: false, accordions: true });
    // After expansion, page.content() includes the content of expanded panels
    assert.match(r.body, /DETAIL_CONTENT/);
    assert.match(r.body, /ACCORDION_CONTENT/);
  } finally {
    if (session) await session.close();
    await srv.close();
  }
});

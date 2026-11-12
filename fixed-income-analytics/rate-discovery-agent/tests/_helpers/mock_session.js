'use strict';

/**
 * Mock of `lib/actions/_playwright_session.createSession()`'s return value.
 *
 * Used by orchestrator tests (and _http.js delegation tests) to exercise the
 * Phase 3 session wiring without launching a real Chromium. The shape mirrors
 * the real session: `fetch(url, opts)` returns the same `{statusCode, headers,
 * body, truncated, finalUrl}` envelope that `_playwright_session.fetch`
 * emits, and `close()` is idempotent.
 *
 * Usage:
 *   const { mockSession } = require('../_helpers/mock_session');
 *
 *   // Default 200 / empty body:
 *   const s = mockSession();
 *
 *   // Per-URL canned responses:
 *   const s = mockSession({
 *     responses: {
 *       'https://hdfc.bank.in/': { statusCode: 200, body: '<html>...</html>' },
 *       // throwing response triggers _http.js's Node-HTTP fallback:
 *       'https://broken/': () => { throw new Error('nav timeout'); },
 *     },
 *   });
 *
 *   // Inspect calls after the run:
 *   assert.equal(s._internals.calls.length, 3);
 *   assert.equal(s._internals.closed, true);
 */
function mockSession({ responses = {}, defaultStatus = 200, defaultBody = '<html></html>' } = {}) {
  const internals = { calls: [], closed: false };
  return {
    async fetch(url, opts = {}) {
      internals.calls.push({ url, opts });
      const r = responses[url];
      if (typeof r === 'function') return r(url, opts); // may throw — exercises auto-fallback
      return {
        statusCode: r?.statusCode ?? defaultStatus,
        headers: r?.headers ?? { 'content-type': 'text/html' },
        body: r?.body ?? defaultBody,
        truncated: r?.truncated ?? false,
        finalUrl: r?.finalUrl ?? url,
      };
    },
    async close() { internals.closed = true; },
    _internals: internals,
  };
}

module.exports = { mockSession };

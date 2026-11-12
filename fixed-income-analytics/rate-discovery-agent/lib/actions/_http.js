'use strict';

/**
 * Shared HTTP helpers for action implementations.
 *
 * Each action used to keep a private copy of httpRequest. Centralising here
 * so a single change to TLS handling, redirects, or header conventions
 * propagates everywhere.
 *
 * `tolerant: true` accepts incomplete TLS chains — common for Indian bank
 * websites (.bank.in domains in particular) that serve trust chains without
 * the intermediate cert. Use it only when the URL is pre-trusted (e.g., a
 * cached_domain from data/bank-domains.json).
 */

const http = require('node:http');
const https = require('node:https');

function headCheck(url, { tolerant = false, session = null } = {}) {
  const timeoutMs = session ? 20000 : 8000;
  return new Promise(async (resolve) => {
    try {
      const res = await httpRequest(url, 'HEAD', { timeoutMs, tolerant, session });
      if (res.statusCode >= 200 && res.statusCode < 400) return resolve(true);
      // Some servers reject HEAD; try GET with byte cap.
      if (res.statusCode === 405 || res.statusCode === 403) {
        const get = await httpRequest(url, 'GET', { timeoutMs, maxBytes: 4096, tolerant, session });
        return resolve(get.statusCode >= 200 && get.statusCode < 400);
      }
      return resolve(false);
    } catch {
      return resolve(false);
    }
  });
}

// Default byte cap for content fetches. Raised from 32 KB → 512 KB on
// 2026-05-16; raised again 512 KB → 2 MB on 2026-05-17 after observing
// HDFC pages at 1.04–1.19 MB (FD/NRE/NRO/FCNR all > 1 MB rendered) and
// the LLM extraction fallback was receiving truncated bodies that
// dropped the rate table out of view. The cap is still useful as a
// safety limit; truncation when it fires is warn-logged so silent data
// loss is visible.
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function httpRequest(url, method = 'GET', { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = 15000, maxRedirects = 5, headers = {}, tolerant = false, logger, session = null, responseType = 'text' } = {}) {
  // Session delegation (Phase 3 of option A+C). When a per-bank Playwright
  // session is provided, route the request through `_playwright_session.js`'s
  // page.goto() so WAF-protected hosts (HDFC, AU SFB, BOI-IBU) accept us as a
  // real browser. Skip the session in these cases:
  //   - `headers` is non-empty: custom headers (Bing API key, AOAI auth) target
  //     non-WAF endpoints and Playwright can't carry per-request headers without
  //     a routing layer we don't have. Stay on Node HTTP.
  //   - `tolerant: true` does NOT skip session — Chromium's trust store handles
  //     most incomplete-chain banks just fine, and the auto-fallback below
  //     preserves `tolerant` for the Node-HTTP retry if session does throw.
  // If session.fetch throws (nav timeout, browser crash, closed session) we
  // fall back to plain Node HTTP for that single call so an infrastructure
  // glitch doesn't poison a whole orchestrate(). Real 4xx/5xx HTTP errors
  // arrive as a status code, not a throw, so they reach the caller untouched.
  // Binary fetches (PDF, images) bypass Playwright — `page.goto` aborts with
  // "Download is starting" for attachment-disposition responses and
  // `page.content()` would return rendered HTML, not bytes.
  const sessionUsable = session && Object.keys(headers).length === 0 && responseType === 'text';
  if (sessionUsable) {
    return sessionFetch(session, url, { maxBytes, timeoutMs, logger })
      .catch((err) => {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`_http.js: session.fetch failed for ${url} (${err.message}); falling back to Node HTTP`);
        } else {
          process.stderr.write(`[WARN] _http.js: session.fetch failed for ${url} (${err.message}); falling back to Node HTTP\n`);
        }
        return nodeHttpRequest(url, method, { maxBytes, timeoutMs, maxRedirects, headers, tolerant, logger, responseType });
      });
  }
  return nodeHttpRequest(url, method, { maxBytes, timeoutMs, maxRedirects, headers, tolerant, logger, responseType });
}

async function sessionFetch(session, url, { maxBytes, timeoutMs, logger }) {
  // Map _http.js options to session.fetch's signature. scroll/accordions stay
  // off for delegated fetches — `_http.js` callers are doing classify/anchor
  // sniffs, not full extraction. The extractor has its own session.fetch path
  // (Phase 4) where it can request the full treatment.
  const r = await session.fetch(url, { maxBytes, timeoutMs, scroll: false, accordions: false });
  // Drop `finalUrl` to preserve _http.js's existing return contract. Callers
  // don't read it today; revisit if a later phase needs redirect provenance.
  return { statusCode: r.statusCode, headers: r.headers, body: r.body, truncated: r.truncated };
}

function nodeHttpRequest(url, method, { maxBytes, timeoutMs, maxRedirects, headers, tolerant, logger, responseType = 'text' }) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    let proto;
    try {
      proto = url.startsWith('https') ? https : http;
    } catch {
      return reject(new Error('Invalid URL'));
    }
    // `resolved` is hoisted to the Promise scope so byte-cap overflow can
    // recover partial body via req.on('close') even when req.on('error')
    // fires first with ECONNRESET. Whoever sets resolved=true first wins.
    let resolved = false;
    let chunks = [];
    let receivedResponse = false;
    let resStatus;
    let resHeaders;
    const req = proto.request(url, {
      method,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
      ...(tolerant ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        // Redirects from inside nodeHttpRequest stay on the Node-HTTP path —
        // the original call already lost the session (either no session was
        // passed, or session.fetch threw and we fell back). Re-entering via
        // httpRequest() would waste a session attempt that we know will fail.
        return nodeHttpRequest(next, method, { maxBytes, timeoutMs, maxRedirects: maxRedirects - 1, headers, tolerant, logger, responseType }).then((r) => { if (!resolved) { resolved = true; resolve(r); } }, (e) => { if (!resolved) { resolved = true; reject(e); } });
      }
      receivedResponse = true;
      resStatus = res.statusCode;
      resHeaders = res.headers;
      let total = 0;
      res.on('data', (chunk) => {
        // Always push — caller-side concat phase enforces maxBytes via slice.
        // If we gated the push on `total <= maxBytes` we'd silently drop the
        // first chunk on responses where the first packet already exceeds
        // the cap (server side-write of a single big buffer).
        chunks.push(chunk);
        total += chunk.length;
        if (total >= maxBytes) req.destroy();
      });
      res.on('end', () => {
        if (resolved) return;
        resolved = true;
        finalize();
      });
      res.on('error', (err) => {
        if (resolved) return;
        // Defer to close-handler when we have partial bytes from a byte-cap
        // destroy. Otherwise reject.
        if (receivedResponse && chunks.length > 0) return;
        resolved = true;
        reject(err);
      });
    });
    req.on('timeout', () => { req.destroy(); if (!resolved) { resolved = true; reject(new Error(`Timeout after ${timeoutMs}ms`)); } });
    req.on('error', (err) => {
      // If req.destroy() fired for byte-cap overflow, 'error' arrives as
      // ECONNRESET/aborted. The 'close' handler below resolves with the
      // partial body; only reject if we never received any data.
      if (resolved) return;
      if (receivedResponse && chunks.length > 0) return; // close handler will resolve
      resolved = true;
      reject(err);
    });
    // Partial-body recovery via close: fires after byte-cap req.destroy().
    req.on('close', () => {
      if (resolved) return;
      if (receivedResponse && chunks.length > 0) {
        resolved = true;
        finalize();
      }
    });
    req.end();

    function finalize() {
      const raw = Buffer.concat(chunks);
      const truncated = raw.length > maxBytes;
      if (truncated) {
        const msg = `_http.js: truncated response from ${url} at ${maxBytes} bytes (server sent ${raw.length}+ bytes). Increase maxBytes if rate data may live past the cap.`;
        if (logger && typeof logger.warn === 'function') logger.warn(msg);
        else process.stderr.write(`[WARN] ${msg}\n`);
      }
      const capped = raw.slice(0, maxBytes);
      const body = responseType === 'buffer' ? capped : capped.toString('utf-8');
      resolve({ statusCode: resStatus, headers: resHeaders, body, truncated });
    }
  });
}

module.exports = { httpRequest, headCheck };

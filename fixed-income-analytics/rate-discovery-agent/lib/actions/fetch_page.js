'use strict';

/**
 * Action: fetch_page — Phase 4 of option A+C (cached_body plumbing).
 *
 * Performs ONE full-quality fetch of a rate page URL via the orchestrator's
 * per-bank Playwright session, returning the rendered HTML in a typed
 * envelope the orchestrator can forward to downstream actions as
 * `hints.cached_body` (classify, extract). Goal: eliminate the
 * 2-3 redundant page fetches per (bank, product) inherent in today's
 * find→classify→extract pipeline, and ensure the LLM fallback has a body
 * to send when the deterministic extractor's subprocess crashes on heavy
 * pages (HDFC's 1.04-1.19 MB rendered DOM is the motivating case).
 *
 * Quality settings differ from `_http.js`'s session delegation:
 *   - `waitFor: 'networkidle'` — wait for rate widgets to settle (vs.
 *     `_http.js`'s `domcontentloaded` default for cheap sniffs).
 *   - `scroll: true` + `accordions: true` — surface lazy-loaded / collapsed
 *     rate panels in the captured DOM.
 *   - `maxBytes: 2 MB` — matches `_http.js`'s DEFAULT_MAX_BYTES; large
 *     enough for HDFC-class pages.
 *
 * Fallback chain:
 *   1. If a Playwright `session` is provided, attempt session.fetch.
 *   2. On session throw (timeout, browser crash, closed) OR no session,
 *      fall through to Node HTTP via `_http.js`'s `httpRequest`. Lower
 *      fidelity (no JS rendering) but enough for html_static pages.
 *   3. On both failing, return `{ ok: false, error_class, error_message }`.
 *
 * Input:
 *   {
 *     url: string,
 *     session?: object,           // _playwright_session instance
 *     logger?: object,            // { info, warn, debug }
 *     timeoutMs?: number,         // default 60000
 *     maxBytes?: number,          // default 2 MB
 *   }
 *
 * Output (success):
 *   {
 *     ok: true,
 *     body: string,               // rendered HTML
 *     content_type: string,       // "text/html", "application/pdf", ...
 *     status_code: number,
 *     final_url: string,
 *     truncated: boolean,
 *     fetched_via: "session"|"node_http",
 *   }
 *
 * Output (failure):
 *   { ok: false, error_class: "fetch_failed", error_message: string }
 */

const { httpRequest } = require('./_http');

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;

async function fetchPage(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('fetchPage: input must be an object');
  }
  const { url, session = null, logger, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = input;
  if (!url || typeof url !== 'string') throw new Error('fetchPage: input.url is required');

  if (session) {
    try {
      const r = await session.fetch(url, {
        // `domcontentloaded` matches the rest of the orchestrator (Step 1G).
        // `networkidle` was tried first but timed out at 8s on tracker-heavy
        // hosts (bankofindia.bank.in) — same regression class Step 1G fixed
        // for the cheap sniffs. scroll + accordions still surface lazy /
        // collapsed rate panels, which was the original reason to want
        // networkidle.
        waitFor: 'domcontentloaded',
        scroll: true,
        accordions: true,
        maxBytes,
        timeoutMs,
      });
      const ct = (r.headers && r.headers['content-type']) || '';
      return {
        ok: true,
        body: r.body,
        content_type: String(ct).toLowerCase(),
        status_code: r.statusCode,
        final_url: r.finalUrl || url,
        truncated: !!r.truncated,
        fetched_via: 'session',
      };
    } catch (err) {
      if (logger?.warn) {
        logger.warn(`fetch_page: session.fetch threw for ${url} (${err.message}); falling back to Node HTTP`);
      }
      // fall through to Node HTTP
    }
  }

  // Node HTTP fallback (no session, or session threw).
  try {
    const r = await httpRequest(url, 'GET', { maxBytes, tolerant: true, logger });
    const ct = (r.headers && r.headers['content-type']) || '';
    const ok = r.statusCode >= 200 && r.statusCode < 400;
    if (!ok) {
      // Sprint 009 Phase 3 — also surface status_code + body on non-2xx so
      // cloud-block detection (lib/cloud-block/inspector.js) can run
      // detectChallenge() on 403/406/429 bodies. Pre-Phase-3 readers that
      // only checked `ok` continue to ignore these extra fields.
      return {
        ok: false,
        error_class: 'fetch_failed',
        error_message: `HTTP ${r.statusCode}`,
        status_code: r.statusCode,
        body: r.body || '',
      };
    }
    return {
      ok: true,
      body: r.body,
      content_type: String(ct).toLowerCase(),
      status_code: r.statusCode,
      final_url: url,
      truncated: !!r.truncated,
      fetched_via: 'node_http',
    };
  } catch (err) {
    return { ok: false, error_class: 'fetch_failed', error_message: err.message };
  }
}

module.exports = { fetchPage };

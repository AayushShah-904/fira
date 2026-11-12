'use strict';

/**
 * Hardened HTML fetcher with escalating retry rungs.
 *
 * Sprint 006 Phase B / Step 1a. Library function (not a CLI). Replaces
 * scripts/fetch_rates_playwright.js for runtime fetch — the old CLI is kept
 * as a deprecated stub through Sprint 6 per scripts/analysis/code-inventory.md.
 *
 * Escalation rungs (order from templateFetch.retry_escalation, default
 * ['default', 'stealth', 'firefox', 'llm-fallback']):
 *
 *   default     — chromium + standard UA
 *   stealth     — chromium + playwright-extra stealth plugin + UA rotation
 *   firefox     — firefox engine (no stealth — chromium-only)
 *   llm-fallback— short-circuit; do not fetch; caller routes to _llm-fallback
 *
 * Between rungs: if challenge_detect.js flags the response as a WAF page,
 * skip remaining `default` rungs and jump directly to `stealth`. PDF URLs
 * short-circuit immediately (no browser launch) so the caller can route to
 * lib/fetch/fetch_pdf.js.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/fetch-layer-hardening.md
 */

const path = require('node:path');
const fs = require('node:fs');
const { detectChallenge } = require('./challenge_detect');
const { runRung: defaultRunRung } = require('./_playwright_session');

const DEFAULT_ESCALATION = ['default', 'stealth', 'firefox', 'llm-fallback'];
const DEFAULT_TIMEOUT_MS = 60000;

const RUNG_TO_BROWSER = {
  default: 'chromium',
  stealth: 'chromium',
  firefox: 'firefox',
};

const PDF_RE = /\.pdf(?:\?|$)/i;

/**
 * Main entry point.
 *
 * @param {object} input
 * @param {string} input.url                Required.
 * @param {object} [input.templateFetch]    template.fetch block from bank-domains.json
 * @param {object} [input.log]              { info, warn, error, debug }
 * @param {string} [input.capturePath]      Directory for HAR + screenshot on failure
 * @param {function} [input._runRung]       Test injection — override the per-rung runner
 * @returns {Promise<{
 *   status, html, attempts, challenge_detected, final_strategy, ms, iframe_traversed, capture_path?
 * }>}
 */
async function fetchHtml(input) {
  const {
    url,
    templateFetch = {},
    log = noopLogger(),
    capturePath = null,
    _runRung = defaultRunRung,
  } = input || {};

  if (!url || typeof url !== 'string') {
    throw new Error('fetchHtml: input.url is required (string)');
  }

  const tStart = Date.now();

  // PDF short-circuit — fetch_html doesn't render PDFs.
  if (PDF_RE.test(url)) {
    return {
      status: 'failed',
      html: null,
      attempts: [{ rung: 'pdf-short-circuit', browser: null, outcome: 'pdf_url_not_html', ms: 0 }],
      challenge_detected: null,
      final_strategy: null,
      ms: Date.now() - tStart,
      iframe_traversed: false,
      reason: 'URL points to a PDF — route through lib/fetch/fetch_pdf.js instead',
    };
  }

  const escalation = Array.isArray(templateFetch.retry_escalation) && templateFetch.retry_escalation.length > 0
    ? templateFetch.retry_escalation
    : DEFAULT_ESCALATION;
  const timeoutMs = Number.isInteger(templateFetch.timeout_ms) ? templateFetch.timeout_ms : DEFAULT_TIMEOUT_MS;

  const attempts = [];
  let challengeDetected = null;
  let challengeJumpUsed = false;

  // Effective escalation order — may be re-shuffled when challenge_detect fires.
  const rungs = [...escalation];

  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i];

    if (rung === 'llm-fallback') {
      attempts.push({
        rung: 'llm-fallback',
        browser: null,
        outcome: 'no_fetch_attempted',
        ms: 0,
      });
      return {
        status: 'failed',
        html: null,
        attempts,
        challenge_detected: challengeDetected,
        final_strategy: 'llm-fallback',
        ms: Date.now() - tStart,
        iframe_traversed: false,
        reason: 'all browser rungs exhausted or skipped — caller routes to _llm-fallback',
      };
    }

    const browser = RUNG_TO_BROWSER[rung];
    if (!browser) {
      attempts.push({ rung, browser: null, outcome: 'unknown_rung_skipped', ms: 0 });
      continue;
    }

    const tRung = Date.now();
    try {
      if (log.info) log.info(`[fetch_html] rung=${rung} browser=${browser} attempt url=${url}`);
      const result = await _runRung({
        url,
        rung,
        browser,
        templateFetch,
        timeoutMs,
        capturePath,
        log,
      });
      const cd = detectChallenge({
        html: result.html || '',
        status: result.statusCode,
        headers: result.headers,
        bodySize: (result.html || '').length,
      });
      if (cd.challenged) {
        challengeDetected = challengeDetected || cd;
        attempts.push({
          rung,
          browser,
          outcome: 'challenge_detected',
          status_code: result.statusCode,
          challenge: cd,
          ms: Date.now() - tRung,
        });
        if (log.warn) log.warn(`[fetch_html] rung=${rung} → challenge (${cd.vendor}: ${cd.signal})`);
        // Jump-to-stealth: if we just hit a challenge on a non-stealth rung,
        // skip ahead to the first stealth rung in the remaining queue. Only
        // do this once per fetchHtml call to avoid pathological loops.
        if (!challengeJumpUsed && rung !== 'stealth') {
          const stealthIdx = rungs.indexOf('stealth', i + 1);
          if (stealthIdx > i + 1) {
            // Skip intervening rungs
            for (let j = i + 1; j < stealthIdx; j++) {
              attempts.push({
                rung: rungs[j],
                browser: RUNG_TO_BROWSER[rungs[j]] || null,
                outcome: 'skipped_due_to_challenge_jump',
                ms: 0,
              });
            }
            i = stealthIdx - 1; // outer loop will i++ to stealthIdx
            challengeJumpUsed = true;
          }
        }
        continue;
      }
      // Success — return immediately.
      attempts.push({
        rung,
        browser,
        outcome: 'success',
        status_code: result.statusCode,
        iframe_traversed: result.iframe_traversed,
        ms: Date.now() - tRung,
      });
      return {
        status: 'success',
        html: result.html,
        attempts,
        challenge_detected: challengeDetected,
        final_strategy: rung,
        ms: Date.now() - tStart,
        iframe_traversed: !!result.iframe_traversed,
      };
    } catch (err) {
      attempts.push({
        rung,
        browser,
        outcome: 'error',
        error: { message: err.message, code: err.code || null },
        ms: Date.now() - tRung,
      });
      if (log.warn) log.warn(`[fetch_html] rung=${rung} threw: ${err.message}`);
    }
  }

  // Every rung failed.
  const capture = capturePath ? writeCaptureManifest(capturePath, { url, attempts, challengeDetected }) : null;
  return {
    status: 'failed',
    html: null,
    attempts,
    challenge_detected: challengeDetected,
    final_strategy: null,
    ms: Date.now() - tStart,
    iframe_traversed: false,
    capture_path: capture,
  };
}

function writeCaptureManifest(capturePath, summary) {
  try {
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    const manifestPath = `${capturePath}.summary.json`;
    // safe-write-exempt: fetch-failure capture under operator-supplied capturePath (tmp/runs/<bank>/); not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(manifestPath, JSON.stringify(summary, null, 2));
    return manifestPath;
  } catch {
    return null;
  }
}

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

module.exports = {
  fetchHtml,
  DEFAULT_ESCALATION,
  DEFAULT_TIMEOUT_MS,
  // exported for testing:
  _internal: { RUNG_TO_BROWSER, PDF_RE },
};

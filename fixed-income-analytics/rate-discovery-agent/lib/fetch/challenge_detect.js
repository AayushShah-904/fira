'use strict';

/**
 * Pure WAF / anti-bot challenge detector.
 *
 * Sprint 006 Phase B / Step 1b. Inspects an HTTP response (body, status,
 * headers) and decides whether the response is a challenge page from
 * Cloudflare / Akamai / CloudFront / Imperva / generic WAF — vs the real
 * rate page we were trying to fetch.
 *
 * Called by lib/fetch/fetch_html.js between escalation rungs: on `challenged:
 * true` the fetcher jumps directly to the `stealth` rung, skipping the
 * `default` retry that would just hit the same challenge.
 *
 * Pure function — no I/O, no env, no global state. Trivially unit-testable.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/fetch-layer-hardening.md
 */

// Challenge-page markers must be SPECIFIC to a block/challenge state, not
// generic vendor mentions. Most Indian bank pages reference Cloudflare via
// CDN assets (`<script src="https://cdnjs.cloudflare.com/...">`), Imperva
// in footer attribution, etc. — those are NOT blocks. The detector should
// only fire on text that ONLY appears on a real challenge/block page.
//
// Sprint 7 2026-05-24: tightened after a 72-bank false-positive incident.
// The bare "/cloudflare/i" alternative was matching cdnjs.cloudflare.com
// inside <script src> tags on legitimate pages (bank-of-india, canara-bank,
// PNB, union-bank, all previously extracted by Playwright).
const SIGNAL_PATTERNS = [
  { vendor: 'cloudflare',  re: /Just a moment\.\.\.|Checking your browser before accessing|cf-chl-bypass|cf-mitigated|<title>[^<]*Attention Required.*Cloudflare/i },
  { vendor: 'akamai',      re: /Pardon Our Interruption|Reference&nbsp;#\d+\.\w+|akamai\s+reference\s*#/i },
  { vendor: 'cloudfront',  re: /Request blocked.*cloudfront|cloudfront\.net.*access denied|ERROR:\s*The request could not be satisfied/i },
  { vendor: 'imperva',     re: /incap_ses_|Incapsula\s+Incident\s+ID|<title>[^<]*Request unsuccessful.*Incapsula/i },
  { vendor: 'unknown_waf', re: /<title>[^<]*(?:Attention Required|Access Denied)|web\s+application\s+firewall\s+(?:blocked|triggered)/i },
];

const TINY_BODY_THRESHOLD = 5000;
const TABLE_RE = /<table[\s>]/i;

/**
 * @param {object} input
 * @param {string} input.html        Response body (HTML or plain text). Required.
 * @param {number} [input.status]    HTTP status code. Default: 200.
 * @param {object} [input.headers]   Response headers (case-insensitive lookup not required).
 * @param {number} [input.bodySize]  Override body size (else uses html.length).
 * @returns {{ challenged: boolean, vendor: string|null, signal: string|null }}
 */
function detectChallenge(input = {}) {
  const html = typeof input.html === 'string' ? input.html : '';
  const status = Number.isInteger(input.status) ? input.status : 200;
  const bodySize = Number.isInteger(input.bodySize) ? input.bodySize : html.length;

  // Signal 1-5: known WAF body strings (first match wins, ordered by specificity).
  for (const { vendor, re } of SIGNAL_PATTERNS) {
    if (re.test(html)) {
      const m = html.match(re);
      const fragment = m ? String(m[0]).slice(0, 80) : '';
      return { challenged: true, vendor, signal: `body-match: ${fragment}` };
    }
  }

  // Signal 6: status 200 with suspiciously thin body and no <table> at all.
  // Real bank rate pages always have tables; a sub-5KB success without one
  // is almost certainly a stub WAF response or a JS-shell that didn't render.
  if (status === 200 && bodySize < TINY_BODY_THRESHOLD && !TABLE_RE.test(html)) {
    return {
      challenged: true,
      vendor: 'unknown_waf',
      signal: `thin-body: status=200 size=${bodySize} no-table`,
    };
  }

  // Signal 7: explicit HTTP challenge codes.
  if (status === 403) return { challenged: true, vendor: 'unknown_waf', signal: 'http-403' };
  if (status === 429) return { challenged: true, vendor: 'unknown_waf', signal: 'http-429-rate-limit' };

  // Signal 8 (header-based): some CDNs leak vendor in headers even when body looks normal.
  if (input.headers) {
    const server = String(input.headers['server'] || input.headers['Server'] || '').toLowerCase();
    if (server.includes('cloudflare') && status >= 400) {
      return { challenged: true, vendor: 'cloudflare', signal: `header server=${server} status=${status}` };
    }
  }

  return { challenged: false, vendor: null, signal: null };
}

module.exports = {
  detectChallenge,
  // exported for testing / fuzzing:
  _internal: { SIGNAL_PATTERNS, TINY_BODY_THRESHOLD, TABLE_RE },
};

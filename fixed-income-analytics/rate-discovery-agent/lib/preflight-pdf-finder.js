'use strict';

/**
 * lib/preflight-pdf-finder.js — Phase 2: Dynamic PDF Discovery
 *
 * Solves the "dated PDF URL" anti-pattern where banks hardcode upload dates
 * into their PDF filenames (e.g., `nri-fixed-deposits-27-august-26.pdf`).
 * The moment they upload a new file, our hardcoded URL becomes a 404.
 *
 * Strategy:
 *   Instead of storing a hardcoded PDF URL in bank-domains.json, the registry
 *   stores the HTML landing page. This module fetches that HTML page and scans
 *   its anchor tags for a PDF href that matches a keyword pattern declared in
 *   the registry's `pdf_discovery` block.
 *
 * Registry schema (bank-domains.json):
 * ```json
 * "extraction": {
 *   "fd_pdf_nri": {
 *     "type": "pdf",
 *     "fulfills_product": ["fd_nre", "fd_nro"],
 *     "pdf_discovery": {
 *       "landing_page": "https://axis.bank.in/deposits/fixed-deposits/fd-interest-rates",
 *       "link_pattern": "nri.*fixed.deposit.*\\.pdf",
 *       "exclude_pattern": "plus|floating",
 *       "prefer_latest": true
 *     }
 *   }
 * }
 * ```
 *
 * When `pdf_discovery` is present, this module dynamically resolves the live
 * PDF URL at runtime and returns it for the orchestrator to use instead of
 * any hardcoded URL.
 *
 * Usage (called from orchestrator.js):
 *   const { discoverPdfUrl } = require('./preflight-pdf-finder');
 *   const liveUrl = await discoverPdfUrl(discoveryConfig, { domain, logger });
 *   if (liveUrl) cachedPath = liveUrl; // orchestrator uses this live URL
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

/**
 * Fetch the raw HTML body of a URL using Node's built-in http/https.
 * Follows one redirect. Returns null on failure.
 *
 * @param {string} url
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<string|null>}
 */
function fetchHtml(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(url, {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RateDiscoveryAgent/2.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      }, (res) => {
        // Follow one redirect
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          fetchHtml(res.headers.location, timeoutMs).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Extract all href values from <a> and <link> tags in raw HTML.
 *
 * @param {string} html
 * @returns {string[]}
 */
function extractHrefs(html) {
  const hrefs = [];
  // Match href="..." and href='...' in anchor and link tags
  const re = /href\s*=\s*["']([^"']+\.pdf[^"']*)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    hrefs.push(m[1].trim());
  }
  return hrefs;
}

/**
 * Resolve a potentially relative href to an absolute URL.
 *
 * @param {string} href
 * @param {string} baseUrl — the landing page URL
 * @returns {string|null}
 */
function resolveHref(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Dynamically discover the live PDF URL from an HTML landing page.
 *
 * @param {object} discoveryConfig — the `pdf_discovery` block from the registry
 * @param {string}   discoveryConfig.landing_page    — HTML page to scan
 * @param {string}   discoveryConfig.link_pattern    — regex string to match PDF hrefs (case-insensitive)
 * @param {string}   [discoveryConfig.exclude_pattern] — regex string to exclude certain hrefs
 * @param {boolean}  [discoveryConfig.prefer_latest]   — if true, sort results and pick the last (most recent) match
 * @param {object} opts
 * @param {object}  [opts.logger]  — optional logger with .info / .warn
 * @returns {Promise<string|null>} — resolved absolute PDF URL, or null if not found
 */
async function discoverPdfUrl(discoveryConfig, opts = {}) {
  const { landing_page, link_pattern, exclude_pattern, prefer_latest = true } = discoveryConfig;
  const { logger } = opts;
  const log = {
    info: (m) => (logger && logger.info ? logger.info(m) : null),
    warn: (m) => (logger && logger.warn ? logger.warn(m) : null),
  };

  if (!landing_page || !link_pattern) {
    log.warn('[preflight-pdf-finder] pdf_discovery config missing landing_page or link_pattern — skipping');
    return null;
  }

  log.info(`[preflight-pdf-finder] scanning ${landing_page} for PDF matching /${link_pattern}/i`);

  const html = await fetchHtml(landing_page);
  if (!html) {
    log.warn(`[preflight-pdf-finder] failed to fetch landing page: ${landing_page}`);
    return null;
  }

  const includeRe = new RegExp(link_pattern, 'i');
  const excludeRe = exclude_pattern ? new RegExp(exclude_pattern, 'i') : null;

  const hrefs = extractHrefs(html);
  log.info(`[preflight-pdf-finder] found ${hrefs.length} PDF href(s) on the page`);

  let matches = hrefs
    .map((href) => resolveHref(href, landing_page))
    .filter(Boolean)
    .filter((url) => includeRe.test(url))
    .filter((url) => !excludeRe || !excludeRe.test(url));

  if (matches.length === 0) {
    log.warn(`[preflight-pdf-finder] no PDF href matched /${link_pattern}/i on ${landing_page}`);
    return null;
  }

  // If prefer_latest, sort alphabetically (date strings in filenames sort naturally)
  // and pick the last entry — it will be the most recently named file.
  if (prefer_latest && matches.length > 1) {
    matches = matches.sort();
  }

  const chosen = prefer_latest ? matches[matches.length - 1] : matches[0];
  log.info(`[preflight-pdf-finder] discovered live PDF URL: ${chosen} (from ${matches.length} match(es))`);
  return chosen;
}

module.exports = { discoverPdfUrl, fetchHtml, extractHrefs };

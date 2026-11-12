'use strict';

/**
 * Per-URL extraction-hint resolver.
 *
 * Used by both the LLM-path (`lib/tools.js#fetchPdf` and `runPlaywright`) and
 * the orchestrator path (`lib/actions/extract_pdf_table.js`) to match a
 * fetched URL against the bank's registry entry and return the matching
 * `extraction.<rate_pages_key>` block, if any.
 *
 * Match logic: the requested URL must equal `https://<domain><rate_pages[key]>`
 * (treating `rate_pages[key]` as either an absolute URL or a path appended
 * to the bank's `domain`). Query string and trailing slash are normalised.
 *
 * Extracted to its own module so the resolver doesn't pull in the LLM
 * tooling chain when the orchestrator imports it.
 *
 * Added 2026-05-21 (sprint-004 M2.5).
 */

function normalizeUrl(s) {
  try {
    const u = new URL(s);
    return (u.host + u.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Match the URL against the bank's rate_pages.* entries and return the
 * extraction.<key> block (annotated with `{ key }`) when one exists, else
 * return null.
 *
 * @param {object|null} bankEntry — value from data/bank-domains.json[<bank_code>]
 * @param {string} url            — fully qualified URL the agent is fetching
 * @returns {object|null}         — { key, type, ...hint fields } or null
 */
function resolveExtractionHint(bankEntry, url) {
  if (!bankEntry || !bankEntry.rate_pages || !bankEntry.extraction) return null;
  const domain = bankEntry.domain;
  const target = normalizeUrl(url);
  if (!target) return null;
  for (const [key, raw] of Object.entries(bankEntry.rate_pages)) {
    if (!raw || typeof raw !== 'string') continue;
    const candidate = raw.startsWith('http')
      ? raw
      : `https://${domain}${raw.startsWith('/') ? raw : '/' + raw}`;
    const candidateN = normalizeUrl(candidate);
    if (candidateN && candidateN === target) {
      const hint = bankEntry.extraction[key];
      if (hint && typeof hint === 'object') return { key, ...hint };
    }
  }
  return null;
}

/**
 * M2.6 (sprint-004 2026-05-21): given a bank registry entry and an
 * orchestrator product name (`fd` / `fd_nre` / `fd_nro` / `fd_fcnr` /
 * `fd_gift`), return the full URL of a hinted PDF that fulfills that
 * product, or null if none exists.
 *
 * Authors declare which product a PDF fulfills via the `fulfills_product`
 * field on the extraction.<key> block — either a single string or an
 * array (e.g., one NRI PDF fulfilling both `fd_nre` and `fd_nro`).
 *
 * Returns `{ url, key, hint }` so the caller can both override the
 * find_rate_page URL AND log telemetry about which key matched.
 *
 * @param {object|null} bankEntry — value from data/bank-domains.json[<bank_code>]
 * @param {string} product        — "fd" | "fd_nre" | "fd_nro" | "fd_fcnr" | "fd_gift"
 * @returns {{url: string, key: string, hint: object}|null}
 */
function findHintedPdfUrl(bankEntry, product) {
  return findHintedUrlByType(bankEntry, product, 'pdf');
}

/**
 * Orch-2 (sprint-004 2026-05-21): HTML-side companion of `findHintedPdfUrl`.
 *
 * Allows a single HTML rate page to fulfill multiple variants — e.g.,
 * HDFC's `/fixed-deposit/fd-interest-rate` declares one rate table that
 * applies to `fd`, `fd_nre`, and `fd_nro`. The orchestrator routes all three
 * product iterations to the same URL; Orch-1's section-context interpretation
 * applies per-variant rule overrides (senior-exclusion, min-tenor) inside
 * `extract_html_table`.
 *
 * Same return shape as `findHintedPdfUrl`. Only the `type === 'html'` filter
 * differs.
 *
 * @param {object|null} bankEntry — value from data/bank-domains.json[<bank_code>]
 * @param {string} product        — "fd" | "fd_nre" | "fd_nro" | "fd_fcnr" | "fd_gift"
 * @returns {{url: string, key: string, hint: object}|null}
 */
function findHintedHtmlUrl(bankEntry, product) {
  return findHintedUrlByType(bankEntry, product, 'html');
}

/**
 * M3 (sprint-004 2026-05-22): OCR companion of `findHintedPdfUrl` and
 * `findHintedHtmlUrl`. Returns the hinted URL when a bank declares
 * `extraction.<key>.type === "image_ocr"` for the given product.
 *
 * Used for banks whose rate cards are published as images (JPG/PNG) or
 * scanned image-based PDFs that `pdf-parse` returns with empty text.
 * The orchestrator routes the product iteration through Azure Document
 * Intelligence Layout API via `lib/actions/extract_via_ocr.js`.
 *
 * @param {object|null} bankEntry — data/bank-domains.json[<bank_code>]
 * @param {string} product        — "fd" | "fd_nre" | "fd_nro" | "fd_fcnr" | "fd_gift"
 * @returns {{url: string, key: string, hint: object}|null}
 */
function findHintedOcrUrl(bankEntry, product) {
  return findHintedUrlByType(bankEntry, product, 'image_ocr');
}

function findHintedUrlByType(bankEntry, product, type) {
  if (!bankEntry || !bankEntry.extraction || !bankEntry.rate_pages) return null;
  const domain = bankEntry.domain;
  for (const [key, hint] of Object.entries(bankEntry.extraction)) {
    if (!hint || typeof hint !== 'object') continue;
    if (hint.type !== type) continue;
    const fp = hint.fulfills_product;
    const list = Array.isArray(fp) ? fp : (typeof fp === 'string' ? [fp] : []);
    if (!list.includes(product)) continue;
    const raw = bankEntry.rate_pages[key];
    if (!raw || typeof raw !== 'string') continue;
    const url = raw.startsWith('http') ? raw : `https://${domain}${raw.startsWith('/') ? raw : '/' + raw}`;
    return { url, key, hint };
  }
  return null;
}

module.exports = { resolveExtractionHint, findHintedPdfUrl, findHintedHtmlUrl, findHintedOcrUrl };

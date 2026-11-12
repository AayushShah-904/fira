'use strict';

/**
 * Canonical enum of `extraction_method` values per ADR-012.
 *
 * Two consumers:
 *   - lib/safe-write.js — validates incoming writes; refuses overwrites of
 *     curated artifacts unless the source is 'operator' or force is set.
 *   - lib/tier-router.js — gates the skip path; curated extraction methods
 *     bypass discovery to avoid clobbering operator data.
 *
 * Adding a new value: extend the right sub-set below, also document it in
 * ADR-012, and add a test for the safe-write check.
 *
 * Sprint 002 #5 / ADR-012.
 */

// Values produced by an automated agent / extractor path. These are
// auto-overwriteable on subsequent runs.
const AUTO_OVERWRITEABLE_METHODS = Object.freeze([
  // The agent's exploratory path (LLM inlines extraction during discovery).
  // Used as the default fallback for writes that don't tag a method —
  // matches today's behavior where the LLM writes config + rates directly.
  'llm_inline_extraction',

  // scripts/extract_rates.js dispatcher branches:
  'automatic_html_static',
  'automatic_html_js',
  'automatic_pdf',
  'automatic_mixed',

  // Playwright fallback paths (Sprint 002 L13 codification):
  'automatic_div_table',
  'automatic_text_lines',

  // Sprint 4 A15 — text-pattern fallback that scans body text for
  // (tenure, rate%) sequences when cheerio + LLM both return zero.
  // Used for SPA pages with no <table> elements (Equitas FD) and for
  // static pages whose single <table> has mashed cells (Equitas FCNR).
  'automatic_text_pattern',

  // Skip-gate synthetic outputs (registry_skip in lib/registry-skip.js).
  'registry_skip',

  // Operator-set opt-in refresh signal — "please re-extract on the next
  // run." Lifts the curated-data protection temporarily.
  'stale_needs_refresh',

  // scripts/refresh/verify-with-llm.js — LLM re-extraction over the cached
  // page body after the sanity gate flagged the deterministic candidate.
  // Distinct from llm_inline_extraction because it operates on a fixed body
  // (no fresh fetch) and passes both pre- and post-sanity gates.
  'llm_verified',

  // Sprint 004 M3 (2026-05-22): Azure Document Intelligence Layout API
  // (lib/actions/extract_via_ocr.js). Fires when a bank declares an
  // extraction.<key>.type === "image_ocr" hint pointing at a JPG/PNG or
  // image-only PDF rate card. Lifts banks out of the curated "pending_ocr"
  // / "pending_vision" state once an automated path is available.
  'automatic_ocr',

  // Custom bank parser adapters (lib/parsers/):
  'custom_parser_saraswat',
  'custom_parser_cosmos',
  'custom_parser_bom',
  'custom_parser_idfc',
]);

// Values that require operator-level authority to overwrite. The agent's
// re-run skips these (via tier-router) or routes its incoming to a pending
// sidecar (via safe-write).
const CURATED_EXTRACTION_METHODS = Object.freeze([
  'manual_image_transcription',
  'manual_transcription_from_rendered_text',
  'manual_pdf_transcription',
  'manual_data_entry',
  'pending_vision',
  'pending_ocr',
]);

const ALLOWED_EXTRACTION_METHODS = Object.freeze(
  [...AUTO_OVERWRITEABLE_METHODS, ...CURATED_EXTRACTION_METHODS],
);

const AUTO_OVERWRITEABLE_SET = new Set(AUTO_OVERWRITEABLE_METHODS);
const CURATED_SET = new Set(CURATED_EXTRACTION_METHODS);
const ALLOWED_SET = new Set(ALLOWED_EXTRACTION_METHODS);

function isAutoOverwriteable(method) {
  return AUTO_OVERWRITEABLE_SET.has(method) || (typeof method === 'string' && method.startsWith('custom_parser_'));
}

function isCurated(method) {
  return CURATED_SET.has(method);
}

function isAllowed(method) {
  return ALLOWED_SET.has(method) || (typeof method === 'string' && method.startsWith('custom_parser_'));
}

module.exports = {
  AUTO_OVERWRITEABLE_METHODS,
  CURATED_EXTRACTION_METHODS,
  ALLOWED_EXTRACTION_METHODS,
  isAutoOverwriteable,
  isCurated,
  isAllowed,
};

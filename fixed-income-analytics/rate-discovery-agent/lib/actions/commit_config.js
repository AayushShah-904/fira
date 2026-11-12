'use strict';

/**
 * Action: commit_config — write the per-bank `<bank_code>_config.json`
 * artifact that downstream tools (packages/scraper import-discovery,
 * pack/build-pack, etc.) expect alongside `<bank_code>_rates.json`.
 *
 * The LLM-prompt path produces this file implicitly: the LLM follows
 * docs/agent/schemas.md (Config File Schema) and writes it via the write_file
 * tool. The orchestrator path is deterministic Node, so it needs an explicit
 * action.
 *
 * Schema follows docs/agent/schemas.md (Config File Schema):
 *   {
 *     bank_code, bank_name, bank_type, category, state?, website,
 *     scraper_type, rate_page_urls: { fd, fd_nre, fd_nro, fd_fcnr, fd_gift, savings?, rd? },
 *     deposit_insurance, expected_slab_count?, notes?, scraper_notes?,
 *     discovery_metadata: { discovered_at, discovery_method, confidence },
 *     extraction_method  // required by safe-write; orchestrator emits 'automatic_orchestrator'
 *   }
 *
 * Input:
 *   {
 *     bank_code, bank_name, bank_type, category?, state?,
 *     website, scraper_type,
 *     rate_page_urls,             // map product → URL or null
 *     deposit_insurance?,         // default: true (false for IBU, RRB-ish)
 *     output_dir,                 // where to write (typically run_dir or output/latest/)
 *     confidence?,                // 'high'|'medium'|'low'|'none' (from find_website)
 *     logger?,
 *   }
 *
 * Output:
 *   { ok: true, wrote: boolean, path: string, reason?: string }
 */

const path = require('node:path');

const { safeWriteArtifact } = require('../safe-write');
const { slugify: canonicalSlugify } = require('../../scripts/utils/slugify');

const VALID_BANK_TYPES = new Set([
  'PSB', 'PVB', 'SFB', 'PB', 'FB', 'RRB', 'SUCB', 'NSUCB', 'SSCB', 'NSSCB',
  'DCCB', 'LAB', 'FI', 'IBU', 'HFC',
  // Sprint 010 A2 (2026-06-09): sentinel for orchestrator runs where the
  // category-to-type lookup failed (e.g., bank missing from registry, or
  // category string not in CATEGORY_TO_TYPE). Records the bank with a
  // truthful "we don't know what this is" type rather than crashing.
  'UNKNOWN',
]);

// Default deposit_insurance per bank type. IBU = no DICGC; everything else = true.
const NO_DEPOSIT_INSURANCE = new Set(['IBU']);

async function commitConfig(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('commitConfig: input must be an object');
  }
  const {
    bank_code, bank_name, bank_type, category, state,
    website, scraper_type, rate_page_urls,
    deposit_insurance, output_dir, confidence, logger,
  } = input;

  if (!bank_code) throw new Error('commitConfig: input.bank_code is required');
  if (!bank_name) throw new Error('commitConfig: input.bank_name is required');
  if (!bank_type) throw new Error('commitConfig: input.bank_type is required');
  if (!VALID_BANK_TYPES.has(bank_type)) {
    throw new Error(`commitConfig: input.bank_type must be one of ${[...VALID_BANK_TYPES].join(', ')} (got "${bank_type}")`);
  }
  if (!output_dir) throw new Error('commitConfig: input.output_dir is required');

  // Slug discipline — same boundary check as commit_rates.
  const canonical = canonicalSlugify(bank_name);
  if (canonical !== bank_code) {
    return {
      ok: false,
      error_class: 'slug_mismatch',
      error_message: `bank_code "${bank_code}" does not match slugify(bank_name) "${canonical}"`,
      log_entry: {
        level: 'warn', action: 'commit_config',
        bank_code, expected_slug: canonical, received_slug: bank_code,
        bank_name,
      },
    };
  }

  const insuranceDefault = !NO_DEPOSIT_INSURANCE.has(bank_type);
  const payload = {
    bank_code,
    bank_name,
    bank_type,
    ...(category ? { category } : {}),
    ...(state ? { state } : {}),
    website: website || null,
    scraper_type: scraper_type || null,
    rate_page_urls: cleanRatePageUrls(rate_page_urls),
    deposit_insurance: deposit_insurance != null ? deposit_insurance : insuranceDefault,
    discovery_metadata: {
      discovered_at: new Date().toISOString(),
      discovery_method: 'orchestrator',
      confidence: confidence || 'medium',
    },
    // extraction_method on a config file means "the method downstream will use
    // to extract rates from this bank". Drive it from scraper_type so safe-write
    // can apply its overwrite policy consistently. Unknown / unclassified falls
    // back to llm_inline_extraction (the historical agent default).
    extraction_method: extractionMethodFromScraperType(scraper_type),
  };

  const targetPath = path.join(output_dir, `${bank_code}_config.json`);
  const writeResult = safeWriteArtifact({
    path: targetPath,
    incoming: payload,
    kind: 'config',
    source: 'agent',
    logger,
  });

  return {
    ok: true,
    wrote: writeResult.wrote,
    path: targetPath,
    ...(writeResult.deferred_to_pending ? { deferred_to_pending: true, pending_path: writeResult.pending_path } : {}),
    ...(writeResult.reason ? { reason: writeResult.reason } : {}),
  };
}

/**
 * Map orchestrator scraper_type (kind from classify_rate_page) to a valid
 * extraction_method per lib/extraction-methods.js. Used so safe-write's
 * curated-overwrite check evaluates consistently against the canonical enum.
 */
function extractionMethodFromScraperType(scraperType) {
  switch (scraperType) {
    case 'html_static': return 'automatic_html_static';
    case 'html_js':     return 'automatic_html_js';
    case 'pdf':         return 'automatic_pdf';
    case 'mixed':       return 'automatic_mixed';
    case 'image':       return 'pending_vision';
    default:            return 'llm_inline_extraction'; // safe historical default
  }
}

/**
 * Normalize rate_page_urls input. Accepts:
 *   - { fd: "https://..." | "/path", fd_nre: null, ... }
 *   - undefined / null → returns null
 * Drops keys whose value is undefined; preserves null (operator signal for
 * "this variant doesn't apply"). Values are stored as-is — both absolute URLs
 * and relative paths are valid since the downstream consumer pairs them with
 * the website field.
 */
function cleanRatePageUrls(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

module.exports = { commitConfig };

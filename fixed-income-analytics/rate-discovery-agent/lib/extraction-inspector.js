'use strict';

/**
 * Sprint 009 Phase 2.5 — read a bank's per-variant rate files + final
 * summary to decide whether an exit-0 child actually produced useful
 * work. Used by run-batch.js#classifyResult to catch the "ARM Succeeded
 * but extraction was empty" case (HDFC 2026-06-03 smoke).
 *
 * Lives in lib/ rather than inline in run-batch.js so the rule can be
 * unit-tested against tmp-dir fixtures without spinning up the agent.
 *
 * See container-mgmt/doc/cloud-deploy-smoke-operational-handoff.md
 * item 2.
 */

const fs = require('node:fs');
const path = require('node:path');

const { CURATED_EXTRACTION_METHODS } = require('./extraction-methods');

// Per CLAUDE.md: the discovery agent writes a bare domestic file
// `<bankCode>_rates.json` plus optional variants suffixed with
// `_nre` / `_nro` / `_fcnr` / `_gift`. Other product types (savings,
// RD, current account) carry rates inline in the config file and have
// no separate rate file.
const RATE_FILE_VARIANTS = Object.freeze(['', '_nre', '_nro', '_fcnr', '_gift']);

// Sprint 009 Phase 9.2 (2026-06-05): methods that represent a legitimate
// "no rates extracted, but that's the intended outcome" state. The
// zero-slab classifier should NOT reclassify these as failures.
//   - registry_skip: lib/registry-skip.js writes a synthetic bare _rates.json
//     when a bank is tier-router-skipped (discovery_status or curated extraction_method).
//   - manual_*: operator-curated rate files. If the bank-LEVEL extraction_method
//     is curated, tier-router skips and writes registry_skip. If only the FILE-LEVEL
//     method is curated (operator-edited rate file), it's not a zero-slab failure.
const SKIP_OUTPUT_METHODS = new Set(['registry_skip', ...CURATED_EXTRACTION_METHODS]);

/**
 * @param {string} bankCode    canonical bank slug (matches output filenames)
 * @param {string} latestDir   directory holding <bankCode>*_rates.json +
 *                             <bankCode>.summary.json
 * @returns {{
 *   totalSlabs: number,
 *   bareConfidence: string|null,
 *   failureClass: string|null,
 *   filesPresent: number,
 * }}
 */
function inspectExtractionOutput(bankCode, latestDir) {
  let totalSlabs = 0;
  let filesPresent = 0;
  let bareConfidence = null;
  let bareExtractionMethod = null;

  for (const variant of RATE_FILE_VARIANTS) {
    const ratesFile = path.join(latestDir, `${bankCode}${variant}_rates.json`);
    if (!fs.existsSync(ratesFile)) continue;
    filesPresent++;
    try {
      const rates = JSON.parse(fs.readFileSync(ratesFile, 'utf-8'));
      if (Array.isArray(rates.rate_slabs)) totalSlabs += rates.rate_slabs.length;
      if (variant === '' && typeof rates.extraction_confidence === 'string') {
        bareConfidence = rates.extraction_confidence.toLowerCase();
      }
      if (variant === '' && typeof rates.extraction_method === 'string') {
        bareExtractionMethod = rates.extraction_method;
      }
    } catch { /* malformed rate file — leave counters untouched */ }
  }

  // Prefer the post-retry summary if it exists (matches run-discovery.js's
  // file-naming convention: `_attempt2.summary.json` for the retry pass,
  // `.summary.json` for the first pass).
  let failureClass = null;
  for (const name of [`${bankCode}_attempt2.summary.json`, `${bankCode}.summary.json`]) {
    const p = path.join(latestDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const summary = JSON.parse(fs.readFileSync(p, 'utf-8'));
      failureClass = summary.failure_class || null;
      break;
    } catch { /* ignore */ }
  }

  return { totalSlabs, bareConfidence, failureClass, filesPresent, bareExtractionMethod };
}

/**
 * Decide whether an exit-0 bank run was actually a zero-slab failure.
 * Strict per the handoff doc: every produced rate file is empty AND the
 * bare file's confidence is `none`. Legitimate no-FD banks (Payments
 * Bank, etc.) carry failure_class=`no_rates_expected` and are excluded.
 *
 * @param {ReturnType<typeof inspectExtractionOutput>} out
 * @returns {boolean}
 */
function isZeroSlabFailure(out) {
  if (!out) return false;
  if (out.failureClass === 'no_rates_expected') return false;
  // Sprint 009 Phase 9.2 (2026-06-05): tier-router-skipped banks
  // (discovery_status or curated extraction_method) produce a synthetic
  // bare _rates.json with `extraction_method: registry_skip` and conf=none.
  // That's a legitimate skip, not an extraction failure. Likewise for
  // operator-curated `manual_*` files written by hand. The zero-slab
  // classifier shouldn't reclassify these as failed — the bank's data
  // (or intentional absence) is preserved in the registry/blob via the
  // existing safe-write + curated-preservation paths.
  if (out.bareExtractionMethod && SKIP_OUTPUT_METHODS.has(out.bareExtractionMethod)) {
    return false;
  }
  return out.filesPresent > 0 && out.totalSlabs === 0 && out.bareConfidence === 'none';
}

module.exports = { inspectExtractionOutput, isZeroSlabFailure, RATE_FILE_VARIANTS };

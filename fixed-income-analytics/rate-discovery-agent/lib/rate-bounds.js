'use strict';

/**
 * Sanity bounds for rejecting extraction-error slabs.
 *
 * Distinct from `scripts/utils/validation-constants.js#VARIANT_RATE_RANGES`,
 * which is the *tight* validation band used by `validate-rates.js` to emit
 * warnings (e.g., "rate 10.5% above ceiling 9.5%"). These bounds are the
 * *loose* sanity check used by:
 *
 *   - `pack/build-pack.js`           — drops a slab from the published pack
 *                                      when an obviously-bad value escaped
 *                                      extraction (e.g., a tenure cell like
 *                                      "15 days to 100 days" mis-mapped to
 *                                      `rate_general_pct` becomes 15100).
 *   - `lib/actions/extract_html_table.js` — applies the same filter at
 *                                      extraction time so the bad slab
 *                                      never reaches `_rates.json`.
 *   - `scripts/extract_rates.js`     — `looksLikeBadMapping` threshold
 *                                      tightens from the legacy `>30` to
 *                                      the variant-aware max.
 *
 * The values are deliberately wider than the validation band so legitimate
 * but unusually high rates (e.g., a one-off 12% promotional FD) still ship
 * with a warning rather than being dropped silently.
 *
 * Added 2026-05-23 (cohort #3 Phase B + E). 165 of 304 dual-gate anomalies
 * trace to slabs where `rate_general_pct` was clearly an extraction error
 * (values like 15100, 181365, 247.5, 366) — these bounds catch all of them.
 */

/**
 * Loose sanity bounds per variant. Values outside this band are treated as
 * extraction errors and dropped (not warned).
 */
const PACK_FILTER_BOUNDS = Object.freeze({
  regular: { min: 0.1, max: 15 },
  nre:     { min: 0.1, max: 15 },
  nro:     { min: 0.1, max: 15 },
  fcnr:    { min: 0.0, max: 12 },
  gift:    { min: 0.0, max: 12 },
});

/**
 * Workstream E (sprint-004 2026-05-23): hard cap on tenure_max_days. Indian
 * FDs cap at 10 years (3650d); any slab claiming tenure_max > 3700 is an
 * extraction error — typically a digit-concatenation bug (e.g., bank lists
 * "5475 days" because "15 years 5475d" got mis-parsed; or "10890" from
 * "1 year — 0890" cell mash). The slab is dropped at pack-build time the
 * same way out-of-band rates are.
 */
const TENURE_MAX_DAYS_CAP = 3700;

function isSlabTenureSane(slab) {
  if (!slab || typeof slab !== 'object') return true;
  const tMax = slab.tenure_max_days;
  if (typeof tMax === 'number' && tMax > TENURE_MAX_DAYS_CAP) return false;
  const tMin = slab.tenure_min_days;
  if (typeof tMin === 'number' && typeof tMax === 'number' && tMin > tMax) return false;
  return true;
}

function boundsForVariant(variant) {
  const v = variant || 'regular';
  return PACK_FILTER_BOUNDS[v] || PACK_FILTER_BOUNDS.regular;
}

/**
 * Test whether a numeric rate is within the loose sanity band for the variant.
 * Returns true for non-numeric / null inputs (those are handled separately by
 * the extraction layer — this helper only judges *present* values).
 *
 * @param {*} pct - the rate value to check
 * @param {string} variant - 'regular'|'nre'|'nro'|'fcnr'|'gift'
 * @returns {boolean}
 */
function isRateInBounds(pct, variant) {
  if (pct == null || typeof pct !== 'number' || Number.isNaN(pct)) return true;
  const { min, max } = boundsForVariant(variant);
  return pct >= min && pct <= max;
}

/**
 * Test whether a slab's rate fields (general/senior/super-senior) all fall
 * within the loose sanity band. A slab failing this check should be dropped
 * by the consumer.
 *
 * @param {object} slab - { rate_general_pct, rate_senior_pct?, rate_super_senior_pct? }
 * @param {string} variant
 * @returns {boolean}
 */
function isSlabRateInBounds(slab, variant) {
  if (!slab || typeof slab !== 'object') return true;
  return isRateInBounds(slab.rate_general_pct, variant)
      && isRateInBounds(slab.rate_senior_pct, variant)
      && isRateInBounds(slab.rate_super_senior_pct, variant);
}

module.exports = {
  PACK_FILTER_BOUNDS,
  TENURE_MAX_DAYS_CAP,
  boundsForVariant,
  isRateInBounds,
  isSlabRateInBounds,
  isSlabTenureSane,
};

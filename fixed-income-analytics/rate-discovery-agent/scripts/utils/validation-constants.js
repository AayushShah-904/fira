/**
 * Validation constants — CJS port of `packages/shared/src/validation/`.
 *
 * Per ADR-014: this file is the agent-side mirror of the canonical TS module.
 * Both files keep numeric constants in sync; the drift-check test at
 * `tests/lib/validation-constants-drift.test.js` runs against the TS dist and
 * fails on any mismatch.
 *
 * When a value changes:
 *   1. Update `packages/shared/src/validation/` (TS source of truth).
 *   2. Mirror the change here (CJS twin).
 *   3. Run the drift-check test — it asserts every number agrees.
 *
 * The same convention applies as `parse-tenure.js` ↔ `tenure-maps.ts`.
 */

'use strict';

/**
 * Variant-specific rate-range overrides.
 * `regular` returns null so callers fall back to product-level rateRange.
 * NRE/NRO are INR-denominated; FCNR/GIFT are foreign-currency.
 */
const VARIANT_RATE_RANGES = Object.freeze({
  // Validation bounds for regular FD are deliberately wider than PRODUCT_TYPES.FD.rateRange
  // (which is for display/metadata). Real PSB 7-day rates hit 2.0-2.5%; the 1.5 floor avoids
  // false-positive warnings on those legitimate rates.
  regular: { min: 1.5, max: 9.5 },
  nre:  { min: 2.0, max: 9.5 },
  nro:  { min: 2.0, max: 9.5 },
  fcnr: { min: 0.5, max: 8.0 },
  gift: { min: 0.5, max: 8.0 },
});

/**
 * Currency-specific rate-range overrides for FCNR/GIFT low-yield currencies.
 * JPY and CHF FCNR(B) rates are legitimately near-zero (e.g. Axis publishes
 * JPY at 0.00–0.01%); the flat fcnr floor (0.5) collapsed those currencies
 * wholesale at filter time. min 0 means 0% is legal; negative rates remain
 * below-floor. SGD/HKD stay on the default fcnr/gift band.
 */
const LOW_YIELD_CURRENCIES = Object.freeze({
  JPY: Object.freeze({ min: 0, max: 3.0 }),
  CHF: Object.freeze({ min: 0, max: 3.0 }),
});

/** Variants where senior/super-senior rates do NOT apply. */
const NO_SENIOR_VARIANTS = Object.freeze(new Set(['fcnr', 'gift']));

/** Variant-specific tenure constraints (in days); null = no constraint beyond product-level. */
const VARIANT_TENURE = Object.freeze({
  regular: null,
  nre:  { min: 365, max: 3650 },
  nro:  null,
  fcnr: { min: 365, max: 1825 },
  // GIFT-City IBU deposits are OFFSHORE and legitimately offer short tenors
  // (7-day, 1-month, etc.) — unlike domestic FCNR(B) which is bound by the
  // RBI 1-year floor. Keep the 7-day floor to drop sub-week/garbage rows while
  // admitting genuine short-tenor FCY FDs. Only `gift` gets this relaxation;
  // `fcnr` KEEPS min 365 (RBI rule + Call-Deposit-table conflation guard).
  gift: { min: 7, max: 1825 },
});

/** Premium ceilings for senior / super-senior rates above the general max. */
const SENIOR_PREMIUM = 1.0;
const SUPER_SENIOR_PREMIUM = 1.5;

/** "Critical" overshoot — when rate exceeds general_max by this much, scraper L2 emits critical (blocks import). */
const CRITICAL_OVERSHOOT = 2.0;

/** Default delta-bps thresholds — 1× warning, 2× critical. */
const DEFAULT_DELTA_BPS = 50;
const HIGH_DELTA_BPS = 75;
const HIGH_DELTA_CATEGORIES = Object.freeze(new Set(['SFB', 'NBFC', 'LAB']));

/**
 * FD product-level rate range (mirrors PRODUCT_TYPES.FD.rateRange from the
 * TS module; pinned here so the agent doesn't need to import packages/shared).
 */
const FD_RATE_RANGE = Object.freeze({ min: 2.5, max: 9.5 });

/** Resolve the active rate-range for a (product, variant) pair. */
function getRateRange(productType, variant) {
  const v = variant || 'regular';
  if (VARIANT_RATE_RANGES[v]) return VARIANT_RATE_RANGES[v];
  // Fallback for future variants we don't yet enumerate.
  if (productType === 'FD') return FD_RATE_RANGE;
  return null;
}

function getSeniorRange(productType, variant) {
  const v = variant || 'regular';
  if (NO_SENIOR_VARIANTS.has(v)) return null;
  const base = getRateRange(productType, v);
  if (!base) return null;
  return { min: base.min, max: base.max + SENIOR_PREMIUM };
}

function getSuperSeniorRange(productType, variant) {
  const v = variant || 'regular';
  if (NO_SENIOR_VARIANTS.has(v)) return null;
  const base = getRateRange(productType, v);
  if (!base) return null;
  return { min: base.min, max: base.max + SUPER_SENIOR_PREMIUM };
}

function getDeltaThreshold(bankCategory) {
  const warningBps = bankCategory && HIGH_DELTA_CATEGORIES.has(bankCategory)
    ? HIGH_DELTA_BPS
    : DEFAULT_DELTA_BPS;
  return { warningBps, criticalBps: warningBps * 2 };
}

module.exports = {
  VARIANT_RATE_RANGES,
  LOW_YIELD_CURRENCIES,
  NO_SENIOR_VARIANTS,
  VARIANT_TENURE,
  SENIOR_PREMIUM,
  SUPER_SENIOR_PREMIUM,
  CRITICAL_OVERSHOOT,
  DEFAULT_DELTA_BPS,
  HIGH_DELTA_BPS,
  HIGH_DELTA_CATEGORIES,
  FD_RATE_RANGE,
  getRateRange,
  getSeniorRange,
  getSuperSeniorRange,
  getDeltaThreshold,
};

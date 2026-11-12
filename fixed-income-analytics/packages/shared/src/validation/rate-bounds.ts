/**
 * Canonical rate-range bounds for FD / RD / Savings / etc., variant-aware.
 *
 * ADR-014 single source of truth. Both rate-discovery-agent (via the CJS port
 * at scripts/utils/validate-rates.js) and packages/scraper (via
 * validators/range.ts) read from this module.
 *
 * Numeric values match `PRODUCT_TYPES.FD.rateRange` from
 * `packages/shared/src/constants/product-types.ts` where applicable; variant
 * overrides are listed here because the product-types module is product-level,
 * not variant-level.
 */

import { PRODUCT_TYPES } from "../constants/product-types.js";
import type { ProductType } from "../types/index.js";

/** Variant-specific rate range overrides. INR (regular/nre/nro) inherit product defaults; FCNR/GIFT have foreign-currency ranges. */
export interface VariantRateRange {
  min: number;
  max: number;
}

export type Variant = "regular" | "nre" | "nro" | "fcnr" | "gift";

export const VARIANT_RATE_RANGES: Record<Variant, VariantRateRange | null> = {
  // Validation bounds for regular FD are deliberately wider than PRODUCT_TYPES.FD.rateRange
  // (which is for display/metadata). Real PSB 7-day rates hit 2.0-2.5%; using a 1.5 floor
  // avoids false-positive warnings on those legitimate rates.
  regular: { min: 1.5, max: 9.5 },
  // NRE/NRO are INR-denominated; minimum tracks at 2.0 because banks don't bottom these out.
  nre: { min: 2.0, max: 9.5 },
  nro: { min: 2.0, max: 9.5 },
  // FCNR / GIFT are foreign-currency; rates run lower.
  fcnr: { min: 0.5, max: 8.0 },
  gift: { min: 0.5, max: 8.0 },
};

/**
 * Currency-specific rate-range overrides for FCNR/GIFT low-yield currencies.
 * JPY and CHF FCNR(B) rates are legitimately near-zero (e.g. Axis publishes
 * JPY at 0.00–0.01%); the flat fcnr floor (0.5) collapsed those currencies
 * wholesale at filter time. min 0 means 0% is legal; negative rates remain
 * below-floor. SGD/HKD stay on the default fcnr/gift band.
 */
export const LOW_YIELD_CURRENCIES: Record<string, VariantRateRange> = {
  JPY: { min: 0, max: 3.0 },
  CHF: { min: 0, max: 3.0 },
};

/** Variants where senior/super-senior rates do NOT apply (foreign currency products). */
export const NO_SENIOR_VARIANTS: ReadonlySet<Variant> = new Set(["fcnr", "gift"]);

/** Variant-specific tenure constraints (days). null = no constraint beyond product-level. */
export const VARIANT_TENURE: Record<Variant, { min: number; max: number } | null> = {
  regular: null,
  nre: { min: 365, max: 3650 },
  nro: null,
  fcnr: { min: 365, max: 1825 },
  // GIFT-City IBU deposits are OFFSHORE and legitimately offer short tenors
  // (7-day, 1-month, etc.) — unlike domestic FCNR(B) which is bound by the
  // RBI 1-year floor. Keep the 7-day floor to drop sub-week/garbage rows while
  // admitting genuine short-tenor FCY FDs. Only `gift` gets this relaxation;
  // `fcnr` KEEPS min 365 (RBI rule + Call-Deposit-table conflation guard).
  gift: { min: 7, max: 1825 },
};

/** Bps premium ceilings for senior / super-senior rates above the general max. */
export const SENIOR_PREMIUM = 1.0;       // senior rate may go up to general_max + 1.0%
export const SUPER_SENIOR_PREMIUM = 1.5;  // super-senior may go up to general_max + 1.5%

/**
 * Resolve the active rate-range for a (product, variant) pair.
 * Returns null if the product is unknown.
 */
export function getRateRange(productType: string, variant: Variant = "regular"): VariantRateRange | null {
  const variantRange = VARIANT_RATE_RANGES[variant];
  if (variantRange) return variantRange;
  // Fallback for future variants we don't yet enumerate.
  const ptKey = productType as ProductType;
  return PRODUCT_TYPES[ptKey]?.rateRange ?? null;
}

/**
 * Senior rate range given the (product, variant). Returns null for fcnr/gift.
 */
export function getSeniorRange(productType: string, variant: Variant = "regular"): VariantRateRange | null {
  if (NO_SENIOR_VARIANTS.has(variant)) return null;
  const base = getRateRange(productType, variant);
  if (!base) return null;
  return { min: base.min, max: base.max + SENIOR_PREMIUM };
}

/**
 * Super-senior rate range given the (product, variant). Returns null for fcnr/gift.
 */
export function getSuperSeniorRange(productType: string, variant: Variant = "regular"): VariantRateRange | null {
  if (NO_SENIOR_VARIANTS.has(variant)) return null;
  const base = getRateRange(productType, variant);
  if (!base) return null;
  return { min: base.min, max: base.max + SUPER_SENIOR_PREMIUM };
}

/**
 * "Critical" cutoff: when a rate is THIS far outside the expected range, the
 * scraper-side L2 validator emits a critical (blocking) flag rather than a
 * warning. Used by both the agent's commit_rates and packages/scraper.
 */
export const CRITICAL_OVERSHOOT = 2.0; // rate > max + 2 → critical

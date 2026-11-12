/**
 * Layer 2: Range validation — adapter over the canonical validation module
 * at `@bird/shared/validation` per ADR-014. Numeric bounds and senior/super
 * premium ceilings live in the shared module; this file maps the shared
 * rule outputs onto the scraper's `scrape_flags` schema.
 */
import {
  getRateRange as sharedGetRateRange,
  NO_SENIOR_VARIANTS as SHARED_NO_SENIOR_VARIANTS,
  SENIOR_PREMIUM,
  SUPER_SENIOR_PREMIUM,
  CRITICAL_OVERSHOOT,
  type Variant,
} from "@bird/shared";
import type { RawSlab, ValidationResult, ValidationFlag } from "./types.js";

const NO_SENIOR_VARIANTS = SHARED_NO_SENIOR_VARIANTS;

function getRateRange(productType: string, variant?: string): { min: number; max: number } | null {
  // The shared API defaults variant to "regular"; callers may pass undefined
  // which we map the same way for back-compat.
  return sharedGetRateRange(productType, (variant as Variant) || "regular");
}

export function validateRange(
  slabs: RawSlab[],
  productType: string,
  variant?: string,
): ValidationResult {
  const flags: ValidationFlag[] = [];
  const range = getRateRange(productType, variant);

  if (!range) {
    flags.push({
      flag_type: "range",
      severity: "warning",
      details: JSON.stringify({ message: `Unknown product type: ${productType}, skipping range check` }),
    });
    return { passed: true, flags };
  }

  const { min, max } = range;
  const skipSenior = variant ? NO_SENIOR_VARIANTS.has(variant as Variant) : false;

  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i];
    const rate = slab.rate_general_pct;
    if (rate == null) continue;

    if (rate < min || rate > max) {
      flags.push({
        flag_type: "range",
        severity: rate < 0 || rate > max + CRITICAL_OVERSHOOT ? "critical" : "warning",
        details: JSON.stringify({
          message: `rate_general_pct ${rate}% outside expected range [${min}%, ${max}%]${variant ? ` (variant: ${variant})` : ""}`,
          rate,
          expected_min: min,
          expected_max: max,
          tenure_text: slab.tenure_text,
          variant: variant || "regular",
        }),
        slab_index: i,
      });
    }

    // Check senior rate bounds — skip for FCNR/GIFT
    if (slab.rate_senior_pct != null) {
      if (skipSenior) {
        flags.push({
          flag_type: "range",
          severity: "info",
          details: JSON.stringify({
            message: `${variant} slab has senior rate — not expected for this variant`,
            rate: slab.rate_senior_pct,
            tenure_text: slab.tenure_text,
          }),
          slab_index: i,
        });
      } else {
        const seniorMax = max + SENIOR_PREMIUM;
        if (slab.rate_senior_pct < min || slab.rate_senior_pct > seniorMax) {
          flags.push({
            flag_type: "range",
            severity: "warning",
            details: JSON.stringify({
              message: `rate_senior_pct ${slab.rate_senior_pct}% outside expected range [${min}%, ${seniorMax}%]`,
              rate: slab.rate_senior_pct,
              expected_min: min,
              expected_max: seniorMax,
              tenure_text: slab.tenure_text,
            }),
            slab_index: i,
          });
        }
      }
    }

    // Check super senior rate bounds — skip for FCNR/GIFT
    if (slab.rate_super_senior_pct != null && !skipSenior) {
      const superMax = max + SUPER_SENIOR_PREMIUM;
      if (slab.rate_super_senior_pct < min || slab.rate_super_senior_pct > superMax) {
        flags.push({
          flag_type: "range",
          severity: "warning",
          details: JSON.stringify({
            message: `rate_super_senior_pct ${slab.rate_super_senior_pct}% outside expected range [${min}%, ${superMax}%]`,
            rate: slab.rate_super_senior_pct,
            expected_min: min,
            expected_max: superMax,
            tenure_text: slab.tenure_text,
          }),
          slab_index: i,
        });
      }
    }
  }

  const hasCritical = flags.some(f => f.severity === "critical");
  return { passed: !hasCritical, flags };
}

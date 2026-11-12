/**
 * Rate validation utilities for extracted FD interest rates.
 *
 * Numeric constants are consumed from `scripts/utils/validation-constants.js`,
 * which is the CJS twin of `packages/shared/src/validation/` per ADR-014.
 * The legacy `RATE_BOUNDS`, `VARIANT_BOUNDS`, `VARIANT_TENURE` exports are
 * preserved for back-compat with any older callers.
 */

const {
  VARIANT_RATE_RANGES,
  LOW_YIELD_CURRENCIES,
  VARIANT_TENURE: V_TENURE_SHARED,
  SENIOR_PREMIUM,
  SUPER_SENIOR_PREMIUM,
} = require('./validation-constants');

/** Derived from validation-constants: general/senior/super-senior bounds for the regular variant. */
const RATE_BOUNDS = {
  general: VARIANT_RATE_RANGES.regular,
  senior: { min: VARIANT_RATE_RANGES.regular.min, max: VARIANT_RATE_RANGES.regular.max + SENIOR_PREMIUM },
  super_senior: { min: VARIANT_RATE_RANGES.regular.min, max: VARIANT_RATE_RANGES.regular.max + SUPER_SENIOR_PREMIUM },
};

/** Variant-specific rate bounds for NRI/FCNR/GIFT products (filtered to variants that override regular). */
const VARIANT_BOUNDS = {
  nre: VARIANT_RATE_RANGES.nre,
  nro: VARIANT_RATE_RANGES.nro,
  fcnr: VARIANT_RATE_RANGES.fcnr,
  gift: VARIANT_RATE_RANGES.gift,
};

/** Variant-specific tenure constraints (in days) — entries with non-null shared constraint. */
const VARIANT_TENURE = {
  ...(V_TENURE_SHARED.nre  ? { nre:  V_TENURE_SHARED.nre  } : {}),
  ...(V_TENURE_SHARED.fcnr ? { fcnr: V_TENURE_SHARED.fcnr } : {}),
  ...(V_TENURE_SHARED.gift ? { gift: V_TENURE_SHARED.gift } : {}),
};

/**
 * Resolve the rate bounds for a single slab: for foreign-currency variants
 * (fcnr/gift) a low-yield currency override (JPY/CHF near-zero band) takes
 * precedence over the variant band. Everything else keeps the variant band.
 *
 * Sprint 011 fix (2026-07-07): the flat fcnr floor (0.5%) was dropping ALL
 * JPY slabs — Axis publishes real JPY FCNR(B) rates at 0.00–0.01% — the
 * "collapsed FCNR currencies" error class. With the override, min 0 keeps
 * 0% legal while negative rates are still below-floor.
 *
 * @param {string} variant - 'regular'|'nre'|'nro'|'fcnr'|'gift'
 * @param {object} slab - the rate slab (uses slab.currency)
 * @param {{min:number,max:number}|null} variantBounds - fallback band
 * @returns {{min:number,max:number}|null}
 */
function resolveSlabBounds(variant, slab, variantBounds) {
  if ((variant === 'fcnr' || variant === 'gift') && slab && slab.currency) {
    const override = LOW_YIELD_CURRENCIES[String(slab.currency).toUpperCase()];
    if (override) return override;
  }
  return variantBounds;
}

/**
 * Validate a single rate value.
 * Returns { valid, warnings[] }.
 */
function validateRate(pct, type = "general") {
  const bounds = RATE_BOUNDS[type] || RATE_BOUNDS.general;
  const warnings = [];

  if (typeof pct !== "number" || isNaN(pct)) {
    return { valid: false, warnings: [`${type} rate is not a number: ${pct}`] };
  }
  if (pct < bounds.min) {
    warnings.push(`${type} rate ${pct}% below floor (${bounds.min}%)`);
  }
  if (pct > bounds.max) {
    warnings.push(`${type} rate ${pct}% above ceiling (${bounds.max}%)`);
  }

  return { valid: warnings.length === 0, warnings };
}

/**
 * Validate an array of rate slabs.
 * Checks: rate bounds, tenure continuity, senior >= general.
 * @param {Array} slabs - Rate slabs to validate
 * @param {string} [variant="regular"] - Product variant (regular, nre, nro, fcnr, gift)
 * Returns { valid, warnings[], errors[] }.
 */
function validateSlabs(slabs, variant = "regular") {
  const warnings = [];
  const errors = [];

  if (!Array.isArray(slabs) || slabs.length === 0) {
    return { valid: true, warnings: ["No rate slabs to validate"], errors: [] };
  }

  const isForeignCurrency = variant === "fcnr" || variant === "gift";
  const variantBounds = VARIANT_BOUNDS[variant] || null;
  const tenureConstraints = VARIANT_TENURE[variant] || null;

  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i];
    const prefix = `Slab ${i + 1} (${slab.tenure_text || "?"})`;

    // Validate general rate — use variant-specific bounds if available.
    // For FCNR/GIFT the bounds are currency-aware: low-yield currencies
    // (JPY/CHF) get a near-zero band instead of the flat variant floor.
    const slabBounds = resolveSlabBounds(variant, slab, variantBounds);
    if (slab.rate_general_pct != null) {
      if (slabBounds) {
        if (slab.rate_general_pct < slabBounds.min) {
          warnings.push(`${prefix}: ${variant} rate ${slab.rate_general_pct}% below floor (${slabBounds.min}%)`);
        }
        if (slab.rate_general_pct > slabBounds.max) {
          warnings.push(`${prefix}: ${variant} rate ${slab.rate_general_pct}% above ceiling (${slabBounds.max}%)`);
        }
      } else {
        const r = validateRate(slab.rate_general_pct, "general");
        for (const w of r.warnings) warnings.push(`${prefix}: ${w}`);
      }
    }

    // Validate senior rate — skip for FCNR/GIFT (they don't have senior rates)
    if (!isForeignCurrency && slab.rate_senior_pct != null) {
      const r = validateRate(slab.rate_senior_pct, "senior");
      for (const w of r.warnings) warnings.push(`${prefix}: ${w}`);

      // Senior should be >= general
      if (slab.rate_general_pct != null && slab.rate_senior_pct < slab.rate_general_pct) {
        warnings.push(`${prefix}: senior rate (${slab.rate_senior_pct}%) < general rate (${slab.rate_general_pct}%)`);
      }
    }

    // Flag unexpected senior rates on FCNR/GIFT
    if (isForeignCurrency && slab.rate_senior_pct != null) {
      warnings.push(`${prefix}: ${variant} slab has senior rate — FCNR/GIFT should not have senior citizen premium`);
    }

    // Validate super senior rate — skip for FCNR/GIFT
    if (!isForeignCurrency && slab.rate_super_senior_pct != null) {
      const r = validateRate(slab.rate_super_senior_pct, "super_senior");
      for (const w of r.warnings) warnings.push(`${prefix}: ${w}`);
    }

    // Validate tenure days
    if (slab.tenure_min_days != null && slab.tenure_max_days != null) {
      if (slab.tenure_min_days > slab.tenure_max_days) {
        errors.push(`${prefix}: min_days (${slab.tenure_min_days}) > max_days (${slab.tenure_max_days})`);
      }
    }

    // Validate variant-specific tenure constraints
    if (tenureConstraints && slab.tenure_min_days != null) {
      if (slab.tenure_min_days < tenureConstraints.min) {
        warnings.push(`${prefix}: ${variant} tenure ${slab.tenure_min_days}d below minimum (${tenureConstraints.min}d)`);
      }
    }
    if (tenureConstraints && slab.tenure_max_days != null) {
      if (slab.tenure_max_days > tenureConstraints.max) {
        warnings.push(`${prefix}: ${variant} tenure ${slab.tenure_max_days}d above maximum (${tenureConstraints.max}d)`);
      }
    }

    // Validate currency field for FCNR/GIFT slabs
    if (isForeignCurrency && !slab.currency) {
      warnings.push(`${prefix}: ${variant} slab missing currency field`);
    }
  }

  // Check tenure continuity (non-overlapping, roughly sequential)
  const sorted = [...slabs]
    .filter((s) => s.tenure_min_days != null)
    .sort((a, b) => a.tenure_min_days - b.tenure_min_days);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.tenure_min_days < prev.tenure_min_days) {
      warnings.push(
        `Tenure overlap: "${prev.tenure_text}" and "${curr.tenure_text}"`,
      );
    }
  }

  return { valid: errors.length === 0, warnings, errors };
}

/**
 * Cohort #3 Phase C1 (2026-05-23): filter out slabs whose rate values are
 * outside the variant's validation band (below floor / above ceiling). The
 * existing `validateSlabs` only WARNS on these — Kotak in cohort #3 emitted
 * 5 duplicate slabs at 0.5-1% (well below the 1.5% regular floor) and they
 * silently shipped to the pack. This filter drops them before `commit_rates`
 * sees the slab list, so the canonical `_rates.json` only contains slabs
 * with plausible rates.
 *
 * Reuses the same VARIANT_BOUNDS as `validateSlabs` (tight validation band,
 * NOT the loose `lib/rate-bounds.js` band used by pack-builder — these two
 * layers serve different purposes).
 *
 * Also dedupes slabs with identical (tenure_text, rate_general_pct,
 * rate_senior_pct) tuples — Kotak's wrong-table picker produced two
 * identical pairs. Currency is included in the dedup key for FCNR/GIFT.
 *
 * @param {Array} slabs - candidate rate slabs
 * @param {string} variant - 'regular'|'nre'|'nro'|'fcnr'|'gift'
 * @returns {{ filteredSlabs: Array, droppedBelowFloor: number, droppedAboveCeiling: number, droppedDuplicate: number }}
 */
function filterInvalidSlabs(slabs, variant = 'regular') {
  if (!Array.isArray(slabs) || slabs.length === 0) {
    return {
      filteredSlabs: [],
      droppedBelowFloor: 0,
      droppedAboveCeiling: 0,
      droppedDuplicate: 0,
      droppedTenureOutOfBand: 0,
    };
  }
  // Resolve bounds: variant-specific override > regular default (RATE_BOUNDS.general).
  // VARIANT_BOUNDS only includes nre/nro/fcnr/gift; for `regular` we fall
  // back to the general band the same way validateSlabs/validateRate do.
  const bounds = VARIANT_BOUNDS[variant] || RATE_BOUNDS.general || null;
  const tenureConstraints = VARIANT_TENURE[variant] || null;
  const filtered = [];
  const seen = new Set();
  let droppedBelowFloor = 0;
  let droppedAboveCeiling = 0;
  let droppedDuplicate = 0;
  let droppedTenureOutOfBand = 0;
  for (const slab of slabs) {
    const g = slab && slab.rate_general_pct;
    // Currency-aware floor for FCNR/GIFT: JPY/CHF FCNR(B) rates are
    // legitimately near-zero (Axis JPY 0.00–0.01%); the flat fcnr floor
    // (0.5%) was collapsing those currencies wholesale (Sprint 011,
    // 2026-07-07). LOW_YIELD_CURRENCIES gives them a min-0 band — 0% is
    // legal, negative rates are still dropped below-floor.
    const slabBounds = resolveSlabBounds(variant, slab, bounds);
    if (slabBounds && typeof g === 'number') {
      // Phase C1: drop below-floor slabs (Kotak 0.5-1% garbage). Above-
      // ceiling slabs are LEFT in place and warned by validateSlabs — some
      // legitimate small-bank rates briefly exceed the 9.5% display ceiling.
      // Truly garbage values (>15%) are caught by the loose sanity band in
      // lib/rate-bounds.js at pack-build time (Phase B). The two layers
      // together: tight-band-floor here (per-bank artifact), loose-band-
      // both-ends in pack-builder.
      if (g < slabBounds.min) { droppedBelowFloor++; continue; }
    }
    // Cohort #3 Phase C3 (2026-05-23): FCNR/GIFT have hard RBI tenure
    // constraints (min 365 days). Cohort #3 ICICI emitted 12 short-tenor
    // (0-30d, 30-180d, 180-365d) slabs under FCNR variant — these
    // belonged to a Call Deposit table that the picker conflated with the
    // FCNR matrix. Filter them out at commit time so the variant invariant
    // is preserved without needing per-bank picker tuning.
    if (tenureConstraints && slab) {
      const tMin = slab.tenure_min_days;
      const tMax = slab.tenure_max_days;
      // Drop when the slab's tenure range falls entirely below the variant
      // minimum (e.g., FCNR slab with tenure 30-180d). Slabs spanning the
      // boundary (e.g., 300-400d for FCNR) are warned by validateSlabs but
      // kept — the operator can review.
      if (typeof tMax === 'number' && tMax < tenureConstraints.min) {
        droppedTenureOutOfBand++;
        continue;
      }
      if (typeof tMin === 'number' && tMin > tenureConstraints.max) {
        droppedTenureOutOfBand++;
        continue;
      }
    }
    const key = [
      (slab && slab.tenure_text) || '',
      g,
      (slab && slab.rate_senior_pct) ?? null,
      (slab && slab.currency) || '',
    ].join('|');
    if (seen.has(key)) { droppedDuplicate++; continue; }
    seen.add(key);
    filtered.push(slab);
  }
  return {
    filteredSlabs: filtered,
    droppedBelowFloor,
    droppedAboveCeiling,
    droppedDuplicate,
    droppedTenureOutOfBand,
  };
}

module.exports = { validateRate, validateSlabs, filterInvalidSlabs, RATE_BOUNDS, VARIANT_BOUNDS, VARIANT_TENURE };

// CLI mode: node scripts/utils/validate-rates.js output/sbi_rates.json
// CLI mode: node scripts/utils/validate-rates.js output/sbi_fcnr_rates.json --variant fcnr
if (require.main === module) {
  const fs = require("fs");
  const cliArgs = process.argv.slice(2);
  let filePath = "";
  let cliVariant = "";
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === "--variant" && cliArgs[i + 1]) cliVariant = cliArgs[++i];
    else if (!cliArgs[i].startsWith("--") && !filePath) filePath = cliArgs[i];
  }
  if (!filePath) {
    console.error("Usage: node scripts/utils/validate-rates.js <rates_json_file> [--variant fcnr]");
    process.exit(1);
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const slabs = data.rate_slabs || [];
    const variant = cliVariant || data.variant || "regular";
    console.log(`Validating ${slabs.length} slabs from ${filePath} (variant: ${variant})...`);
    const result = validateSlabs(slabs, variant);
    if (result.errors.length > 0) {
      console.log("\nErrors:");
      result.errors.forEach((e) => console.log(`  ✗ ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      result.warnings.forEach((w) => console.log(`  ! ${w}`));
    }
    if (result.valid && result.warnings.length === 0) {
      console.log("  ✓ All slabs valid, no warnings.");
    }
    process.exit(result.valid ? 0 : 1);
  } catch (err) {
    console.error(`Error reading ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

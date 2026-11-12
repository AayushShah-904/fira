/**
 * Validation engine — runs all applicable layers and collects flags.
 *
 * Layers 1-5 run during import. Layers 6-7 run on separate schedules.
 * - Layer 1: Format (auto-reject malformed)
 * - Layer 2: Range (rate within product-type bounds)
 * - Layer 3: Delta (rate change vs previous value)
 * - Layer 4: Monotonicity (rates increase with tenure)
 * - Layer 5: Completeness (slab count vs expected)
 * - Layer 6: Cross-reference (vs secondary sources) — deferred
 * - Layer 7: Staleness (data age) — separate schedule
 */
export { validateFormat } from "./format.js";
export { validateRange } from "./range.js";
export { validateDelta } from "./delta.js";
export { validateMonotonicity } from "./monotonicity.js";
export { validateCompleteness } from "./completeness.js";
export { validateStaleness } from "./staleness.js";
export type { ValidationFlag, ValidationResult, RawSlab, ActiveSlab } from "./types.js";

import { validateFormat } from "./format.js";
import { validateRange } from "./range.js";
import { validateDelta } from "./delta.js";
import { validateMonotonicity } from "./monotonicity.js";
import { validateCompleteness } from "./completeness.js";
import type { RawSlab, ActiveSlab, ValidationFlag } from "./types.js";

export type ImportValidationContext = {
  productType: string;
  variant?: string; // e.g., "regular", "nre", "nro", "fcnr", "gift"
  bankCategory?: string;
  expectedSlabCount?: number | null;
  activeSlabs: ActiveSlab[];
  previousSlabCount?: number;
};

export type ImportValidationResult = {
  passed: boolean;
  flags: ValidationFlag[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
};

/**
 * Run all import-time validation layers (1-5) on a set of rate slabs.
 */
export function validateImport(
  slabs: RawSlab[],
  ctx: ImportValidationContext,
): ImportValidationResult {
  const allFlags: ValidationFlag[] = [];

  // Layer 1: Format
  const format = validateFormat(slabs);
  allFlags.push(...format.flags);

  // Layer 2: Range (variant-aware)
  const range = validateRange(slabs, ctx.productType, ctx.variant);
  allFlags.push(...range.flags);

  // Layer 3: Delta
  const delta = validateDelta(slabs, ctx.activeSlabs, ctx.bankCategory);
  allFlags.push(...delta.flags);

  // Layer 4: Monotonicity
  const monotonicity = validateMonotonicity(slabs);
  allFlags.push(...monotonicity.flags);

  // Layer 5: Completeness
  const completeness = validateCompleteness(
    slabs,
    ctx.expectedSlabCount,
    ctx.previousSlabCount,
  );
  allFlags.push(...completeness.flags);

  const criticalCount = allFlags.filter(f => f.severity === "critical").length;
  const warningCount = allFlags.filter(f => f.severity === "warning").length;
  const infoCount = allFlags.filter(f => f.severity === "info").length;

  return {
    passed: criticalCount === 0,
    flags: allFlags,
    criticalCount,
    warningCount,
    infoCount,
  };
}

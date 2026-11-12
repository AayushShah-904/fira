/**
 * Layer 5: Completeness validation.
 * Checks that the number of slabs matches the expected count (±20%).
 * Too few slabs suggests partial extraction; too many suggests extraneous data.
 */
import type { RawSlab, ValidationResult, ValidationFlag } from "./types.js";

const TOLERANCE = 0.2; // 20%

export function validateCompleteness(
  slabs: RawSlab[],
  expectedSlabCount: number | null | undefined,
  previousSlabCount?: number,
): ValidationResult {
  const flags: ValidationFlag[] = [];
  const actual = slabs.length;

  if (actual === 0) {
    flags.push({
      flag_type: "completeness",
      severity: "critical",
      details: JSON.stringify({ message: "No rate slabs extracted", expected: expectedSlabCount }),
    });
    return { passed: false, flags };
  }

  // Check against expected slab count from bank config
  if (expectedSlabCount != null && expectedSlabCount > 0) {
    const lower = Math.floor(expectedSlabCount * (1 - TOLERANCE));
    const upper = Math.ceil(expectedSlabCount * (1 + TOLERANCE));

    if (actual < lower) {
      flags.push({
        flag_type: "completeness",
        severity: "warning",
        details: JSON.stringify({
          message: `Only ${actual} slabs extracted, expected ~${expectedSlabCount} (minimum ${lower})`,
          actual,
          expected: expectedSlabCount,
          lower_bound: lower,
        }),
      });
    } else if (actual > upper) {
      flags.push({
        flag_type: "completeness",
        severity: "info",
        details: JSON.stringify({
          message: `${actual} slabs extracted, expected ~${expectedSlabCount} (maximum ${upper}). May include extra tables.`,
          actual,
          expected: expectedSlabCount,
          upper_bound: upper,
        }),
      });
    }
  }

  // Check against previous import count
  if (previousSlabCount != null && previousSlabCount > 0) {
    const lower = Math.floor(previousSlabCount * (1 - TOLERANCE));
    if (actual < lower) {
      flags.push({
        flag_type: "completeness",
        severity: "warning",
        details: JSON.stringify({
          message: `Slab count dropped from ${previousSlabCount} to ${actual}`,
          actual,
          previous: previousSlabCount,
        }),
      });
    }
  }

  const hasCritical = flags.some(f => f.severity === "critical");
  return { passed: !hasCritical, flags };
}

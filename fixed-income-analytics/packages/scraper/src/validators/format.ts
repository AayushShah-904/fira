/**
 * Layer 1: Format validation.
 * Ensures rates are numeric, tenures parse to valid days, no null required fields.
 * Malformed records are auto-rejected.
 */
import { parseTenureText } from "@bird/shared";
import type { RawSlab, ValidationResult, ValidationFlag } from "./types.js";

export function validateFormat(slabs: RawSlab[]): ValidationResult {
  const flags: ValidationFlag[] = [];

  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i];

    // Rate must be a positive number
    if (slab.rate_general_pct == null || typeof slab.rate_general_pct !== "number" || isNaN(slab.rate_general_pct)) {
      flags.push({
        flag_type: "format",
        severity: "critical",
        details: JSON.stringify({ message: "rate_general_pct is missing or non-numeric", value: slab.rate_general_pct }),
        slab_index: i,
      });
      continue;
    }

    // Tenure text must be present
    if (!slab.tenure_text || typeof slab.tenure_text !== "string") {
      flags.push({
        flag_type: "format",
        severity: "critical",
        details: JSON.stringify({ message: "tenure_text is missing", value: slab.tenure_text }),
        slab_index: i,
      });
      continue;
    }

    // Tenure must resolve to valid days (either from pre-parsed fields or via parser)
    const minDays = slab.tenure_min_days;
    const maxDays = slab.tenure_max_days;

    if (minDays == null || maxDays == null) {
      // Try to parse from text
      const parsed = parseTenureText(slab.tenure_text);
      if (!parsed) {
        flags.push({
          flag_type: "format",
          severity: "warning",
          details: JSON.stringify({ message: "tenure_text could not be parsed to days", tenure_text: slab.tenure_text }),
          slab_index: i,
        });
      }
    } else {
      // Validate parsed values make sense
      if (minDays < 0 || maxDays < 0) {
        flags.push({
          flag_type: "format",
          severity: "critical",
          details: JSON.stringify({ message: "negative tenure days", min: minDays, max: maxDays }),
          slab_index: i,
        });
      }
      if (minDays > maxDays) {
        flags.push({
          flag_type: "format",
          severity: "critical",
          details: JSON.stringify({ message: "tenure_min_days > tenure_max_days", min: minDays, max: maxDays }),
          slab_index: i,
        });
      }
    }

    // Senior rate should be >= general when present
    if (slab.rate_senior_pct != null && typeof slab.rate_senior_pct === "number") {
      if (slab.rate_senior_pct < slab.rate_general_pct) {
        flags.push({
          flag_type: "format",
          severity: "warning",
          details: JSON.stringify({
            message: "senior rate < general rate",
            general: slab.rate_general_pct,
            senior: slab.rate_senior_pct,
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

/**
 * Layer 4: Monotonicity validation.
 * FD rates should generally increase with tenure (banks pay more for longer lock-in).
 * Inversions do occur but are unusual enough to flag for review.
 */
import type { RawSlab, ValidationResult, ValidationFlag } from "./types.js";

export function validateMonotonicity(slabs: RawSlab[]): ValidationResult {
  const flags: ValidationFlag[] = [];

  // Only meaningful with 2+ slabs that have tenure info
  const sorted = slabs
    .map((s, i) => ({ ...s, originalIndex: i }))
    .filter(s => s.tenure_min_days != null && s.rate_general_pct != null)
    .sort((a, b) => (a.tenure_min_days ?? 0) - (b.tenure_min_days ?? 0));

  if (sorted.length < 2) {
    return { passed: true, flags };
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    // Skip if same tenure range (deposit-amount tiers, not tenure tiers)
    if (prev.tenure_min_days === curr.tenure_min_days && prev.tenure_max_days === curr.tenure_max_days) {
      continue;
    }

    if (curr.rate_general_pct! < prev.rate_general_pct!) {
      const drop = prev.rate_general_pct! - curr.rate_general_pct!;
      flags.push({
        flag_type: "monotonicity",
        severity: drop > 0.5 ? "warning" : "info",
        details: JSON.stringify({
          message: `Rate inversion: ${prev.rate_general_pct}% → ${curr.rate_general_pct}% (drop of ${drop.toFixed(2)}%)`,
          shorter_tenure: prev.tenure_text,
          shorter_rate: prev.rate_general_pct,
          longer_tenure: curr.tenure_text,
          longer_rate: curr.rate_general_pct,
        }),
        slab_index: curr.originalIndex,
      });
    }
  }

  // Monotonicity flags are always warnings/info, never block import
  return { passed: true, flags };
}

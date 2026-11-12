/**
 * Layer 3: Delta validation — adapter over the canonical delta thresholds at
 * `@bird/shared/validation` per ADR-014. Flag-emission shape stays here so
 * the scrape_flags table format is preserved.
 */
import { getDeltaThreshold } from "@bird/shared";
import type { RawSlab, ActiveSlab, ValidationResult, ValidationFlag } from "./types.js";

/**
 * Match a new slab to an existing active slab by tenure range overlap.
 */
function findMatchingSlab(newSlab: RawSlab, activeSlabs: ActiveSlab[]): ActiveSlab | undefined {
  const newMin = newSlab.tenure_min_days ?? 0;
  const newMax = newSlab.tenure_max_days ?? 0;

  // Exact match on tenure range
  const exact = activeSlabs.find(
    s => s.tenure_min_days === newMin && s.tenure_max_days === newMax
  );
  if (exact) return exact;

  // Overlapping tenure range
  return activeSlabs.find(
    s => s.tenure_min_days <= newMax && s.tenure_max_days >= newMin
  );
}

export function validateDelta(
  slabs: RawSlab[],
  activeSlabs: ActiveSlab[],
  bankCategory?: string,
): ValidationResult {
  const flags: ValidationFlag[] = [];

  if (activeSlabs.length === 0) {
    // No previous data to compare — first import, skip delta check
    return { passed: true, flags };
  }

  const { warningBps: thresholdBps, criticalBps } = getDeltaThreshold(bankCategory);

  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i];
    if (slab.rate_general_pct == null) continue;

    const match = findMatchingSlab(slab, activeSlabs);
    if (!match) continue; // New tenure, no comparison possible

    const deltaBps = Math.abs(slab.rate_general_pct - match.rate_general_pct) * 100;

    if (deltaBps > thresholdBps) {
      flags.push({
        flag_type: "delta",
        severity: deltaBps > criticalBps ? "critical" : "warning",
        details: JSON.stringify({
          message: `rate changed by ${deltaBps.toFixed(0)} bps (threshold: ${thresholdBps} bps)`,
          tenure_text: slab.tenure_text,
          old_rate: match.rate_general_pct,
          new_rate: slab.rate_general_pct,
          delta_bps: Math.round(deltaBps),
        }),
        slab_index: i,
      });
    }

    // Also check senior rate delta
    if (slab.rate_senior_pct != null && match.rate_senior_pct != null) {
      const seniorDelta = Math.abs(slab.rate_senior_pct - match.rate_senior_pct) * 100;
      if (seniorDelta > thresholdBps) {
        flags.push({
          flag_type: "delta",
          severity: "warning",
          details: JSON.stringify({
            message: `senior rate changed by ${seniorDelta.toFixed(0)} bps`,
            tenure_text: slab.tenure_text,
            old_rate: match.rate_senior_pct,
            new_rate: slab.rate_senior_pct,
            delta_bps: Math.round(seniorDelta),
          }),
          slab_index: i,
        });
      }
    }
  }

  const hasCritical = flags.some(f => f.severity === "critical");
  return { passed: !hasCritical, flags };
}

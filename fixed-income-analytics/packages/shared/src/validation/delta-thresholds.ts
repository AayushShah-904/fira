/**
 * Canonical delta-bps thresholds for rate change detection.
 *
 * ADR-014 single source of truth. Indian banks rarely change rates by more
 * than 25-50 bps in a single revision. SFB / NBFC / Local Area Banks have
 * more volatile pricing so get a wider tolerance.
 */

/** Default warning threshold (1× → warning; 2× → critical for blocking import). */
export const DEFAULT_DELTA_BPS = 50;

/** Wider threshold for categories with more volatile rates. */
export const HIGH_DELTA_BPS = 75;

/** Bank categories that get the higher threshold. */
export const HIGH_DELTA_CATEGORIES: ReadonlySet<string> = new Set(["SFB", "NBFC", "LAB"]);

/**
 * Resolve the active delta threshold for a bank category.
 * Critical threshold (blocking import) is 2× the warning threshold.
 */
export function getDeltaThreshold(bankCategory?: string): { warningBps: number; criticalBps: number } {
  const warningBps = bankCategory && HIGH_DELTA_CATEGORIES.has(bankCategory)
    ? HIGH_DELTA_BPS
    : DEFAULT_DELTA_BPS;
  return { warningBps, criticalBps: warningBps * 2 };
}

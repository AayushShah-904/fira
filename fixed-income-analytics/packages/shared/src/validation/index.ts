/**
 * @bird/shared/validation — single source of truth for rate-data validation
 * constants and rule semantics. Per ADR-014.
 *
 * Two consumer surfaces today:
 *   - rate-discovery-agent (CJS) — via the hand-mirrored port at
 *     `rate-discovery-agent/scripts/utils/validate-rates.js`. A drift-check
 *     test in this package's __tests__ asserts the numeric constants match.
 *   - packages/scraper (TS) — imports directly. Layer-file adapters in
 *     `packages/scraper/src/validators/{range,delta,format}.ts` map shared
 *     rule outputs onto scrape_flags schema.
 *
 * Adding a new bound, threshold, or rule belongs here. Both consumers pick it
 * up automatically (the scraper at compile time; the agent at the next commit
 * to the CJS port).
 */

export * from "./rate-bounds.js";
export * from "./delta-thresholds.js";

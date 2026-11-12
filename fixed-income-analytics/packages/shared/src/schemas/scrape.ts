import { z } from "zod";

export const scrapeStatus = z.enum([
  "success", // All expected data scraped and validated
  "partial", // Some data scraped, some failures
  "failed", // Scrape failed entirely
]);

export const flagType = z.enum([
  "format", // Non-numeric rate, unparseable tenure, null required field
  "range", // Rate outside expected bounds (FD: 2.5-9.5%)
  "delta", // Rate change >50 bps from previous value
  "monotonicity", // FD rates should increase with tenure — inversion detected
  "completeness", // Slab count differs from expected by >20%
  "cross_ref", // >10 bps discrepancy vs secondary source
  "staleness", // No change detected in 60+ days
]);

export const flagSeverity = z.enum([
  "info",
  "warning",
  "critical",
]);

export const flagResolution = z.enum([
  "approved", // Data confirmed correct, publish
  "rejected", // Data incorrect, rescrape or hold
  "held", // Data uncertain, mark as unverified
]);

/** Scrape run — one execution of a bank's scraper */
export const scrapeRunSchema = z.object({
  id: z.number().int().positive(),
  bank_id: z.number().int().positive(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
  status: scrapeStatus,
  error_message: z.string().max(2048).nullable(),
  records_found: z.number().int().nonnegative().default(0),
  records_changed: z.number().int().nonnegative().default(0),
  records_flagged: z.number().int().nonnegative().default(0),
  scraper_version: z.string().max(32).nullable(),
});

export const scrapeRunInsertSchema = scrapeRunSchema.omit({
  id: true,
});

/** Scrape flag — a validation issue requiring human review */
export const scrapeFlagSchema = z.object({
  id: z.number().int().positive(),
  scrape_run_id: z.number().int().positive().nullable(),
  bank_id: z.number().int().positive(),
  rate_slab_id: z.number().int().positive().nullable(),
  flag_type: flagType,
  severity: flagSeverity,
  details: z.string().max(4096), // JSON string with context
  resolution: flagResolution.nullable(),
  resolved_by: z.string().max(128).nullable(),
  resolved_at: z.string().datetime().nullable(),
});

export const scrapeFlagInsertSchema = scrapeFlagSchema.omit({
  id: true,
});

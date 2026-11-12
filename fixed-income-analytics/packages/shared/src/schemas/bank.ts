import { z } from "zod";

/**
 * RBI bank classification categories.
 * Covers all institution types in the RBI master list (~1900 entries).
 */
export const bankCategory = z.enum([
  "PSB", // Public Sector Bank
  "PVB", // Private Sector Bank
  "SFB", // Small Finance Bank
  "PB", // Payments Bank
  "FB", // Foreign Bank
  "RRB", // Regional Rural Bank
  "SUCB", // Scheduled Urban Co-operative Bank
  "NSUCB", // Non-Scheduled Urban Co-operative Bank
  "SSCB", // Scheduled State Co-operative Bank
  "NSSCB", // Non-Scheduled State Co-operative Bank
  "DCCB", // District Central Co-operative Bank
  "LAB", // Local Area Bank
  "FI", // Financial Institution
  "NBFC", // Non-Banking Financial Company (deposit-taking)
  "IBU", // IFSC Banking Unit (GIFT City)
  "HFC", // Housing Finance Company
]);

export const scraperStatus = z.enum([
  "active", // Scraper configured and running
  "no_website", // Bank has no functional website
  "no_rates", // Website exists but no rate page found
  "failed", // Scraper configured but currently failing
  "manual_only", // Rates only obtainable manually
  "pending", // Not yet classified
]);

export const discoveryStatus = z.enum([
  "discovered", // Rate page found and config created
  "not_found", // Searched but no rate page found
  "partial", // Some rate data found, incomplete
  "pending", // Not yet searched
]);

export const bankSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1).max(128), // URL-safe slug
  name: z.string().min(1).max(256),
  category: bankCategory,
  state: z.string().max(128).nullable(),
  website_url: z.string().url().nullable(),
  rate_page_url: z.string().url().nullable(),
  logo_url: z.string().url().nullable(),
  rbi_licence_no: z.string().max(64).nullable(),
  ifsc_prefix: z.string().max(11).nullable(),
  deposit_insurance: z.boolean().default(false), // DICGC coverage — default false, set true per bank
  assets_under_mgmt: z.number().nullable(), // in crores
  trust_score: z.number().min(0).max(100).nullable(), // computed metric
  scraper_status: scraperStatus.default("pending"),
  discovery_status: discoveryStatus.default("pending"),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

/** Schema for creating a new bank (omits auto-generated fields) */
export const bankInsertSchema = bankSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

/** Schema for bank query parameters */
export const bankQuerySchema = z.object({
  category: bankCategory.optional(),
  state: z.string().optional(),
  scraper_status: scraperStatus.optional(),
  discovery_status: discoveryStatus.optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

import { z } from "zod";
import { compoundingFrequency } from "./product.js";

/**
 * Rate slab — a single row in a bank's rate table.
 * Append-only: when rates change, old slabs get effective_to set
 * and new slabs are inserted with effective_to = null (current).
 */
export const rateSlabSchema = z.object({
  id: z.number().int().positive(),
  product_id: z.number().int().positive(),
  bank_id: z.number().int().positive(), // denormalized for query speed
  tenure_min_days: z.number().int().nonnegative(),
  tenure_max_days: z.number().int().positive(),
  tenure_text: z.string().max(256), // original text from bank, e.g. "1 year to less than 2 years"
  rate_general_pct: z.number().min(0).max(20),
  rate_senior_pct: z.number().min(0).max(20).nullable(),
  rate_super_senior_pct: z.number().min(0).max(20).nullable(),
  compounding_frequency: compoundingFrequency.nullable(),
  effective_from: z.string().datetime(),
  effective_to: z.string().datetime().nullable(), // null = currently active
  min_deposit_for_slab: z.number().nullable(), // some banks have deposit-based tiers
  max_deposit_for_slab: z.number().nullable(),
  source_url: z.string().url().nullable(),
  scraped_at: z.string().datetime(),
  created_at: z.string().datetime(),
});

export const rateSlabInsertSchema = rateSlabSchema.omit({
  id: true,
  created_at: true,
});

/**
 * Rate change log — audit trail for every detected rate change.
 * One entry per changed field (e.g., rate_general_pct changed from 6.5 to 6.75).
 */
export const rateChangeLogSchema = z.object({
  id: z.number().int().positive(),
  rate_slab_id: z.number().int().positive(),
  bank_id: z.number().int().positive(),
  product_id: z.number().int().positive(),
  field_changed: z.string().max(64),
  old_value: z.string().max(256),
  new_value: z.string().max(256),
  detected_at: z.string().datetime(),
  source_url: z.string().url().nullable(),
});

export const rateChangeLogInsertSchema = rateChangeLogSchema.omit({
  id: true,
});

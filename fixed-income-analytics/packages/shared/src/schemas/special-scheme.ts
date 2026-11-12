import { z } from "zod";

/**
 * Special scheme — promotional or limited-period deposit offers.
 * E.g., "SBI Amrit Vrishti 444 Days" at a premium rate with an expiry date.
 */
export const specialSchemeSchema = z.object({
  id: z.number().int().positive(),
  bank_id: z.number().int().positive(),
  name: z.string().max(256),
  rate_pct: z.number().min(0).max(20),
  tenure_days: z.number().int().positive().nullable(),
  launch_date: z.string().datetime().nullable(),
  expiry_date: z.string().datetime().nullable(),
  min_deposit: z.number().nullable(),
  source_url: z.string().url().nullable(),
  notes: z.string().max(1024).nullable(),
});

export const specialSchemeInsertSchema = specialSchemeSchema.omit({
  id: true,
});

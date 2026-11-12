import { z } from "zod";

/**
 * Product types covering all interest-yielding instruments
 * tracked by the platform.
 */
export const productType = z.enum([
  "FD", // Fixed Deposit
  "RD", // Recurring Deposit
  "SA", // Savings Account
  "PPF", // Public Provident Fund
  "SCSS", // Senior Citizens Savings Scheme
  "SSY", // Sukanya Samriddhi Yojana
  "NSC", // National Savings Certificate
  "KVP", // Kisan Vikas Patra
  "MIS", // Monthly Income Scheme (Post Office)
  "SGB", // Sovereign Gold Bond
  "RBI_BOND", // RBI Floating Rate Bond
  "POTD", // Post Office Time Deposit
  "NBFC_FD", // NBFC Fixed Deposit
]);

/**
 * Product variants within a product type.
 * E.g., an FD can be regular, senior citizen, NRE, tax-saving, etc.
 */
export const productVariant = z.enum([
  "regular",
  "senior_citizen",
  "super_senior", // 80+ years, offered by some banks (e.g., SBI)
  "nre", // Non-Resident External
  "nro", // Non-Resident Ordinary
  "fcnr", // Foreign Currency Non-Resident
  "gift", // GIFT City (IFSC Banking Unit) FD
  "tax_saving", // Sec 80C, 5-year lock-in
  "flexi", // Flexi/Sweep FD linked to savings account
  "green", // Green/ESG deposits
  "special_tenure", // Special tenure offers (e.g., SBI 444 days)
  "women", // Women-specific variants
  "minor", // Minor account variants
  "staff", // Bank staff rates (tracked but flagged)
]);

export const compoundingFrequency = z.enum([
  "monthly",
  "quarterly",
  "half_yearly",
  "yearly",
  "on_maturity", // Simple interest, paid at maturity
]);

export const productSchema = z.object({
  id: z.number().int().positive(),
  bank_id: z.number().int().positive(),
  product_type: productType,
  variant: productVariant,
  name: z.string().max(256).nullable(),
  description: z.string().max(1024).nullable(),
  eligibility_notes: z.string().max(1024).nullable(),
  sec_80c_eligible: z.boolean().default(false),
  premature_withdrawal_allowed: z.boolean().default(true),
  min_deposit: z.number().nullable(), // in rupees
  max_deposit: z.number().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const productInsertSchema = productSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

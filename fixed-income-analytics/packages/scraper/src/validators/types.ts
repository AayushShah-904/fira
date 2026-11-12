import type { FlagType, FlagSeverity } from "@bird/shared";

export type ValidationFlag = {
  flag_type: FlagType;
  severity: FlagSeverity;
  details: string;
  slab_index?: number; // index into the slabs array being validated
};

export type ValidationResult = {
  passed: boolean;
  flags: ValidationFlag[];
};

/** Shape of a rate slab as it comes from the agent output (before DB insert). */
export type RawSlab = {
  tenure_text: string;
  tenure_min_days: number | null;
  tenure_max_days: number | null;
  rate_general_pct: number | null;
  rate_senior_pct?: number | null;
  rate_super_senior_pct?: number | null;
  compounding_freq?: string | null;
  min_deposit?: number | null;
  max_deposit?: number | null;
  currency?: string | null; // e.g., "INR", "USD", "GBP" — required for FCNR/GIFT variants
};

/** Active slab from DB for delta comparison. */
export type ActiveSlab = {
  id: number;
  tenure_min_days: number;
  tenure_max_days: number;
  tenure_text: string;
  rate_general_pct: number;
  rate_senior_pct: number | null;
  rate_super_senior_pct: number | null;
  currency?: string; // "INR" for domestic/NRE/NRO, currency code for FCNR/GIFT
};

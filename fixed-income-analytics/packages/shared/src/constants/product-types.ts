import type { ProductType } from "../types/index.js";

export interface ProductTypeInfo {
  label: string;
  description: string;
  tenureRange: { minDays: number; maxDays: number } | null; // null = on-demand
  rateRange: { min: number; max: number }; // typical rate bounds for validation
  offeredBy: string; // who typically offers this product
}

/**
 * Metadata for each product type.
 * Rate ranges are used by the validation engine for range checks.
 */
export const PRODUCT_TYPES: Record<ProductType, ProductTypeInfo> = {
  FD: {
    label: "Fixed Deposit",
    description: "Term deposit with fixed interest rate and maturity date",
    tenureRange: { minDays: 7, maxDays: 3650 },
    rateRange: { min: 2.5, max: 9.5 },
    offeredBy: "All banks, SFBs, NBFCs",
  },
  RD: {
    label: "Recurring Deposit",
    description: "Monthly deposits at a fixed rate for a fixed tenure",
    tenureRange: { minDays: 180, maxDays: 3650 },
    rateRange: { min: 3.0, max: 9.0 },
    offeredBy: "All banks, SFBs",
  },
  SA: {
    label: "Savings Account",
    description: "On-demand deposit account with variable interest",
    tenureRange: null,
    rateRange: { min: 2.0, max: 8.0 },
    offeredBy: "All banks, SFBs, Payments banks",
  },
  PPF: {
    label: "Public Provident Fund",
    description: "Government-backed 15-year savings scheme with EEE tax status",
    tenureRange: { minDays: 5475, maxDays: 5475 }, // 15 years
    rateRange: { min: 6.0, max: 9.0 },
    offeredBy: "India Post, select banks",
  },
  SCSS: {
    label: "Senior Citizens Savings Scheme",
    description: "Government scheme for 60+ with quarterly payouts",
    tenureRange: { minDays: 1825, maxDays: 1825 }, // 5 years
    rateRange: { min: 7.0, max: 9.5 },
    offeredBy: "India Post, select banks",
  },
  SSY: {
    label: "Sukanya Samriddhi Yojana",
    description: "Girl child savings scheme with EEE tax status, 21-year maturity",
    tenureRange: { minDays: 7665, maxDays: 7665 }, // 21 years
    rateRange: { min: 7.0, max: 9.5 },
    offeredBy: "India Post, select banks",
  },
  NSC: {
    label: "National Savings Certificate",
    description: "5-year government savings certificate, Sec 80C eligible",
    tenureRange: { minDays: 1825, maxDays: 1825 },
    rateRange: { min: 6.0, max: 9.0 },
    offeredBy: "India Post",
  },
  KVP: {
    label: "Kisan Vikas Patra",
    description: "Savings certificate that doubles investment at maturity",
    tenureRange: { minDays: 3450, maxDays: 3450 }, // ~115 months
    rateRange: { min: 6.0, max: 9.0 },
    offeredBy: "India Post",
  },
  MIS: {
    label: "Monthly Income Scheme",
    description: "Post office scheme providing monthly interest payouts",
    tenureRange: { minDays: 1825, maxDays: 1825 },
    rateRange: { min: 6.0, max: 9.0 },
    offeredBy: "India Post",
  },
  SGB: {
    label: "Sovereign Gold Bond",
    description: "Government bond linked to gold price with 2.5% annual interest",
    tenureRange: { minDays: 2920, maxDays: 2920 }, // 8 years
    rateRange: { min: 2.0, max: 3.0 },
    offeredBy: "RBI (periodic issuance)",
  },
  RBI_BOND: {
    label: "RBI Floating Rate Bond",
    description: "7-year bond with rate linked to NSC + 35 bps, reset every 6 months",
    tenureRange: { minDays: 2555, maxDays: 2555 },
    rateRange: { min: 6.0, max: 9.0 },
    offeredBy: "Select banks",
  },
  POTD: {
    label: "Post Office Time Deposit",
    description: "Term deposit at India Post, 1-5 year tenures",
    tenureRange: { minDays: 365, maxDays: 1825 },
    rateRange: { min: 5.0, max: 8.5 },
    offeredBy: "India Post",
  },
  NBFC_FD: {
    label: "NBFC Fixed Deposit",
    description: "Fixed deposits with non-banking financial companies — no DICGC insurance",
    tenureRange: { minDays: 365, maxDays: 1825 },
    rateRange: { min: 5.0, max: 10.0 },
    offeredBy: "Bajaj Finance, Shriram, Mahindra, etc.",
  },
};

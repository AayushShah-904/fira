import type { BankCategory } from "../types/index.js";

export interface CategoryInfo {
  label: string;
  description: string;
  depositInsurance: boolean; // Whether DICGC insurance typically applies
  typicalCount: string; // Rough count in RBI list for context
}

/**
 * Metadata for each bank category.
 * Used for UI labels, filtering descriptions, and default deposit insurance status.
 */
export const BANK_CATEGORIES: Record<BankCategory, CategoryInfo> = {
  PSB: {
    label: "Public Sector Bank",
    description: "Government-owned commercial banks",
    depositInsurance: true,
    typicalCount: "12",
  },
  PVB: {
    label: "Private Sector Bank",
    description: "Privately-owned scheduled commercial banks",
    depositInsurance: true,
    typicalCount: "21",
  },
  SFB: {
    label: "Small Finance Bank",
    description: "Banks focused on financial inclusion with higher deposit rates",
    depositInsurance: true,
    typicalCount: "12",
  },
  PB: {
    label: "Payments Bank",
    description: "Banks offering deposits up to ₹2 lakh, no lending",
    depositInsurance: true,
    typicalCount: "6",
  },
  FB: {
    label: "Foreign Bank",
    description: "International banks operating in India",
    depositInsurance: true,
    typicalCount: "46",
  },
  RRB: {
    label: "Regional Rural Bank",
    description: "Banks serving rural and semi-urban areas, sponsored by PSBs",
    depositInsurance: true,
    typicalCount: "43",
  },
  SUCB: {
    label: "Scheduled Urban Co-operative Bank",
    description: "Urban co-operative banks included in RBI's second schedule",
    depositInsurance: true,
    typicalCount: "54",
  },
  NSUCB: {
    label: "Non-Scheduled Urban Co-operative Bank",
    description: "Smaller urban co-operative banks not in RBI's second schedule",
    depositInsurance: true,
    typicalCount: "~1400",
  },
  SSCB: {
    label: "Scheduled State Co-operative Bank",
    description: "Apex co-operative banks at the state level",
    depositInsurance: false,
    typicalCount: "33",
  },
  NSSCB: {
    label: "Non-Scheduled State Co-operative Bank",
    description: "Smaller state-level co-operative banks",
    depositInsurance: false,
    typicalCount: "~1",
  },
  DCCB: {
    label: "District Central Co-operative Bank",
    description: "District-level co-operative banks serving rural credit",
    depositInsurance: false,
    typicalCount: "~350",
  },
  LAB: {
    label: "Local Area Bank",
    description: "Banks operating in limited geographical areas",
    depositInsurance: true,
    typicalCount: "2",
  },
  FI: {
    label: "Financial Institution",
    description: "Non-bank financial institutions regulated by RBI",
    depositInsurance: false,
    typicalCount: "4",
  },
  NBFC: {
    label: "NBFC (Deposit-Taking)",
    description: "Non-banking financial companies accepting public deposits — no DICGC insurance",
    depositInsurance: false,
    typicalCount: "~15",
  },
  IBU: {
    label: "IFSC Banking Unit",
    description: "Banks operating in GIFT City IFSC",
    depositInsurance: false,
    typicalCount: "37",  // Source: IFSCA official entity list
  },
  HFC: {
    label: "Housing Finance Company",
    description: "NHB-registered housing finance companies authorized to accept public deposits",
    depositInsurance: false,
    typicalCount: "7",
  },
};

import type { z } from "zod";
import type {
  bankCategory,
  scraperStatus,
  discoveryStatus,
  bankSchema,
  bankInsertSchema,
  bankQuerySchema,
  productType,
  productVariant,
  compoundingFrequency,
  productSchema,
  productInsertSchema,
  rateSlabSchema,
  rateSlabInsertSchema,
  rateChangeLogSchema,
  rateChangeLogInsertSchema,
  scrapeStatus,
  flagType,
  flagSeverity,
  flagResolution,
  scrapeRunSchema,
  scrapeRunInsertSchema,
  scrapeFlagSchema,
  scrapeFlagInsertSchema,
  specialSchemeSchema,
  specialSchemeInsertSchema,
} from "../schemas/index.js";

// Enum types
export type BankCategory = z.infer<typeof bankCategory>;
export type ScraperStatus = z.infer<typeof scraperStatus>;
export type DiscoveryStatus = z.infer<typeof discoveryStatus>;
export type ProductType = z.infer<typeof productType>;
export type ProductVariant = z.infer<typeof productVariant>;
export type CompoundingFrequency = z.infer<typeof compoundingFrequency>;
export type ScrapeStatus = z.infer<typeof scrapeStatus>;
export type FlagType = z.infer<typeof flagType>;
export type FlagSeverity = z.infer<typeof flagSeverity>;
export type FlagResolution = z.infer<typeof flagResolution>;

// Entity types
export type Bank = z.infer<typeof bankSchema>;
export type BankInsert = z.infer<typeof bankInsertSchema>;
export type BankQuery = z.infer<typeof bankQuerySchema>;
export type Product = z.infer<typeof productSchema>;
export type ProductInsert = z.infer<typeof productInsertSchema>;
export type RateSlab = z.infer<typeof rateSlabSchema>;
export type RateSlabInsert = z.infer<typeof rateSlabInsertSchema>;
export type RateChangeLog = z.infer<typeof rateChangeLogSchema>;
export type RateChangeLogInsert = z.infer<typeof rateChangeLogInsertSchema>;
export type ScrapeRun = z.infer<typeof scrapeRunSchema>;
export type ScrapeRunInsert = z.infer<typeof scrapeRunInsertSchema>;
export type ScrapeFlag = z.infer<typeof scrapeFlagSchema>;
export type ScrapeFlagInsert = z.infer<typeof scrapeFlagInsertSchema>;
export type SpecialScheme = z.infer<typeof specialSchemeSchema>;
export type SpecialSchemeInsert = z.infer<typeof specialSchemeInsertSchema>;

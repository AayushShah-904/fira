/**
 * Import rate-discovery-agent outputs into the BIRD database.
 *
 * Enhanced from the original import-discovery.mjs with:
 * - Rate versioning (append-only with effective_to)
 * - 7-layer validation engine
 * - Scrape run + flag recording
 * - Agent config defaults compatibility
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { resolve, join } from "path";
import { eq, and, isNull } from "drizzle-orm";
import { parseTenureText } from "@bird/shared";
import { createDb, schema, type Db } from "../db.js";
import { validateImport, type RawSlab, type ActiveSlab, type ValidationFlag } from "../validators/index.js";

// ── Agent output types ───────────────────────────────────────────

type AgentConfig = {
  bank_code: string;
  bank_name: string;
  bank_type?: string;
  category?: string;
  website?: string;
  scraper_type?: string;
  rate_page_urls?: { fd?: string; savings?: string; rd?: string };
  selectors?: Record<string, unknown>;
  column_mapping?: Record<string, unknown>;
  tenure_parser?: string;
  expected_slab_count?: number | null;
  rate_multiplier?: number;
  senior_citizen_premium?: string;
  deposit_insurance?: boolean;
  update_frequency?: string;
  notes?: string;
  scraper_notes?: Record<string, unknown>;
  discovery_metadata?: {
    confidence?: string;
    discovered_at?: string;
    discovery_method?: string;
  };
};

type AgentRates = {
  bank_code: string;
  product_type?: string;
  variant?: string;
  effective_date?: string | null;
  source_url?: string;
  scraped_at?: string;
  extraction_confidence?: string;
  rate_slabs: Array<{
    tenure_text: string;
    tenure_min_days?: number | null;
    tenure_max_days?: number | null;
    rate_general_pct: number;
    rate_senior_pct?: number | null;
    rate_super_senior_pct?: number | null;
    compounding_freq?: string | null;
    min_deposit?: number | null;
    max_deposit?: number | null;
    currency?: string | null; // e.g., "USD", "GBP" — for FCNR/GIFT variants
  }>;
  special_schemes?: Array<{
    scheme_name: string;
    tenure_days?: number;
    rate_general_pct: number;
    rate_senior_pct?: number;
    expiry_date?: string | null;
  }>;
  warnings?: string[];
  errors?: string[];
};

/** Variant rate file suffixes to scan for alongside the main _rates.json */
const VARIANT_SUFFIXES = ["_nre_rates.json", "_nro_rates.json", "_fcnr_rates.json", "_gift_rates.json"];

/** Variants where currency must be considered for slab matching */
const CURRENCY_VARIANTS = new Set(["fcnr", "gift"]);

// ── Config defaults (mirrors rate-discovery-agent/scripts/utils/config-defaults.js) ──

const CONFIG_DEFAULTS: Partial<AgentConfig> = {
  tenure_parser: "standard_indian",
  rate_multiplier: 1.0,
  senior_citizen_premium: "same_table",
  deposit_insurance: true,
  update_frequency: "monthly",
};

function mergeWithDefaults(config: AgentConfig): AgentConfig {
  return { ...CONFIG_DEFAULTS, ...config };
}

// ── Status mapping ───────────────────────────────────────────────

function mapScraperStatus(config: AgentConfig): string {
  const type = config.scraper_type;
  if (!type || type === "manual") return "manual_only";
  if (["html_static", "html_js", "pdf", "mixed", "government"].includes(type)) return "active";
  return "pending";
}

function mapDiscoveryStatus(config: AgentConfig): string {
  const confidence = config.discovery_metadata?.confidence;
  if (confidence === "high" || confidence === "medium") return "discovered";
  if (confidence === "low") return "partial";
  if (confidence === "none") return "not_found";
  if (config.website) return "discovered";
  return "not_found";
}

// ── Slugify (same algorithm as packages/api/src/lib/helpers.ts) ──

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Bank matching ────────────────────────────────────────────────

function findBankByCode(db: Db, code: string) {
  return db.select().from(schema.banks).where(eq(schema.banks.code, code)).get();
}

function findBankByName(db: Db, name: string) {
  const slug = slugify(name);
  return db.select().from(schema.banks).where(eq(schema.banks.code, slug)).get();
}

// ── Rate versioning ──────────────────────────────────────────────

/**
 * Get currently active slabs for a bank+product (where effective_to IS NULL).
 */
function getActiveSlabs(db: Db, bankId: number, productId: number): ActiveSlab[] {
  const rows = db
    .select({
      id: schema.rateSlabs.id,
      tenure_min_days: schema.rateSlabs.tenure_min_days,
      tenure_max_days: schema.rateSlabs.tenure_max_days,
      tenure_text: schema.rateSlabs.tenure_text,
      rate_general_pct: schema.rateSlabs.rate_general_pct,
      rate_senior_pct: schema.rateSlabs.rate_senior_pct,
      rate_super_senior_pct: schema.rateSlabs.rate_super_senior_pct,
      currency: schema.rateSlabs.currency,
    })
    .from(schema.rateSlabs)
    .where(
      and(
        eq(schema.rateSlabs.bank_id, bankId),
        eq(schema.rateSlabs.product_id, productId),
        isNull(schema.rateSlabs.effective_to),
      ),
    )
    .all();
  return rows;
}

/**
 * Find matching active slab by tenure range (and optionally currency) for versioning comparison.
 * For FCNR/GIFT variants, currency is part of the identity — same tenure with different
 * currencies (e.g., 1Y USD vs 1Y GBP) are distinct slabs.
 */
function findMatchingActive(
  newMinDays: number,
  newMaxDays: number,
  activeSlabs: ActiveSlab[],
  currency?: string | null,
): ActiveSlab | undefined {
  return activeSlabs.find(s => {
    if (s.tenure_min_days !== newMinDays || s.tenure_max_days !== newMaxDays) return false;
    // If currency is specified, match it too (for FCNR/GIFT)
    if (currency && currency !== "INR") return s.currency === currency;
    return true;
  });
}

/**
 * Check if a new slab's rates differ from an existing active slab.
 */
function ratesChanged(
  newSlab: RawSlab,
  activeSlab: ActiveSlab,
): Array<{ field: string; oldVal: string; newVal: string }> {
  const changes: Array<{ field: string; oldVal: string; newVal: string }> = [];

  if (newSlab.rate_general_pct != null && newSlab.rate_general_pct !== activeSlab.rate_general_pct) {
    changes.push({
      field: "rate_general_pct",
      oldVal: String(activeSlab.rate_general_pct),
      newVal: String(newSlab.rate_general_pct),
    });
  }
  if (newSlab.rate_senior_pct !== undefined && newSlab.rate_senior_pct !== activeSlab.rate_senior_pct) {
    changes.push({
      field: "rate_senior_pct",
      oldVal: String(activeSlab.rate_senior_pct ?? ""),
      newVal: String(newSlab.rate_senior_pct ?? ""),
    });
  }
  if (newSlab.rate_super_senior_pct !== undefined && newSlab.rate_super_senior_pct !== activeSlab.rate_super_senior_pct) {
    changes.push({
      field: "rate_super_senior_pct",
      oldVal: String(activeSlab.rate_super_senior_pct ?? ""),
      newVal: String(newSlab.rate_super_senior_pct ?? ""),
    });
  }
  return changes;
}

// ── Import stats ─────────────────────────────────────────────────

type ImportStats = {
  updated: Array<{ code: string; dbName: string; scraperStatus: string; discoveryStatus: string }>;
  unmatched: Array<{ code: string; name: string }>;
  errors: Array<{ file: string; error: string }>;
  rateSlabs: number;
  rateSlabsChanged: number;
  rateSlabsUnchanged: number;
  flagsCreated: number;
};

function createStats(): ImportStats {
  return {
    updated: [],
    unmatched: [],
    errors: [],
    rateSlabs: 0,
    rateSlabsChanged: 0,
    rateSlabsUnchanged: 0,
    flagsCreated: 0,
  };
}

// ── Core import logic ────────────────────────────────────────────

function importConfig(db: Db, configPath: string, stats: ImportStats): void {
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as AgentConfig;
  const config = mergeWithDefaults(raw);
  const bankCode = config.bank_code;

  // Find matching bank
  const bank = findBankByCode(db, bankCode) ?? findBankByName(db, config.bank_name);
  if (!bank) {
    console.log(`  SKIP ${bankCode}: no matching bank for "${config.bank_name}"`);
    stats.unmatched.push({ code: bankCode, name: config.bank_name });
    return;
  }

  // Update bank record
  const scraperStatus = mapScraperStatus(config);
  const discoveryStatus = mapDiscoveryStatus(config);
  const now = new Date().toISOString();

  db.update(schema.banks)
    .set({
      website_url: config.website ?? undefined,
      rate_page_url: config.rate_page_urls?.fd ?? undefined,
      scraper_status: scraperStatus,
      discovery_status: discoveryStatus,
      deposit_insurance: config.deposit_insurance ?? false,
      updated_at: now,
    })
    .where(eq(schema.banks.id, bank.id))
    .run();

  console.log(`  OK   ${bankCode} → ${bank.name} (id=${bank.id}) [${scraperStatus}, ${discoveryStatus}]`);
  stats.updated.push({ code: bankCode, dbName: bank.name, scraperStatus, discoveryStatus });

  // Import rates if available — domestic + variant files
  const basePath = configPath.replace("_config.json", "");

  // Domestic rates (existing behavior)
  const ratesPath = basePath + "_rates.json";
  if (existsSync(ratesPath)) {
    importRates(db, ratesPath, bank.id, bank.category, config, stats);
  }

  // Variant rate files (NRE, NRO, FCNR, GIFT)
  for (const suffix of VARIANT_SUFFIXES) {
    const variantPath = basePath + suffix;
    if (existsSync(variantPath)) {
      importRates(db, variantPath, bank.id, bank.category, config, stats);
    }
  }
}

function importRates(
  db: Db,
  ratesPath: string,
  bankId: number,
  bankCategory: string,
  config: AgentConfig,
  stats: ImportStats,
): void {
  const rates = JSON.parse(readFileSync(ratesPath, "utf-8")) as AgentRates;
  const slabs = rates.rate_slabs || [];

  if (slabs.length === 0) return;

  const productType = rates.product_type || "FD";
  const variant = rates.variant || "regular";
  const now = new Date().toISOString();
  const effectiveDate = rates.effective_date || now.split("T")[0];
  const sourceUrl = rates.source_url || null;

  // Ensure tenure days are resolved
  const resolvedSlabs: RawSlab[] = slabs.map(s => {
    let minDays = s.tenure_min_days ?? null;
    let maxDays = s.tenure_max_days ?? null;

    // Try parsing tenure text if days are missing
    if ((minDays == null || maxDays == null) && s.tenure_text) {
      const parsed = parseTenureText(s.tenure_text);
      if (parsed) {
        minDays = minDays ?? parsed.minDays;
        maxDays = maxDays ?? parsed.maxDays;
      }
    }

    // Currency: required for FCNR/GIFT (per-slab, e.g. USD/GBP/EUR/AED),
    // default to INR for domestic/NRE/NRO variants
    const currency = s.currency ?? (CURRENCY_VARIANTS.has(variant) ? null : "INR");

    return {
      tenure_text: s.tenure_text,
      tenure_min_days: minDays,
      tenure_max_days: maxDays,
      rate_general_pct: s.rate_general_pct,
      rate_senior_pct: s.rate_senior_pct ?? null,
      rate_super_senior_pct: s.rate_super_senior_pct ?? null,
      compounding_freq: s.compounding_freq ?? null,
      min_deposit: s.min_deposit ?? null,
      max_deposit: s.max_deposit ?? null,
      currency,
    };
  });

  // Warn about FCNR/GIFT slabs missing currency
  if (CURRENCY_VARIANTS.has(variant)) {
    const missingCurrency = resolvedSlabs.filter(s => !s.currency);
    if (missingCurrency.length > 0) {
      console.log(`    WARN: ${missingCurrency.length} ${variant.toUpperCase()} slabs missing currency — they will be skipped`);
    }
  }

  // Find or create product
  let product = db
    .select()
    .from(schema.products)
    .where(
      and(
        eq(schema.products.bank_id, bankId),
        eq(schema.products.product_type, productType),
        eq(schema.products.variant, variant),
      ),
    )
    .get();

  if (!product) {
    db.insert(schema.products)
      .values({
        bank_id: bankId,
        product_type: productType,
        variant,
        created_at: now,
        updated_at: now,
      })
      .run();
    product = db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.bank_id, bankId),
          eq(schema.products.product_type, productType),
          eq(schema.products.variant, variant),
        ),
      )
      .get();
  }

  if (!product) {
    console.log(`    WARN: failed to create product for ${config.bank_code}`);
    return;
  }

  const productId = product.id;

  // Get active slabs for versioning + validation
  const activeSlabs = getActiveSlabs(db, bankId, productId);

  // Run validation (variant-aware for NRI/FCNR/GIFT)
  const validation = validateImport(resolvedSlabs, {
    productType,
    variant,
    bankCategory,
    expectedSlabCount: config.expected_slab_count,
    activeSlabs,
    previousSlabCount: activeSlabs.length > 0 ? activeSlabs.length : undefined,
  });

  // Record scrape run
  const scrapeRunResult = db
    .insert(schema.scrapeRuns)
    .values({
      bank_id: bankId,
      started_at: now,
      completed_at: now,
      status: validation.passed ? (validation.warningCount > 0 ? "partial" : "success") : "failed",
      records_found: resolvedSlabs.length,
      records_changed: 0, // will be updated after versioning
      records_flagged: validation.flags.length,
      scraper_version: "discovery-agent-v1",
    })
    .run();
  const scrapeRunId = Number(scrapeRunResult.lastInsertRowid);

  // Write validation flags to DB
  for (const flag of validation.flags) {
    db.insert(schema.scrapeFlags)
      .values({
        scrape_run_id: scrapeRunId,
        bank_id: bankId,
        flag_type: flag.flag_type,
        severity: flag.severity,
        details: flag.details,
      })
      .run();
    stats.flagsCreated++;
  }

  if (validation.criticalCount > 0) {
    console.log(`    WARN: ${validation.criticalCount} critical validation flags — slabs held for review`);
  }

  // Versioned import
  let changed = 0;
  let unchanged = 0;
  let inserted = 0;

  const isCurrencyVariant = CURRENCY_VARIANTS.has(variant);

  for (const slab of resolvedSlabs) {
    // Skip slabs that failed format validation (no valid days or rate)
    if (slab.tenure_min_days == null || slab.tenure_max_days == null || slab.rate_general_pct == null) {
      continue;
    }
    // Skip FCNR/GIFT slabs missing currency — can't insert without it
    if (isCurrencyVariant && !slab.currency) {
      continue;
    }

    const matching = findMatchingActive(
      slab.tenure_min_days, slab.tenure_max_days, activeSlabs,
      isCurrencyVariant ? slab.currency : undefined,
    );

    if (matching) {
      const changes = ratesChanged(slab, matching);
      if (changes.length === 0) {
        unchanged++;
        continue;
      }

      // Rate changed: close old slab, insert new one
      db.update(schema.rateSlabs)
        .set({ effective_to: effectiveDate })
        .where(eq(schema.rateSlabs.id, matching.id))
        .run();

      // Log changes
      for (const ch of changes) {
        db.insert(schema.rateChangeLog)
          .values({
            rate_slab_id: matching.id,
            bank_id: bankId,
            product_id: productId,
            field_changed: ch.field,
            old_value: ch.oldVal,
            new_value: ch.newVal,
            detected_at: now,
            source_url: sourceUrl,
          })
          .run();
      }

      changed++;
    }

    // Insert new slab (either new tenure or replacement for changed rate)
    db.insert(schema.rateSlabs)
      .values({
        product_id: productId,
        bank_id: bankId,
        tenure_min_days: slab.tenure_min_days,
        tenure_max_days: slab.tenure_max_days,
        tenure_text: slab.tenure_text,
        rate_general_pct: slab.rate_general_pct,
        rate_senior_pct: slab.rate_senior_pct,
        rate_super_senior_pct: slab.rate_super_senior_pct,
        compounding_frequency: slab.compounding_freq,
        effective_from: effectiveDate,
        effective_to: null,
        min_deposit_for_slab: slab.min_deposit,
        max_deposit_for_slab: slab.max_deposit,
        currency: slab.currency ?? "INR",
        source_url: sourceUrl,
        scraped_at: now,
      })
      .run();
    inserted++;
  }

  // Update scrape run with actual change count
  db.update(schema.scrapeRuns)
    .set({ records_changed: changed })
    .where(eq(schema.scrapeRuns.id, scrapeRunId))
    .run();

  // Import special schemes
  if (rates.special_schemes && rates.special_schemes.length > 0) {
    let schemeCount = 0;
    for (const scheme of rates.special_schemes) {
      if (scheme.rate_general_pct == null) continue; // skip schemes without a rate
      try {
        db.insert(schema.specialSchemes)
          .values({
            bank_id: bankId,
            name: scheme.scheme_name,
            rate_pct: scheme.rate_general_pct,
            tenure_days: scheme.tenure_days ?? null,
            expiry_date: scheme.expiry_date ?? null,
            source_url: sourceUrl,
          })
          .run();
        schemeCount++;
      } catch {
        // Skip duplicate or invalid schemes silently
      }
    }
    if (schemeCount > 0) console.log(`         + ${schemeCount} special schemes`);
  }

  stats.rateSlabs += inserted;
  stats.rateSlabsChanged += changed;
  stats.rateSlabsUnchanged += unchanged;

  const parts = [`${inserted} slabs imported`];
  if (changed > 0) parts.push(`${changed} changed`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  if (validation.flags.length > 0) parts.push(`${validation.flags.length} flags`);
  console.log(`         + ${parts.join(", ")} (${productType}/${variant})`);
}

// ── Public API ───────────────────────────────────────────────────

export function runImport(inputPath: string): ImportStats {
  const { db, dbPath } = createDb();
  console.log(`Database: ${dbPath}\n`);

  const stats = createStats();
  const resolved = resolve(inputPath);

  if (resolved.endsWith("_config.json")) {
    console.log(`Importing: ${resolved}\n`);
    importConfig(db, resolved, stats);
  } else if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    // Recursively find all *_config.json files (supports category subfolders)
    const configs: string[] = [];
    function scanDir(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry.endsWith("_config.json")) {
          configs.push(full);
        } else if (statSync(full).isDirectory() && !entry.startsWith("_")) {
          scanDir(full);
        }
      }
    }
    scanDir(resolved);
    configs.sort();

    console.log(`Found ${configs.length} config files in ${resolved}\n`);

    for (const configPath of configs) {
      try {
        importConfig(db, configPath, stats);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ERR  ${configPath}: ${msg}`);
        stats.errors.push({ file: configPath, error: msg });
      }
    }
  } else {
    throw new Error(`Input must be a *_config.json file or a directory: ${resolved}`);
  }

  return stats;
}

export function printSummary(stats: ImportStats): void {
  console.log("\n============================================");
  console.log(" Import Summary");
  console.log("============================================");
  console.log(`  Updated:         ${stats.updated.length} banks`);
  console.log(`  Unmatched:       ${stats.unmatched.length} banks`);
  console.log(`  Errors:          ${stats.errors.length}`);
  console.log(`  Rate slabs:      ${stats.rateSlabs} imported`);
  console.log(`  Rate changes:    ${stats.rateSlabsChanged} detected`);
  console.log(`  Unchanged:       ${stats.rateSlabsUnchanged} skipped`);
  console.log(`  Flags created:   ${stats.flagsCreated}`);

  if (stats.unmatched.length > 0) {
    console.log("\n  Unmatched banks:");
    for (const u of stats.unmatched) {
      console.log(`    - ${u.code}: "${u.name}"`);
    }
  }

  if (stats.errors.length > 0) {
    console.log("\n  Errors:");
    for (const e of stats.errors) {
      console.log(`    - ${e.file}: ${e.error}`);
    }
  }

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const u of stats.updated) {
    const key = `${u.scraperStatus}/${u.discoveryStatus}`;
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  if (Object.keys(statusCounts).length > 0) {
    console.log("\n  Status breakdown:");
    for (const [key, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${key}: ${count}`);
    }
  }

  console.log("\nDone.");
}

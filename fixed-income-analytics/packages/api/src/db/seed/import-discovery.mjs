/**
 * Import rate-discovery-agent outputs into the BIRD database.
 *
 * Reads *_config.json and *_rates.json files from the agent output directory,
 * matches banks by name, and updates the database with discovery results.
 *
 * Usage:
 *   # Import all discovery results from a directory
 *   node packages/api/src/db/seed/import-discovery.mjs rate-discovery-agent/output/
 *
 *   # Import a single bank config
 *   node packages/api/src/db/seed/import-discovery.mjs rate-discovery-agent/output/sbi_config.json
 *
 * Prerequisites:
 *   Run from the project root (C:\sw\BharatOmni\UFA\BIRD)
 *   Database must be migrated and seeded (npm run db:setup in packages/api)
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { resolve, dirname, basename, join } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Find the local D1 database ────────────────────────────────────
function findD1Database() {
  // Wrangler stores local D1 under packages/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
  const apiDir = resolve(__dirname, "../../..");
  const d1Dir = join(apiDir, ".wrangler", "state", "v3", "d1");
  if (!existsSync(d1Dir)) {
    throw new Error(`Wrangler D1 state not found at ${d1Dir}. Run 'npm run db:setup' first.`);
  }

  // Find the sqlite file recursively — Wrangler uses a hash-based filename
  function findSqlite(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isFile() && entry.endsWith(".sqlite")) return full;
      if (stat.isDirectory()) {
        const found = findSqlite(full);
        if (found) return found;
      }
    }
    return null;
  }

  const dbPath = findSqlite(d1Dir);
  if (!dbPath) {
    throw new Error(`No .sqlite file found under ${d1Dir}. Run 'npm run db:setup' first.`);
  }
  return dbPath;
}

// ── Slugify (same as helpers.ts) ──────────────────────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Map scraper_type to our status enums ──────────────────────────
function mapScraperStatus(config) {
  const type = config.scraper_type;
  if (!type || type === "manual") return "manual_only";
  if (["html_static", "html_js", "pdf", "mixed", "government"].includes(type)) return "active";
  return "pending";
}

function mapDiscoveryStatus(config) {
  const confidence = config.discovery_metadata?.confidence;
  if (confidence === "high" || confidence === "medium") return "discovered";
  if (confidence === "low") return "partial";
  if (confidence === "none") return "not_found";
  // If no metadata but we have a website, count as discovered
  if (config.website) return "discovered";
  return "not_found";
}

// ── Match bank name to database record ────────────────────────────
function findBankMatch(db, config) {
  const code = slugify(config.bank_name);

  // Try exact code match first
  let row = db.prepare("SELECT id, code, name FROM banks WHERE code = ?").get(code);
  if (row) return row;

  // Try LIKE match on name
  row = db
    .prepare("SELECT id, code, name FROM banks WHERE LOWER(name) = LOWER(?)")
    .get(config.bank_name);
  if (row) return row;

  // Try fuzzy: name contains the config name or vice versa
  row = db
    .prepare("SELECT id, code, name FROM banks WHERE LOWER(name) LIKE ? ORDER BY LENGTH(name) ASC LIMIT 1")
    .get(`%${config.bank_name.toLowerCase()}%`);
  if (row) return row;

  // Try the other direction
  row = db
    .prepare("SELECT id, code, name FROM banks WHERE ? LIKE '%' || LOWER(name) || '%' ORDER BY LENGTH(name) DESC LIMIT 1")
    .get(config.bank_name.toLowerCase());
  if (row) return row;

  return null;
}

// ── Import a single config file ───────────────────────────────────
function importConfig(db, configPath, stats) {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const bankCode = config.bank_code;

  // Find matching bank in database
  const match = findBankMatch(db, config);
  if (!match) {
    console.log(`  SKIP ${bankCode}: no matching bank found for "${config.bank_name}"`);
    stats.unmatched.push({ code: bankCode, name: config.bank_name });
    return;
  }

  // Update bank record
  const scraperStatus = mapScraperStatus(config);
  const discoveryStatus = mapDiscoveryStatus(config);
  const websiteUrl = config.website || null;
  const ratePageUrl = config.rate_page_urls?.fd || null;
  const depositInsurance = config.deposit_insurance ? 1 : 0;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE banks SET
      website_url = COALESCE(?, website_url),
      rate_page_url = COALESCE(?, rate_page_url),
      scraper_status = ?,
      discovery_status = ?,
      deposit_insurance = ?,
      updated_at = ?
    WHERE id = ?
  `).run(websiteUrl, ratePageUrl, scraperStatus, discoveryStatus, depositInsurance, now, match.id);

  console.log(`  OK   ${bankCode} → ${match.name} (id=${match.id}) [${scraperStatus}, ${discoveryStatus}]`);
  stats.updated.push({ code: bankCode, dbName: match.name, scraperStatus, discoveryStatus });

  // Check for corresponding rates file
  const ratesPath = configPath.replace("_config.json", "_rates.json");
  if (existsSync(ratesPath)) {
    importRates(db, ratesPath, match.id, stats);
  }
}

// ── Import rate data ──────────────────────────────────────────────
function importRates(db, ratesPath, bankId, stats) {
  const rates = JSON.parse(readFileSync(ratesPath, "utf-8"));
  const slabs = rates.rate_slabs || [];

  if (slabs.length === 0) {
    return;
  }

  // Create or find the product record
  const productType = rates.product_type || "FD";
  const variant = rates.variant || "regular";

  let product = db
    .prepare("SELECT id FROM products WHERE bank_id = ? AND product_type = ? AND variant = ?")
    .get(bankId, productType, variant);

  if (!product) {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        "INSERT INTO products (bank_id, product_type, variant, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(bankId, productType, variant, now, now);
    product = { id: result.lastInsertRowid };
  }

  // Insert rate slabs
  const insertSlab = db.prepare(`
    INSERT INTO rate_slabs (
      product_id, bank_id, tenure_min_days, tenure_max_days, tenure_text,
      rate_general_pct, rate_senior_pct, rate_super_senior_pct,
      compounding_frequency, effective_from, effective_to,
      min_deposit_for_slab, max_deposit_for_slab,
      source_url, scraped_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const effectiveDate = rates.effective_date || now;
  const sourceUrl = rates.source_url || null;
  let imported = 0;

  for (const slab of slabs) {
    try {
      insertSlab.run(
        product.id,
        bankId,
        slab.tenure_min_days ?? 0,
        slab.tenure_max_days ?? 0,
        slab.tenure_text || "",
        slab.rate_general_pct ?? 0,
        slab.rate_senior_pct ?? null,
        slab.rate_super_senior_pct ?? null,
        slab.compounding_freq || null,
        effectiveDate,
        slab.min_deposit ?? null,
        null,
        sourceUrl,
        now,
        now,
      );
      imported++;
    } catch (err) {
      console.log(`    WARN: failed to import slab: ${err.message}`);
    }
  }

  if (imported > 0) {
    console.log(`         + ${imported} rate slabs imported (${productType}/${variant})`);
    stats.rateSlabs += imported;
  }
}

// ── Main ──────────────────────────────────────────────────────────
const input = process.argv[2];
if (!input) {
  console.error("Usage: node import-discovery.mjs <output_dir_or_config_file>");
  process.exit(1);
}

const dbPath = findD1Database();
console.log(`Database: ${dbPath}\n`);
const db = new Database(dbPath);

const stats = {
  updated: [],
  unmatched: [],
  errors: [],
  rateSlabs: 0,
};

const inputPath = resolve(input);

if (inputPath.endsWith("_config.json")) {
  // Single file
  console.log(`Importing: ${inputPath}\n`);
  importConfig(db, inputPath, stats);
} else if (statSync(inputPath).isDirectory()) {
  // Directory — find all *_config.json files
  const configs = readdirSync(inputPath)
    .filter((f) => f.endsWith("_config.json"))
    .sort();

  console.log(`Found ${configs.length} config files in ${inputPath}\n`);

  for (const configFile of configs) {
    try {
      importConfig(db, join(inputPath, configFile), stats);
    } catch (err) {
      console.log(`  ERR  ${configFile}: ${err.message}`);
      stats.errors.push({ file: configFile, error: err.message });
    }
  }
} else {
  console.error(`Input must be a *_config.json file or a directory: ${inputPath}`);
  process.exit(1);
}

// ── Summary ───────────────────────────────────────────────────────
console.log("\n============================================");
console.log(" Import Summary");
console.log("============================================");
console.log(`  Updated:    ${stats.updated.length} banks`);
console.log(`  Unmatched:  ${stats.unmatched.length} banks`);
console.log(`  Errors:     ${stats.errors.length}`);
console.log(`  Rate slabs: ${stats.rateSlabs}`);

if (stats.unmatched.length > 0) {
  console.log("\n  Unmatched banks (no DB match found):");
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
const statusCounts = {};
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

db.close();
console.log("\nDone.");

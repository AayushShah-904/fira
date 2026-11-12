#!/usr/bin/env node

/**
 * reconcile-runs.js — Reconcile old-slug and new-slug discovery output.
 *
 * Scans output/latest/ for config files, derives canonical slugs from bank_name,
 * renames mismatched files, merges duplicates, adds discovery_completeness and
 * data_freshness fields, and optionally cleans up output/ root.
 *
 * Usage:
 *   node scripts/reconcile-runs.js --dry-run          # preview changes
 *   node scripts/reconcile-runs.js                     # execute
 *   node scripts/reconcile-runs.js --clean-root        # also archive output/ root files
 */

const fs = require("fs");
const path = require("path");
const { slugify } = require("./utils/slugify");

// ── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const cleanRoot = args.includes("--clean-root");

const LATEST_DIR = path.join(__dirname, "..", "output", "latest");
const ARCHIVE_DIR = path.join(__dirname, "..", "output", "archive");
const OUTPUT_ROOT = path.join(__dirname, "..", "output");

const MAX_AGE_DAYS = 7;

// ── Helpers ────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // safe-write-exempt: TODO migrate per ADR-012 — reconcile-runs writeJson helper is multi-purpose (writes per-bank artifacts AND aggregator outputs depending on caller). Migration needs caller-by-caller kind/source inference. Queued for follow-up.
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function moveFile(src, dest) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

function deleteFile(filePath) {
  if (dryRun) return;
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

/** Find all files in a directory matching a slug prefix. */
function findBankFiles(dir, slug) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => {
    // Match: slug_config.json, slug_rates.json, slug_nre_rates.json, slug.log, slug.summary.json, etc.
    return f === `${slug}_config.json`
      || f === `${slug}_rates.json`
      || f.startsWith(`${slug}_`) && f.endsWith("_rates.json")
      || f === `${slug}.log`
      || f === `${slug}.summary.json`
      || f === `${slug}.trace.jsonl`
      || f.startsWith(`${slug}_`) && f.endsWith(".json") && !f.includes("_rates");
  });
}

/** Derive discovery_completeness from config. */
function deriveCompleteness(config) {
  const urls = config.rate_page_urls || {};
  const hasNriFields = "fd_nre" in urls || "fd_nro" in urls || "fd_fcnr" in urls;

  const completeness = {
    domestic_fd: !!urls.fd,
    nri_searched: hasNriFields,
  };

  if (hasNriFields) {
    completeness.nre = urls.fd_nre ? true : urls.fd_nre === null ? false : null;
    completeness.nro = urls.fd_nro ? true : urls.fd_nro === null ? false : null;
    completeness.fcnr = urls.fd_fcnr ? true : urls.fd_fcnr === null ? false : null;
  }

  if (config.bank_type === "IBU") {
    completeness.gift = urls.fd_gift ? true : null;
  }

  return completeness;
}

/** Derive data_freshness from config + rates file. */
function deriveFreshness(slug) {
  const ratesPath = path.join(LATEST_DIR, `${slug}_rates.json`);
  const rates = readJson(ratesPath);
  if (!rates) return "demo_only";

  const slabs = rates.rate_slabs || [];
  if (slabs.length === 0) return "demo_only";

  const scrapedAt = rates.scraped_at;
  if (!scrapedAt) return "stale";

  const ageMs = Date.now() - new Date(scrapedAt).getTime();
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return ageMs <= maxAgeMs ? "current" : "stale";
}

/** Deep merge: fill null/missing fields in target from source. */
function fillNulls(target, source, fieldPaths) {
  for (const fp of fieldPaths) {
    const keys = fp.split(".");
    let tRef = target;
    let sRef = source;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!tRef[keys[i]]) tRef[keys[i]] = {};
      tRef = tRef[keys[i]];
      sRef = sRef?.[keys[i]];
    }
    const lastKey = keys[keys.length - 1];
    if ((tRef[lastKey] == null || (typeof tRef[lastKey] === "object" && Object.keys(tRef[lastKey]).length === 0)) && sRef?.[lastKey] != null) {
      tRef[lastKey] = sRef[lastKey];
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────

console.log(`\n=== Reconcile Discovery Runs ${dryRun ? "(DRY RUN)" : ""} ===\n`);

// Step 1: Scan all configs, derive canonical slugs
const configFiles = fs.readdirSync(LATEST_DIR)
  .filter((f) => f.endsWith("_config.json") && !f.startsWith("_"));

const slugMap = new Map(); // canonical_slug → [{ fileSlug, configPath }]

for (const f of configFiles) {
  const fileSlug = f.replace(/_config\.json$/, "");
  const configPath = path.join(LATEST_DIR, f);
  const config = readJson(configPath);
  if (!config || !config.bank_name) {
    console.log(`  SKIP: ${f} — no bank_name`);
    continue;
  }

  const canonical = slugify(config.bank_name);
  if (!slugMap.has(canonical)) slugMap.set(canonical, []);
  slugMap.get(canonical).push({ fileSlug, configPath, config });
}

console.log(`Found ${configFiles.length} configs, ${slugMap.size} unique banks\n`);

// Step 2: Process each canonical slug
const stats = { renamed: 0, merged: 0, unchanged: 0, completeness_added: 0, errors: 0 };

for (const [canonical, entries] of slugMap) {
  if (entries.length === 1 && entries[0].fileSlug === canonical) {
    // Already canonical — just add completeness/freshness if missing
    const { config, configPath } = entries[0];
    let changed = false;

    if (!config.discovery_completeness) {
      config.discovery_completeness = deriveCompleteness(config);
      changed = true;
    }
    if (!config.data_freshness) {
      config.data_freshness = deriveFreshness(canonical);
      changed = true;
    }
    if (changed) {
      writeJson(configPath, config);
      stats.completeness_added++;
    }
    stats.unchanged++;
    continue;
  }

  if (entries.length === 1 && entries[0].fileSlug !== canonical) {
    // ── RENAME: old slug → canonical ──
    const { fileSlug, config } = entries[0];

    // Check for collision: does canonical already exist as a separate file?
    const canonicalConfigPath = path.join(LATEST_DIR, `${canonical}_config.json`);
    if (fs.existsSync(canonicalConfigPath) && fileSlug !== canonical) {
      // This shouldn't happen since we grouped by canonical, but guard anyway
      console.log(`  WARN: ${fileSlug} → ${canonical} would collide; skipping`);
      stats.errors++;
      continue;
    }

    console.log(`  RENAME: ${fileSlug} → ${canonical}`);

    // Update bank_code in config
    config.bank_code = canonical;
    config.discovery_completeness = deriveCompleteness(config);
    config.data_freshness = deriveFreshness(fileSlug); // read rates from old slug before rename

    // Find and rename all files for this bank
    const files = findBankFiles(LATEST_DIR, fileSlug);
    for (const f of files) {
      const newName = f.replace(fileSlug, canonical);
      const src = path.join(LATEST_DIR, f);
      const dest = path.join(LATEST_DIR, newName);
      console.log(`    ${f} → ${newName}`);
      moveFile(src, dest);
    }

    // Write updated config (after rename so it goes to canonical path)
    writeJson(path.join(LATEST_DIR, `${canonical}_config.json`), config);

    // Update bank_code in rate files too
    const rateVariants = ["", "_nre", "_nro", "_fcnr", "_gift"];
    for (const v of rateVariants) {
      const ratePath = path.join(LATEST_DIR, `${canonical}${v}_rates.json`);
      if (fs.existsSync(ratePath)) {
        const rates = readJson(ratePath);
        if (rates && rates.bank_code !== canonical) {
          rates.bank_code = canonical;
          writeJson(ratePath, rates);
        }
      }
    }

    stats.renamed++;
    continue;
  }

  if (entries.length >= 2) {
    // ── MERGE: multiple slugs for same canonical ──
    // Find the new-slug entry (matches canonical) and old-slug entry
    const newEntry = entries.find((e) => e.fileSlug === canonical);
    const oldEntries = entries.filter((e) => e.fileSlug !== canonical);

    if (!newEntry) {
      // No entry matches canonical — pick the newest by discovered_at
      console.log(`  WARN: ${canonical} has ${entries.length} entries but none is canonical; picking first`);
      // Just rename the first one
      const pick = entries[0];
      pick.config.bank_code = canonical;
      pick.config.discovery_completeness = deriveCompleteness(pick.config);
      pick.config.data_freshness = deriveFreshness(pick.fileSlug);

      const files = findBankFiles(LATEST_DIR, pick.fileSlug);
      for (const f of files) {
        const newName = f.replace(pick.fileSlug, canonical);
        moveFile(path.join(LATEST_DIR, f), path.join(LATEST_DIR, newName));
      }
      writeJson(path.join(LATEST_DIR, `${canonical}_config.json`), pick.config);

      // Archive the rest
      for (const old of entries.filter((e) => e !== pick)) {
        const archiveSubdir = path.join(ARCHIVE_DIR, old.fileSlug);
        const oldFiles = findBankFiles(LATEST_DIR, old.fileSlug);
        for (const f of oldFiles) {
          moveFile(path.join(LATEST_DIR, f), path.join(archiveSubdir, f));
        }
        console.log(`    Archived ${old.fileSlug} → archive/${old.fileSlug}/`);
      }
      stats.merged++;
      continue;
    }

    console.log(`  MERGE: ${oldEntries.map((e) => e.fileSlug).join(", ")} → ${canonical}`);

    const mergedConfig = { ...newEntry.config };

    // Fill null fields from old configs
    for (const old of oldEntries) {
      fillNulls(mergedConfig, old.config, [
        "selectors",
        "column_mapping",
        "expected_slab_count",
      ]);

      // Merge scraper_notes (old fills missing keys)
      if (old.config.scraper_notes && mergedConfig.scraper_notes) {
        for (const [k, v] of Object.entries(old.config.scraper_notes)) {
          if (mergedConfig.scraper_notes[k] == null && v != null) {
            mergedConfig.scraper_notes[k] = v;
          }
        }
      }

      // Append old notes if different and non-empty
      if (old.config.notes && old.config.notes !== mergedConfig.notes) {
        const oldNotes = old.config.notes.trim();
        if (oldNotes && (!mergedConfig.notes || !mergedConfig.notes.includes(oldNotes))) {
          mergedConfig.notes = (mergedConfig.notes || "").trim()
            + (mergedConfig.notes ? " | [from prior run] " : "")
            + oldNotes;
        }
      }
    }

    // Add completeness + freshness
    mergedConfig.discovery_completeness = deriveCompleteness(mergedConfig);
    mergedConfig.data_freshness = deriveFreshness(canonical);

    // Write merged config
    writeJson(path.join(LATEST_DIR, `${canonical}_config.json`), mergedConfig);

    // Archive old-slug files
    for (const old of oldEntries) {
      const archiveSubdir = path.join(ARCHIVE_DIR, old.fileSlug);
      const oldFiles = findBankFiles(LATEST_DIR, old.fileSlug);
      console.log(`    Archive ${old.fileSlug}/ (${oldFiles.length} files)`);
      for (const f of oldFiles) {
        moveFile(path.join(LATEST_DIR, f), path.join(archiveSubdir, f));
      }
    }

    stats.merged++;
  }
}

// ── Step 3: Clean up output/ root ──────────────────────────────────

if (cleanRoot) {
  console.log("\n--- Cleaning output/ root ---");
  const archiveFirstWave = path.join(ARCHIVE_DIR, "first-wave");
  const rootFiles = fs.readdirSync(OUTPUT_ROOT).filter((f) => {
    const full = path.join(OUTPUT_ROOT, f);
    return fs.statSync(full).isFile();
  });

  let archived = 0;
  for (const f of rootFiles) {
    const src = path.join(OUTPUT_ROOT, f);
    const dest = path.join(archiveFirstWave, f);
    console.log(`  ${f} → archive/first-wave/`);
    moveFile(src, dest);
    archived++;
  }
  console.log(`  Archived ${archived} files from output/ root`);
}

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n=== Summary ${dryRun ? "(DRY RUN — no files changed)" : ""} ===`);
console.log(`  Renamed:    ${stats.renamed} banks (old slug → canonical)`);
console.log(`  Merged:     ${stats.merged} banks (old + new → merged)`);
console.log(`  Unchanged:  ${stats.unchanged} banks (already canonical)`);
console.log(`  Completeness added: ${stats.completeness_added}`);
console.log(`  Errors:     ${stats.errors}`);

// Count remaining old slugs as a verification
if (!dryRun) {
  const remaining = fs.readdirSync(LATEST_DIR)
    .filter((f) => f.endsWith("_config.json") && !f.startsWith("_"))
    .filter((f) => {
      const slug = f.replace(/_config\.json$/, "");
      const config = readJson(path.join(LATEST_DIR, f));
      if (!config || !config.bank_name) return false;
      return slug !== slugify(config.bank_name);
    });
  if (remaining.length > 0) {
    console.log(`\n  WARNING: ${remaining.length} configs still have non-canonical slugs:`);
    remaining.forEach((f) => console.log(`    ${f}`));
  } else {
    console.log(`\n  All configs use canonical slugs.`);
  }
}

console.log("");

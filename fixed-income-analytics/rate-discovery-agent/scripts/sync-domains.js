#!/usr/bin/env node

/**
 * sync-domains.js — Backfill data/bank-domains.json from discovered configs.
 *
 * Reads all *_config.json from output/latest/, extracts domain + rate page
 * URLs + scraper type, and merges into bank-domains.json. Existing entries
 * are preserved; new fields fill in gaps but never overwrite non-null values.
 *
 * This creates a growing cache that eliminates web search calls for
 * already-discovered banks on subsequent pipeline runs.
 *
 * Usage:
 *   node scripts/sync-domains.js              # execute
 *   node scripts/sync-domains.js --dry-run    # preview changes
 */

const fs = require("fs");
const path = require("path");

const dryRun = process.argv.includes("--dry-run");

const LATEST_DIR = path.join(__dirname, "..", "output", "latest");
const DOMAINS_FILE = path.join(__dirname, "..", "data", "bank-domains.json");

// ── Helpers ────────────────────────────────────────────────────────

/** Extract domain from a full URL. Returns null if unparseable. */
function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Convert a full URL to a relative path given a domain. */
function toRelativePath(fullUrl, domain) {
  if (!fullUrl || !domain) return null;
  try {
    const u = new URL(fullUrl);
    const urlDomain = u.hostname.replace(/^www\./, "");
    if (urlDomain !== domain) return null; // different domain, keep as null
    return u.pathname + u.search + u.hash || "/";
  } catch {
    return null;
  }
}

/** Extract a compact notes string from config. */
function extractNotes(config) {
  const parts = [];
  const sn = config.scraper_notes || {};
  if (sn.framework) parts.push(sn.framework);
  if (sn.bot_protection && !/none/i.test(sn.bot_protection)) parts.push(sn.bot_protection);
  if (sn.data_format) parts.push(sn.data_format);
  if (sn.rate_tables_on_page) parts.push(`${sn.rate_tables_on_page} tables`);
  // Add key observations from notes field
  const notes = config.notes || "";
  if (/redirect/i.test(notes)) {
    const match = notes.match(/\b[\w.-]+\s+redirect\w*\s+to\s+[\w.-]+/i);
    if (match) parts.push(match[0]);
  }
  return parts.join(". ") || null;
}

// ── Main ───────────────────────────────────────────────────────────

console.log(`\n=== Sync Domains ${dryRun ? "(DRY RUN)" : ""} ===\n`);

// Load existing domains
let domains = {};
if (fs.existsSync(DOMAINS_FILE)) {
  domains = JSON.parse(fs.readFileSync(DOMAINS_FILE, "utf-8"));
}
const originalCount = Object.keys(domains).length;

// Scan configs
const configFiles = fs.readdirSync(LATEST_DIR)
  .filter((f) => f.endsWith("_config.json") && !f.startsWith("_"));

let added = 0;
let updated = 0;
let skipped = 0;

for (const f of configFiles) {
  const bankCode = f.replace(/_config\.json$/, "");
  const configPath = path.join(LATEST_DIR, f);

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    skipped++;
    continue;
  }

  // Skip manual/no-website banks — nothing useful to cache
  if (!config.website && config.scraper_type === "manual") {
    skipped++;
    continue;
  }

  const domain = extractDomain(config.website);
  if (!domain) {
    skipped++;
    continue;
  }

  const existing = domains[bankCode] || {};
  const isNew = !domains[bankCode];

  // Build rate_pages from config.rate_page_urls (convert full URLs to relative paths)
  const ratePages = {};
  const urls = config.rate_page_urls || {};
  for (const [key, fullUrl] of Object.entries(urls)) {
    if (fullUrl) {
      ratePages[key] = toRelativePath(fullUrl, domain);
    } else if (fullUrl === null) {
      // Explicitly null = searched but not found — preserve that signal
      ratePages[key] = null;
    }
    // undefined/missing = never searched — don't add it
  }

  // Merge: existing non-null values win, new values fill gaps
  const mergedRatePages = { ...(existing.rate_pages || {}) };
  for (const [key, val] of Object.entries(ratePages)) {
    if (mergedRatePages[key] === undefined) {
      // New key — add it
      mergedRatePages[key] = val;
    } else if (mergedRatePages[key] === null && val !== null) {
      // Was null (not found), now we have a URL — upgrade
      mergedRatePages[key] = val;
    }
    // Otherwise keep existing non-null value
  }

  const entry = {
    domain: existing.domain || domain,
    ...(Object.keys(mergedRatePages).length > 0 ? { rate_pages: mergedRatePages } : {}),
    scraper_type: existing.scraper_type || config.scraper_type || undefined,
    ...(existing.parent_bank_code ? { parent_bank_code: existing.parent_bank_code } : {}),
  };

  // Add notes only if we have something useful and no existing notes
  const notes = existing.notes || extractNotes(config);
  if (notes) entry.notes = notes;

  // Check if anything actually changed
  const existingJson = JSON.stringify(existing);
  const entryJson = JSON.stringify(entry);
  if (existingJson === entryJson) {
    skipped++;
    continue;
  }

  domains[bankCode] = entry;

  if (isNew) {
    added++;
    console.log(`  ADD: ${bankCode} → ${domain} (${Object.keys(mergedRatePages).filter(k => mergedRatePages[k]).length} rate pages)`);
  } else {
    updated++;
    console.log(`  UPD: ${bankCode} (${Object.keys(mergedRatePages).filter(k => mergedRatePages[k]).length} rate pages)`);
  }
}

// Sort keys alphabetically for stable diffs
const sorted = {};
for (const key of Object.keys(domains).sort()) {
  sorted[key] = domains[key];
}

if (!dryRun) {
  // safe-write-exempt: TODO migrate per ADR-012 — registry write (kind: 'registry-file'); operator-invoked sync script. Queued for follow-up.
  fs.writeFileSync(DOMAINS_FILE, JSON.stringify(sorted, null, 2) + "\n");
}

console.log(`\n=== Summary ${dryRun ? "(DRY RUN)" : ""} ===`);
console.log(`  Before: ${originalCount} entries`);
console.log(`  After:  ${Object.keys(sorted).length} entries`);
console.log(`  Added:  ${added}`);
console.log(`  Updated: ${updated}`);
console.log(`  Skipped: ${skipped} (manual/no-website/no-change)`);
console.log("");

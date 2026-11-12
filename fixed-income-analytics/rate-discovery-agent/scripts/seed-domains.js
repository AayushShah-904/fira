#!/usr/bin/env node

/**
 * seed-domains.js — Generate data/bank-domains.json from existing discovery output.
 *
 * Reads all output/*_config.json files and extracts domain, rate page URLs,
 * scraper type, and notes into a compact lookup file for use by the agent
 * (skip web search for known banks) and the extraction pipeline.
 *
 * Usage:
 *   node scripts/seed-domains.js                  # writes data/bank-domains.json
 *   node scripts/seed-domains.js --dry-run        # print to stdout instead
 */

const fs = require("fs");
const path = require("path");

const dryRun = process.argv.includes("--dry-run");

const outputDir = path.join(__dirname, "..", "output");
const dataFile = path.join(__dirname, "..", "data", "bank-domains.json");

// Collect all config files
const configFiles = fs.readdirSync(outputDir)
  .filter((f) => f.endsWith("_config.json") && !f.startsWith("_"))
  .sort();

console.log(`Found ${configFiles.length} config files in output/`);

const domains = {};
let skipped = 0;

for (const file of configFiles) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(outputDir, file), "utf-8"));
    const bankCode = config.bank_code;
    if (!bankCode) { skipped++; continue; }

    const website = config.website || null;
    if (!website) { skipped++; continue; }

    // Extract domain from full URL
    let domain;
    try {
      domain = new URL(website).hostname.replace(/^www\./, "");
    } catch {
      domain = website;
    }

    // Build rate_pages from rate_page_urls
    const ratePages = {};
    if (config.rate_page_urls) {
      for (const [product, url] of Object.entries(config.rate_page_urls)) {
        if (url) {
          try {
            const parsed = new URL(url);
            ratePages[product] = parsed.pathname + parsed.search;
          } catch {
            ratePages[product] = url;
          }
        }
      }
    }

    // Scraper notes summary
    const notes = [];
    if (config.scraper_notes?.framework) notes.push(config.scraper_notes.framework);
    if (config.scraper_notes?.bot_protection) notes.push(config.scraper_notes.bot_protection);

    const entry = { domain };
    if (Object.keys(ratePages).length > 0) entry.rate_pages = ratePages;
    if (config.scraper_type) entry.scraper_type = config.scraper_type;
    if (notes.length > 0) entry.notes = notes.join(", ");

    domains[bankCode] = entry;
  } catch (err) {
    console.error(`  Error processing ${file}: ${err.message}`);
    skipped++;
  }
}

console.log(`Extracted ${Object.keys(domains).length} bank domains (${skipped} skipped)`);

const output = JSON.stringify(domains, null, 2);

if (dryRun) {
  console.log(output);
} else {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  // safe-write-exempt: TODO migrate per ADR-012 — registry seed write (kind: 'registry-file'); operator-invoked one-shot script. Queued for follow-up.
  fs.writeFileSync(dataFile, output + "\n");
  console.log(`Written to ${dataFile}`);
}

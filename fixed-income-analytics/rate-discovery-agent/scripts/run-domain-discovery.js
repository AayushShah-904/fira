#!/usr/bin/env node

/**
 * run-domain-discovery.js — Discover bank domains via Azure OpenAI Responses API.
 *
 * Reads the banks CSV, filters to those not yet in bank-domains.json,
 * batches them, and uses the Azure OpenAI Responses API with built-in
 * web_search tool to find official websites and rate page URLs.
 * Merges results back into bank-domains.json.
 *
 * Uses the Responses API (not Chat Completions) because it has a
 * built-in web_search tool with Bing grounding — no separate Bing
 * Search resource needed.
 *
 * Prerequisites:
 *   - AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY env vars set
 *   - A GPT-4.1 (or later) deployment on Azure OpenAI
 *
 * Usage:
 *   node scripts/run-domain-discovery.js banks.csv
 *   node scripts/run-domain-discovery.js banks.csv --batch-size 10
 *   node scripts/run-domain-discovery.js banks.csv --category "Regional Rural Bank"
 *   node scripts/run-domain-discovery.js banks.csv --limit 50
 *   node scripts/run-domain-discovery.js banks.csv --dry-run
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");

const { slugify } = require("./utils/slugify");
const { loadBanksCSV } = require("./utils/parse-csv");
const { createResponsesClient, discoverDomains } = require("../lib/azure-openai-responses");

// ── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
let csvFile = "";
let batchSize = 10;
let categoryFilter = "";
let limit = Infinity;
let delayBetweenBatches = 5; // seconds
const dryRun = args.includes("--dry-run");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--batch-size" && args[i + 1]) batchSize = parseInt(args[++i], 10);
  else if (args[i] === "--category" && args[i + 1]) categoryFilter = args[++i];
  else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
  else if (args[i] === "--delay" && args[i + 1]) delayBetweenBatches = parseInt(args[++i], 10);
  else if (!args[i].startsWith("--") && !csvFile) csvFile = args[i];
}

if (!csvFile) {
  console.error("Usage: node scripts/run-domain-discovery.js <banks.csv> [options]");
  console.error("");
  console.error("Options:");
  console.error("  --batch-size <n>   Banks per API call (default: 10)");
  console.error("  --category <cat>   Filter by category");
  console.error("  --limit <n>        Max banks to process");
  console.error("  --delay <sec>      Seconds between batches (default: 5)");
  console.error("  --dry-run          Show batches without calling API");
  process.exit(1);
}

const PROJECT_ROOT = path.join(__dirname, "..");
const DOMAINS_FILE = path.join(PROJECT_ROOT, "data", "bank-domains.json");

// ── Load state ─────────────────────────────────────────────────────

let domains = {};
if (fs.existsSync(DOMAINS_FILE)) {
  domains = JSON.parse(fs.readFileSync(DOMAINS_FILE, "utf-8"));
}

// ── Parse CSV ──────────────────────────────────────────────────────

const banks = loadBanksCSV(csvFile, { categoryFilter });

// Filter to uncached banks
const uncached = banks.filter((b) => {
  const slug = slugify(b.name);
  const entry = domains[slug];
  return !entry || !entry.domain;
});

const toProcess = uncached.slice(0, limit);

console.log(`\n=== Domain Discovery via Azure OpenAI Responses API ${dryRun ? "(DRY RUN)" : ""} ===`);
console.log(`  Total banks in CSV: ${banks.length}`);
console.log(`  Already cached: ${banks.length - uncached.length}`);
console.log(`  Uncached: ${uncached.length}`);
console.log(`  To process: ${toProcess.length} (batch size: ${batchSize})`);
console.log("");

if (toProcess.length === 0) {
  console.log("All banks are already cached. Nothing to do.");
  process.exit(0);
}

// ── Batch and invoke ───────────────────────────────────────────────

const batches = [];
for (let i = 0; i < toProcess.length; i += batchSize) {
  batches.push(toProcess.slice(i, i + batchSize));
}

async function main() {
  const client = dryRun ? null : createResponsesClient();
  const model = process.env.AZURE_OPENAI_DEPLOYMENT_FULL || "gpt-4.1";

  let totalFound = 0;
  let totalFailed = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    console.log(`\n--- Batch ${i + 1}/${batches.length} (${batch.length} banks) ---`);
    for (const b of batch) console.log(`  ${slugify(b.name)}`);

    if (dryRun) continue;

    const startMs = Date.now();
    try {
      const discovered = await discoverDomains(client, batch, {
        model,
        logger: (msg) => console.log(`  WARN: ${msg}`),
      });

      // Check for parse errors
      if (discovered._error) {
        console.log(`  ✗ JSON parse error: ${discovered._error}`);
        console.log(`  Raw response (first 500 chars): ${(discovered._raw || "").slice(0, 500)}`);
        totalFailed += batch.length;
        continue;
      }

      // Merge results
      let batchFound = 0;
      for (const [slug, entry] of Object.entries(discovered)) {
        if (slug.startsWith("_")) continue; // skip internal keys

        if (entry.domain) {
          const existing = domains[slug] || {};
          // Merge rate_pages: existing non-null wins
          const mergedPages = { ...(existing.rate_pages || {}) };
          for (const [key, val] of Object.entries(entry.rate_pages || {})) {
            if (mergedPages[key] === undefined || (mergedPages[key] === null && val)) {
              mergedPages[key] = val;
            }
          }

          domains[slug] = {
            ...existing,
            domain: existing.domain || entry.domain,
            ...(!existing.domain ? { domain_source: "discovered" } : {}),
            ...(Object.keys(mergedPages).length > 0 ? { rate_pages: mergedPages } : {}),
            ...(entry.notes && !existing.notes ? { notes: entry.notes } : {}),
          };
          batchFound++;
          console.log(`  ✓ ${slug} → ${entry.domain}`);
        } else {
          console.log(`  ✗ ${slug} — ${entry.notes || "no website found"}`);
        }
      }

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      totalFound += batchFound;
      totalFailed += batch.length - batchFound;
      console.log(`  → ${batchFound}/${batch.length} found (${elapsed}s)`);

    } catch (err) {
      console.error(`  ✗ API error: ${err.message}`);
      totalFailed += batch.length;
    }

    // Save after each batch (in case of interruption)
    const sorted = {};
    for (const key of Object.keys(domains).sort()) sorted[key] = domains[key];
    // safe-write-exempt: TODO migrate per ADR-012 — registry write (kind: 'registry-file', source: 'agent'). Queued for follow-up.
    fs.writeFileSync(DOMAINS_FILE, JSON.stringify(sorted, null, 2) + "\n");

    // Delay between batches to avoid rate limiting
    if (i < batches.length - 1 && delayBetweenBatches > 0) {
      console.log(`  (waiting ${delayBetweenBatches}s before next batch...)`);
      await new Promise((r) => setTimeout(r, delayBetweenBatches * 1000));
    }
  }

  console.log(`\n=== Summary ${dryRun ? "(DRY RUN)" : ""} ===`);
  console.log(`  Found: ${totalFound}`);
  console.log(`  Not found: ${totalFailed}`);
  console.log(`  Total cached: ${Object.keys(domains).length}`);
  if (!dryRun) console.log(`  Updated: ${DOMAINS_FILE}`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

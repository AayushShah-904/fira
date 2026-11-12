#!/usr/bin/env node

/**
 * run-extract-only.js — Batch rate extraction without LLM discovery.
 *
 * Runs extract_rates.js for banks that already have _config.json files.
 * This is the "recurring scraper" entry point — re-extract rates from
 * known bank configs with zero LLM cost.
 *
 * Usage:
 *   node scripts/run-extract-only.js                         # all banks with configs
 *   node scripts/run-extract-only.js --scraper-type pdf       # only PDF banks
 *   node scripts/run-extract-only.js --scraper-type html_static --limit 10
 *   node scripts/run-extract-only.js --bank-code citibank-na  # specific bank
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── Argument parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let bankCode = "";
let scraperTypeFilter = "";
let limitCount = 0;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--scraper-type" && args[i + 1]) scraperTypeFilter = args[++i];
  else if (args[i] === "--limit" && args[i + 1]) limitCount = parseInt(args[++i], 10);
  else if (args[i] === "--bank-code" && args[i + 1]) bankCode = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: node scripts/run-extract-only.js [options]");
    console.log("  --scraper-type <type>  Filter by scraper type (html_static, html_js, pdf)");
    console.log("  --limit <n>            Process at most n banks");
    console.log("  --bank-code <code>     Extract a specific bank");
    process.exit(0);
  }
}

const outputDir = path.join(__dirname, "..", "output");
const extractScript = path.join(__dirname, "extract_rates.js");

// ── Build extraction arguments ──────────────────────────────────────

const extractArgs = [extractScript];

if (bankCode) {
  extractArgs.push(bankCode);
} else {
  extractArgs.push("--all");
  if (scraperTypeFilter) extractArgs.push("--scraper-type", scraperTypeFilter);
  if (limitCount > 0) extractArgs.push("--limit", String(limitCount));
}

// ── Header ──────────────────────────────────────────────────────────

console.log("============================================");
console.log(" Extract-Only Batch (no LLM, 0 tokens)");
console.log("============================================");
if (bankCode) {
  console.log(` Bank: ${bankCode}`);
} else {
  const configCount = fs.readdirSync(outputDir)
    .filter((f) => f.endsWith("_config.json") && !f.startsWith("_"))
    .length;
  console.log(` Configs available: ${configCount}`);
  if (scraperTypeFilter) console.log(` Filter: ${scraperTypeFilter}`);
  if (limitCount > 0) console.log(` Limit: ${limitCount}`);
}
console.log("============================================");
console.log();

// ── Run extraction ──────────────────────────────────────────────────

const startTime = Date.now();

const result = spawnSync(process.execPath, extractArgs, {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  timeout: 600_000, // 10 min for full batch
});

const elapsedSec = Math.round((Date.now() - startTime) / 1000);
const min = Math.floor(elapsedSec / 60);
const sec = elapsedSec % 60;

console.log();
console.log(`Total time: ${min > 0 ? min + "m" : ""}${sec}s`);
console.log("LLM tokens used: 0");

process.exit(result.status || 0);

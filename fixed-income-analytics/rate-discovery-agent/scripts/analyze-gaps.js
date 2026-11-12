#!/usr/bin/env node

/**
 * analyze-gaps.js — Coverage dashboard and gap list generator.
 *
 * Dashboard mode (default): Shows a table of coverage per bank category.
 * List mode (--list <type>): Outputs bank slugs for a specific gap type
 *   to output/gaps/<type>.txt for feeding into run-batch.js --banks.
 *
 * Usage:
 *   node scripts/analyze-gaps.js                                # dashboard
 *   node scripts/analyze-gaps.js --list missing-fd              # banks with domain but no FD URL
 *   node scripts/analyze-gaps.js --list missing-domain          # banks with no domain
 *   node scripts/analyze-gaps.js --list missing-nri             # NRI-eligible banks without NRE/NRO
 *   node scripts/analyze-gaps.js --list missing-gift            # IBU banks without GIFT rates
 *   node scripts/analyze-gaps.js --list manual                  # banks marked scraper_type manual
 *   node scripts/analyze-gaps.js --list problems                # WAF/CAPTCHA/cert/blocked banks
 *   node scripts/analyze-gaps.js --list no-config               # banks with domain but no output config
 *   node scripts/analyze-gaps.js --list stale --max-age 7       # banks with rates older than N days
 *   node scripts/analyze-gaps.js --list skipped                 # banks with a skip status tag
 *   node scripts/analyze-gaps.js --category "Foreign Bank"      # filter to one category
 *   node scripts/analyze-gaps.js --exclude-nsucb-dccb           # exclude NSUCB and DCCB (default)
 *   node scripts/analyze-gaps.js --all                          # include all categories
 *   node scripts/analyze-gaps.js --json                         # machine-readable output
 */

const fs = require("fs");
const path = require("path");

const { loadBanksCSV } = require("./utils/parse-csv");
const { slugify } = require("./utils/slugify");

// ── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
let listMode = "";
let categoryFilter = "";
let maxAge = 7;
let includeAll = false;
let jsonOutput = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--list" && args[i + 1]) listMode = args[++i];
  else if (args[i] === "--category" && args[i + 1]) categoryFilter = args[++i];
  else if (args[i] === "--max-age" && args[i + 1]) maxAge = parseInt(args[++i], 10);
  else if (args[i] === "--all") includeAll = true;
  else if (args[i] === "--json") jsonOutput = true;
}

// ── Paths ──────────────────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, "..");
const CSV_FILE = path.join(PROJECT_ROOT, "..", "docs", "Indian_Banks_Comprehensive_List_RBI.csv");
const DOMAINS_FILE = path.join(PROJECT_ROOT, "data", "bank-domains.json");
const LATEST_DIR = path.join(PROJECT_ROOT, "output", "latest");
const GAPS_DIR = path.join(PROJECT_ROOT, "output", "gaps");

// ── Load data ──────────────────────────────────────────────────────

const domains = fs.existsSync(DOMAINS_FILE)
  ? JSON.parse(fs.readFileSync(DOMAINS_FILE, "utf-8"))
  : {};

let banks = loadBanksCSV(CSV_FILE);

// Default: exclude NSUCB and DCCB unless --all
const SKIP_CATS = ["Non-Scheduled Urban Co-operative Bank", "District Central Co-operative Bank"];
if (!includeAll && !categoryFilter) {
  banks = banks.filter((b) => !SKIP_CATS.includes(b.category));
}
if (categoryFilter) {
  banks = banks.filter((b) => b.category.toLowerCase().includes(categoryFilter.toLowerCase()));
}

// Scan output/latest for existing files
const existingFiles = new Set();
if (fs.existsSync(LATEST_DIR)) {
  for (const f of fs.readdirSync(LATEST_DIR)) existingFiles.add(f);
}

// ── NRI eligibility ────────────────────────────────────────────────

const NRI_ELIGIBLE = new Set([
  "Public Sector Bank",
  "Private Sector Bank (Indian)",
  "Foreign Bank",
  "Small Finance Bank",
]);

const SKIP_STATUSES = new Set([
  "no_retail_deposits",
  "no_website",
  "website_not_found",
  "wholesale_only",
  "rates_in_images",
  "rates_not_published",
  "site_unreachable",
]);

const PROBLEM_PATTERNS = /waf|captcha|blocked|403|certificate|ssl|tls|timeout|unreachable|imperva|cloudflare|akamai|recaptcha/i;

// ── Analyze each bank ──────────────────────────────────────────────

function analyzeBank(bank) {
  const slug = slugify(bank.name);
  const entry = domains[slug] || {};
  const rp = entry.rate_pages || {};
  const notes = entry.notes || "";
  const status = entry.status || null;
  const isIBU = bank.category.includes("IFSC");
  const isNriEligible = NRI_ELIGIBLE.has(bank.category);

  // Output files
  const hasConfig = existingFiles.has(`${slug}_config.json`);
  const hasRates = existingFiles.has(`${slug}_rates.json`);
  const hasNre = existingFiles.has(`${slug}_nre_rates.json`);
  const hasNro = existingFiles.has(`${slug}_nro_rates.json`);
  const hasFcnr = existingFiles.has(`${slug}_fcnr_rates.json`);
  const hasGift = existingFiles.has(`${slug}_gift_rates.json`);

  // Staleness check
  let ratesAge = null;
  if (hasRates) {
    try {
      const ratesFile = path.join(LATEST_DIR, `${slug}_rates.json`);
      const rates = JSON.parse(fs.readFileSync(ratesFile, "utf-8"));
      if (rates.scraped_at) {
        ratesAge = Math.floor((Date.now() - new Date(rates.scraped_at).getTime()) / 86400000);
      }
    } catch {}
  }

  // Slab count
  let slabCount = 0;
  if (hasRates) {
    try {
      const ratesFile = path.join(LATEST_DIR, `${slug}_rates.json`);
      const rates = JSON.parse(fs.readFileSync(ratesFile, "utf-8"));
      slabCount = (rates.rate_slabs || []).length;
    } catch {}
  }

  return {
    slug,
    name: bank.name,
    category: bank.category,
    hasDomain: !!entry.domain,
    domain: entry.domain || null,
    hasFdUrl: !!rp.fd,
    hasConfig,
    hasRates,
    hasNre,
    hasNro,
    hasFcnr,
    hasGift,
    slabCount,
    ratesAge,
    scraperType: entry.scraper_type || null,
    isManual: entry.scraper_type === "manual",
    isProblem: PROBLEM_PATTERNS.test(notes),
    isSkipped: SKIP_STATUSES.has(status),
    status,
    isIBU,
    isNriEligible,
    notes,
  };
}

const analyzed = banks.map(analyzeBank);

// ── List mode ──────────────────────────────────────────────────────

const LIST_FILTERS = {
  "missing-domain": (b) => !b.hasDomain && !b.isSkipped,
  "missing-fd": (b) => b.hasDomain && !b.hasFdUrl && !b.isSkipped,
  "missing-nri": (b) => b.isNriEligible && b.hasFdUrl && !b.hasNre && !b.hasNro && !b.isSkipped,
  "missing-gift": (b) => b.isIBU && !b.hasGift && !b.hasRates && !b.isSkipped,
  "manual": (b) => b.isManual,
  "problems": (b) => b.isProblem && !b.isSkipped,
  "no-config": (b) => b.hasDomain && !b.hasConfig && !b.isSkipped,
  "stale": (b) => b.hasRates && b.ratesAge !== null && b.ratesAge > maxAge && !b.isSkipped,
  "skipped": (b) => b.isSkipped,
};

if (listMode) {
  const filter = LIST_FILTERS[listMode];
  if (!filter) {
    console.error(`Unknown list type: ${listMode}`);
    console.error("Available types:", Object.keys(LIST_FILTERS).join(", "));
    process.exit(1);
  }

  const matches = analyzed.filter(filter);

  // Write to file
  fs.mkdirSync(GAPS_DIR, { recursive: true });
  const outFile = path.join(GAPS_DIR, `${listMode}.txt`);
  const slugs = matches.map((b) => b.slug);
  // safe-write-exempt: gap-analysis output (operational report, not a per-bank artifact).
  fs.writeFileSync(outFile, slugs.join("\n") + "\n");

  if (jsonOutput) {
    console.log(JSON.stringify(matches.map((b) => ({ slug: b.slug, name: b.name, category: b.category, domain: b.domain, notes: b.notes })), null, 2));
  } else {
    console.log(`\n=== ${listMode} (${matches.length} banks) ===\n`);
    // Group by category
    const byCat = {};
    for (const b of matches) {
      if (!byCat[b.category]) byCat[b.category] = [];
      byCat[b.category].push(b);
    }
    for (const [cat, catBanks] of Object.entries(byCat).sort()) {
      console.log(`${cat} (${catBanks.length}):`);
      for (const b of catBanks) {
        const extra = [];
        if (b.domain) extra.push(b.domain);
        if (b.scraperType) extra.push(`type:${b.scraperType}`);
        if (b.status) extra.push(`status:${b.status}`);
        if (b.ratesAge !== null) extra.push(`${b.ratesAge}d old`);
        if (b.notes) extra.push(b.notes.substring(0, 60));
        console.log(`  ${b.slug}${extra.length ? " — " + extra.join(" | ") : ""}`);
      }
    }
    console.log(`\nWrote ${slugs.length} slugs to ${outFile}`);
  }
  process.exit(0);
}

// ── Dashboard mode ─────────────────────────────────────────────────

// Short category labels
const CAT_LABELS = {
  "Public Sector Bank": "PSB",
  "Private Sector Bank (Indian)": "PVB",
  "Small Finance Bank": "SFB",
  "Payments Bank": "PB",
  "Foreign Bank": "FB",
  "Regional Rural Bank": "RRB",
  "Scheduled Urban Co-operative Bank": "SUCB",
  "Non-Scheduled Urban Co-operative Bank": "NSUCB",
  "Scheduled State Co-operative Bank": "SSCB",
  "Non-Scheduled State Co-operative Bank": "NSSCB",
  "District Central Co-operative Bank": "DCCB",
  "Local Area Bank": "LAB",
  "Financial Institution": "FI",
  "IFSC Banking Unit (IFSCA)": "IBU",
  "Housing Finance Company": "HFC",
};

// Group by category
const catGroups = {};
for (const b of analyzed) {
  if (!catGroups[b.category]) catGroups[b.category] = [];
  catGroups[b.category].push(b);
}

// Category display order
const CAT_ORDER = [
  "Public Sector Bank", "Private Sector Bank (Indian)", "Small Finance Bank",
  "Payments Bank", "Foreign Bank", "IFSC Banking Unit (IFSCA)",
  "Regional Rural Bank", "Scheduled Urban Co-operative Bank",
  "Scheduled State Co-operative Bank", "Non-Scheduled State Co-operative Bank",
  "Local Area Bank", "Financial Institution",
  "Non-Scheduled Urban Co-operative Bank", "District Central Co-operative Bank",
];

const sortedCats = Object.keys(catGroups).sort((a, b) => {
  const ia = CAT_ORDER.indexOf(a);
  const ib = CAT_ORDER.indexOf(b);
  return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
});

if (jsonOutput) {
  const result = {};
  for (const cat of sortedCats) {
    const bs = catGroups[cat];
    result[cat] = {
      total: bs.length,
      domain: bs.filter((b) => b.hasDomain).length,
      fd_url: bs.filter((b) => b.hasFdUrl).length,
      config: bs.filter((b) => b.hasConfig).length,
      rates: bs.filter((b) => b.hasRates).length,
      nre: bs.filter((b) => b.hasNre).length,
      nro: bs.filter((b) => b.hasNro).length,
      fcnr: bs.filter((b) => b.hasFcnr).length,
      gift: bs.filter((b) => b.hasGift).length,
      manual: bs.filter((b) => b.isManual).length,
      problem: bs.filter((b) => b.isProblem).length,
      skipped: bs.filter((b) => b.isSkipped).length,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// Print dashboard table
const pad = (s, n) => String(s).padStart(n);
const hdr = [
  "Category".padEnd(8),
  pad("Total", 5), pad("Domain", 6), pad("FD URL", 6),
  pad("Config", 6), pad("Rates", 5),
  pad("NRE", 4), pad("NRO", 4), pad("FCNR", 4), pad("GIFT", 4),
  pad("Skip", 4), pad("Manual", 6), pad("Prob", 4),
].join(" | ");

console.log(`\n=== Bank Coverage Dashboard ===\n`);
console.log(hdr);
console.log("-".repeat(hdr.length));

let totals = { total: 0, domain: 0, fd: 0, config: 0, rates: 0, nre: 0, nro: 0, fcnr: 0, gift: 0, skip: 0, manual: 0, prob: 0 };

for (const cat of sortedCats) {
  const bs = catGroups[cat];
  const label = (CAT_LABELS[cat] || cat.substring(0, 8)).padEnd(8);
  const d = bs.filter((b) => b.hasDomain).length;
  const fd = bs.filter((b) => b.hasFdUrl).length;
  const cfg = bs.filter((b) => b.hasConfig).length;
  const rt = bs.filter((b) => b.hasRates).length;
  const nre = bs.filter((b) => b.hasNre).length;
  const nro = bs.filter((b) => b.hasNro).length;
  const fcnr = bs.filter((b) => b.hasFcnr).length;
  const gift = bs.filter((b) => b.hasGift).length;
  const skip = bs.filter((b) => b.isSkipped).length;
  const man = bs.filter((b) => b.isManual).length;
  const prob = bs.filter((b) => b.isProblem).length;

  const isNri = NRI_ELIGIBLE.has(cat);
  const isIBU = cat.includes("IFSC");

  console.log([
    label,
    pad(bs.length, 5), pad(d, 6), pad(fd, 6),
    pad(cfg, 6), pad(rt, 5),
    pad(isNri ? nre : "-", 4), pad(isNri ? nro : "-", 4), pad(isNri ? fcnr : "-", 4),
    pad(isIBU ? gift : "-", 4),
    pad(skip, 4), pad(man, 6), pad(prob, 4),
  ].join(" | "));

  totals.total += bs.length;
  totals.domain += d;
  totals.fd += fd;
  totals.config += cfg;
  totals.rates += rt;
  totals.nre += nre;
  totals.nro += nro;
  totals.fcnr += fcnr;
  totals.gift += gift;
  totals.skip += skip;
  totals.manual += man;
  totals.prob += prob;
}

console.log("-".repeat(hdr.length));
console.log([
  "TOTAL".padEnd(8),
  pad(totals.total, 5), pad(totals.domain, 6), pad(totals.fd, 6),
  pad(totals.config, 6), pad(totals.rates, 5),
  pad(totals.nre, 4), pad(totals.nro, 4), pad(totals.fcnr, 4), pad(totals.gift, 4),
  pad(totals.skip, 4), pad(totals.manual, 6), pad(totals.prob, 4),
].join(" | "));

// Summary of gap types
console.log(`\n=== Gap Summary ===`);
for (const [type, filter] of Object.entries(LIST_FILTERS)) {
  const count = analyzed.filter(filter).length;
  if (count > 0) console.log(`  ${type}: ${count} banks`);
}
console.log(`\nUse --list <type> to get bank slugs for each gap.`);
console.log(`Use --all to include NSUCB/DCCB categories.\n`);

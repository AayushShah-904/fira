#!/usr/bin/env node

/**
 * extract_rates.js — Deterministic rate extraction router.
 *
 * Reads a bank's _config.json, routes to the appropriate extractor
 * (HTML fetch, Playwright, or PDF), and writes _rates.json.
 * No LLM involved — pure code execution.
 *
 * Usage:
 *   node scripts/extract_rates.js <bank_code>
 *   node scripts/extract_rates.js --all
 *   node scripts/extract_rates.js --scraper-type pdf
 *   node scripts/extract_rates.js --scraper-type html_static --limit 5
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const { parseTenure } = require("./utils/parse-tenure");
const { validateSlabs } = require("./utils/validate-rates");
const { slugify } = require("./utils/slugify");
const { mergeWithDefaults } = require("./utils/config-defaults");

// ── Argument parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let bankCode = "";
let extractAll = false;
let scraperTypeFilter = "";
let limitCount = 0;

let configDir = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--all") extractAll = true;
  else if (args[i] === "--scraper-type" && args[i + 1]) scraperTypeFilter = args[++i];
  else if (args[i] === "--limit" && args[i + 1]) limitCount = parseInt(args[++i], 10);
  else if (args[i] === "--config-dir" && args[i + 1]) configDir = args[++i];
  else if (!args[i].startsWith("--") && !bankCode) bankCode = args[i];
}

// Only enforce arg presence when invoked as a CLI; require() callers (Phase 3
// refresh) import helpers and don't need the CLI args.
if (require.main === module && !bankCode && !extractAll && !scraperTypeFilter) {
  console.error("Usage: node scripts/extract_rates.js <bank_code>");
  console.error("       node scripts/extract_rates.js --all");
  console.error("       node scripts/extract_rates.js --scraper-type pdf");
  console.error("       node scripts/extract_rates.js --config-dir output/latest/ <bank_code>");
  process.exit(1);
}

const outputDir = configDir
  ? path.resolve(configDir)
  : path.join(__dirname, "..", "output");
const scriptsDir = __dirname;

// ── HTTP fetch helper ───────────────────────────────────────────────

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const getter = url.startsWith("https") ? https : http;
    getter.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirect = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(redirect, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── HTML table parser ───────────────────────────────────────────────

/**
 * Extract rate data from raw HTML using simple regex parsing.
 * Handles standard <table> elements with <tr>/<td> cells.
 */
function parseHtmlTables(html) {
  const tables = [];
  // Match each <table>...</table>
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rows = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const cells = [];
      const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        // Strip HTML tags and normalize whitespace
        const text = cellMatch[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#?\w+;/g, "")
          .replace(/\s+/g, " ")
          .trim();
        cells.push(text);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 1) tables.push(rows); // skip empty/header-only tables
  }
  return tables;
}

/**
 * Given a table (array of rows) and column_mapping from config,
 * extract rate slabs.
 *
 * Sprint 4 B2 (sprint-004): when the default index-based column_mapping
 * produces impossible slabs (rate > 30 — FDs max ~15% — OR tenure_text
 * is a pure serial number), re-detect column positions by content shape
 * and retry. PNB and other "S.No, Tenure, Rate" layouts shift the
 * tenure/rate columns one position right; the default {0:tenure,1:rate}
 * picks up the row number and a concatenated cell instead. Generic —
 * helps every bank whose table layout has a leading serial-number column.
 */
function extractSlabsFromTable(rows, columnMapping) {
  const firstAttempt = extractSlabsWithMapping(rows, columnMapping);
  if (looksLikeBadMapping(firstAttempt)) {
    const detected = detectColumns(rows);
    if (detected) {
      const second = extractSlabsWithMapping(rows, detected);
      // Only swap in if the heuristic mapping produces ≥1 plausible slab.
      if (second.length > 0 && !looksLikeBadMapping(second)) {
        return second;
      }
    }
  }
  return firstAttempt;
}

function parseFieldSpec(fieldSpec) {
  let rest = fieldSpec;
  let currency = null;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const cur = rest.slice(hash + 1).trim();
    currency = cur ? cur.toUpperCase() : null;
    rest = rest.slice(0, hash);
  }
  let field = rest;
  let depositRange = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    field = rest.slice(0, at);
    depositRange = rest.slice(at + 1) || null;
  }
  return { field, depositRange, currency };
}

function extractSlabsWithMapping(rows, columnMapping) {
  const slabs = [];
  if (!columnMapping || Object.keys(columnMapping).length === 0) return slabs;

  // Skip header row(s) — rows where no cell looks like a rate
  const ratePattern = /\d+\.\d+/;
  const dataRows = rows.filter((row) =>
    row.some((cell) => ratePattern.test(cell)),
  );

  const RATE_FIELDS = new Set(['rate_general_pct', 'rate_senior_pct', 'rate_super_senior_pct']);

  for (const row of dataRows) {
    let tenureText = null;
    let tenureMinDays = null;
    let tenureMaxDays = null;

    // Per-currency, per-deposit-range bucket. Map<currency, Map<deposit_range, rates>>
    const byCurrency = new Map();
    const ensure = (cur, r) => {
      if (!byCurrency.has(cur)) byCurrency.set(cur, new Map());
      const inner = byCurrency.get(cur);
      if (!inner.has(r)) inner.set(r, {});
      return inner.get(r);
    };

    for (const [colIdx, fieldSpec] of Object.entries(columnMapping)) {
      const idx = parseInt(colIdx, 10);
      const cellText = (row[idx] || "").trim();
      if (!cellText) continue;

      const { field, depositRange: fieldRange, currency } = parseFieldSpec(fieldSpec);

      if (field === "tenure_text") {
        tenureText = cellText;
        const parsed = parseTenure(cellText);
        tenureMinDays = parsed ? parsed.minDays : null;
        tenureMaxDays = parsed ? parsed.maxDays : null;
      } else if (RATE_FIELDS.has(field)) {
        // Extract numeric rate: "6.50%" → 6.50, "6.50" → 6.50
        const num = parseFloat(cellText.replace(/[^0-9.]/g, ""));
        if (!isNaN(num)) {
          const range = fieldRange || "below_3cr";
          ensure(currency, range)[field] = num;
        }
      } else if (field.includes("deposit")) {
        // Ignored or parsed
      }
    }

    if (tenureText) {
      const sourceRowText = row.join(" ").replace(/\s+/g, " ").trim();
      for (const [currency, byRange] of byCurrency.entries()) {
        for (const [range, rates] of byRange.entries()) {
          if (rates.rate_general_pct == null) continue;
          const slab = {
            tenure_text: tenureText,
            tenure_min_days: tenureMinDays,
            tenure_max_days: tenureMaxDays,
            rate_general_pct: rates.rate_general_pct,
            rate_senior_pct: rates.rate_senior_pct ?? null,
            rate_super_senior_pct: rates.rate_super_senior_pct ?? null,
            deposit_range: range,
            min_deposit: null,
            compounding_freq: "QUARTERLY",
            source_row_text: sourceRowText
          };
          if (currency) {
            slab.currency = currency;
          }
          slabs.push(slab);
        }
      }
    }
  }
  return slabs;
}

/**
 * Heuristic: did the column mapping line up with the actual table?
 * Returns true if every slab is bad (no salvageable mapping).
 *
 *   - tenure_text is a pure integer (1, 2, 3, ...) → row index leaked in
 *   - rate_general_pct > 30 (max Indian FD ~15%; everything past 30
 *     is a concatenation of two columns or the row index pasted onto a rate)
 */
function looksLikeBadMapping(slabs) {
  if (slabs.length === 0) return false;
  return slabs.every((s) => {
    const tenureIsSerial = typeof s.tenure_text === "string" && /^\s*\d+\s*$/.test(s.tenure_text);
    // Cohort #3 Phase E (2026-05-23): threshold tightened from `>30` to
    // `>15` (the loose sanity max from lib/rate-bounds.js for INR variants).
    // Anomaly triage showed real digit-concatenation garbage included
    // borderline values like 18.5, 24, 37 that the old >30 cutoff let
    // through, so detectColumns never fired and column-misalignment was
    // silently shipped. The new ceiling is below the highest legitimate
    // Indian FD rate (~9.5% display, 12-15% historic outliers) but above
    // every value any rate-bearing cell should plausibly hold.
    const rateImpossible = typeof s.rate_general_pct === "number" && s.rate_general_pct > 15;
    return tenureIsSerial || rateImpossible;
  });
}

/**
 * Scan the data rows to detect which cell index holds tenure-shaped text
 * and which holds rate-shaped numbers (0–15). Returns a column_mapping in
 * the same shape as the config — or null if nothing tenure-shaped exists.
 */
function detectColumns(rows) {
  const ratePattern = /\d+\.\d+/;
  const dataRows = rows.filter((row) => row.some((cell) => ratePattern.test(cell)));
  if (dataRows.length === 0) return null;

  // Score each column index: how often does its cell parse as a tenure /
  // as a plausible rate?
  const colCount = Math.max(...dataRows.map((r) => r.length));
  const tenureHits = new Array(colCount).fill(0);
  const rateHits = new Array(colCount).fill(0);
  for (const row of dataRows) {
    for (let i = 0; i < colCount; i++) {
      const cell = (row[i] || "").trim();
      if (!cell) continue;
      if (parseTenure(cell)) tenureHits[i]++;
      const num = parseFloat(cell.replace(/[^0-9.]/g, ""));
      if (!isNaN(num) && num > 0 && num <= 15 && /\d+\.\d+/.test(cell)) {
        rateHits[i]++;
      }
    }
  }

  const tenureIdx = argMax(tenureHits);
  if (tenureIdx == null || tenureHits[tenureIdx] === 0) return null;

  // Rate column: highest rate-hits, NOT equal to tenure column.
  const rateScoresExcl = rateHits.map((v, i) => (i === tenureIdx ? -1 : v));
  const rateIdx = argMax(rateScoresExcl);
  if (rateIdx == null || rateScoresExcl[rateIdx] <= 0) return null;

  const mapping = { [String(tenureIdx)]: "tenure_text", [String(rateIdx)]: "rate_general_pct" };
  // Optionally map a third column as senior rate if it ALSO scores as rate-shaped.
  const seniorScores = rateHits.map((v, i) => (i === tenureIdx || i === rateIdx ? -1 : v));
  const seniorIdx = argMax(seniorScores);
  if (seniorIdx != null && seniorScores[seniorIdx] > 0) {
    mapping[String(seniorIdx)] = "rate_senior_pct";
  }
  return mapping;
}

function argMax(arr) {
  let best = -Infinity;
  let bestIdx = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > best) { best = arr[i]; bestIdx = i; }
  }
  return bestIdx;
}

// ── Effective date extraction from HTML ─────────────────────────────

const { extractEffectiveDateFromHtml } = require("../lib/extract-date");

// ── Extractor: html_static ──────────────────────────────────────────

async function extractHtmlStatic(config) {
  const fdUrl = config.rate_page_urls?.fd;
  if (!fdUrl) return { slabs: [], warnings: ["No FD rate page URL in config"] };

  console.log(`  Fetching: ${fdUrl}`);
  let html;
  try {
    html = await fetchUrl(fdUrl);
  } catch (err) {
    return { slabs: [], warnings: [`Fetch failed: ${err.message}`] };
  }
  console.log(`  Fetched: ${html.length} bytes`);

  const effectiveDate = extractEffectiveDateFromHtml(html);
  if (effectiveDate) console.log(`  Effective date: ${effectiveDate}`);

  const tables = parseHtmlTables(html);
  console.log(`  Found ${tables.length} HTML table(s)`);

  if (tables.length === 0) {
    return { slabs: [], effectiveDate, warnings: ["No HTML tables found on page"] };
  }

  // Use column_mapping from config, or try auto-detection
  const columnMapping = config.column_mapping && Object.keys(config.column_mapping).length > 0
    ? config.column_mapping
    : { "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct" };

  // Try each table — pick the one with the most valid rate slabs
  let bestSlabs = [];
  for (const table of tables) {
    const slabs = extractSlabsFromTable(table, columnMapping);
    if (slabs.length > bestSlabs.length) bestSlabs = slabs;
  }

  console.log(`  Extracted ${bestSlabs.length} rate slabs`);
  // Sprint 4 A15: surface the raw HTML so the action layer can run a
  // text-pattern fallback when this path returns 0 slabs (SPA / unusual
  // table layouts where cell extraction fails). Existing CLI callers
  // simply ignore the extra field.
  return { slabs: bestSlabs, effectiveDate, warnings: [], pageHtml: html };
}

// ── Extractor: html_js (via Playwright) ─────────────────────────────

function extractHtmlJs(config) {
  const fdUrl = config.rate_page_urls?.fd;
  if (!fdUrl) return { slabs: [], warnings: ["No FD rate page URL in config"] };

  console.log(`  Playwright: ${fdUrl}`);
  const playwrightScript = path.join(scriptsDir, "fetch_rates_playwright.js");

  // Sprint 4 Track A (2026-05-20): always pass --tabs/--selects/--scroll
  // for html_js. notes.has_* flags are LLM-populated metadata and were
  // unreliable on AU SFB (which has amount-tier tabs but notes.has_tabs
  // wasn't set). Flags no-op on pages that don't have the matching
  // elements, so the worst case is one extra pass.
  const playwrightArgs = [playwrightScript, fdUrl, "--tabs", "--selects", "--scroll"];

  const result = spawnSync(
    process.execPath,
    playwrightArgs,
    { cwd: path.join(scriptsDir, ".."), timeout: 120_000, encoding: "utf-8" },
  );

  if (result.status !== 0) {
    const err = (result.stderr || "").slice(0, 200);
    return { slabs: [], warnings: [`Playwright failed (exit ${result.status}): ${err}`] };
  }

  // Parse JSON output after === JSON_OUTPUT === marker
  const output = result.stdout || "";
  const jsonMarker = output.indexOf("=== JSON_OUTPUT ===");
  if (jsonMarker === -1) {
    return { slabs: [], warnings: ["Playwright output missing JSON_OUTPUT marker"] };
  }

  try {
    const json = JSON.parse(output.slice(jsonMarker + 19).trim());
    const slabs = (json.rate_slabs || []).map((s) => {
      const parsed = parseTenure(s.tenure_text || "");
      return {
        tenure_text: s.tenure_text,
        tenure_min_days: parsed ? parsed.minDays : null,
        tenure_max_days: parsed ? parsed.maxDays : null,
        rate_general_pct: parseFloat((s.rate_general_pct || "0").replace("%", "")),
        rate_senior_pct: s.rate_senior_pct ? parseFloat(s.rate_senior_pct.replace("%", "")) : null,
        rate_super_senior_pct: null,
        min_deposit: null,
        compounding_freq: "QUARTERLY",
      };
    });
    const effectiveDate = (json.effective_dates || [])[0] || null;
    console.log(`  Extracted ${slabs.length} rate slabs`);
    return { slabs, effectiveDate, warnings: [], pageHtml: json.page_html || null };
  } catch (err) {
    return { slabs: [], warnings: [`Failed to parse Playwright JSON: ${err.message}`] };
  }
}

// ── Extractor: pdf ──────────────────────────────────────────────────

function extractPdf(config, variant) {
  // Find PDF URL from config
  let pdfUrl = config.rate_page_urls?.fd;
  // Check scraper_notes for explicit PDF URL
  if (config.scraper_notes?.pdf_url) pdfUrl = config.scraper_notes.pdf_url;
  // Some configs store PDF URLs in additional_urls
  if (!pdfUrl && config.scraper_notes?.additional_urls) {
    const urls = Array.isArray(config.scraper_notes.additional_urls)
      ? config.scraper_notes.additional_urls
      : [config.scraper_notes.additional_urls];
    pdfUrl = urls.find((u) => u && u.toLowerCase().endsWith(".pdf"));
  }
  if (!pdfUrl) return { slabs: [], warnings: ["No PDF URL found in config"] };

  console.log(`  PDF: ${pdfUrl}`);
  const pdfScript = path.join(scriptsDir, "extract_rates_pdf.mjs");
  const pdfArgs = [pdfScript, pdfUrl, "--bank-code", config.bank_code || ""];
  if (variant && variant !== "regular") {
    pdfArgs.push("--variant", variant);
  }
  const result = spawnSync(
    process.execPath,
    pdfArgs,
    { cwd: path.join(scriptsDir, ".."), timeout: 30_000, encoding: "utf-8" },
  );

  if (result.status !== 0) {
    const err = (result.stderr || "").slice(-300);
    return { slabs: [], warnings: [`PDF extraction failed (exit ${result.status}): ${err}`] };
  }

  const output = result.stdout || "";
  const jsonMarker = output.indexOf("=== JSON_OUTPUT ===");
  if (jsonMarker === -1) {
    return { slabs: [], warnings: ["PDF extractor output missing JSON_OUTPUT marker"] };
  }

  try {
    const json = JSON.parse(output.slice(jsonMarker + 19).trim());
    const slabs = json.rate_slabs || [];
    const effectiveDate = json.effective_date || null;
    console.log(`  Extracted ${slabs.length} rate slabs`);
    return { slabs, effectiveDate, warnings: json.warnings || [] };
  } catch (err) {
    return { slabs: [], warnings: [`Failed to parse PDF JSON: ${err.message}`] };
  }
}

// ── Scraper router (shared by domestic + variant extraction) ────────

/**
 * Route extraction to the appropriate scraper based on scraper_type.
 * @param {object} config - Bank config (with scraper_type)
 * @param {string} url - The URL to extract from
 * @param {string} [variant] - Optional variant hint passed to PDF extractor
 * @returns {{ slabs: Array, effectiveDate: string|null, warnings: string[] }}
 */
async function routeExtraction(config, url, variant) {
  const scraperType = config.scraper_type || "manual";

  // Determine if URL is a PDF
  const isPdfUrl = url && url.toLowerCase().endsWith(".pdf");

  if (isPdfUrl || scraperType === "pdf") {
    // Override config temporarily to use this specific URL
    const pdfConfig = { ...config, rate_page_urls: { ...config.rate_page_urls, fd: url } };
    if (!pdfConfig.scraper_notes) pdfConfig.scraper_notes = {};
    pdfConfig.scraper_notes.pdf_url = url;
    if (variant) pdfConfig.scraper_notes._variant = variant;
    return extractPdf(pdfConfig, variant);
  }

  switch (scraperType) {
    case "html_static": {
      const tmpConfig = { ...config, rate_page_urls: { ...config.rate_page_urls, fd: url } };
      return extractHtmlStatic(tmpConfig);
    }
    case "html_js": {
      const tmpConfig = { ...config, rate_page_urls: { ...config.rate_page_urls, fd: url } };
      return extractHtmlJs(tmpConfig);
    }
    case "mixed": {
      const tmpConfig = { ...config, rate_page_urls: { ...config.rate_page_urls, fd: url } };
      let result = await extractHtmlStatic(tmpConfig);
      if (result.slabs.length === 0) {
        console.log("    HTML yielded 0 slabs, trying PDF...");
        result = extractPdf(tmpConfig, variant);
      }
      return result;
    }
    default:
      return { slabs: [], effectiveDate: null, warnings: [`Cannot extract ${variant || "rates"}: scraper_type "${scraperType}" not supported`] };
  }
}

// ── Write a rates JSON file ─────────────────────────────────────────

function writeRatesFile(code, config, result, variant, sourceUrl) {
  const validation = validateSlabs(result.slabs, variant);
  const allWarnings = [...(result.warnings || []), ...validation.warnings];

  for (const slab of result.slabs) {
    if (!slab.deposit_range) slab.deposit_range = "below_3cr";
  }

  const ratesData = {
    bank_code: config.bank_code || code,
    product_type: "FD",
    variant,
    effective_date: result.effectiveDate || null,
    source_url: sourceUrl || config.website || null,
    scraped_at: new Date().toISOString(),
    extraction_confidence: result.slabs.length > 0 ? "high" : "none",
    rate_slabs: result.slabs,
    special_schemes: [],
    warnings: allWarnings,
    errors: validation.errors || [],
  };

  const suffix = variant === "regular" ? "" : `_${variant}`;
  const ratesFile = path.join(outputDir, `${code}${suffix}_rates.json`);
  // safe-write-exempt: TODO migrate per ADR-012 — this is the deterministic extract_rates.js dispatcher writing _rates.json (kind: 'rates', source: 'agent'). Not in the Sprint 002 #15b 5-writer scope; queued for follow-up.
  fs.writeFileSync(ratesFile, JSON.stringify(ratesData, null, 2) + "\n");
  console.log(`  ✓ Wrote ${ratesFile} (${result.slabs.length} slabs, variant: ${variant})`);
  if (allWarnings.length > 0) {
    console.log(`  Warnings: ${allWarnings.length}`);
  }
  return result.slabs.length > 0;
}

// ── NRI variant URL keys ────────────────────────────────────────────

const NRI_VARIANTS = [
  { variant: "nre", urlKey: "fd_nre", currency: "INR" },
  { variant: "nro", urlKey: "fd_nro", currency: "INR" },
  { variant: "fcnr", urlKey: "fd_fcnr", currency: null },  // per-slab currency
];

// ── Main extraction logic ───────────────────────────────────────────

async function extractBank(code) {
  const configFile = path.join(outputDir, `${code}_config.json`);
  if (!fs.existsSync(configFile)) {
    console.log(`  ✗ No config file: ${configFile}`);
    return { domestic: false, nre: false, nro: false, fcnr: false };
  }

  const rawConfig = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const config = mergeWithDefaults(rawConfig);
  const scraperType = config.scraper_type || "manual";
  console.log(`  Type: ${scraperType}`);

  const results = { domestic: false, nre: false, nro: false, fcnr: false };

  // ── Domestic FD extraction (existing behavior) ──────────────────
  if (scraperType === "manual" || scraperType === "government") {
    console.log(`  Skipping: ${scraperType} (requires manual extraction)`);
  } else {
    let result;
    switch (scraperType) {
      case "html_static":
        result = await extractHtmlStatic(config);
        break;
      case "html_js":
        result = extractHtmlJs(config);
        break;
      case "pdf":
        result = extractPdf(config);
        break;
      case "mixed":
        result = await extractHtmlStatic(config);
        if (result.slabs.length === 0) {
          console.log("  HTML yielded 0 slabs, trying PDF...");
          result = extractPdf(config);
        }
        break;
      default:
        console.log(`  Skipping: unknown scraper_type "${scraperType}"`);
        result = { slabs: [], effectiveDate: null, warnings: [] };
    }

    if (result.slabs.length > 0) {
      results.domestic = writeRatesFile(code, config, result, "regular", config.rate_page_urls?.fd);
    }
  }

  // ── NRI variant extraction ──────────────────────────────────────
  const urls = config.rate_page_urls || {};
  const combinedNriUrl = urls.fd_nri_combined || null;

  for (const { variant, urlKey, currency } of NRI_VARIANTS) {
    let url = urls[urlKey] || null;

    // Fall back to combined NRI page for NRE/NRO (not FCNR)
    if (!url && variant !== "fcnr" && combinedNriUrl) {
      url = combinedNriUrl;
    }

    if (!url) continue;

    console.log(`  --- ${variant.toUpperCase()} extraction ---`);
    console.log(`  URL: ${url}`);

    try {
      const result = await routeExtraction(config, url, variant);

      // Tag currency on slabs
      if (currency) {
        // Fixed currency (INR for NRE/NRO)
        for (const slab of result.slabs) {
          if (!slab.currency) slab.currency = currency;
        }
      }
      // For FCNR: currency should already be tagged per-slab by the extractor
      // If not, default to USD
      if (variant === "fcnr") {
        for (const slab of result.slabs) {
          if (!slab.currency) slab.currency = "USD";
        }
      }

      if (result.slabs.length > 0) {
        results[variant] = writeRatesFile(code, config, result, variant, url);
      } else {
        console.log(`  No ${variant.toUpperCase()} slabs extracted`);
      }
    } catch (err) {
      console.log(`  ✗ ${variant.toUpperCase()} extraction failed: ${err.message}`);
    }
  }

  return results;
}

// ── Entry point ─────────────────────────────────────────────────────

async function main() {
  if (bankCode) {
    // Single bank
    console.log(`Extracting rates for: ${bankCode}`);
    const results = await extractBank(bankCode);
    const anyOk = Object.values(results).some(Boolean);
    const variants = Object.entries(results).filter(([, ok]) => ok).map(([v]) => v);
    if (variants.length > 0) {
      console.log(`  Extracted variants: ${variants.join(", ")}`);
    }
    process.exit(anyOk ? 0 : 1);
  }

  // Batch mode: find all config files
  const configFiles = fs.readdirSync(outputDir)
    .filter((f) => f.endsWith("_config.json") && !f.startsWith("_"))
    .sort();

  let candidates = configFiles.map((f) => {
    const code = f.replace("_config.json", "");
    const config = JSON.parse(fs.readFileSync(path.join(outputDir, f), "utf-8"));
    return { code, scraperType: config.scraper_type || "manual" };
  });

  if (scraperTypeFilter) {
    candidates = candidates.filter((c) => c.scraperType === scraperTypeFilter);
  }
  if (limitCount > 0) {
    candidates = candidates.slice(0, limitCount);
  }

  console.log(`Extracting rates for ${candidates.length} banks`);
  if (scraperTypeFilter) console.log(`  Filter: scraper_type = ${scraperTypeFilter}`);
  console.log();

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let variantCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const { code, scraperType } = candidates[i];
    console.log(`[${i + 1}/${candidates.length}] ${code} (${scraperType})`);
    try {
      const results = await extractBank(code);
      const anyOk = Object.values(results).some(Boolean);
      const extractedVariants = Object.entries(results).filter(([, ok]) => ok).length;
      variantCount += extractedVariants;
      if (anyOk) succeeded++;
      else skipped++;
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
      failed++;
    }
    console.log();
  }

  console.log("============================================");
  console.log(`Extraction complete: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`);
  console.log(`  Total variant files written: ${variantCount}`);
  console.log("============================================");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  // HTML parsing helpers — pure functions that take HTML strings (no fetching).
  // Phase 3 refresh consumes these against cached bodies to avoid re-fetching.
  parseHtmlTables,
  extractSlabsFromTable,
  extractEffectiveDateFromHtml,
  // Sprint 4 B2 helpers — exported for unit tests of column heuristic.
  _detectColumns: detectColumns,
  _looksLikeBadMapping: looksLikeBadMapping,
  // Dispatcher entry points — exported for Sprint 003 #1d (deterministic
  // extract_html_table action wraps these). Each accepts a parsed config object
  // and returns { slabs, effectiveDate?, warnings }. No side effects (no _rates.json write).
  extractHtmlStatic,
  extractHtmlJs,
  extractPdf,
  routeExtraction,
};

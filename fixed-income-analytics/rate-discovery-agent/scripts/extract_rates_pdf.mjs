#!/usr/bin/env node

/**
 * extract_rates_pdf.mjs — Extract FD interest rates from PDF rate cards.
 *
 * Uses pdfjs-dist (ESM) to extract text, then parses rate tables.
 * Outputs structured JSON after === JSON_OUTPUT === marker
 * (same convention as fetch_rates_playwright.js).
 *
 * Usage:
 *   node scripts/extract_rates_pdf.mjs <pdf_path_or_url> [--bank-code <code>]
 *
 * Examples:
 *   node scripts/extract_rates_pdf.mjs output/citibank-na_deposit_rates.pdf
 *   node scripts/extract_rates_pdf.mjs https://example.com/rates.pdf --bank-code citibank-na
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { parseTenure } = require("./utils/parse-tenure.js");
const { validateRate } = require("./utils/validate-rates.js");
// M2.3 (sprint-004 2026-05-21): rate-line parsers extracted to a CJS helper
// so they're require()-able from the test suite without dynamic-importing
// this .mjs script. The helper exports parseRateLines (legacy 3-column),
// parseRateLinesWithHint (column-aware), normalizeTenureText, and the
// canonical RATE_LINE_PATTERN regex.
const { parseRateLines, parseRateLinesWithHint, normalizeTenureText } = require("./utils/parse-pdf-rate-lines.js");

// ── Argument parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let input = "";
let bankCode = "";
let referer = "";
let hintPath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bank-code" && args[i + 1]) bankCode = args[++i];
  else if (args[i] === "--referer" && args[i + 1]) referer = args[++i];
  else if (args[i] === "--hint" && args[i + 1]) hintPath = args[++i];
  else if (!args[i].startsWith("--") && !input) input = args[i];
}

if (!input) {
  console.error("Usage: node scripts/extract_rates_pdf.mjs <pdf_path_or_url> [--bank-code <code>] [--referer <url>] [--hint <path-to-hint.json>]");
  process.exit(1);
}

// M2.3 (sprint-004 2026-05-21): per-page column hint. Shape:
//   { type: "pdf", pages: [{ page: 1, columns: [{ age_tier, deposit_range }, ...] }, ...] }
// When the hint declares columns for the current page, the parser splits
// the line positionally (rather than capping at the 3-rate regex) and emits
// one slab per (tenure × column), labeled with the column's age_tier and
// deposit_range. Pages absent from the hint fall back to the legacy
// 3-column regex behaviour. Hint file is JSON written to a tmp path by
// lib/tools.js#fetchPdf when bank-domains.json carries the hint.
let pdfHint = null;
if (hintPath) {
  try {
    pdfHint = JSON.parse(readFileSync(hintPath, "utf-8"));
    if (pdfHint && pdfHint.type !== "pdf") {
      console.error(`--hint provided but type is "${pdfHint.type}" (expected "pdf"); ignoring.`);
      pdfHint = null;
    }
  } catch (err) {
    console.error(`Failed to read --hint ${hintPath}: ${err.message}; continuing without hint.`);
    pdfHint = null;
  }
}

function hintForPage(pageNum) {
  if (!pdfHint || !Array.isArray(pdfHint.pages)) return null;
  return pdfHint.pages.find((p) => p.page === pageNum) || null;
}

// ── Download PDF if URL (M1 sprint-004: browser headers + timeouts + relative redirects) ─

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/pdf, application/octet-stream;q=0.9, */*;q=0.5",
  "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
};

const CONNECT_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 90_000;
const MAX_REDIRECTS = 5;

async function downloadPdf(url, { redirectsLeft = MAX_REDIRECTS, refererOverride } = {}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(url); } catch (e) {
      return reject(new Error(`Invalid URL "${url}": ${e.message}`));
    }
    const getter = urlObj.protocol === "https:" ? httpsGet : httpGet;
    const headers = { ...BROWSER_HEADERS };
    const effRef = refererOverride || referer;
    if (effRef) headers["Referer"] = effRef;

    const req = getter({
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || undefined,
      path: urlObj.pathname + urlObj.search,
      headers,
      timeout: CONNECT_TIMEOUT_MS,
    }, (res) => {
      // Once response headers arrive, switch to read-timeout: kill the socket
      // if no data for READ_TIMEOUT_MS.
      res.socket.setTimeout(READ_TIMEOUT_MS, () => {
        res.destroy(new Error(`read timeout after ${READ_TIMEOUT_MS}ms`));
      });

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          return reject(new Error(`too many redirects (>${MAX_REDIRECTS}) for ${url}`));
        }
        // Resolve relative redirects against the current URL (Axis CDN bug).
        let nextUrl;
        try { nextUrl = new URL(res.headers.location, url).toString(); }
        catch (e) { return reject(new Error(`bad redirect target "${res.headers.location}": ${e.message}`)); }
        return downloadPdf(nextUrl, { redirectsLeft: redirectsLeft - 1, refererOverride: url }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.on("timeout", () => {
      // Fired when no socket activity for CONNECT_TIMEOUT_MS before response headers.
      req.destroy(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms to ${urlObj.hostname}`));
    });
    req.on("error", reject);
  });
}

// ── Extract text from PDF ───────────────────────────────────────────

async function extractPdfText(data) {
  const uint8 = new Uint8Array(data);
  const doc = await getDocument({ data: uint8 }).promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();

    // Group text items into lines by Y coordinate
    const lines = [];
    let lastY = null;
    let currentLine = "";

    for (const item of textContent.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        lines.push(currentLine.trim());
        currentLine = "";
      }
      currentLine += item.str + "\t";
      lastY = y;
    }
    if (currentLine.trim()) lines.push(currentLine.trim());

    pages.push({ pageNum: i, lines });
  }

  return pages;
}

// ── Parse rate slabs from text lines ────────────────────────────────
// Legacy 3-column regex parser and the M2.3 column-aware parser are
// imported from ./utils/parse-pdf-rate-lines.js — extracted as a CJS
// module so they're testable without dynamic-importing this .mjs file.

const { extractEffectiveDate: extractDateUtil } = require("../lib/extract-date.js");

function extractEffectiveDate(allText) {
  return extractDateUtil(allText, { pdfMode: true });
}

// ── Per-page heading / variant inference ────────────────────────────

/**
 * Look at the first N lines of a page for a variant cue. Indian bank PDFs
 * typically place a heading like "NRE FIXED DEPOSIT RATES" at the top of
 * each variant page. Returns { variant, heading } when matched; otherwise
 * { variant: "regular", heading: null }.
 */
function inferPageVariant(lines) {
  const headerSlice = lines.slice(0, 8).join(" ").toLowerCase();
  const patterns = [
    { variant: "fcnr",    regex: /\bfcnr(?:[\-\s]?b)?\b/ },
    { variant: "gift",    regex: /\bgift\s*city|\bifsc(?:a)?\b/ },
    { variant: "nre",     regex: /\bnre\b|\bnon[\-\s]?resident\s*external\b/ },
    { variant: "nro",     regex: /\bnro\b|\bnon[\-\s]?resident\s*(?:ordinary|rupee)\b/ },
  ];
  for (const { variant, regex } of patterns) {
    if (regex.test(headerSlice)) {
      // Capture a short heading slice for the structure_hint
      const lineWithCue = lines.slice(0, 8).find((l) => regex.test(l.toLowerCase())) || null;
      return { variant, heading: lineWithCue };
    }
  }
  return { variant: "regular", heading: null };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  let pdfData;
  let sourceUrl = input;

  if (input.startsWith("http://") || input.startsWith("https://")) {
    console.log(`Downloading: ${input}`);
    pdfData = await downloadPdf(input);
    console.log(`Downloaded: ${pdfData.length} bytes`);
  } else {
    const filePath = resolve(input);
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    pdfData = readFileSync(filePath);
    sourceUrl = filePath;
    console.log(`Reading: ${filePath} (${pdfData.length} bytes)`);
  }

  const pages = await extractPdfText(pdfData);
  console.log(`Extracted text from ${pages.length} page(s)`);

  // Combine all lines for back-compat: flat `rate_slabs` is still emitted so
  // any caller that hasn't migrated to `pages_data[]` keeps working.
  const allLines = pages.flatMap((p) => p.lines);
  const allText = allLines.join("\n");
  const effectiveDate = extractEffectiveDate(allText);
  if (effectiveDate) console.log(`Effective date: ${effectiveDate}`);

  // Per-page parsing — Sprint 003 #1c follow-up. Each page gets its own slab
  // array, variant inference from the heading, and tagged with the page number.
  // M2.3 (sprint-004 2026-05-21): if --hint declares columns for this page,
  // the column-aware parser is used to emit one slab per (tenure × column).
  const pages_data = pages.map((p) => {
    const pageHint = hintForPage(p.pageNum);
    const pageEffectiveDate = (pageHint && pageHint.effective_date)
      ? pageHint.effective_date
      : (extractEffectiveDate(p.lines.join("\n")) || null);
    const { variant, heading } = inferPageVariant(p.lines);
    const resolvedVariant = (pageHint && pageHint.variant) ? pageHint.variant : variant;
    const isHintedPdf = pdfHint && Array.isArray(pdfHint.pages) && pdfHint.pages.length > 0;
    const isPageIncluded = !isHintedPdf || pageHint !== null;
    const { slabs, warnings } = !isPageIncluded
      ? { slabs: [], warnings: [] }
      : (pageHint && Array.isArray(pageHint.columns) && pageHint.columns.length > 0
          ? parseRateLinesWithHint(p.lines, pageHint)
          : parseRateLines(p.lines));
    if (pageHint) {
      console.log(`Page ${p.pageNum}: applied column hint (${pageHint.columns ? pageHint.columns.length : 0} columns) → ${slabs.length} slabs`);
    }
    // Annotate each slab with its source page; downstream callers may strip.
    for (const slab of slabs) slab._page = p.pageNum;
    return {
      page_number: p.pageNum,
      variant_inferred: resolvedVariant,
      heading_pattern: heading,
      effective_date: pageEffectiveDate,
      slabs,
      warnings,
      table_count: slabs.length > 0 ? 1 : 0, // single-table-per-page heuristic; refine later
      column_hint_applied: pageHint != null && Array.isArray(pageHint.columns) && pageHint.columns.length > 0,
    };
  });

  // Flat aggregation (back-compat): all slabs across all pages, with _page tags.
  const flatSlabs = pages_data.flatMap((pd) => pd.slabs);
  const flatWarnings = pages_data.flatMap((pd) => pd.warnings);

  console.log(`\n=== RESULTS ===`);
  console.log(`Rate slabs parsed: ${flatSlabs.length} across ${pages_data.length} page(s)`);
  for (const pd of pages_data) {
    if (pd.slabs.length > 0) {
      console.log(`  page ${pd.page_number}: ${pd.slabs.length} slab(s), variant=${pd.variant_inferred}${pd.heading_pattern ? `, heading="${pd.heading_pattern.slice(0, 60)}"` : ''}`);
    }
  }
  if (flatWarnings.length > 0) {
    console.log(`Warnings: ${flatWarnings.length}`);
    flatWarnings.slice(0, 10).forEach((w) => console.log(`  ! ${w}`));
  }

  console.log(`\n--- Parsed Rate Slabs ---`);
  for (const s of flatSlabs) {
    const parts = [`p${s._page}`, s.tenure_text, `${s.rate_general_pct}%`];
    if (s.rate_senior_pct != null) parts.push(`senior: ${s.rate_senior_pct}%`);
    console.log(`  ${parts.join(" | ")}`);
  }

  // Output structured JSON with both shapes.
  const output = {
    source: sourceUrl,
    bank_code: bankCode || null,
    scraped_at: new Date().toISOString(),
    effective_date: effectiveDate,
    extraction_method: "pdf",
    rate_slabs: flatSlabs,            // back-compat
    warnings: flatWarnings,           // back-compat
    pages_data,                       // Sprint 003 #1c per-page output
    pages_count: pages_data.length,
  };

  console.log(`\n=== JSON_OUTPUT ===`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

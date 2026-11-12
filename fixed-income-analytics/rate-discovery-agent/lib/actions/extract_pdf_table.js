'use strict';

/**
 * Action: extract_pdf_table — Sprint 003 A4 contract.
 *
 * Wraps `scripts/extract_rates_pdf.mjs` (which uses pdfjs-dist to extract
 * tables from PDF rate cards) and applies Q8 multi-page handling: PDFs may
 * contain multiple products/variants across pages (Yes Bank style); all
 * pages are parsed and returned grouped. The first pass also emits a
 * `structure_hint` describing the per-page layout, which the orchestrator
 * persists into `bank-domains.json` so repeat passes can short-circuit
 * page-scanning.
 *
 * Input:
 *   {
 *     url: string,                          // PDF URL (or local path; the spawned script accepts both)
 *     expected?: {
 *       products?: ("FD")[],                // hint about expected products in the PDF
 *       variants?: ("regular"|"nre"|"nro"|"fcnr"|"gift")[],
 *     },
 *     hints?: {
 *       effective_date_pattern?: string,
 *       structure?: object,                 // prior `structure_hint` from a previous pass
 *       bank_code?: string,                 // forwarded to the spawned script for output naming
 *     },
 *     session?: object,                     // optional Playwright session — gives the download
 *                                           //   step access to WAF-tolerant context cookies
 *     logger?: object,
 *   }
 *
 * Output (success):
 *   {
 *     ok: true,
 *     pages: Array<{
 *       page_number: number,
 *       product_type: "FD",
 *       variant: "regular"|"nre"|"nro"|"fcnr"|"gift",
 *       effective_date: string|null,
 *       slabs: Array<...>,
 *       warnings: string[],
 *       confidence: "high"|"medium"|"low",
 *     }>,
 *     structure_hint: { page_count, pages: [{ page_number, heading_pattern, variant_inferred, table_count }] },
 *     extraction_method: "automatic_pdf",
 *   }
 *
 * Output (failure):
 *   - FETCH-class (the PDF bytes were never obtained — HTTP >= 400, empty
 *     body, network error):
 *       { ok: false, failure_class: "fetch", http_status: number|null, error_message: string }
 *     Sprint 011 hint-fallback (2026-07-07): structured so the orchestrator
 *     can distinguish "hinted dated PDF URL rolled/404" (retry the product
 *     un-hinted) from a parse-stage failure (do not retry).
 *   - parse-class (bytes obtained but no usable slabs / script failure):
 *     null  (caller proceeds with rate_slabs: [] per variant; per CLAUDE.md).
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { httpRequest } = require('./_http');
// M2.5 (sprint-004 2026-05-21): per-URL extraction-hint resolver shared
// with the LLM-path (lib/tools.js#fetchPdf). When the bank's registry
// entry declares `extraction.<rate_pages_key>.type === "pdf"` for the
// URL being fetched, write the hint to a temp file and pass
// `--hint <path>` to the spawned scripts/extract_rates_pdf.mjs so the
// parser emits one slab per (tenure × column).
const { resolveExtractionHint } = require('../extraction-hint');

const VALID_VARIANTS = new Set(['regular', 'nre', 'nro', 'fcnr', 'gift']);

/**
 * Sprint 011 hint-fallback (2026-07-07): FETCH-class failure envelope — the
 * download step never yielded PDF bytes (HTTP >= 400, empty body, network
 * error). Returned instead of null for exactly these cases so the
 * orchestrator can fall back to the un-hinted rate page when a registry-
 * hinted dated PDF URL has rolled (Axis: domestic-fixed-deposits-<date>.pdf
 * → HTTP 404). Parse-stage failures keep returning null: a PDF that
 * downloads fine but yields 0 slabs must NOT look fetch-failed (the
 * orchestrator would double-extract for no new information).
 */
function fetchFailure(httpStatus, message) {
  return { ok: false, failure_class: 'fetch', http_status: httpStatus, error_message: message };
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PDF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'extract_rates_pdf.mjs');
const PDF_MAX_BYTES = 50 * 1024 * 1024;       // 50 MB; bank rate cards are typically < 5 MB
const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;        // network only — parsing has its own budget below
const PDF_PARSE_TIMEOUT_MS = 120_000;          // subprocess only parses pre-downloaded bytes
const PDF_URL_RX = /^https?:\/\//i;

/** Heading patterns that suggest a variant for a given page's content. */
const VARIANT_HEADING_PATTERNS = [
  { variant: 'fcnr',    regex: /\bfcnr(?:[\-\s]?b)?\b/i },
  { variant: 'gift',    regex: /\bgift\s*city|\bifsc(?:a)?(?:\s*banking)?(?:\s*unit)?\b/i },
  { variant: 'nre',     regex: /\bnre\b|\bnon[\-\s]?resident\s*external\b/i },
  { variant: 'nro',     regex: /\bnro\b|\bnon[\-\s]?resident\s*(?:ordinary|rupee)\b/i },
  // regular is the fallback when no variant cue found
];

async function extractPdfTable(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('extractPdfTable: input must be an object');
  }
  const { url, expected, hints, logger, session } = input;
  if (!url || typeof url !== 'string') throw new Error('extractPdfTable: input.url is required');

  // For remote URLs, pre-download the PDF here (browser UA via _http.js;
  // optional session for stateful WAFs) and pass a local path to the
  // subprocess. The subprocess used to do its own bare `https.get(url)`
  // without any User-Agent, which hung or got 403'd on hosts like Citi
  // and surfaced as ETIMEDOUT when spawnSync's 60s budget elapsed — the
  // budget covered network + parse together. Splitting the two lets each
  // get its own timeout and lets the download reuse the same WAF-tolerant
  // fetch path used for every other action.
  let pdfArg = url;
  let tempPath = null;
  if (PDF_URL_RX.test(url)) {
    try {
      const dl = await httpRequest(url, 'GET', {
        timeoutMs: PDF_DOWNLOAD_TIMEOUT_MS,
        maxBytes: PDF_MAX_BYTES,
        tolerant: true,
        session: session || null,
        responseType: 'buffer',
        logger,
      });
      if (!dl || dl.statusCode < 200 || dl.statusCode >= 400) {
        if (logger?.warn) logger.warn(`extract_pdf_table: download HTTP ${dl?.statusCode} for ${url}`);
        return fetchFailure(dl?.statusCode ?? null, `download HTTP ${dl?.statusCode}`);
      }
      if (!Buffer.isBuffer(dl.body) || dl.body.length === 0) {
        if (logger?.warn) logger.warn(`extract_pdf_table: empty body for ${url}`);
        return fetchFailure(dl.statusCode, 'empty download body');
      }
      const tempName = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.pdf`;
      tempPath = path.join(os.tmpdir(), tempName);
      // safe-write-exempt: ephemeral OS-tmpdir PDF used as subprocess input, unlinked in finally
      fs.writeFileSync(tempPath, dl.body);
      pdfArg = tempPath;
    } catch (err) {
      if (logger?.warn) logger.warn(`extract_pdf_table: download failed for ${url}: ${err.message}`);
      return fetchFailure(null, `download failed: ${err.message}`);
    }
  }

  // Spawn the PDF extractor script — it already wraps pdfjs-dist + tenure
  // parsing + rate validation. We forward bank_code if provided so the
  // script's diagnostic output is labelled.
  const args = [PDF_SCRIPT, pdfArg];
  if (hints?.bank_code) args.push('--bank-code', hints.bank_code);

  // M2.5: thread per-URL PDF column hint when one is declared in the
  // registry. Read bank-domains.json (with a small one-shot cache to avoid
  // disk reads in tight loops), match the URL, write the hint to a tmp
  // file, and pass --hint to the child. The orchestrator path is the
  // load-bearing route for multi-column PDFs because the LLM-path
  // truncates the parser's slab list during inline JSON emission
  // (sprint-004 M2.4 finding — see engine-fixes-m2.md §M2.4).
  let tmpHintPath = null;
  if (hints?.bank_code) {
    try {
      const domainsFile = path.join(PROJECT_ROOT, 'data', 'bank-domains.json');
      const domains = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'));
      const bankEntry = domains[hints.bank_code];
      const hint = resolveExtractionHint(bankEntry, url);
      if (hint && hint.type === 'pdf') {
        tmpHintPath = path.join(os.tmpdir(), `rdai-pdf-hint-orch-${hints.bank_code}-${process.pid}-${Date.now()}.json`);
        // safe-write-exempt: ephemeral OS-tmpdir hint file used as subprocess input, unlinked in finally.
        fs.writeFileSync(tmpHintPath, JSON.stringify(hint), 'utf-8');
        args.push('--hint', tmpHintPath);
        if (logger?.info) logger.info(`[METRIC] hint_applied bank=${hints.bank_code} key=${hint.key} type=pdf path=orchestrator`);
      }
    } catch (err) {
      // Hint read failed (file missing, malformed JSON, etc.) — fall back
      // to no-hint parse. Not fatal.
      if (logger?.warn) logger.warn(`extract_pdf_table: hint resolve failed (${err.message}); continuing without hint`);
    }
  }

  let res;
  try {
    res = spawnSync(process.execPath, args, {
      cwd: PROJECT_ROOT,
      timeout: PDF_PARSE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });
  } catch (err) {
    if (logger?.warn) logger.warn(`extract_pdf_table: spawn failed: ${err.message}`);
    return null;
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
    if (tmpHintPath) { try { fs.unlinkSync(tmpHintPath); } catch {} }
  }

  if (res.error) {
    if (logger?.warn) logger.warn(`extract_pdf_table: ${res.error.message}`);
    return null;
  }
  if (res.status !== 0) {
    if (logger?.warn) logger.warn(`extract_pdf_table: exit ${res.status}; stderr: ${(res.stderr || '').slice(-300)}`);
    return null;
  }

  const stdout = res.stdout || '';
  const marker = stdout.indexOf('=== JSON_OUTPUT ===');
  if (marker < 0) {
    if (logger?.warn) logger.warn('extract_pdf_table: no JSON_OUTPUT marker in PDF script output');
    return null;
  }
  const jsonStart = stdout.indexOf('{', marker);
  if (jsonStart < 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart).trim());
  } catch (err) {
    if (logger?.warn) logger.warn(`extract_pdf_table: failed to parse PDF script JSON: ${err.message}`);
    return null;
  }

  // The current PDF script returns a flat shape: { rate_slabs, effective_date, warnings, source_pages? }.
  // Q8 contract requires `pages[]` grouped by (product, variant). For now we
  // infer page boundaries from `source_pages` metadata if the script provides
  // it; otherwise we treat the result as a single-page payload and emit a
  // structure_hint summarising what we have. A future enhancement to
  // extract_rates_pdf.mjs will surface per-page output directly.

  // Preferred path: the underlying script's per-page output (Sprint 003 #1c
  // follow-up landed extract_rates_pdf.mjs's `pages_data[]`). When present,
  // each entry is already grouped and variant-inferred — we just need to
  // shape it into the action's contract.
  if (Array.isArray(parsed.pages_data) && parsed.pages_data.length > 0) {
    const pages = parsed.pages_data
      .filter((pd) => Array.isArray(pd.slabs) && pd.slabs.length > 0)
      .map((pd) => {
        // Drop the internal _page tag from public slabs.
        const cleanSlabs = pd.slabs.map((s) => { const { _page, ...rest } = s; return rest; });
        const v = (pd.variant_inferred && pd.variant_inferred !== 'regular')
          ? pd.variant_inferred
          : ((expected?.variants && expected.variants.length === 1) ? expected.variants[0] : (pd.variant_inferred || 'regular'));
        return {
          page_number: pd.page_number,
          product_type: 'FD',
          variant: v,
          effective_date: pd.effective_date || parsed.effective_date || null,
          slabs: cleanSlabs,
          warnings: pd.heading_pattern ? [`page heading: "${pd.heading_pattern}"`, ...(pd.warnings || [])] : (pd.warnings || []),
          confidence: cleanSlabs.length >= 4 ? 'high' : 'medium',
        };
      });
    if (pages.length === 0) {
      if (logger?.warn) logger.warn('extract_pdf_table: pages_data present but no page produced slabs');
      return null;
    }
    return {
      ok: true,
      pages,
      structure_hint: {
        page_count: parsed.pages_data.length,
        pages: parsed.pages_data.map((pd) => ({
          page_number: pd.page_number,
          heading_pattern: pd.heading_pattern || null,
          variant_inferred: pd.variant_inferred,
          table_count: pd.table_count || (Array.isArray(pd.slabs) && pd.slabs.length > 0 ? 1 : 0),
        })),
      },
      extraction_method: 'automatic_pdf',
    };
  }

  // Back-compat path: older `extract_rates_pdf.mjs` returns only flat slabs.
  // Apply the heuristic grouping (per-slab _page tag if present, heading hints,
  // or single-page fallback).
  const allSlabs = Array.isArray(parsed.rate_slabs) ? parsed.rate_slabs : [];
  if (allSlabs.length === 0) {
    if (logger?.warn) logger.warn('extract_pdf_table: PDF script returned 0 slabs');
    return null;
  }

  const pages = groupSlabsByPage(allSlabs, parsed, expected);
  const structure_hint = buildStructureHint(pages, parsed);

  return {
    ok: true,
    pages,
    structure_hint,
    extraction_method: 'automatic_pdf',
  };
}

/**
 * Group slabs into per-page records. Three modes:
 *   - Slabs carry a `_page` field from the underlying script → group by it.
 *   - Heading patterns at slab.heading or slab.section_label suggest variant.
 *   - Single-page fallback: emit one page with variant inferred from
 *     `expected.variants[0]` or "regular".
 */
function groupSlabsByPage(slabs, parsed, expected) {
  // Mode 1: explicit per-slab _page field
  const hasPageNumbers = slabs.some((s) => typeof s._page === 'number');
  if (hasPageNumbers) {
    const byPage = new Map();
    for (const slab of slabs) {
      const p = slab._page ?? 0;
      if (!byPage.has(p)) byPage.set(p, []);
      // Drop the internal _page field from the public slab.
      const { _page, ...clean } = slab;
      byPage.get(p).push(clean);
    }
    return [...byPage.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page_number, pageSlabs]) => ({
        page_number,
        product_type: 'FD',
        variant: inferVariantFromContext(pageSlabs, parsed, expected),
        effective_date: parsed.effective_date || null,
        slabs: pageSlabs,
        warnings: [],
        confidence: pageSlabs.length >= 4 ? 'high' : 'medium',
      }));
  }

  // Mode 2: section_label / heading hints
  const grouped = new Map();
  for (const slab of slabs) {
    const heading = slab.section_label || slab.heading || '';
    const variant = inferVariantFromHeading(heading) || (expected?.variants?.[0]) || 'regular';
    const key = `${variant}|${heading}`;
    if (!grouped.has(key)) grouped.set(key, { variant, heading, slabs: [] });
    grouped.get(key).slabs.push(slab);
  }

  if (grouped.size > 1) {
    let pageNum = 1;
    return [...grouped.values()].map((g) => ({
      page_number: pageNum++,
      product_type: 'FD',
      variant: g.variant,
      effective_date: parsed.effective_date || null,
      slabs: g.slabs,
      warnings: g.heading ? [`page heading: "${g.heading}"`] : [],
      confidence: g.slabs.length >= 4 ? 'high' : 'medium',
    }));
  }

  // Mode 3: single-page fallback
  return [{
    page_number: 1,
    product_type: 'FD',
    variant: expected?.variants?.[0] || 'regular',
    effective_date: parsed.effective_date || null,
    slabs,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    confidence: slabs.length >= 4 ? 'high' : 'medium',
  }];
}

function inferVariantFromHeading(heading) {
  if (!heading) return null;
  for (const { variant, regex } of VARIANT_HEADING_PATTERNS) {
    if (regex.test(heading)) return variant;
  }
  return null;
}

function inferVariantFromContext(slabs, parsed, expected) {
  // Currency cue: any FCNR/GIFT slab has a non-INR currency
  if (slabs.some((s) => s.currency && s.currency !== 'INR')) return 'fcnr';
  // Heading cue from parsed metadata
  if (parsed.section_label) {
    const v = inferVariantFromHeading(parsed.section_label);
    if (v) return v;
  }
  return expected?.variants?.[0] || 'regular';
}

function buildStructureHint(pages, parsed) {
  return {
    page_count: pages.length,
    pages: pages.map((p) => ({
      page_number: p.page_number,
      heading_pattern: parsed.section_label || null,
      variant_inferred: p.variant,
      table_count: 1, // single-table assumption per page; will become richer as per-page output lands
    })),
  };
}

module.exports = {
  extractPdfTable,
  _inferVariantFromHeading: inferVariantFromHeading,
  _groupSlabsByPage: groupSlabsByPage,
};

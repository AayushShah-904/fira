'use strict';

/**
 * PDF fetch + extraction with Azure Document Intelligence fallback.
 *
 * Sprint 006 Phase B / Step 1c. Library function. Used by fetchHtml when the
 * URL is a PDF (short-circuit), and by Phase C+ extractors that target PDF
 * rate cards (PSB, IBU).
 *
 * Routing:
 *   1. Download PDF to OS tmp.
 *   2. Run pdfjs-dist text extraction via scripts/extract_rates_pdf.mjs subprocess.
 *   3. Count slabs from text (using existing parsePdfRateLines).
 *   4. If slabs >= 3 AND no multi-column hint → return method='pdfjs'.
 *   5. Else if Azure DocIntel is configured → call analyzeBuffer → return method='doc_intelligence'.
 *   6. Else → return method='pdfjs' anyway (with whatever slabs we got) and let
 *      the extractor decide what to do.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/fetch-layer-hardening.md
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { httpRequest } = require('../actions/_http');
const docIntel = require('../azure/doc_intelligence');

const DEFAULT_MIN_SLABS_FOR_PDFJS = 3;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXTRACT_PDF_SCRIPT = path.join(REPO_ROOT, 'scripts', 'extract_rates_pdf.mjs');

/**
 * @param {object} args
 * @param {string} args.url
 * @param {object} [args.hints]            { multi_column?: boolean, expected_slab_count?: number }
 * @param {object} [args.log]
 * @param {boolean} [args.forceDocIntel]   Skip pdfjs, go straight to DocIntel (operator override)
 * @param {object} [args._http]            Test injection: { httpRequest }
 * @param {function} [args._spawn]         Test injection for the subprocess call
 * @param {object} [args._docIntel]        Test injection for the Azure client
 * @returns {Promise<{
 *   method, pdfText, docIntelLayout, slabs, slabsPreview, effective_date,
 *   pages_data, ms, fallback_reason?, error?
 * }>}
 *   slabs         — structured rate_slabs array parsed by extract_rates_pdf.mjs
 *                   (authoritative). Empty when no marker / parse failure.
 *   effective_date — w.e.f. date parsed by the .mjs (or null).
 *   pages_data    — per-page parser output from the .mjs (or null).
 */
async function fetchPdf(args) {
  const {
    url,
    hints = {},
    log = noopLogger(),
    forceDocIntel = false,
    _http = { httpRequest },
    _spawn = spawn,
    _docIntel = docIntel,
  } = args || {};

  if (!url || typeof url !== 'string') {
    throw new Error('fetchPdf: url is required (string)');
  }

  const tStart = Date.now();
  let tmpPath = null;
  try {
    // Step 1: download the PDF. responseType:'buffer' is REQUIRED — the default
    // 'text' path runs capped.toString('utf-8') on the body, which mangles
    // binary PDF bytes (non-ASCII bytes round-trip through UTF-8 and inflate /
    // corrupt the file → pdfjs reports "obj inside obj" and parses 0 slabs).
    const download = await _http.httpRequest(url, 'GET', { maxBytes: 32 * 1024 * 1024, tolerant: true, responseType: 'buffer' });
    if (!download.body || download.body.length === 0) {
      return errorResult('empty_download', `download returned 0 bytes from ${url}`, tStart);
    }
    if (download.statusCode >= 400) {
      return errorResult('http_error', `download returned status ${download.statusCode}`, tStart);
    }

    const buf = Buffer.isBuffer(download.body) ? download.body : Buffer.from(download.body);
    const sha = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    tmpPath = path.join(os.tmpdir(), `rda-fetch-pdf-${sha}.pdf`);
    // safe-write-exempt: ephemeral OS-tmpdir PDF used as subprocess input, unlinked in finally
    fs.writeFileSync(tmpPath, buf);

    if (forceDocIntel) {
      if (log.info) log.info(`[fetch_pdf] forceDocIntel=true; skipping pdfjs`);
      return await runDocIntelFallback(buf, 0, 'force_doc_intel', tStart, log, _docIntel);
    }

    // Step 2: run pdfjs subprocess. The subprocess prints a diagnostic text
    // block, then a `=== JSON_OUTPUT ===` marker, then a structured JSON
    // envelope ({ rate_slabs, effective_date, pages_data, ... }). We surface
    // BOTH: `text` (the clean pre-marker diagnostics, kept for back-compat) and
    // `parsed` (the structured envelope — the authoritative slab data).
    let pdfText = null;
    let structured = null;
    let pdfjsError = null;
    try {
      const sub = await runPdfjsSubprocess(tmpPath, log, _spawn);
      pdfText = sub.text;
      structured = sub.parsed;
    } catch (err) {
      pdfjsError = err.message;
      if (log.warn) log.warn(`[fetch_pdf] pdfjs subprocess failed: ${err.message}`);
    }

    // Step 3: take slab count from the STRUCTURED output (the .mjs already
    // parsed slabs correctly). Do NOT re-derive from the diagnostic text — that
    // was the root-cause bug (text was the polluted JSON envelope, never parsed).
    const slabs = structured && Array.isArray(structured.rate_slabs) ? structured.rate_slabs : [];
    const slabsPreview = slabs.length;
    const effectiveDate = structured && structured.effective_date != null ? structured.effective_date : null;
    const pagesData = structured && structured.pages_data != null ? structured.pages_data : null;

    // Step 4: decide routing
    const enoughSlabs = slabsPreview >= DEFAULT_MIN_SLABS_FOR_PDFJS;
    const multiColumnHint = !!hints.multi_column;
    const pdfjsOk = (pdfText != null || structured != null) && enoughSlabs && !multiColumnHint;

    if (pdfjsOk) {
      return {
        method: 'pdfjs',
        pdfText,
        docIntelLayout: null,
        slabs,
        slabsPreview,
        effective_date: effectiveDate,
        pages_data: pagesData,
        ms: Date.now() - tStart,
      };
    }

    // Step 5: DocIntel fallback
    const fallbackReason = pdfjsError
      ? `pdfjs_failed: ${pdfjsError}`
      : multiColumnHint
        ? 'multi_column_hint_set'
        : `pdfjs_too_few_slabs: ${slabsPreview} < ${DEFAULT_MIN_SLABS_FOR_PDFJS}`;

    if (!_docIntel.isConfigured()) {
      if (log.warn) log.warn(`[fetch_pdf] DocIntel not configured; returning pdfjs result with ${slabsPreview} slabs (fallback_reason: ${fallbackReason})`);
      return {
        method: 'pdfjs',
        pdfText,
        docIntelLayout: null,
        slabs,
        slabsPreview,
        effective_date: effectiveDate,
        pages_data: pagesData,
        ms: Date.now() - tStart,
        fallback_reason: `would_have_used_doc_intel: ${fallbackReason}`,
      };
    }

    return await runDocIntelFallback(buf, slabsPreview, fallbackReason, tStart, log, _docIntel, pdfText, slabs, effectiveDate, pagesData);
  } catch (err) {
    if (log.error) log.error(`[fetch_pdf] unexpected: ${err.stack || err.message}`);
    return errorResult('unexpected_error', err.message, tStart);
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

async function runDocIntelFallback(buf, slabsPreview, fallbackReason, tStart, log, _docIntel, pdfText = null, slabs = [], effectiveDate = null, pagesData = null) {
  try {
    const layout = await _docIntel.analyzeBuffer({ pdfBuffer: buf, log });
    const metrics = _docIntel.previewMetrics(layout);
    if (log.info) {
      log.info(`[fetch_pdf] DocIntel returned ${metrics.table_count} tables, ${metrics.total_cells} cells across ${metrics.page_count} pages`);
    }
    return {
      method: 'doc_intelligence',
      pdfText,
      docIntelLayout: layout,
      slabs, // pdfjs slabs (possibly empty) kept alongside DocIntel layout
      slabsPreview, // pdfjs slabs preview kept for diagnostic
      effective_date: effectiveDate,
      pages_data: pagesData,
      ms: Date.now() - tStart,
      fallback_reason: fallbackReason,
      doc_intel_metrics: metrics,
    };
  } catch (err) {
    if (log.warn) log.warn(`[fetch_pdf] DocIntel call failed: ${err.message}; returning pdfjs result`);
    return {
      method: 'pdfjs',
      pdfText,
      docIntelLayout: null,
      slabs,
      slabsPreview,
      effective_date: effectiveDate,
      pages_data: pagesData,
      ms: Date.now() - tStart,
      fallback_reason: `${fallbackReason}; doc_intel_then_failed: ${err.message}`,
    };
  }
}

// Markers the .mjs extractor emits before its structured JSON envelope.
// extract_rates_pdf.mjs prints `=== JSON_OUTPUT ===` (current). The legacy
// `JSON_OUTPUT:` form is accepted for back-compat in case an older script is
// on PATH. We split on whichever appears.
const JSON_MARKER = '=== JSON_OUTPUT ===';
const JSON_MARKER_LEGACY = 'JSON_OUTPUT:';

/**
 * Run the pdfjs extractor subprocess and split its stdout at the JSON marker.
 *
 * @returns {Promise<{ text: string, parsed: object|null }>}
 *   text   — everything BEFORE the marker (clean diagnostic text; full stdout
 *            if no marker present).
 *   parsed — the JSON object parsed from AFTER the marker, or null if there is
 *            no marker or the JSON fails to parse (tolerant — never throws on
 *            a parse failure; logs a warn instead).
 */
function runPdfjsSubprocess(pdfPath, log, spawnFn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [EXTRACT_PDF_SCRIPT, pdfPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`pdfjs subprocess exited ${code}: ${stderr.slice(0, 500)}`));
      }
      resolve(parseSubprocessStdout(stdout, log));
    });
  });
}

/**
 * Locate the JSON marker in subprocess stdout and split into clean diagnostic
 * text + parsed JSON envelope. Exported via _internal for unit testing.
 */
function parseSubprocessStdout(stdout, log = noopLogger()) {
  let markerIdx = stdout.indexOf(JSON_MARKER);
  let markerLen = JSON_MARKER.length;
  if (markerIdx < 0) {
    markerIdx = stdout.indexOf(JSON_MARKER_LEGACY);
    markerLen = JSON_MARKER_LEGACY.length;
  }
  if (markerIdx < 0) {
    // No marker at all → whole stdout is diagnostic text, no structured data.
    return { text: stdout, parsed: null };
  }
  const text = stdout.slice(0, markerIdx);
  const jsonStr = stdout.slice(markerIdx + markerLen);
  let parsed = null;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch (err) {
    if (log && log.warn) log.warn(`[fetch_pdf] failed to parse JSON_OUTPUT envelope: ${err.message}`);
    parsed = null;
  }
  return { text, parsed };
}

function errorResult(code, message, tStart) {
  return {
    method: 'failed',
    pdfText: null,
    docIntelLayout: null,
    slabs: [],
    slabsPreview: 0,
    effective_date: null,
    pages_data: null,
    ms: Date.now() - tStart,
    error: { code, message },
  };
}

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

module.exports = {
  fetchPdf,
  DEFAULT_MIN_SLABS_FOR_PDFJS,
  // exported for testing:
  _internal: { runPdfjsSubprocess, runDocIntelFallback, parseSubprocessStdout, JSON_MARKER, JSON_MARKER_LEGACY },
};

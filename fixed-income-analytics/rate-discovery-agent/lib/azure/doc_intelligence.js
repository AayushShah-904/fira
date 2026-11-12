'use strict';

/**
 * Shared Azure Document Intelligence client.
 *
 * Sprint 006 Phase B / Step 1c. NEW module — thin wrapper around
 * @azure/ai-form-recognizer's DocumentAnalysisClient using the
 * "prebuilt-layout" model. Used by lib/fetch/fetch_pdf.js for PDF fallback
 * extraction when pdfjs-dist text doesn't yield enough slabs.
 *
 * Scope adjustment (2026-05-24): the original Phase B plan called for
 * lib/actions/{extract_via_ocr,extract_via_vision}.js to be refactored to
 * delegate to this new module. That refactor is INVASIVE — both files have
 * 30+ existing tests built around their current shape. To keep Sprint 6
 * Step 1c blast radius small, those existing modules are LEFT UNCHANGED.
 * The new lib/fetch/fetch_pdf.js uses this client directly. The lift of
 * extract_via_ocr / extract_via_vision onto this shared client is deferred
 * to end-of-Sprint-6 or Sprint 7. Documented in
 * sdlc/sprints/sprint-006/design/fetch-layer-hardening.md "Risks #4".
 *
 * Design: ../../sdlc/sprints/sprint-006/design/fetch-layer-hardening.md
 */

// Lazy-load the SDK so requiring this module doesn't fail in environments
// where browser binaries / Azure deps aren't installed (e.g., CI without secrets).
let _SDK = null;
function loadSdk() {
  if (_SDK) return _SDK;
  // eslint-disable-next-line global-require
  _SDK = require('@azure/ai-form-recognizer');
  return _SDK;
}

/**
 * Build a DocumentAnalysisClient using key-based auth from env.
 *
 * Throws (with code='DOCINTEL_NOT_CONFIGURED') if env vars missing — caller
 * should fail-soft and fall back to a non-DocIntel path.
 *
 * @returns {object} DocumentAnalysisClient instance
 */
function buildClient() {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  if (!endpoint || !key) {
    const e = new Error('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT or AZURE_DOCUMENT_INTELLIGENCE_KEY not set');
    e.code = 'DOCINTEL_NOT_CONFIGURED';
    throw e;
  }
  const { DocumentAnalysisClient, AzureKeyCredential } = loadSdk();
  return new DocumentAnalysisClient(endpoint, new AzureKeyCredential(key));
}

/**
 * Analyze a PDF/image at a URL using the prebuilt-layout model.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {object} [args.client]    Inject for testing (default: buildClient())
 * @param {object} [args.log]
 * @returns {Promise<object>} AnalyzeResult (Azure SDK shape)
 * @throws on auth/network/timeout
 */
async function analyzeUrl({ url, client, log } = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('analyzeUrl: url is required');
  }
  const c = client || buildClient();
  if (log?.info) log.info(`[docintel] analyzeUrl: ${url.slice(0, 120)}`);
  const poller = await c.beginAnalyzeDocumentFromUrl('prebuilt-layout', url);
  return poller.pollUntilDone();
}

/**
 * Analyze a PDF buffer (already downloaded). Useful when fetch_pdf has the
 * bytes in hand and we want to avoid the DocIntel-fetches-the-URL round-trip.
 *
 * @param {object} args
 * @param {Buffer} args.pdfBuffer
 * @param {object} [args.client]
 * @param {object} [args.log]
 * @returns {Promise<object>} AnalyzeResult
 */
async function analyzeBuffer({ pdfBuffer, client, log } = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('analyzeBuffer: pdfBuffer must be a non-empty Buffer');
  }
  const c = client || buildClient();
  if (log?.info) log.info(`[docintel] analyzeBuffer: ${pdfBuffer.length} bytes`);
  const poller = await c.beginAnalyzeDocument('prebuilt-layout', pdfBuffer);
  return poller.pollUntilDone();
}

/**
 * Normalize a DocIntel AnalyzeResult into a slabs-friendly preview shape.
 * Returns just the table-count metadata — full cell-to-grid conversion lives
 * in the existing lib/actions/extract_via_ocr.js helpers (kept stable for
 * back-compat per the scope adjustment above).
 *
 * @param {object} analyzeResult
 * @returns {{ table_count, total_rows, total_cells, page_count }}
 */
function previewMetrics(analyzeResult) {
  if (!analyzeResult || typeof analyzeResult !== 'object') {
    return { table_count: 0, total_rows: 0, total_cells: 0, page_count: 0 };
  }
  const tables = Array.isArray(analyzeResult.tables) ? analyzeResult.tables : [];
  const pages = Array.isArray(analyzeResult.pages) ? analyzeResult.pages : [];
  let totalRows = 0;
  let totalCells = 0;
  for (const t of tables) {
    totalRows += t.rowCount || 0;
    totalCells += Array.isArray(t.cells) ? t.cells.length : 0;
  }
  return {
    table_count: tables.length,
    total_rows: totalRows,
    total_cells: totalCells,
    page_count: pages.length,
  };
}

/**
 * Whether the env is configured for DocIntel. Used by fetch_pdf to decide
 * whether the fallback path is even available — if not, it skips DocIntel
 * silently rather than throwing.
 */
function isConfigured() {
  return Boolean(
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
    && process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
  );
}

module.exports = {
  buildClient,
  analyzeUrl,
  analyzeBuffer,
  previewMetrics,
  isConfigured,
  // exported for testing:
  _internal: { loadSdk },
};

'use strict';

/**
 * DocIntelligence cells → 2D row-major grid + helpers.
 *
 * Sprint 006 Step 3e (un-deferred from Sprint 7). Used by
 * lib/extractors/psb-pdf-rate-card-3col.js + lib/extractors/ibu-static-pdf-quarterly.js
 * to convert Azure Document Intelligence layout-API results into slab arrays.
 *
 * Mirrors lib/actions/extract_via_ocr.js#cellsToGrid + classifyColumns so the
 * dispatcher-path extractors don't have to import from the legacy module
 * (which would couple their lifecycles). When extract_via_ocr.js retires in
 * Sprint 7, that copy goes; this one stays as the canonical home.
 *
 * Pure functions — no IO, no env.
 */

// Header-token regexes — same intent as extract_via_ocr.js but kept local
const TENURE_HEADER_RE = /(\b(?:tenor|tenure|period|days|months|years|maturity|slab|bucket|fixed\s*deposit|deposit|scheme)\b|अवधि)/i;
const GENERAL_RATE_HEADER_RE = /(\b(?:rate|interest|roi|general|public|individual|p\.a\.?|%)\b|ब्याज|दर)/i;
const SENIOR_RATE_HEADER_RE = /\b(senior|sr\.?|60\s*\+|elderly)/i;
const SUPER_SENIOR_HEADER_RE = /\b(super\s*senior|80\s*\+|sup\.?\s*sr\.?)/i;
const CURRENCY_HEADER_RE = /\b(currency|ccy|USD|GBP|EUR|JPY|CAD|AUD|SGD|CHF|HKD|NZD)\b/i;
const PCT_RE = /(-?\d+(?:\.\d+)?)\s*%?\s*$/;

/**
 * Convert a DocIntel table (with cells array carrying rowIndex/columnIndex)
 * into a row-major 2D string grid. Cells spanning multiple rows/cols are
 * written into every covered position (so callers don't have to handle merges).
 */
function cellsToGrid(table) {
  if (!table || !Number.isInteger(table.rowCount) || !Number.isInteger(table.columnCount)) {
    return [];
  }
  const grid = Array.from({ length: table.rowCount }, () =>
    Array.from({ length: table.columnCount }, () => ''),
  );
  for (const cell of (table.cells || [])) {
    const text = (cell.content || '').trim();
    const rs = cell.rowSpan || 1;
    const cs = cell.columnSpan || 1;
    const r0 = cell.rowIndex || 0;
    const c0 = cell.columnIndex || 0;
    for (let dr = 0; dr < rs; dr++) {
      for (let dc = 0; dc < cs; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < table.rowCount && c < table.columnCount) grid[r][c] = text;
      }
    }
  }
  return grid;
}

/**
 * Classify the columns of a header row into {tenure, general, senior, super_senior, currency}.
 * Returns -1 for any role not detected. The classifier is order-sensitive so super-senior
 * is checked BEFORE senior (senior regex would otherwise claim super-senior cells).
 */
function classifyColumns(headerRow) {
  const out = { tenureCol: -1, generalCol: -1, seniorCol: -1, superSeniorCol: -1, currencyCol: -1 };
  if (!Array.isArray(headerRow)) return out;
  for (let i = 0; i < headerRow.length; i++) {
    const h = headerRow[i];
    if (!h) continue;
    if (out.tenureCol < 0 && TENURE_HEADER_RE.test(h)) out.tenureCol = i;
    if (out.currencyCol < 0 && CURRENCY_HEADER_RE.test(h)) out.currencyCol = i;
    if (out.superSeniorCol < 0 && SUPER_SENIOR_HEADER_RE.test(h)) out.superSeniorCol = i;
    if (out.seniorCol < 0 && SENIOR_RATE_HEADER_RE.test(h) && i !== out.superSeniorCol) out.seniorCol = i;
    if (out.generalCol < 0 && GENERAL_RATE_HEADER_RE.test(h) && i !== out.seniorCol && i !== out.superSeniorCol) {
      out.generalCol = i;
    }
  }
  return out;
}

/**
 * Parse a rate cell into a numeric percentage, or null if it doesn't look
 * like one. Strips %, commas, whitespace; rejects "-" / "n/a".
 */
function parseRateCell(cell) {
  if (cell == null) return null;
  const cleaned = String(cell).replace(/[%,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || /^n\/?a$/i.test(cleaned)) return null;
  const m = cleaned.match(/^-?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Determine which row contains headers — first row with NO percentage-shaped cell.
 * Falls back to row 0 if every row has rates.
 */
function findHeaderRowIndex(grid) {
  for (let i = 0; i < Math.min(grid.length, 3); i++) {
    if (!grid[i].some((c) => PCT_RE.test(c))) return i;
  }
  return 0;
}

module.exports = {
  cellsToGrid,
  classifyColumns,
  parseRateCell,
  findHeaderRowIndex,
  // exported for tests
  _internal: { TENURE_HEADER_RE, GENERAL_RATE_HEADER_RE, SENIOR_RATE_HEADER_RE, SUPER_SENIOR_HEADER_RE, CURRENCY_HEADER_RE, PCT_RE },
};

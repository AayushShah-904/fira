'use strict';

/**
 * Currency-matrix extractor for FCNR / GIFT HTML tables.
 *
 * Sprint 006 Step 3f (un-deferred from Sprint 7). FCNR pages typically publish
 * rates in one of two shapes:
 *
 *   Pattern A — currency-as-rows: each row is { currency, tenure1_rate,
 *               tenure2_rate, tenure3_rate, ... }. Header row = tenures.
 *
 *   Pattern B — currency-as-columns: each row is { tenure, USD, GBP, EUR, JPY, ... }.
 *               Header row = currency codes.
 *
 * Both must emit one slab per (tenure × currency). FCNR/GIFT slabs have NO
 * senior premium, so rate_senior_pct stays null.
 *
 * This is the canonical FCNR extractor used by PVB + FB multi-variant
 * extractors when variant=fcnr or variant=gift. Mirrors the patterns lifted
 * from lib/actions/extract_html_table.js (the currency-counting +
 * currency-as-cols + currency-as-rows logic at lines ~135-180 + the FCNR
 * picker filter).
 *
 * Pure function — no IO, no env. Accepts cheerio-parsed rows OR pre-extracted
 * grid.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/extract-html-table-split.md
 */

const { parseTenure } = require('../../../scripts/utils/parse-tenure');
const { normaliseCurrency } = require('../../../scripts/utils/normalise-currency');

const CCY_RE = /\b(USD|GBP|EUR|JPY|CAD|AUD|SGD|CHF|HKD|NZD)\b/i;
const TENURE_RE = /\b\d+\s*(?:days?|months?|years?|d|y|mo|yr)/i;
const PCT_RE = /^-?\d+(?:\.\d+)?\s*%?$/;

/**
 * Parse a single rate cell to a number, or null.
 */
function parseRateCell(cell) {
  if (cell == null) return null;
  const cleaned = String(cell).replace(/[%,\s]/g, '');
  if (!cleaned || cleaned === '-' || /^n\/?a$/i.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect whether a row of cells is currency-shaped (header containing
 * currency codes in cells 1+).
 */
function isCurrencyHeaderRow(row) {
  if (!Array.isArray(row)) return false;
  let codes = 0;
  for (let i = 1; i < row.length; i++) {
    if (normaliseCurrency(row[i]) || CCY_RE.test(String(row[i] || ''))) codes++;
  }
  return codes >= 2;
}

/**
 * Detect whether a row is tenure-headed (first column tenure-shaped).
 */
function isTenureHeadRow(row) {
  if (!Array.isArray(row) || row.length === 0) return false;
  return TENURE_RE.test(String(row[0] || ''));
}

/**
 * Pattern A: header row is tenures, data rows are { currency, rate1, rate2, ... }.
 */
function extractCurrencyAsRows(rows) {
  if (!rows || rows.length < 2) return { slabs: [], pattern: null };
  const header = rows[0];
  const tenureCols = [];
  for (let i = 1; i < header.length; i++) {
    if (TENURE_RE.test(String(header[i] || ''))) {
      tenureCols.push({ colIndex: i, tenureText: String(header[i]).trim() });
    }
  }
  if (tenureCols.length < 1) return { slabs: [], pattern: null };

  const slabs = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length === 0) continue;
    const currency = normaliseCurrency(row[0]) || (String(row[0] || '').match(CCY_RE)?.[1]?.toUpperCase());
    if (!currency) continue;
    for (const { colIndex, tenureText } of tenureCols) {
      const rate = parseRateCell(row[colIndex]);
      if (rate == null) continue;
      const parsed = parseTenure(tenureText);
      if (!parsed || parsed.minDays == null) continue;
      slabs.push({
        tenure_text: tenureText,
        tenure_min_days: parsed.minDays,
        tenure_max_days: parsed.maxDays != null ? parsed.maxDays : null,
        rate_general_pct: rate,
        rate_senior_pct: null,
        rate_super_senior_pct: null,
        currency,
        source_row_text: row.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return { slabs, pattern: 'A_currency_as_rows', tenure_cols: tenureCols.length };
}

/**
 * Pattern B: header row is currencies, data rows are { tenure, USD, GBP, EUR, ... }.
 */
function extractCurrencyAsColumns(rows) {
  if (!rows || rows.length < 2) return { slabs: [], pattern: null };
  const header = rows[0];
  const ccyCols = [];
  for (let i = 1; i < header.length; i++) {
    const exact = normaliseCurrency(header[i]);
    const embedded = String(header[i] || '').match(CCY_RE);
    const code = exact || (embedded ? embedded[1].toUpperCase() : null);
    if (code) ccyCols.push({ colIndex: i, currency: code });
  }
  if (ccyCols.length < 1) return { slabs: [], pattern: null };

  const slabs = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length === 0) continue;
    const tenureRaw = String(row[0] || '').trim();
    if (!tenureRaw || !TENURE_RE.test(tenureRaw)) continue;
    const parsed = parseTenure(tenureRaw.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim());
    if (!parsed || parsed.minDays == null) continue;
    for (const { colIndex, currency } of ccyCols) {
      const rate = parseRateCell(row[colIndex]);
      if (rate == null) continue;
      slabs.push({
        tenure_text: tenureRaw,
        tenure_min_days: parsed.minDays,
        tenure_max_days: parsed.maxDays != null ? parsed.maxDays : null,
        rate_general_pct: rate,
        rate_senior_pct: null,
        rate_super_senior_pct: null,
        currency,
        source_row_text: row.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return { slabs, pattern: 'B_currency_as_columns', currency_cols: ccyCols.length };
}

/**
 * Main entry point — try Pattern B first (more common), then Pattern A.
 * Returns whichever produced more slabs.
 */
function extractFromCurrencyMatrix(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { slabs: [], pattern: null, diagnostics: { reason: 'empty rows' } };
  }
  const b = extractCurrencyAsColumns(rows);
  const a = extractCurrencyAsRows(rows);
  const best = (b.slabs.length >= a.slabs.length) ? b : a;
  return {
    slabs: best.slabs,
    pattern: best.pattern,
    diagnostics: {
      pattern_A_slabs: a.slabs.length,
      pattern_B_slabs: b.slabs.length,
      chosen: best.pattern,
      tenure_cols: a.tenure_cols || 0,
      currency_cols: b.currency_cols || 0,
    },
  };
}

module.exports = {
  extractFromCurrencyMatrix,
  extractCurrencyAsRows,
  extractCurrencyAsColumns,
  isCurrencyHeaderRow,
  isTenureHeadRow,
  _internal: { CCY_RE, parseRateCell },
};

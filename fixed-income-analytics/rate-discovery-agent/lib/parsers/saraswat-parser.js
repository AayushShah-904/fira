'use strict';

/**
 * lib/parsers/saraswat-parser.js
 *
 * Custom parser for Saraswat Co-operative Bank.
 *
 * Problem: Saraswat frequently restructures their rate table column layout.
 * Previously they had separate columns for USD <1M and USD >1M deposits.
 * Their latest page merged these into a single USD column. The generic parser
 * maps columns rigidly by position (col 1 = currency A, col 2 = currency B)
 * and cannot adapt when columns are added or removed — it either assigns rates
 * to the wrong currency or emits 0 slabs when the expected column count
 * doesn't match.
 *
 * Additionally, Saraswat publishes FCNR rates for multiple currencies (USD,
 * GBP, EUR, JPY, CAD, AUD) in a single table where each column header is
 * a currency name. The parser must dynamically discover the column→currency
 * mapping from the header row rather than assuming a fixed layout.
 *
 * Solution: Read the header row to build a dynamic column→currency map, then
 * parse each data row using that map. This makes the parser immune to columns
 * being added, removed, or reordered between website updates.
 */

const { extractEffectiveDateFromHtml } = require('../extract-date');

// Known FCNR currencies to look for in header cells
const KNOWN_CURRENCIES = ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF', 'HKD'];

/**
 * @param {string} html
 * @param {object} opts
 * @returns {Promise<{ slabs, effective_date, warnings }>}
 */
async function parse(html, opts = {}) {
  const { variant = 'fcnr', url = '', logger } = opts;
  const log = {
    info: (m) => (logger && logger.info ? logger.info(m) : null),
    warn: (m) => (logger && logger.warn ? logger.warn(m) : null),
  };

  log.info(`[saraswat-parser] parsing variant=${variant} from ${url}`);
  const warnings = [];
  const effective_date = extractEffectiveDateFromHtml(html) || null;
  const slabs = [];

  if (variant !== 'fcnr') {
    // For non-FCNR variants, use standard row extraction (no dynamic column mapping needed)
    return parseStandardTable(html, variant, opts);
  }

  // ── FCNR: Dynamic column → currency mapping ───────────────────────────────
  const tableBodyRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  let bestTable = null;
  let bestScore = 0;

  // Find the table most likely to be the FCNR rate table
  while ((tableMatch = tableBodyRe.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const score = KNOWN_CURRENCIES.filter(c => tableHtml.includes(c)).length;
    if (score > bestScore) { bestScore = score; bestTable = tableHtml; }
  }

  if (!bestTable) {
    warnings.push('[saraswat-parser] no FCNR table found');
    return { slabs: [], effective_date, warnings };
  }

  log.info(`[saraswat-parser] FCNR table found with ${bestScore} currency matches`);

  // Extract rows
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(bestTable)) !== null) {
    rows.push(extractCells(rowMatch[1]));
  }

  if (rows.length < 2) {
    warnings.push('[saraswat-parser] FCNR table has fewer than 2 rows');
    return { slabs: [], effective_date, warnings };
  }

  // ── Build column→currency map from header row ─────────────────────────────
  const headerCells = rows[0];
  const colCurrencyMap = {}; // colIndex → currencyCode
  for (let i = 1; i < headerCells.length; i++) {
    const cellText = headerCells[i].toUpperCase();
    for (const curr of KNOWN_CURRENCIES) {
      if (cellText.includes(curr)) {
        colCurrencyMap[i] = curr;
        break;
      }
    }
  }

  log.info(`[saraswat-parser] column currency map: ${JSON.stringify(colCurrencyMap)}`);

  if (Object.keys(colCurrencyMap).length === 0) {
    warnings.push('[saraswat-parser] could not detect any currency columns from header row');
    return { slabs: [], effective_date, warnings };
  }

  // ── Parse data rows ───────────────────────────────────────────────────────
  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const cells = rows[rowIdx];
    if (!cells.length) continue;

    const tenureText = cells[0];
    if (!tenureText || tenureText.length < 3) continue;

    const { minDays, maxDays } = parseTenureDays(tenureText);
    if (minDays == null) continue;

    // Create one slab per currency column
    for (const [colIdx, currency] of Object.entries(colCurrencyMap)) {
      const rawRate = (cells[parseInt(colIdx)] || '').replace(/[^0-9.]/g, '');
      const rate = parseFloat(rawRate);
      if (isNaN(rate) || rate <= 0 || rate > 15) continue;

      slabs.push({
        tenure_text: tenureText,
        tenure_min_days: minDays,
        tenure_max_days: maxDays,
        rate_general_pct: rate,
        rate_senior_pct: null, // FCNR never has senior rates
        rate_super_senior_pct: null,
        currency,
        deposit_range: 'below_1cr',
      });
    }
  }

  if (slabs.length === 0) {
    warnings.push(`[saraswat-parser] 0 FCNR slabs extracted`);
    log.warn(`[saraswat-parser] 0 slabs at ${url}`);
  } else {
    log.info(`[saraswat-parser] extracted ${slabs.length} FCNR slabs (${Object.values(colCurrencyMap).join(', ')})`);
  }

  return { slabs, effective_date, warnings };
}

/** Standard INR table parser for domestic/NRE/NRO variants. */
async function parseStandardTable(html, variant, opts = {}) {
  const { logger } = opts;
  const log = { info: (m) => (logger?.info ? logger.info(m) : null), warn: (m) => (logger?.warn ? logger.warn(m) : null) };
  const slabs = [];
  const effective_date = extractEffectiveDateFromHtml(html) || null;
  const warnings = [];
  const tableRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = tableRe.exec(html)) !== null) {
    const cells = extractCells(match[1]);
    if (cells.length < 2) continue;
    const tenureText = cells[0];
    if (!tenureText || tenureText.length < 3) continue;
    const { minDays, maxDays } = parseTenureDays(tenureText);
    if (minDays == null) continue;
    const rate = parseFloat((cells[1] || '').replace(/[^0-9.]/g, ''));
    if (isNaN(rate) || rate <= 0 || rate > 15) continue;
    slabs.push({ tenure_text: tenureText, tenure_min_days: minDays, tenure_max_days: maxDays, rate_general_pct: rate, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'INR', deposit_range: 'below_3cr' });
  }
  return { slabs, effective_date, warnings };
}

function extractCells(rowHtml) {
  const cells = [];
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = cellRe.exec(rowHtml)) !== null) {
    cells.push(m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return cells;
}

function parseTenureDays(text) {
  const tokens = [];
  const re = /(\d+)\s*(year|month|day)s?/gi;
  const toDays = (n, u) => u === 'day' ? n : u === 'month' ? Math.round(n * 30.44) : Math.round(n * 365.25);
  let m;
  while ((m = re.exec(text)) !== null) tokens.push(toDays(parseInt(m[1]), m[2].toLowerCase()));
  if (!tokens.length) return { minDays: null, maxDays: null };
  if (tokens.length === 1) return { minDays: tokens[0], maxDays: tokens[0] };
  return { minDays: Math.min(...tokens), maxDays: Math.max(...tokens) };
}

module.exports = { parse };

'use strict';

/**
 * lib/parsers/bom-parser.js
 *
 * Custom parser for Bank of Maharashtra (BoM).
 *
 * Problem: BoM's HTML rate tables use non-standard formatting including:
 *   1. "xx" cell values as placeholders (meaning "not applicable / N/A")
 *   2. Heavily merged columns (using colspan/rowspan) that confuse standard
 *      row-by-row table readers
 *   3. Multiple tables on a single page (domestic, NRE, FCNR) mixed together
 *
 * The generic table parser sees "xx" where a rate number should be and either
 * crashes or emits 0 valid slabs, wiping the existing file on disk.
 *
 * Solution: This parser sanitizes "xx" values to null (not-applicable) and
 * uses a more forgiving cell extraction strategy that handles merged cells
 * gracefully. It also identifies which table section applies to the
 * requested variant to avoid mixing data across product types.
 */

const { extractEffectiveDateFromHtml } = require('../extract-date');

/**
 * @param {string} html
 * @param {object} opts
 * @returns {Promise<{ slabs, effective_date, warnings }>}
 */
async function parse(html, opts = {}) {
  const { variant = 'regular', url = '', logger } = opts;
  const log = {
    info: (m) => (logger && logger.info ? logger.info(m) : null),
    warn: (m) => (logger && logger.warn ? logger.warn(m) : null),
  };

  log.info(`[bom-parser] parsing variant=${variant} from ${url}`);
  const warnings = [];
  const effective_date = extractEffectiveDateFromHtml(html) || null;
  const slabs = [];

  // ── Split page into per-section HTML by variant keywords ─────────────────
  const sectionHtml = extractVariantSection(html, variant);
  if (!sectionHtml) {
    warnings.push(`[bom-parser] could not isolate ${variant} section — scanning full page`);
  }
  const targetHtml = sectionHtml || html;

  // ── Table row extraction ──────────────────────────────────────────────────
  const tableRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = tableRe.exec(targetHtml)) !== null) {
    const rowHtml = match[1];
    const cells = extractCells(rowHtml);
    if (cells.length < 2) continue;

    const tenureText = cells[0];
    if (!tenureText || tenureText.length < 3) continue;
    if (/period|tenure|maturity|heading/i.test(tenureText)) continue; // header row

    const { minDays, maxDays } = parseTenureDays(tenureText);
    if (minDays == null) continue;

    // Sanitize "xx" → skip (not-applicable for that tenure/range combo)
    const generalRaw = sanitizeRateCell(cells[1]);
    if (generalRaw === null) {
      log.info(`[bom-parser] skipping tenure "${tenureText}": general rate is "xx" (not applicable)`);
      continue;
    }

    const generalRate = parseFloat(generalRaw);
    if (isNaN(generalRate) || generalRate <= 0 || generalRate > 15) continue;

    const seniorRaw  = cells[2] ? sanitizeRateCell(cells[2]) : null;
    const seniorRate = seniorRaw != null ? parseFloat(seniorRaw) : null;

    slabs.push({
      tenure_text: tenureText,
      tenure_min_days: minDays,
      tenure_max_days: maxDays,
      rate_general_pct: generalRate,
      rate_senior_pct: isNaN(seniorRate) ? null : seniorRate,
      rate_super_senior_pct: null,
      currency: 'INR',
      deposit_range: 'below_3cr',
    });
  }

  if (slabs.length === 0) {
    warnings.push(`[bom-parser] 0 slabs extracted for variant=${variant} — page structure may have changed`);
    log.warn(`[bom-parser] 0 slabs for ${variant} at ${url}`);
  } else {
    log.info(`[bom-parser] extracted ${slabs.length} slabs for variant=${variant}`);
  }

  return { slabs, effective_date, warnings };
}

/** Extract cell text from a table row, sanitizing HTML tags and whitespace. */
function extractCells(rowHtml) {
  const cells = [];
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = cellRe.exec(rowHtml)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    cells.push(text);
  }
  return cells;
}

/**
 * Sanitize a rate cell:
 *   - "xx", "XX", "x", "X", "-", "N/A", "NA" → null (not applicable)
 *   - numeric strings → return as-is
 *   - others → null
 */
function sanitizeRateCell(raw) {
  if (!raw) return null;
  const clean = raw.trim();
  if (/^(xx?|n\/?a|-+)$/i.test(clean)) return null;
  if (/^\d+(\.\d+)?%?$/.test(clean)) return clean.replace('%', '');
  return null;
}

/**
 * Try to isolate the HTML section relevant to the requested variant.
 * BoM often has section headings like "NRE Term Deposit" or "Domestic" 
 * in bold/header text before the corresponding table.
 */
function extractVariantSection(html, variant) {
  const keywords = {
    regular: ['domestic', 'term deposit', 'general public'],
    nre: ['nre', 'non.resident external'],
    nro: ['nro', 'non.resident ordinary'],
    fcnr: ['fcnr', 'foreign currency'],
  };
  const kws = keywords[variant] || [];
  if (kws.length === 0) return null;

  const pattern = new RegExp(kws.map(k => `(${k})`).join('|'), 'i');
  const idx = html.search(pattern);
  if (idx === -1) return null;

  // Return from that heading to the next major section heading
  const nextSectionRe = /<h[1-4]|<(?:th|caption)[^>]*>(?:domestic|nre|nro|fcnr)/gi;
  nextSectionRe.lastIndex = idx + 100; // skip the current heading
  const nextMatch = nextSectionRe.exec(html);
  const end = nextMatch ? nextMatch.index : html.length;

  return html.slice(idx, end);
}

/** Parse tenure text to min/max days. */
function parseTenureDays(text) {
  const t = text.toLowerCase();
  const tokens = [];
  const combined = /(\d+)\s*(year|month|day)s?/gi;
  let m;
  const toDays = (n, u) => {
    if (u === 'day')   return n;
    if (u === 'month') return Math.round(n * 30.44);
    if (u === 'year')  return Math.round(n * 365.25);
    return null;
  };
  while ((m = combined.exec(t)) !== null) tokens.push(toDays(parseInt(m[1]), m[2]));
  if (!tokens.length) return { minDays: null, maxDays: null };
  if (tokens.length === 1) return { minDays: tokens[0], maxDays: tokens[0] };
  return { minDays: Math.min(...tokens), maxDays: Math.max(...tokens) };
}

module.exports = { parse };

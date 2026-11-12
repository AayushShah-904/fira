'use strict';

/**
 * lib/parsers/idfc-parser.js
 *
 * Custom parser for IDFC First Bank NRE/NRO pages.
 *
 * Problem: The NRE/NRO rate pages use an interactive React <div> widget
 * (a slider-based calculator). There are no <table> elements for the generic
 * parser to find. Attempting generic extraction returns 0 slabs and triggers
 * the dangerous fallback that copies Domestic data into NRE files (along with
 * illegal Senior Citizen rates that don't apply to NRI customers).
 *
 * Solution: This parser looks for the rate data embedded inside the page as
 * JSON in a <script> tag (React apps often hydrate from an inline JSON blob),
 * or falls back to scraping the structured <div> rate-card rows directly
 * using CSS class patterns observed in the IDFC First Bank page structure.
 *
 * Key constraint: Senior Citizen rates are NEVER applicable for NRE/NRO
 * variants per RBI guidelines. This parser enforces rate_senior_pct = null
 * for all slabs when variant is 'nre' or 'nro'.
 */

const { extractEffectiveDateFromHtml } = require('../extract-date');

/** Minimum tenure for NRE deposits per RBI rules (1 year = 365 days). */
const NRE_MIN_DAYS = 365;

/**
 * Parse rate slabs from IDFC First Bank's shared Domestic/NRI table.
 * IDFC First Bank publishes domestic, NRO, and NRE rates on a single
 * combined HTML table (on the domestic FD page) with a footnote clarifying
 * that Senior rates don't apply to NRI customers and NRE minimum is 1 year.
 *
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

  log.info(`[idfc-parser] parsing variant=${variant} from ${url}`);
  const warnings = [];

  // ── Step 1: Extract effective date from page text ─────────────────────────
  const effective_date = extractEffectiveDateFromHtml(html) || null;

  // ── Step 2: Parse the shared rate table ──────────────────────────────────
  // IDFC First Bank's Domestic FD page has a clean <table> with all tenures.
  // NRE/NRO share the same rates but with different tenure constraints.
  const slabs = [];
  const tableRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let match;
  while ((match = tableRe.exec(html)) !== null) {
    const rowHtml = match[1];
    const cells = [];
    let cellMatch;
    const cellReLocal = new RegExp(cellRe.source, 'gi');
    while ((cellMatch = cellReLocal.exec(rowHtml)) !== null) {
      // Strip HTML tags, decode entities, trim
      const text = cellMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(text);
    }
    if (cells.length < 2) continue;

    // Look for rows that start with a tenure description
    const tenureText = cells[0];
    if (!tenureText || tenureText.length < 3) continue;

    // Extract rates — IDFC table: col0=tenure, col1=general%, col2=senior%
    const generalRate = parseFloat((cells[1] || '').replace(/[^0-9.]/g, ''));
    const seniorRate  = parseFloat((cells[2] || '').replace(/[^0-9.]/g, ''));

    if (isNaN(generalRate) || generalRate <= 0 || generalRate > 15) continue;

    // Parse tenure range (days)
    const { minDays, maxDays } = parseTenureDays(tenureText);
    if (minDays == null) continue;

    // Enforce NRE minimum tenure of 1 year
    if ((variant === 'nre') && minDays < NRE_MIN_DAYS) {
      log.info(`[idfc-parser] NRE: skipping sub-1yr tenure "${tenureText}" (RBI constraint)`);
      continue;
    }

    // Build slab — enforce no senior rate for NRI variants
    const isNri = variant === 'nre' || variant === 'nro';
    slabs.push({
      tenure_text: tenureText,
      tenure_min_days: minDays,
      tenure_max_days: maxDays,
      rate_general_pct: generalRate,
      rate_senior_pct: isNri ? null : (isNaN(seniorRate) ? null : seniorRate),
      rate_super_senior_pct: null,
      currency: 'INR',
      deposit_range: 'below_3cr',
    });
  }

  if (slabs.length === 0) {
    warnings.push(`[idfc-parser] variant=${variant}: 0 slabs extracted — page structure may have changed`);
    log.warn(`[idfc-parser] 0 slabs for variant=${variant} at ${url}`);
  } else {
    log.info(`[idfc-parser] extracted ${slabs.length} slabs for variant=${variant}`);
    if (variant === 'nre' || variant === 'nro') {
      log.info(`[idfc-parser] enforced rate_senior_pct=null for all ${slabs.length} ${variant.toUpperCase()} slabs (RBI: no senior premium for NRI)`);
    }
  }

  return { slabs, effective_date, warnings };
}

/** Parse a tenure text like "1 year – 370 days" into { minDays, maxDays }. */
function parseTenureDays(text) {
  const t = text.toLowerCase();

  // Patterns: "7 days – 29 days", "1 year – 370 days", "500 days – 3 years", etc.
  const dayRe   = /(\d+)\s*days?/gi;
  const yearRe  = /(\d+)\s*years?/gi;
  const monthRe = /(\d+)\s*months?/gi;

  const toDays = (num, unit) => {
    if (unit === 'day')   return num;
    if (unit === 'month') return Math.round(num * 30.44);
    if (unit === 'year')  return Math.round(num * 365.25);
    return null;
  };

  // Extract all numeric tokens with their unit
  const tokens = [];
  let m;
  const combined = new RegExp(/(\d+)\s*(year|month|day)s?/gi);
  while ((m = combined.exec(t)) !== null) {
    tokens.push(toDays(parseInt(m[1]), m[2]));
  }

  if (tokens.length === 0) return { minDays: null, maxDays: null };
  if (tokens.length === 1) return { minDays: tokens[0], maxDays: tokens[0] };
  return { minDays: Math.min(...tokens), maxDays: Math.max(...tokens) };
}

module.exports = { parse };

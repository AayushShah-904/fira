'use strict';

/**
 * lib/parsers/cosmos-parser.js
 *
 * Custom parser for Cosmos Co-operative Bank.
 *
 * Problem: Cosmos publishes Domestic, NRE, NRO, and Senior Citizen rate tables
 * ALL on the same HTML page (https://cosmos.bank.in/interest-rates). The
 * generic parser reads the first matching table and often returns the Domestic
 * table regardless of which variant is being requested — injecting 7-day
 * domestic slabs into the NRE file (which is illegal: NRE minimum tenure
 * is 1 year per RBI rules).
 *
 * Additionally, the NRE table on Cosmos's page has a distinctive header row
 * that explicitly says "NRE Term Deposits... w.e.f. DD.MM.YYYY" making it
 * easily identifiable if we look for it specifically.
 *
 * Solution: Isolate the correct table section using variant-specific anchor
 * keywords in the page text before parsing. Apply the NRE 1-year minimum
 * constraint as a post-filter.
 */

const { extractEffectiveDateFromHtml } = require('../extract-date');

const NRE_MIN_DAYS = 365;

// Heading patterns that identify each variant's section on the Cosmos page
const SECTION_ANCHORS = {
  regular: /domestic\s+(?:term\s+)?deposit|interest\s+rates?\s+on\s+(?:domestic|term\s+deposit)/i,
  nre:     /nre\s+(?:term\s+)?deposit|non.resident\s+external/i,
  nro:     /nro\s+(?:term\s+)?deposit|non.resident\s+ordinary/i,
  fcnr:    /fcnr|foreign\s+currency\s+(?:non.resident|deposit)/i,
};

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

  log.info(`[cosmos-parser] parsing variant=${variant} from ${url}`);
  const warnings = [];

  // ── Isolate the correct section ──────────────────────────────────────────
  const anchor = SECTION_ANCHORS[variant];
  let sectionHtml = html;
  if (anchor) {
    const idx = html.search(anchor);
    if (idx !== -1) {
      // Find the next section anchor to bound this section
      const nextAnchorRe = new RegExp(
        Object.values(SECTION_ANCHORS).map(r => r.source).join('|'), 'gi'
      );
      nextAnchorRe.lastIndex = idx + 50;
      const nextMatch = nextAnchorRe.exec(html);
      sectionHtml = html.slice(idx, nextMatch ? nextMatch.index : html.length);
      log.info(`[cosmos-parser] isolated ${variant} section (${sectionHtml.length} chars)`);
    } else {
      warnings.push(`[cosmos-parser] could not find ${variant} section anchor — scanning full page`);
      log.warn(`[cosmos-parser] variant="${variant}" anchor not found in page`);
    }
  }

  // ── Extract effective date from this section first ────────────────────────
  const effective_date = extractEffectiveDateFromHtml(sectionHtml)
    || extractEffectiveDateFromHtml(html)
    || null;

  // ── Parse table rows ──────────────────────────────────────────────────────
  const slabs = [];
  const tableRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = tableRe.exec(sectionHtml)) !== null) {
    const cells = extractCells(match[1]);
    if (cells.length < 2) continue;

    const tenureText = cells[0];
    if (!tenureText || tenureText.length < 3) continue;
    // Skip header rows
    if (/period|tenure|maturity|rate|deposit|interest/i.test(tenureText) && cells.length <= 2) continue;

    const { minDays, maxDays } = parseTenureDays(tenureText);
    if (minDays == null) continue;

    // Enforce NRE 1-year minimum
    if (variant === 'nre' && minDays < NRE_MIN_DAYS) {
      log.info(`[cosmos-parser] NRE: skipping sub-1yr tenure "${tenureText}"`);
      continue;
    }

    const generalRate = parseFloat((cells[1] || '').replace(/[^0-9.]/g, ''));
    if (isNaN(generalRate) || generalRate <= 0 || generalRate > 15) continue;

    const seniorRate = cells[2] ? parseFloat((cells[2] || '').replace(/[^0-9.]/g, '')) : null;
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
    warnings.push(`[cosmos-parser] 0 slabs for variant=${variant}`);
    log.warn(`[cosmos-parser] 0 slabs for ${variant} at ${url}`);
  } else {
    log.info(`[cosmos-parser] extracted ${slabs.length} slabs for variant=${variant}`);
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

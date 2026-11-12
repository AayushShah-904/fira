'use strict';

/**
 * PDF rate-line parsers used by scripts/extract_rates_pdf.mjs.
 *
 * Two entry points:
 *   - parseRateLines(lines): legacy 3-column regex (general/senior/super-senior)
 *   - parseRateLinesWithHint(lines, pageHint): M2.3 (sprint-004 2026-05-21)
 *     column-aware parser that emits one slab per (tenure × column) when a
 *     per-page hint declares the column layout. Supports arbitrary column
 *     counts (Axis page 1 has 4; Axis pages 2-3 have 7).
 *
 * Extracted to a CJS module so unit tests can require() it directly without
 * dynamic-importing the ESM extract_rates_pdf.mjs script.
 */

const { parseTenure } = require('./parse-tenure.js');
const { validateRate } = require('./validate-rates.js');

// Pattern: tenure range + percentage(s)
// Examples:
//   "7-10 Days \t 1.80% \t -"
//   "91 days to 180 days \t 6.50% \t 7.00%"
//   "1 year \t 6.75 \t 7.25"
//   ">=1096 Days \t 1.75%"
//
// HISTORICAL NOTE (discovered 2026-05-21 during M2.3): the `\s*` after the
// first captured rate (`(\d+\.\d+)\s*%?\s*`) consumes any tabs separating
// it from the next rate value, leaving the optional groups for rate 2 and
// rate 3 unmatched. So in practice this regex only ever populated
// rate_general_pct; rate_senior_pct and rate_super_senior_pct were null
// regardless of what's in the PDF. M2.3's parseRateLinesWithHint is the
// first PDF path that captures multi-column rate data reliably.
const RATE_LINE_PATTERN = /^(.+?(?:days?|months?|years?|yrs?|mos?|wks?).*?)\t+\s*(\d+\.\d+)\s*%?\s*(?:\t+\s*(\d+\.\d+)\s*%?)?\s*(?:\t+\s*(\d+\.\d+)\s*%?)?/i;

// Tenure patterns for normalization
// "7-10 Days" → "7 days to 10 days"
// "732 - 1095 Days" → "732 days to 1095 days"
// ">=1096 Days" → "1096 days"
function normalizeTenureText(raw) {
  let text = raw.trim().replace(/(\d)\s+(?=\d)/g, '$1');

  // ">=X Days" or "> X Days" → "X days and above"
  const gteMatch = text.match(/^>=?\s*(\d+)\s*(days?|months?|years?)/i);
  if (gteMatch) {
    return `${gteMatch[1]} ${gteMatch[2].toLowerCase()} and above`;
  }

  // Insert space between digits and unit if missing: "07days" → "07 days", "45Days" → "45 Days"
  text = text.replace(/(\d)(days?|months?|years?)/gi, "$1 $2");

  // "X-Y Days" or "X - Y Days" or "X days-Y days" → "X days to Y days"
  //
  // M2.6 (sprint-004 2026-05-21): only apply this substitution when both
  // halves of the range share the same unit (or the left half is unit-less).
  // Axis page 1 has tenures like "88 days – 3 months 24 days" where the LHS
  // unit ("days") differs from the RHS leading unit ("months") — the old
  // regex would rewrite this to "88 months to 3 months" because it captured
  // "months" as the shared unit, then parseTenure read 88*30=2640 days as
  // min and 3*30=90 days as max → inverted. Defer to parseTenure's
  // multi-unit logic for mixed-unit ranges; only normalise when units match.
  // Also bail when the suffix has trailing tokens (e.g., "...24 days" after
  // "3 months") because that's a same-unit range with a finer second bound.
  const dashRangeFull = text.match(/^(\d+)\s*(days?|months?|years?)?\s*[-–]\s*(\d+)\s+(days?|months?|years?)(?:\s|$)(.*)$/i);
  if (dashRangeFull) {
    const leftUnit  = (dashRangeFull[2] || '').toLowerCase();
    const rightUnit = dashRangeFull[4].toLowerCase();
    const trailing  = (dashRangeFull[5] || '').trim();
    const unitsCompatible = !leftUnit || leftUnit.replace(/s$/, '') === rightUnit.replace(/s$/, '');
    if (unitsCompatible && !trailing) {
      return `${dashRangeFull[1]} ${rightUnit} to ${dashRangeFull[3]} ${rightUnit}`;
    }
  }

  // "> X unit" → "X unit and above"
  const gtMatch = text.match(/^>\s*(\d+)\s*(days?|months?|years?)/i);
  if (gtMatch) {
    return `${parseInt(gtMatch[1], 10) + 1} ${gtMatch[2].toLowerCase()} and above`;
  }

  return text;
}

function parseRateLines(lines) {
  const slabs = [];
  const warnings = [];

  for (const line of lines) {
    const match = line.match(RATE_LINE_PATTERN);
    if (!match) continue;

    const rawTenure = match[1].trim();
    const rate1 = parseFloat(match[2]);
    const rate2 = match[3] ? parseFloat(match[3]) : null;
    const rate3 = match[4] ? parseFloat(match[4]) : null;

    // Skip header-like lines
    if (/^(in\s+days|tenor|tenure|period|p\.a\.|annuali[sz]ed)/i.test(rawTenure)) continue;

    // Normalize and parse tenure
    const normalized = normalizeTenureText(rawTenure);
    const tenure = parseTenure(normalized);

    const slab = {
      tenure_text: rawTenure,
      tenure_min_days: tenure ? tenure.minDays : null,
      tenure_max_days: tenure ? tenure.maxDays : null,
      rate_general_pct: rate1,
      rate_senior_pct: rate2,
      rate_super_senior_pct: rate3,
    };

    // Validate rates
    const rv = validateRate(rate1, "general");
    if (!rv.valid) warnings.push(...rv.warnings);

    if (!tenure) {
      warnings.push(`Could not parse tenure: "${rawTenure}" (normalized: "${normalized}")`);
    }

    slabs.push(slab);
  }

  return { slabs, warnings };
}

/**
 * M2.3 (sprint-004 2026-05-21) — column-aware parser used when a per-page
 * hint declares the column layout. Splits each line positionally and emits
 * one slab per (tenure × column), labelled with the column's `age_tier`
 * and `deposit_range`.
 *
 * Why positional split: the legacy RATE_LINE_PATTERN regex caps at 3 rate
 * captures, so 4-column-or-more layouts (Axis page 1 has 4: general<3cr,
 * general 3-5cr, senior<3cr, senior 3-5cr; pages 2-3 have 7 bulk-tier
 * columns) lose data. Positional split handles arbitrary column counts.
 */
function parseRateLinesWithHint(lines, pageHint) {
  const warnings = [];
  const columns = Array.isArray(pageHint.columns) ? pageHint.columns : [];
  if (columns.length === 0) {
    // Preserve our "falling back" warning by merging into the fallback's
    // result rather than throwing it away by returning parseRateLines' value
    // directly.
    const fallback = parseRateLines(lines);
    return {
      slabs: fallback.slabs,
      warnings: ['Page hint had no columns; falling back to no-hint parse.', ...fallback.warnings],
    };
  }

  const slabs = [];
  const NUMBER_RE = /(\d+(?:\.\d+)?)\s*%?/g;
  for (const line of lines) {
    if (pageHint.stop_at && new RegExp(pageHint.stop_at, 'i').test(line)) break;
    if (!/days?|months?|years?|yrs?|mos?|wks?/i.test(line)) continue;
    if (/^(in\s+days|tenor|tenure|period|p\.a\.|annuali[sz]ed)/i.test(line.trim())) continue;
    if (!/[a-zA-Z]/.test(line)) continue;

    let healedLine = line
      .replace(/(\b\d{1,2})\s*\.\s*(\d)\s*(\d)\b/g, '$1.$2$3')
      .replace(/(\b\d{1,2})\s*\.\s*(\d{1,2})\b/g, '$1.$2');
    const numbers = [];
    let m;
    NUMBER_RE.lastIndex = 0;
    while ((m = NUMBER_RE.exec(healedLine)) !== null) numbers.push({ value: parseFloat(m[1]), index: m.index });
    if (numbers.length < columns.length + 1) continue;

    // First N numbers may be part of the tenure text (e.g. "7 14 days" → 7, 14).
    // Pick the LAST `columns.length` numeric tokens as the rate cells.
    const rateNumbers = numbers.slice(-columns.length).map((n) => n.value);
    const firstRateIdx = numbers[numbers.length - columns.length].index;
    const rawTenure = healedLine.slice(0, firstRateIdx).trim().replace(/\t+/g, " ").replace(/\s+/g, " ");
    if (!rawTenure) continue;

    const normalized = normalizeTenureText(rawTenure);
    const tenure = parseTenure(normalized);
    if (!tenure) {
      warnings.push(`Could not parse tenure (hint path): "${rawTenure}" (normalized: "${normalized}")`);
    }

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (col.ignore) continue;
      const rate = rateNumbers[i];
      if (!Number.isFinite(rate)) continue;

      const slab = {
        tenure_text: rawTenure,
        tenure_min_days: tenure ? tenure.minDays : null,
        tenure_max_days: tenure ? tenure.maxDays : null,
        rate_general_pct: col.age_tier === "general" ? rate : null,
        rate_senior_pct: col.age_tier === "senior" ? rate : null,
        rate_super_senior_pct: col.age_tier === "super_senior" ? rate : null,
        deposit_range: col.deposit_range || null,
      };
      // Sprint 004 FCNR-1 (2026-05-22): when the column hint declares a
      // currency (FCNR / GIFT PDF where each column is a different
      // currency), tag the slab. Required by the slab schema for FCNR
      // and GIFT variants per CLAUDE.md.
      if (col.currency) slab.currency = col.currency;
      const rv = validateRate(rate, col.age_tier || "general");
      if (!rv.valid) warnings.push(...rv.warnings);
      slabs.push(slab);
    }
  }

  return { slabs, warnings };
}

module.exports = {
  RATE_LINE_PATTERN,
  normalizeTenureText,
  parseRateLines,
  parseRateLinesWithHint,
};

'use strict';

/**
 * Heading-text → deposit_range enum mapper.
 *
 * Pure function. Used by `lib/actions/extract_html_table.js`'s multi-table
 * accumulator (Orch-1, sprint-004 2026-05-21) to derive each rate table's
 * `deposit_range` from the nearest preceding heading.
 *
 * Bank-agnostic. The recognised heading shapes are general Indian-banking
 * conventions (₹ N Cr ranges with "<" / "≤" / "above" / "to" connectors,
 * with/without the rupee glyph, with/without spaces). Returns `null` when
 * the heading is absent or doesn't contain a recognisable amount range —
 * the caller (usually the slab emitter in extract_html_table) chooses a
 * safe default.
 *
 * Recognised enum values match `pack/build-pack.js#enums.deposit_ranges`
 * (extended in M2.3 with the fine-grained bulk buckets).
 */

// Connector between the two numbers in a range. Allows the literal
// "to" / dash / hyphen / less-than-or-equal / less-than, optionally
// followed by another `<` (so "3 Crore To < ₹5 Crores" matches by
// "To" then ignoring the extra `<` before "5").
const CONNECTOR = '(?:to|–|-|≤|<=|<)\\s*<?';

function rangeRe(loNum, hiNum) {
  // Lo number, optional cr/crore unit, connector, optional rupee glyph, hi number, cr/crore unit
  const hiStr = String(hiNum).replace(/,/g, '[,\\s]*');
  return new RegExp(`\\b${loNum}\\s*(?:cr|crore|crores?)?\\s*${CONNECTOR}\\s*₹?\\s*${hiStr}\\s*(?:cr|crore|crores?)\\b`, 'i');
}

const RANGES = [
  // Order matters: the first match wins. More specific patterns before
  // generic catch-alls.

  // > 1000 cr and above
  { range: 'above_1000cr', re: /(?:>|above|over|>=|≥)\s*₹?\s*1[,\s]*000\s*(?:cr|crore|crores?)\b/i },
  // 500 - 1000 cr
  { range: '500cr_to_1000cr', re: rangeRe(500, '1,000') },
  // 200 - 500 cr
  { range: '200cr_to_500cr', re: rangeRe(200, 500) },
  // 100 - 200 cr
  { range: '100cr_to_200cr', re: rangeRe(100, 200) },
  // 50 - 100 cr
  { range: '50cr_to_100cr', re: rangeRe(50, 100) },
  // 25 - 50 cr
  { range: '25cr_to_50cr', re: rangeRe(25, 50) },
  // 25 - 100 cr (coarse bucket; check AFTER finer 25-50 and 50-100 to avoid stealing matches)
  { range: '25cr_to_100cr', re: rangeRe(25, 100) },
  // 5 - 25 cr
  { range: '5cr_to_25cr', re: rangeRe(5, 25) },
  // 3 - 5 cr
  { range: '3cr_to_5cr', re: rangeRe(3, 5) },
  // > 100 cr (after the finer ranges so they win when both could match)
  { range: 'above_100cr', re: /(?:>|above|over|>=|≥)\s*₹?\s*100\s*(?:cr|crore|crores?)\b/i },
  // < 3 cr / below 3 cr / less than 3 cr
  { range: 'below_3cr', re: /(?:<|below|less\s*than|under)\s*₹?\s*3\s*(?:cr|crore|crores?)\b/i },
];

/**
 * Map a heading string to one of the canonical `deposit_ranges` enum values.
 *
 * @param {string|null|undefined} heading
 * @returns {string|null} a canonical deposit_range enum value or null
 */
function headingToDepositRange(heading) {
  if (heading == null) return null;
  if (typeof heading !== 'string') return null;
  const text = heading.trim();
  if (text.length === 0) return null;

  for (const { range, re } of RANGES) {
    if (re.test(text)) return range;
  }
  return null;
}

module.exports = { headingToDepositRange };

'use strict';

/**
 * Canonical 3-letter ISO codes for currencies banks publish FCNR/GIFT
 * rates in. Some banks emit "EURO" (→ EUR), "YEN" (→ JPY), or attach
 * deposit-tier suffixes like "USD (Above 5L)" — `normaliseCurrency`
 * strips both to a canonical form so dedup + pack-build treat them as
 * one currency.
 *
 * Originally embedded in `lib/actions/extract_via_ocr.js` (FCNR-1);
 * promoted to a shared module by FCNR-4a so the HTML extractor can
 * apply the same normalisation to LLM-emitted slabs.
 */

const CURRENCY_ALIASES = Object.freeze({
  EUR: 'EUR', EURO: 'EUR',
  USD: 'USD', USDOLLAR: 'USD',
  GBP: 'GBP', POUND: 'GBP', STERLING: 'GBP',
  JPY: 'JPY', YEN: 'JPY',
  CAD: 'CAD',
  AUD: 'AUD',
  SGD: 'SGD',
  CHF: 'CHF',
  HKD: 'HKD',
  NZD: 'NZD',
  DKK: 'DKK',
  SEK: 'SEK',
  NOK: 'NOK',
  AED: 'AED',  // UAE Dirham — FCNR-eligible per RBI
  QAR: 'QAR',  // Qatari Riyal
  SAR: 'SAR',  // Saudi Riyal
  KWD: 'KWD',  // Kuwaiti Dinar
  OMR: 'OMR',  // Omani Rial
  BHD: 'BHD',  // Bahraini Dinar
});

/**
 * @param {string|null|undefined} text
 * @returns {string|null} canonical 3-letter ISO code, or null when the
 *   input doesn't recognisably contain one.
 */
function normaliseCurrency(text) {
  if (!text) return null;
  // Strip "(Above 5L)" / "below 5L" / similar tier suffixes wrapped in parens
  const clean = String(text)
    .replace(/[\(].*?[\)]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .trim();
  if (!clean) return null;
  return CURRENCY_ALIASES[clean] || null;
}

/**
 * Fix A (sprint-011, fcnr-yield-root-cause-2026-07-07) — free-text
 * currency-token detection for chunk scoring.
 *
 * `normaliseCurrency` is a whole-cell normaliser (letter-collapse + alias
 * lookup); it can't scan running text. This helper detects which distinct
 * canonical currencies appear anywhere in a blob of visible page text.
 *
 * Two detection layers, both word-boundaried:
 *   1. ISO codes — UPPERCASE-ONLY, case-sensitive match of the canonical
 *      codes from CURRENCY_ALIASES. Case-sensitivity + \b guards against
 *      false hits inside ordinary words ("audit" ≠ AUD, "CASCADE" ≠ CAD,
 *      "scad"/"aud" lowercase never match).
 *   2. Spelled-out names — case-insensitive ("US Dollar", "Pound",
 *      "Sterling", "Euro", "Yen", "Canadian Dollar", …). Some banks (jkb
 *      observed 2026-07-07) render currency grids with names only and ZERO
 *      ISO codes. Bare "Dollar" without a nationality qualifier is
 *      deliberately NOT counted — it's ambiguous across USD/CAD/AUD/SGD/HKD.
 */
const CURRENCY_NAME_PATTERNS = Object.freeze([
  { re: /\bU\.?\s*S\.?\s+Dollars?\b/i, code: 'USD' },
  { re: /\bAmerican\s+Dollars?\b/i, code: 'USD' },
  { re: /\bPound(?:\s+Sterling)?s?\b/i, code: 'GBP' },
  { re: /\bSterling\b/i, code: 'GBP' },
  { re: /\bBritish\s+Pounds?\b/i, code: 'GBP' },
  { re: /\bEuros?\b/i, code: 'EUR' },
  { re: /\b(?:Japanese\s+)?Yen\b/i, code: 'JPY' },
  { re: /\bCanadian\s+Dollars?\b/i, code: 'CAD' },
  { re: /\bAustralian\s+Dollars?\b/i, code: 'AUD' },
  { re: /\bSwiss\s+Francs?\b/i, code: 'CHF' },
  { re: /\bSingapore\s+Dollars?\b/i, code: 'SGD' },
  { re: /\bHong\s*Kong\s+Dollars?\b/i, code: 'HKD' },
  { re: /\bNew\s+Zealand\s+Dollars?\b/i, code: 'NZD' },
  { re: /\b(?:UAE\s+)?Dirhams?\b/i, code: 'AED' },
]);

// Built once from the canonical alias VALUES so the code list can never
// drift from CURRENCY_ALIASES. Case-SENSITIVE by design (see doc above).
const CURRENCY_CODE_RE = new RegExp(
  `\\b(${[...new Set(Object.values(CURRENCY_ALIASES))].join('|')})\\b`,
  'g',
);

/**
 * @param {string|null|undefined} text — visible (tag-stripped) page text
 * @returns {Set<string>} distinct canonical ISO codes detected (may be empty)
 */
function detectCurrencyTokens(text) {
  const found = new Set();
  if (!text || typeof text !== 'string') return found;
  CURRENCY_CODE_RE.lastIndex = 0;
  let m;
  while ((m = CURRENCY_CODE_RE.exec(text)) !== null) found.add(m[1]);
  for (const { re, code } of CURRENCY_NAME_PATTERNS) {
    if (re.test(text)) found.add(code);
  }
  return found;
}

module.exports = { normaliseCurrency, CURRENCY_ALIASES, CURRENCY_NAME_PATTERNS, detectCurrencyTokens };

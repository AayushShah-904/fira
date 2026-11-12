/**
 * Standard tenure text → min/max days normalization mappings.
 * Used by scrapers and validators to convert human-readable tenure
 * descriptions to day counts.
 *
 * Banks use inconsistent terminology. This map covers common patterns.
 */
export interface TenureMapping {
  minDays: number;
  maxDays: number;
}

/**
 * Common tenure patterns found across Indian bank rate tables.
 * Keys are normalized lowercase patterns; values are day ranges.
 */
export const TENURE_PRESETS: Record<string, TenureMapping> = {
  "7 days to 14 days": { minDays: 7, maxDays: 14 },
  "15 days to 29 days": { minDays: 15, maxDays: 29 },
  "15 days to 45 days": { minDays: 15, maxDays: 45 },
  "7 days to 45 days": { minDays: 7, maxDays: 45 },
  "30 days to 45 days": { minDays: 30, maxDays: 45 },
  "46 days to 90 days": { minDays: 46, maxDays: 90 },
  "46 days to 179 days": { minDays: 46, maxDays: 179 },
  "91 days to 180 days": { minDays: 91, maxDays: 180 },
  "180 days to 210 days": { minDays: 180, maxDays: 210 },
  "181 days to 270 days": { minDays: 181, maxDays: 270 },
  "211 days to less than 1 year": { minDays: 211, maxDays: 364 },
  "271 days to less than 1 year": { minDays: 271, maxDays: 364 },
  "1 year": { minDays: 365, maxDays: 365 },
  "1 year to less than 2 years": { minDays: 365, maxDays: 729 },
  "1 year to 2 years": { minDays: 365, maxDays: 730 },
  "above 1 year to 2 years": { minDays: 366, maxDays: 730 },
  "2 years to less than 3 years": { minDays: 730, maxDays: 1094 },
  "2 years to 3 years": { minDays: 730, maxDays: 1095 },
  "3 years to less than 5 years": { minDays: 1095, maxDays: 1824 },
  "3 years to 5 years": { minDays: 1095, maxDays: 1825 },
  "5 years to 10 years": { minDays: 1825, maxDays: 3650 },
  "5 years and above": { minDays: 1825, maxDays: 3650 },
  "above 5 years to 10 years": { minDays: 1826, maxDays: 3650 },
};

/** Unit multipliers for converting tenure units to days */
export const TENURE_UNIT_DAYS: Record<string, number> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  month: 30,
  months: 30,
  year: 365,
  years: 365,
};

/** Upper bound used when a tenure is open-ended ("above 5 years", ">10 years"). */
const OPEN_UPPER_DAYS = 3650;

const UNIT = "(days?|weeks?|months?|years?)";

/**
 * Parses a tenure text string into a min/max day range.
 *
 * Handles canonical preset strings, single-value tenures, ranges, and the long
 * tail of real-world bank phrasings: hyphen separators (`7-14 Days`, en/em-dash),
 * abbreviated units (`5Y`, `22 Month`), parenthetical qualifiers
 * (`375 Days (Callable)`), comparator symbols (`>2 years`, `<10 months`),
 * compound bounds (`> 22 Month < 2Y`), `Above`/`More than`/`upto` phrasings,
 * and tenure strings where only one side carries the unit (`180 – 364 Days`).
 *
 * Returns null if parsing fails — caller should flag for manual review.
 */
export function parseTenureText(text: string): TenureMapping | null {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // Fast path: canonical strings from the preset map.
  if (lower in TENURE_PRESETS) return TENURE_PRESETS[lower];

  // Normalize: collapse the many ways Indian banks write the same tenure into a
  // single canonical form before running matchers.
  let norm = lower
    // Unicode en/em-dash → ASCII hyphen.
    .replace(/[–—]/g, "-")
    // Strip parenthetical qualifiers (e.g. "(Callable)", "(PSB Green Earth)").
    .replace(/\([^)]*\)/g, " ")
    // Strip stray asterisks ("(Non-Callable*)" footnote markers).
    .replace(/\*/g, " ")
    // Insert a space between digit and adjacent letter ("30Days" → "30 Days").
    .replace(/(\d)([a-z])/g, "$1 $2")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim()
    // Expand single-letter unit abbreviations only when isolated.
    .replace(/\b(\d+)\s+y\b/g, "$1 years")
    .replace(/\b(\d+)\s+m\b/g, "$1 months")
    .replace(/\b(\d+)\s+d\b/g, "$1 days")
    // Phrasing aliases.
    .replace(/\bmore\s+than\b/g, "above")
    .replace(/\bupto\b/g, "up to")
    .replace(/\bup\s+to\s+less\s+than\b/g, "to less than")
    .replace(/\bup\s+to\b/g, "to")
    .replace(/\band\s+to\b/g, "to")
    .replace(/\band\s+less\s+than\b/g, "less than")
    .replace(/\bbut\s+less\s+than\b/g, "less than")
    // Collapse "- to" (left over from "- up to") into a single "to" separator.
    .replace(/-\s*to\b/g, "to")
    // Strip leading "for " ("For 1 year" → "1 year").
    .replace(/^for\s+/g, "")
    // Comparator symbols → words. Use surrounding-space replace so "5Y<66 Month"
    // becomes "5 years less than 66 months" (not "5 yearsless than ...").
    .replace(/\s*>\s*/g, " above ")
    .replace(/\s*<\s*/g, " less than ")
    .replace(/\s+/g, " ")
    .trim();

  // Re-check the preset map after normalization (some normalized forms align).
  if (norm in TENURE_PRESETS) return TENURE_PRESETS[norm];

  // "above X unit less than Y unit" — compound (covers `> X < Y` after normalization).
  const between = norm.match(
    new RegExp(`^above\\s+(\\d+)\\s*${UNIT}\\s+less\\s+than\\s+(\\d+)\\s*${UNIT}$`),
  );
  if (between) {
    const x = parseInt(between[1], 10);
    const y = parseInt(between[3], 10);
    const minDays = x * (TENURE_UNIT_DAYS[between[2]] ?? 1) + 1;
    const maxDays = y * (TENURE_UNIT_DAYS[between[4]] ?? 1) - 1;
    return { minDays, maxDays };
  }

  // "X unit less than Y unit" — implicit range (no `to`/`-` separator).
  // Equitas SFB tables use this form ("9 months < 10 months").
  const lessThanRange = norm.match(
    new RegExp(`^(\\d+)\\s*${UNIT}\\s+less\\s+than\\s+(\\d+)\\s*${UNIT}$`),
  );
  if (lessThanRange) {
    const x = parseInt(lessThanRange[1], 10);
    const y = parseInt(lessThanRange[3], 10);
    return {
      minDays: x * (TENURE_UNIT_DAYS[lessThanRange[2]] ?? 1),
      maxDays: y * (TENURE_UNIT_DAYS[lessThanRange[4]] ?? 1) - 1,
    };
  }

  // Range: "X[unit?] (to|-) [less than] Y unit". First unit is optional —
  // banks often write "7 - 14 Days" with the unit only at the end.
  const range = norm.match(
    new RegExp(
      `^(?:above\\s+)?(\\d+)(?:\\s*${UNIT})?\\s*(?:to|-)\\s*(?:less\\s+than\\s+)?(\\d+)\\s*${UNIT}$`,
    ),
  );
  if (range) {
    const minValue = parseInt(range[1], 10);
    const maxValue = parseInt(range[3], 10);
    const minUnit = range[2] ?? range[4];
    const maxUnit = range[4];
    let minDays = minValue * (TENURE_UNIT_DAYS[minUnit] ?? 1);
    let maxDays = maxValue * (TENURE_UNIT_DAYS[maxUnit] ?? 1);
    if (norm.startsWith("above")) minDays += 1;
    if (norm.includes("less than")) maxDays -= 1;
    return { minDays, maxDays };
  }

  // "above X unit" — single-bound above (open upper).
  const aboveOnly = norm.match(new RegExp(`^above\\s+(\\d+)\\s*${UNIT}$`));
  if (aboveOnly) {
    const value = parseInt(aboveOnly[1], 10);
    return {
      minDays: value * (TENURE_UNIT_DAYS[aboveOnly[2]] ?? 1) + 1,
      maxDays: OPEN_UPPER_DAYS,
    };
  }

  // "less than X unit" — single-bound less-than (zero lower).
  const lessOnly = norm.match(new RegExp(`^less\\s+than\\s+(\\d+)\\s*${UNIT}$`));
  if (lessOnly) {
    const value = parseInt(lessOnly[1], 10);
    return {
      minDays: 0,
      maxDays: value * (TENURE_UNIT_DAYS[lessOnly[2]] ?? 1) - 1,
    };
  }

  // Single value: "X unit" (e.g. "777 days", "5 years", "22 month").
  const single = norm.match(new RegExp(`^(\\d+)\\s*${UNIT}$`));
  if (single) {
    const value = parseInt(single[1], 10);
    const days = value * (TENURE_UNIT_DAYS[single[2]] ?? 1);
    return { minDays: days, maxDays: days };
  }

  return null;
}

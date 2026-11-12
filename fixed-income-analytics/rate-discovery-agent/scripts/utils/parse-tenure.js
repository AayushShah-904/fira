/**
 * Parse tenure text into min/max day ranges.
 *
 * Canonical implementation: packages/shared/src/constants/tenure-maps.ts
 * This is a CommonJS port for use by the rate-discovery-agent scripts.
 *
 * Handles patterns like:
 *   "7 days to 14 days"          → { minDays: 7, maxDays: 14 }
 *   "1 year to less than 2 years"→ { minDays: 365, maxDays: 729 }
 *   "above 5 years"              → { minDays: 1826, maxDays: 3650 }
 *   "365 days"                   → { minDays: 365, maxDays: 365 }
 *   "444 days" (special tenure)  → { minDays: 444, maxDays: 444 }
 */

const TENURE_PRESETS = {
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
  // Sprint 010 K (2026-06-09): explicit overnight / single-day forms.
  // Surfaced by barclays-bank-plc/regular which had "Overnight" 7.7 %
  // emitted with tenure_min/max=null in the n55y5dr cohort.
  "overnight": { minDays: 1, maxDays: 1 },
  "1 day": { minDays: 1, maxDays: 1 },
};

const TENURE_UNIT_DAYS = {
  // Day variants
  day: 1, days: 1, d: 1,
  // Week variants
  week: 7, weeks: 7, wk: 7, wks: 7,
  // Month variants — bare "m" added 2026-05-24 for BoB bulk-deposit cells
  // like "Above 1Y to 15M". The risk that "5 m" could mean "minutes" in
  // operational copy is low in tenure-cell context (banks rarely talk about
  // minutes in rate cards). If false positives emerge from other banks,
  // narrow this back out and add bank-specific overrides.
  month: 30, months: 30, mo: 30, mos: 30, m: 30,
  // Year variants
  year: 365, years: 365, yr: 365, yrs: 365, y: 365,
};

// Single character class for all unit forms — derived from TENURE_UNIT_DAYS
// keys so the regexes stay in sync if we add more aliases later. Sorted
// longest-first so multi-char tokens match before their prefixes (e.g.,
// "months" before "month" before "mo").
const UNIT_RE = '(?:days?|weeks?|months?|years?|yrs?|mos?|wks?|d|y|m)';

/**
 * Sum a compound tenure expression like "2 Years 1 Day" into days.
 * Scans all `N unit` tokens in the input and adds them up. Returns 0 if
 * no tokens match — caller should treat as parse failure.
 *
 * Excludes single-letter abbreviations (`d`, `y`) because they collide
 * with normal word boundaries — "5 d" inside a larger phrase like
 * "5 days" would double-count. Callers needing single-letter support
 * combine this with singleAbbrevDays().
 */
function sumUnitTokens(text) {
  if (!text) return 0;
  // Single-letter aliases (d/y/m) added 2026-05-24 so compound expressions
  // like "above 5y" / "15m" parse without depending on singleAbbrevDays
  // (which only fires for standalone tokens at end-of-string). Required
  // for BoB bulk cells: "Above 1Y to 15M", "Above 15M to 2Y" etc.
  const re = /(\d+)\s*(days?|weeks?|months?|years?|yrs?|mos?|wks?|d|y|m)\b/gi;
  let total = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    total += value * (TENURE_UNIT_DAYS[unit] || 1);
  }
  return total;
}

/**
 * Fallback for single-letter unit abbreviations ("888 D", "5 Y") used by
 * some bank rate cards. Returns days for a single token, 0 otherwise.
 * Kept narrow so it doesn't fire on incidental "y" / "d" inside larger
 * phrases — only triggers on a clean "<digits>\s*<single-letter>$".
 */
function singleAbbrevDays(text) {
  if (!text) return 0;
  const m = String(text).trim().toLowerCase().match(/^(\d+)\s*([dy])$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * (m[2] === 'd' ? 1 : 365);
}

/**
 * Parse tenure text into { minDays, maxDays }.
 * Returns null if parsing fails — caller should flag for manual review.
 */
function parseTenure(text) {
  // A3 (slab-quality-anomalies-2026-05-18) — strip parenthetical commentary
  // before normalisation. Banks add notes like "(35 months)", "(new slab)",
  // "(AMRIT VRISHTI)" that confuse regex matching but are not part of the
  // tenure bound itself.
  let stripped = (text || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  stripped = stripped.replace(/(\d)\s+(?=\d)/g, '$1');
  const normalized = stripped.toLowerCase();

  // Preset map (handles common canonical forms quickly).
  if (normalized in TENURE_PRESETS) {
    return TENURE_PRESETS[normalized];
  }

  // Two-pass parse: split on a range divider, sum-unit each side.
  // Divider priority: "to" / hyphen forms first (won't be confused with
  // negative-look bounds), then "<=" before "<". Tolerate the case where
  // the divider has no surrounding spaces (HDFC's "<=9 months") and the
  // case where "to <" stacks two markers (the second "<" makes the upper
  // bound exclusive — common across PSB/PVB rate cards).
  // Divider tokens between min and max sides:
  //   "to" / hyphens — canonical
  //   "upto" — BoB bulk cells use "Above 5Y and upto 10Y" / "Above 400 days
  //     and upto X days". Added 2026-05-24. Note "upto" intentionally NOT
  //     matched by \bto\b because the boundary requirement fails between
  //     'p' and 't' (both word chars), so we list it explicitly.
  const divider = /\s*(?:\bto\b|\bupto\b|–|—|-)\s*(<=|<)?\s*(?:less\s+than\s+)?|\s*(<=|<)\s*/;
  const dividerMatch = normalized.match(divider);
  if (dividerMatch && dividerMatch.index > 0) {
    const sepText = dividerMatch[0];
    // Strict-less marker can come from EITHER the divider's optional
    // suffix ("to <") or the bare divider being "<".
    const strictMarker = dividerMatch[1] || dividerMatch[2] || null;
    const sepInclusive = strictMarker === '<=';
    const leftRaw = normalized.slice(0, dividerMatch.index).replace(/^above\s+/, '').trim();
    const rightRaw = normalized.slice(dividerMatch.index + sepText.length).trim();
    const minDaysBase = sumUnitTokens(leftRaw) || singleAbbrevDays(leftRaw);
    const maxDaysBase = sumUnitTokens(rightRaw) || singleAbbrevDays(rightRaw);
    if (minDaysBase > 0 && maxDaysBase > 0) {
      let minDays = minDaysBase;
      let maxDays = maxDaysBase;
      if (normalized.startsWith('above')) minDays += 1;
      // Strict upper unless "<=" present, OR "less than" qualifier explicit.
      const strictUpper = (strictMarker === '<') || normalized.includes('less than');
      if (strictUpper && !sepInclusive) maxDays -= 1;
      return { minDays, maxDays };
    }
  }

  // Bare upper-bound: "<= N units" or "< N units" with no left side.
  const bareUpperMatch = normalized.match(new RegExp(`^(<=|<)\\s*(\\d+(?:\\s*${UNIT_RE}\\s*\\d+)*\\s*${UNIT_RE})$`));
  if (bareUpperMatch) {
    const days = sumUnitTokens(bareUpperMatch[2]);
    if (days > 0) {
      return { minDays: 1, maxDays: bareUpperMatch[1] === '<' ? days - 1 : days };
    }
  }

  // Bare lower-bound: ">= N units" or "> N units" with no right side.
  // Mirrors the bare-upper handler; used by some FCNR rate cards (Equitas
  // etc.) that list "> 18 months" / ">= 12 month" as standalone tier
  // labels. Upper cap matches the "X and above" handler (3650 d = 10 y).
  const bareLowerMatch = normalized.match(new RegExp(`^(>=|>)\\s*(\\d+(?:\\s*${UNIT_RE}\\s*\\d+)*\\s*${UNIT_RE})$`));
  if (bareLowerMatch) {
    const days = sumUnitTokens(bareLowerMatch[2]);
    if (days > 0) {
      return { minDays: bareLowerMatch[1] === '>' ? days + 1 : days, maxDays: 3650 };
    }
  }

  // "X-Y unit" / "X to Y unit" / "X to < Y unit" / "X upto Y unit" — range
  // where ONLY the second number carries a unit (e.g., "7 - 14 days",
  // "15-29 days", "15 to 100 days", "185 to < 1 Year" — ICICI). The general
  // two-pass parser misses these because the left side has no unit token.
  // 2026-05-24: added "to"/"upto" separators and the optional "<="/"<"
  // strict-marker before the second number (was hyphen-only, inclusive-only).
  const sharedUnitRangeMatch = normalized.match(new RegExp(
    `^(\\d+)\\s*(?:[-–—]|\\bto\\b|\\bupto\\b)\\s*(<=|<)?\\s*(\\d+)\\s*${UNIT_RE}$`
  ));
  if (sharedUnitRangeMatch) {
    const minValue = parseInt(sharedUnitRangeMatch[1], 10);
    const strictMarker = sharedUnitRangeMatch[2] || null;
    const maxValue = parseInt(sharedUnitRangeMatch[3], 10);
    const unit = extractUnitAfter(normalized, sharedUnitRangeMatch[3], true);
    const factor = TENURE_UNIT_DAYS[unit] || 1;
    let maxDays = maxValue * factor;
    if (strictMarker === '<') maxDays -= 1; // exclusive upper bound
    const minDaysCandidate = minValue * factor;
    // Sanity: shared-unit assumption breaks for mixed-unit cells like
    // "185 to < 1 Year" where the first number is days and the second is
    // years. In that case minValue*factor (185*365=67525) >> maxDays.
    // Don't return wrong values — fall through and let the mixed-unit
    // matcher below try, then the other patterns.
    if (minDaysCandidate <= maxDays) {
      return { minDays: minDaysCandidate, maxDays };
    }
  }

  // Mixed-unit range: "N to <M year(s)" / "N to M months" etc. where the
  // first number is implicitly DAYS and the second carries a larger unit.
  // Common in PSB/PVB rate cards at the day-to-year transition row:
  // "185 to < 1 Year" (ICICI), "271 to < 12 months", etc. Heuristic: only
  // engage when minValue is small enough to plausibly be days (< 1000) and
  // the implied maxDays comes out greater than minValue.
  const mixedRangeMatch = normalized.match(new RegExp(
    `^(\\d+)\\s*(?:[-–—]|\\bto\\b|\\bupto\\b)\\s*(<=|<)?\\s*(\\d+)\\s*${UNIT_RE}$`,
  ));
  if (mixedRangeMatch) {
    const firstAsDays = parseInt(mixedRangeMatch[1], 10);
    const strictMarker = mixedRangeMatch[2] || null;
    const secondValue = parseInt(mixedRangeMatch[3], 10);
    const unit = extractUnitAfter(normalized, mixedRangeMatch[3], true);
    const factor = TENURE_UNIT_DAYS[unit] || 1;
    let maxDays = secondValue * factor;
    if (strictMarker === '<') maxDays -= 1;
    // Engage only when the days interpretation is sane (small first number,
    // produces a non-inverted range, and the second-unit factor is bigger
    // than days — never fires for "7 to 14 days" because factor=1).
    if (factor > 1 && firstAsDays < 1000 && firstAsDays < maxDays) {
      return { minDays: firstAsDays, maxDays };
    }
  }

  // "X unit and above" / "X unit & above" — explicit upper bound is
  // "infinity" (capped at 10y). 2026-05-24: accept "&" as a synonym for
  // "and" (ahmednagar-shahar uses "366 Days & Above").
  const andAboveMatch = normalized.match(new RegExp(
    `^(?:above\\s+)?(\\d+)\\s*${UNIT_RE}\\s+(?:and|&)\\s+above$`
  ));
  if (andAboveMatch) {
    const value = parseInt(andAboveMatch[1], 10);
    const unit = extractUnitAfter(normalized, andAboveMatch[1]);
    let minDays = value * (TENURE_UNIT_DAYS[unit] || 1);
    if (normalized.startsWith("above")) minDays += 1;
    return { minDays, maxDays: 3650 };
  }

  // "above N unit" without "and above" — pure "above N years" form.
  const bareAboveMatch = normalized.match(new RegExp(
    `^above\\s+(\\d+)\\s*${UNIT_RE}$`
  ));
  if (bareAboveMatch) {
    const value = parseInt(bareAboveMatch[1], 10);
    const unit = extractUnitAfter(normalized, bareAboveMatch[1]);
    const minDays = value * (TENURE_UNIT_DAYS[unit] || 1) + 1;
    return { minDays, maxDays: 3650 };
  }

  // Single compound: e.g., "2 Years 11 Months", "444 Days", "888 D".
  // Falls out of sumUnitTokens (or the single-letter abbreviation
  // fallback) when no range divider is present.
  const singleDays = sumUnitTokens(normalized) || singleAbbrevDays(normalized);
  if (singleDays > 0 && /^\s*\d/.test(normalized)
      && !/[-–—<]|\bto\b|\babove\b|\band above\b/.test(normalized)) {
    return { minDays: singleDays, maxDays: singleDays };
  }

  return null;
}

/**
 * Pull the unit token that follows a specific number in the normalised
 * tenure string. Handles whitespace between the digits and the unit.
 * `last=true` means use the LAST occurrence (for range patterns where the
 * same digit string could appear in both bounds).
 */
function extractUnitAfter(normalized, digitStr, last = false) {
  const idx = last ? normalized.lastIndexOf(digitStr) : normalized.indexOf(digitStr);
  if (idx < 0) return '';
  const after = normalized.slice(idx + digitStr.length).trimStart();
  const m = after.match(/^(days?|weeks?|months?|years?|yrs?|mos?|wks?|d|y)/);
  return m ? m[1] : '';
}

module.exports = { parseTenure, TENURE_PRESETS, TENURE_UNIT_DAYS };

// CLI mode: node scripts/utils/parse-tenure.js "7 days to 14 days"
if (require.main === module) {
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.error("Usage: node scripts/utils/parse-tenure.js <tenure text>");
    process.exit(1);
  }
  const result = parseTenure(input);
  if (result) {
    console.log(JSON.stringify({ min_days: result.minDays, max_days: result.maxDays }));
  } else {
    console.error(`Could not parse: "${input}"`);
    process.exit(1);
  }
}

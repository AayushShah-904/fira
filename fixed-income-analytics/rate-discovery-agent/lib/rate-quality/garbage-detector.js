'use strict';

/**
 * Garbage-extraction detector for per-bank rate files.
 *
 * Sprint 010 Phase K (2026-06-09). Surfaced by the n55y5dr cohort, where
 * three banks (chittoor-DCCB / sbpp-coop / kerala-state-coop) had their
 * `automatic_html_static` extractor pull the WRONG table — emitting rows of
 * row-numbers as tenure_text and rate values like 91179 %. The cohort
 * produced more slabs than HEAD (8 vs 7 for kerala-state etc.) so a
 * count-based "HEAD wins iff HEAD > current" recovery decision skipped
 * them.
 *
 * This module makes the recovery decision QUALITY-AWARE.
 *
 * Garbage signatures, applied per slab:
 *   G1 — rate_general_pct > 25 (impossibly high for FD; bank rate cards
 *        top out at ~9% retail + ~10% senior, even bulk-deposit specials
 *        rarely exceed 8%; 25% is a safe ceiling)
 *   G2 — tenure_text matches `^\d+\.?\d*$` — pure number, e.g. "12.45",
 *        "10.", "1." — row indices or rate values landed in tenure_text
 *   G3 — tenure_text contains loan-product keyword (LOAN, JLG, MSME, MICRO
 *        FINANCE, OD, OVERDRAFT, ADVANCE, BORROWING, HOUSING, CONSUMER,
 *        GOLD LOAN, EDUCATION, MORTGAGE, CC) — non-FD product rows
 *
 * A file's verdict is the proportion of its slabs that hit any signature:
 *   - "garbage" — >= 50 % of slabs hit ≥1 signature
 *   - "suspect" — 20 to 50 % hit
 *   - "clean"   — < 20 % hit
 *   - "empty"   — zero slabs
 *
 * Recovery rule (recoverHeadPreferred):
 *   HEAD is preferred over current when:
 *     (a) current is empty and HEAD is non-empty (R1/R2/R4/R6 — original
 *         Phase J empty-overwrite restoration), OR
 *     (b) current is garbage/suspect and HEAD is clean (Phase K — quality-
 *         aware addition), OR
 *     (c) both are clean and HEAD has strictly more slabs (Phase K original
 *         "aggressive" rule, kept for legitimate partial-extraction cases).
 *
 * Pure function — no IO. Caller reads the JSON files.
 */

const RATE_TOO_HIGH = 25;
const PURE_NUMBER_RE = /^\s*\d+\.?\d*\s*$/;
const LOAN_KEYWORD_RE = /\b(LOAN|JLG|MSME|MICRO\s*FINANCE|OD|OVERDRAFT|ADVANCE|BORROWING|HOUSING|CONSUMER|GOLD\s+LOAN|EDUCATION|MORTGAGE|CASH\s+CREDIT)\b/i;

/**
 * Classify a single slab. Returns array of triggered flag codes.
 */
function classifySlab(slab) {
  const flags = [];
  if (slab == null) return flags;
  if (typeof slab.rate_general_pct === 'number' && slab.rate_general_pct > RATE_TOO_HIGH) flags.push('G1');
  if (typeof slab.tenure_text === 'string' && PURE_NUMBER_RE.test(slab.tenure_text)) flags.push('G2');
  if (typeof slab.tenure_text === 'string' && LOAN_KEYWORD_RE.test(slab.tenure_text)) flags.push('G3');
  return flags;
}

/**
 * Classify a rates JSON object.
 * @param {object|null} json — parsed contents of a *_rates.json file
 * @returns {{ verdict: 'empty'|'clean'|'suspect'|'garbage', slab_count: number, garbage_count: number, garbage_pct: number, flag_counts: object }}
 */
function classifyRatesFile(json) {
  const slabs = Array.isArray(json?.rate_slabs) ? json.rate_slabs : [];
  if (slabs.length === 0) {
    return { verdict: 'empty', slab_count: 0, garbage_count: 0, garbage_pct: 0, flag_counts: {} };
  }
  let garbage = 0;
  const flagCounts = {};
  for (const s of slabs) {
    const f = classifySlab(s);
    if (f.length > 0) {
      garbage++;
      for (const x of f) flagCounts[x] = (flagCounts[x] || 0) + 1;
    }
  }
  const pct = garbage / slabs.length;
  let verdict;
  if (pct >= 0.5) verdict = 'garbage';
  else if (pct >= 0.2) verdict = 'suspect';
  else verdict = 'clean';
  return { slab_count: slabs.length, garbage_count: garbage, garbage_pct: pct, flag_counts: flagCounts, verdict };
}

/**
 * Decide whether HEAD's version is preferred over current. Used by the
 * recovery script and any future cross-version comparison tool.
 *
 * @param {object|null} current — parsed _rates.json from output/latest/
 * @param {object|null} head    — parsed _rates.json from `git show HEAD:...`
 * @returns {{ prefer: 'head'|'current'|'either', reason: string, current_verdict: string, head_verdict: string }}
 */
function recoverHeadPreferred(current, head) {
  const c = classifyRatesFile(current);
  const h = classifyRatesFile(head);

  // (a) current empty, HEAD non-empty
  if (c.verdict === 'empty' && h.verdict !== 'empty') {
    return { prefer: 'head', reason: 'current_empty_head_nonempty', current_verdict: c.verdict, head_verdict: h.verdict };
  }
  // HEAD empty, no recovery available
  if (h.verdict === 'empty') {
    return { prefer: 'current', reason: 'head_empty', current_verdict: c.verdict, head_verdict: h.verdict };
  }
  // (b) current garbage/suspect, HEAD clean — quality-aware Phase K addition
  if ((c.verdict === 'garbage' || c.verdict === 'suspect') && h.verdict === 'clean') {
    return { prefer: 'head', reason: 'current_low_quality_head_clean', current_verdict: c.verdict, head_verdict: h.verdict };
  }
  // (c) both clean, HEAD has strictly more slabs (legitimate partial-extraction case)
  if (c.verdict === 'clean' && h.verdict === 'clean' && h.slab_count > c.slab_count) {
    return { prefer: 'head', reason: 'both_clean_head_has_more', current_verdict: c.verdict, head_verdict: h.verdict };
  }
  // Both garbage/suspect — no recovery benefit; flag for Sprint 011
  if (c.verdict !== 'clean' && h.verdict !== 'clean') {
    return { prefer: 'either', reason: 'both_low_quality_no_recovery_available', current_verdict: c.verdict, head_verdict: h.verdict };
  }
  // Current is clean or has more slabs — keep current
  return { prefer: 'current', reason: 'current_clean_or_richer', current_verdict: c.verdict, head_verdict: h.verdict };
}

module.exports = {
  classifySlab,
  classifyRatesFile,
  recoverHeadPreferred,
  RATE_TOO_HIGH,
  PURE_NUMBER_RE,
  LOAN_KEYWORD_RE,
};

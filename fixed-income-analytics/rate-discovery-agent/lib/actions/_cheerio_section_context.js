'use strict';

/**
 * Section-context capture + interpretation for HTML rate tables.
 *
 * Orch-1 (sprint-004 2026-05-21). Bank-agnostic helpers used by
 * `extract_html_table.js`'s multi-table accumulator to derive per-table
 * variant fulfillment + rule overrides from the page's section heading
 * and notes.
 *
 *   captureSectionContext($, $table, lookbackChars)
 *       → { section_heading, effective_date_text, notes[] }
 *
 *   interpretSectionContext(context)
 *       → { fulfills_variants, senior_excluded_for,
 *           min_tenor_days_by_variant, raw_notes }
 *
 * The capture function walks the same DOM ancestor-chain as
 * `extractTableTierLabel` and `buildTableContext` (in
 * `_cheerio_tables.js`) but classifies each preceding sibling into one
 * of three buckets:
 *   - section heading (heading-shape element near the table — usually
 *     phrasing like "Domestic / NRO / NRE FIXED DEPOSIT RATE")
 *   - effective-date stamp (text containing "w.e.f.", "effective from", etc.)
 *   - note line (text starting with "*Note:" or "**" or containing one
 *     of the recognised rule patterns)
 *
 * The interpretation function applies a small regex toolkit to extract
 * variant-fulfillment lists and schema-affecting rules (senior exclusion,
 * minimum-tenor filters). Unrecognised notes survive as `raw_notes`.
 *
 * Both functions degrade gracefully: missing inputs return safe defaults;
 * a missed rule means "apply no override" — never an unintended deletion
 * of data.
 */

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, caption, strong, b';
const WEF_RE = /\b(?:w\.?e\.?f\.?|effective\s+(?:from|date)|applicable\s+from|as\s+on)\b/i;
const NOTE_PREFIX_RE = /^\s*(?:\*+\s*note\s*:|\*\*+|note\s*:)/i;
// Body-hint regex must use word boundaries on the variant tokens so it
// doesn't match "nre" as a substring of "unrelated". Without `\b`, every
// sentence containing a vowel-cluster word like "u(nre)lated" or
// "su(nri)se" would be falsely classified as a rule-bearing note.
const NOTE_BODY_HINTS_RE = /(?:senior\s*(?:citizen)?\s*rates?\s*(?:do\s*not|don'?t)\s*apply|min(?:imum)?\s*tenor|no\s*senior\s*premium|premature\s*withdrawal|\b(?:nri|nris|nre|nro|fcnr|fcnr-b)\b)/i;

const VARIANT_TOKEN_MAP = {
  domestic: 'regular',
  resident: 'regular',
  nre: 'nre',
  nro: 'nro',
  fcnr: 'fcnr',
  'fcnr-b': 'fcnr',
  gift: 'gift',
  ifsc: 'gift',
};

/**
 * Walk upward from the table, classifying preceding-sibling text into
 * one of (section_heading, effective_date_text, notes[]).
 *
 * @param {object} $       — cheerio instance (`require('cheerio').load(html)`)
 * @param {object} $table  — cheerio wrapper around the rate <table> element
 * @param {number} [lookbackChars=2000] — character budget to walk back
 * @returns {{ section_heading: string|null, effective_date_text: string|null, notes: string[] }}
 */
function captureSectionContext($, $table, lookbackChars = 2000) {
  // Headings are collected as { text, tagNumber } pairs and the most-prominent
  // one (lowest tagNumber = highest hierarchy) becomes the `section_heading`.
  // This matters when a page has both a parent heading that declares variants
  // (e.g., HDFC's `<h2>Domestic / NRO / NRE FIXED DEPOSIT RATE</h2>`) AND a
  // direct-above heading that declares the deposit_range (e.g., `<h3>< ₹3
  // Crore</h3>`). The deposit_range heading is closer to the table and
  // remains accessible via the `nearest_heading_text` field for downstream
  // headingToDepositRange use.
  const headings = []; // { text, tagNumber }, in walk order (closest first)
  let effective_date_text = null;
  const notes = [];

  let cursor = $table;
  let budget = lookbackChars;
  while (cursor.length && budget > 0) {
    const sibs = cursor.prevAll().toArray();
    for (const sib of sibs) {
      if (budget <= 0) break;
      const $sib = $(sib);
      const text = ($sib.text() || '').trim();
      if (!text) continue;

      const cleaned = text.replace(/\s+/g, ' ').trim();
      const tagNumber = headingTagNumber($, $sib);
      const isHeading = tagNumber !== null;
      const hasWef = WEF_RE.test(cleaned);
      const isNote = NOTE_PREFIX_RE.test(cleaned) || NOTE_BODY_HINTS_RE.test(cleaned);

      if (isHeading) {
        headings.push({ text: cleaned.slice(0, 300), tagNumber });
      } else if (hasWef && !effective_date_text) {
        effective_date_text = cleaned.slice(0, 300);
      } else if (isNote) {
        // Avoid pushing duplicates of headings/effective-date text under notes.
        notes.unshift(cleaned.slice(0, 500));
      }

      budget -= Math.min(cleaned.length, 500);
    }
    cursor = cursor.parent();
    if (!cursor.length || cursor[0].name === 'html' || cursor[0].name === undefined) break;
  }

  // section_heading: prefer the closest heading that contains a recognised
  // variant token (Domestic / NRE / NRO / FCNR / GIFT); fall back to the
  // closest heading at any level when no variant-declaring heading exists.
  //
  // Why: pages like HDFC have a hierarchy where the SECTION heading
  // declares variants (e.g., `<h2>Domestic / NRO / NRE FIXED DEPOSIT
  // RATE</h2>`) and the per-table heading declares the deposit_range
  // (e.g., `<h3>< ₹3 Crore</h3>`). The variant-declaring heading is
  // upstream; we need to find it past the closer deposit_range heading.
  // But for pages with NO variant-declaring heading (just a section title
  // + a per-table heading), we want the closest one. The closest-with-
  // variant-tokens heuristic does both.
  let sectionHeading = null;
  for (const h of headings) {
    if (HEADING_VARIANT_TOKEN_RE.test(h.text)) {
      sectionHeading = h;
      break; // closest variant-declaring heading wins
    }
  }
  if (sectionHeading === null && headings.length > 0) {
    sectionHeading = headings[0]; // closest heading overall
  }
  // nearest_heading_text = closest heading regardless of level — used for
  // deposit_range derivation (the heading directly above the table).
  const nearest = headings.length > 0 ? headings[0].text : null;

  return {
    section_heading: sectionHeading ? sectionHeading.text : null,
    nearest_heading_text: nearest,
    effective_date_text,
    notes,
  };
}

// Quick word-boundary regex matching any recognised variant token in a
// heading. Used to identify variant-declaring section headings during
// captureSectionContext.
const HEADING_VARIANT_TOKEN_RE = /\b(domestic|nre|nro|fcnr(?:-b)?|gift|ifsc|resident\s+foreign|rfc)\b/i;

/**
 * Return the tag-prominence number for a heading-shaped element:
 *   h1=1, h2=2, h3=3, h4=4, h5=5, h6=6, caption/strong/b=7
 * Returns null when the element is NOT heading-shaped (so the caller
 * can branch on that).
 */
function headingTagNumber($, $el) {
  // Direct match
  const tagName = ($el[0] && ($el[0].name || $el[0].tagName) || '').toLowerCase();
  const direct = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6, caption: 7, strong: 7, b: 7 }[tagName];
  if (direct !== undefined) return direct;
  // Wrapper that contains a heading-shape child
  const $h = $el.find(HEADING_SELECTOR).first();
  if ($h.length > 0) {
    const childTag = ($h[0].name || $h[0].tagName || '').toLowerCase();
    return { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6, caption: 7, strong: 7, b: 7 }[childTag] ?? null;
  }
  return null;
}

/**
 * Parse the captured context into structured fields.
 *
 *   fulfills_variants     — variants this section's tables apply to
 *   senior_excluded_for   — variants where the senior column should be dropped
 *   min_tenor_days_by_variant — variant-keyed minimum tenure (days)
 *   raw_notes             — unrecognised notes echoed for downstream warnings
 *
 * Conservative defaults: unrecognised heading → ["regular"] only. Missing
 * rule patterns → empty arrays / empty object (no override applied).
 *
 * @param {{ section_heading?: string|null, effective_date_text?: string|null, notes?: string[] }} context
 * @returns {{ fulfills_variants: string[], senior_excluded_for: string[], min_tenor_days_by_variant: object, raw_notes: string[] }}
 */
function interpretSectionContext(context) {
  const heading = context && context.section_heading;
  const rawNotes = (context && Array.isArray(context.notes)) ? context.notes : [];

  // ── fulfills_variants from heading "/"-separated tokens ──
  const headingResult = parseVariantsFromHeading(heading);

  // ── rule extraction from notes ──
  const senior_excluded_for = new Set();
  const min_tenor_days_by_variant = {};
  const unrecognised = [];

  // Split each note on the `|` separator before applying rules. Indian
  // bank pages commonly concatenate independent claims with `|` (e.g.,
  // HDFC's "Senior Citizen rates do not apply to NRIs | The minimum
  // tenor for NRE Deposit is 1 year"). Treating each as a separate
  // claim lets the per-rule regex anchors (period / semicolon / EOL)
  // match cleanly without needing to thread `|` through every pattern.
  for (const wholeNote of rawNotes) {
    const subNotes = String(wholeNote).split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    let anyHandled = false;
    for (const sub of subNotes) {
      const handled = applyNoteRules(sub, senior_excluded_for, min_tenor_days_by_variant);
      if (handled) anyHandled = true;
      else unrecognised.push(sub);
    }
    // If the whole note was a single non-pipe-separated string and nothing
    // matched, we already pushed it to unrecognised above.
    void anyHandled;
  }

  // Some banks (HDFC observed 2026-05-21) concatenate the section title,
  // effective-date stamp, AND the notes into a single heading-tagged
  // element. `captureSectionContext` correctly classifies that blob as
  // `section_heading` rather than `notes`, so the loop above never sees
  // the rule-bearing substrings. Apply the same `|`-aware rule scan to
  // `section_heading` so embedded notes still drive senior-exclusion and
  // minimum-tenor filtering. Unmatched heading substrings stay quiet
  // (no `raw_notes` pollution) since the heading isn't a note per se.
  if (heading && typeof heading === 'string') {
    const headingSubs = String(heading).split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    for (const sub of headingSubs) {
      applyNoteRules(sub, senior_excluded_for, min_tenor_days_by_variant);
    }
  }

  return {
    fulfills_variants: headingResult.variants,
    // True when the heading didn't disclose any recognised variant token
    // and the caller should fall back to its own iteration variant
    // (the orchestrator's per-product loop). False when the heading
    // explicitly listed variants (e.g., "Domestic / NRO / NRE").
    fulfills_variants_is_default: headingResult.is_default,
    senior_excluded_for: [...senior_excluded_for],
    min_tenor_days_by_variant,
    raw_notes: unrecognised,
  };
}

function parseVariantsFromHeading(heading) {
  if (!heading || typeof heading !== 'string') return { variants: ['regular'], is_default: true };
  const tokens = new Set();
  // Tokenize on whitespace + "/" + "," + "|" + "&"
  const parts = heading.toLowerCase().split(/[\s/,|&]+/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    // Strip surrounding punctuation
    const clean = p.replace(/[^a-z\-]/g, '');
    if (VARIANT_TOKEN_MAP[clean]) tokens.add(VARIANT_TOKEN_MAP[clean]);
  }
  if (tokens.size === 0) return { variants: ['regular'], is_default: true };
  return { variants: [...tokens], is_default: false };
}

/**
 * Returns true if the note matched at least one known rule pattern and
 * had its rule applied.
 */
function applyNoteRules(note, seniorExcludedSet, minTenorMap) {
  if (typeof note !== 'string' || !note.trim()) return false;
  let handled = false;

  // ── Senior exclusion for NRI variants ──
  // Patterns:
  //   "Senior Citizen rates do not apply to NRIs"
  //   "senior rates don't apply to NRE / NRO / FCNR"
  //   "No senior premium on FCNR"
  //   "no senior citizen benefit on NRE deposits"
  const seniorPatterns = [
    /senior\s*(?:citizen)?\s*rates?\s*(?:do\s*not|don'?t|does\s*not)\s*apply\s*to\s*([A-Za-z\s/,]+?)(?:[.;]|$)/i,
    /no\s*senior\s*(?:citizen)?\s*(?:premium|benefit|rate)s?\s*(?:on|for)\s*([A-Za-z\s/,]+?)(?:[.;]|$)/i,
  ];
  for (const re of seniorPatterns) {
    const m = note.match(re);
    if (m) {
      const targetVariants = extractVariantTokens(m[1]);
      // "NRI" expands to NRE+NRO+FCNR
      const expanded = expandNriToken(targetVariants);
      for (const v of expanded) seniorExcludedSet.add(v);
      handled = true;
      break;
    }
  }

  // ── Minimum tenor for a specific variant ──
  // Patterns:
  //   "The minimum tenor for NRE Deposit is 1 year"
  //   "min tenor for NRO FD is 7 days"
  //   "NRE: 1 year minimum"
  //   "FCNR minimum tenor 1 year"
  const minTenorPatterns = [
    /min(?:imum)?\s*tenor\s*for\s*(NRE|NRO|FCNR|GIFT)\s*(?:deposit|FD|deposits|FDs)?s?\s*(?:is|of)?\s*(\d+)\s*(day|month|year)s?/i,
    /(NRE|NRO|FCNR|GIFT)\s*(?:deposit|FD)?s?\s*[:\-]\s*(\d+)\s*(day|month|year)s?\s*min(?:imum)?/i,
    /(NRE|NRO|FCNR|GIFT)\s*min(?:imum)?\s*tenor\s*(\d+)\s*(day|month|year)s?/i,
  ];
  for (const re of minTenorPatterns) {
    const m = note.match(re);
    if (m) {
      const variant = VARIANT_TOKEN_MAP[m[1].toLowerCase()];
      const n = parseInt(m[2], 10);
      const unit = m[3].toLowerCase();
      const days = unitToDays(n, unit);
      if (variant && Number.isFinite(days)) {
        // Use the largest declared minimum if multiple notes match
        const prior = minTenorMap[variant] || 0;
        minTenorMap[variant] = Math.max(prior, days);
        handled = true;
      }
      break;
    }
  }

  return handled;
}

const NRI_LIKE_TOKENS = new Set(['nri', 'nris']);

function extractVariantTokens(text) {
  if (!text) return [];
  const tokens = new Set();
  const parts = text.toLowerCase().split(/[\s/,|&]+/);
  for (const p of parts) {
    let clean = p.replace(/[^a-z\-]/g, '');
    if (NRI_LIKE_TOKENS.has(clean)) {
      tokens.add('nri'); // sentinel for "all NRI variants"; expanded later
      continue;
    }
    if (VARIANT_TOKEN_MAP[clean]) {
      tokens.add(VARIANT_TOKEN_MAP[clean]);
      continue;
    }
    // Strip plural 's' when the singular form is recognised — handles
    // "NREs", "NROs", "FCNRs" without polluting the map with plurals.
    if (clean.length > 2 && clean.endsWith('s')) {
      const sing = clean.slice(0, -1);
      if (VARIANT_TOKEN_MAP[sing]) tokens.add(VARIANT_TOKEN_MAP[sing]);
    }
  }
  return [...tokens];
}

function expandNriToken(tokens) {
  const out = new Set();
  for (const t of tokens) {
    if (t === 'nri') {
      out.add('nre');
      out.add('nro');
      out.add('fcnr');
    } else {
      out.add(t);
    }
  }
  return [...out];
}

function unitToDays(n, unit) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit.startsWith('day')) return n;
  if (unit.startsWith('month')) return Math.round(n * 30);
  if (unit.startsWith('year')) return Math.round(n * 365);
  return null;
}

module.exports = {
  captureSectionContext,
  interpretSectionContext,
  // exported for unit-test fine-graining
  _parseVariantsFromHeading: parseVariantsFromHeading,
  _applyNoteRules: applyNoteRules,
};

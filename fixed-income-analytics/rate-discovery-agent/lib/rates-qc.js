'use strict';

/**
 * Deterministic post-extraction QC for rates payloads.
 *
 * Sprint 011 Track A item 21 (2026-07-06). Surfaced by the 2026-06-16 audit
 * of the 41 "claimed fresh" FCNR banks: LLM-path extractions
 * (`extraction_method: llm_inline_extraction`) occasionally emit
 *   - duplicate slabs — bank-of-baroda FCNR 41 slabs / 36 unique (5-Year
 *     tier emitted twice for GBP/EUR/CAD/AUD), idfc-first-bank-limited
 *     18 / 12 unique (same `1 Yr < 15 Months|USD` repeated);
 *   - garbage effective_date strings — BoB `"1st July 1995"` is the FCNR(B)
 *     product-introduction date scraped from page legalese, not a rate date;
 *   - under-extraction — deutsche-bank-ag returned 3 slabs where the bank
 *     publishes 5-15 (LLM context truncation; out of scope here beyond a
 *     quality warning).
 *
 * Rules (applied by qcRatesPayload, in order):
 *   Q1 — effective_date ISO normalisation (ALL extraction methods): parse
 *        the formats seen in the wild ("2026-06-09", "01.07.2025",
 *        "01-Jun-2026", "8th June 2026", "1st July 1995", …) → "YYYY-MM-DD".
 *        Dotted/slashed numeric dates are DD.MM.YYYY — the Indian
 *        convention. Unparseable → null + a warning on payload.warnings.
 *   Q2 — dedup by composite key (tenure_text|currency|deposit_range|
 *        scheme_subtype), first wins — llm_inline_extraction ONLY.
 *   Q3 — effective_date stale-year sanitisation — llm_inline_extraction
 *        ONLY: a non-ISO-sourced date whose year < (currentYear - 2) is
 *        almost certainly legalese, not a rate date → null + warning. A
 *        date the LLM emitted ALREADY in ISO form is exempt (per the
 *        sprint-011 scope: "reject if year < (current_year - 2) AND no ISO
 *        format match") — structured ISO output rarely comes from prose.
 *   Q4 — under-extraction flag — llm_inline_extraction ONLY: when
 *        priorSlabCount is known and the new (post-dedup) count is > 0 but
 *        < 50 % of prior, append `quality_warning: under_extraction_suspected`
 *        to payload.warnings. Never blocks — safe-write Rule 2 owns the
 *        zero-slab destructive case; this only surfaces the partial one.
 *
 * Curated extraction methods (manual_*, pending_* — see
 * lib/extraction-methods.js) bypass QC entirely: operator data is
 * authoritative as entered, including its effective_date spelling.
 *
 * Pure function — no IO, never mutates its input. lib/safe-write.js runs it
 * on every `kind: 'rates'` write before the ADR-012 rejection rules.
 */

const { isCurated } = require('./extraction-methods');

// Month-word lookup for "01-Jun-2026" / "8th June 2026" style dates.
const MONTHS = new Map(Object.entries({
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}));

// Strict ISO shape — used both as an input format and for the Q3 exemption.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Composite dedup key per the sprint-011 scope (Item 21 fix step 1).
const DEDUP_KEY_FIELDS = Object.freeze(['tenure_text', 'currency', 'deposit_range', 'scheme_subtype']);

// Years outside this window are treated as parse garbage, not dates.
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

/**
 * Validate (y, m, d) as a real calendar date and render "YYYY-MM-DD".
 * Returns null for impossible dates (month 13, 31st Feb, year 10023, …).
 */
function buildIso(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < YEAR_MIN || year > YEAR_MAX) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through Date to catch per-month day overflow (e.g. 31 Feb).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse an effective-date string in any of the formats seen in the wild
 * into "YYYY-MM-DD". Returns null when the input is not a parseable date.
 *
 * Supported formats:
 *   "2026-06-09"      — ISO (also tolerates unpadded "2026-6-9")
 *   "01.07.2025"      — dotted numeric, DD.MM.YYYY (Indian convention;
 *                        also "/" and "-" separators)
 *   "01-Jun-2026"     — day-first with month word
 *   "8th June 2026"   — ordinal day + month word (also "1st July 1995")
 *   "June 8, 2026"    — month-first with month word
 *   Leading "w.e.f."  — stripped before parsing (common on Indian rate pages)
 *
 * @param {*} input
 * @returns {string|null}
 */
function normalizeEffectiveDate(input) {
  if (typeof input !== 'string') return null;
  const s = input
    .trim()
    .replace(/^w\.?\s*e\.?\s*f\.?:?\s*/i, '') // "w.e.f. 01.07.2025"
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  let m;

  // ISO: YYYY-MM-DD (tolerate unpadded month/day; re-emit canonical)
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    return buildIso(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  // Numeric day-first: DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY / DD/MM/YY
  if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s))) {
    let year = Number(m[3]);
    if (m[3].length === 2) {
      year += 2000;
    }
    return buildIso(year, Number(m[2]), Number(m[1]));
  }

  // Day-first with month word: "01-Jun-2026", "8th June 2026", "1st July 1995", "8th July'26", "8 th July 26"
  if ((m = /^(\d{1,2})\s*(?:st|nd|rd|th)?[-\s]+([A-Za-z]+)[-,'\s]+(\d{2,4})$/i.exec(s))) {
    const month = MONTHS.get(m[2].toLowerCase());
    if (!month) return null;
    let year = Number(m[3]);
    if (m[3].length === 2) {
      year += 2000;
    }
    return buildIso(year, month, Number(m[1]));
  }

  // Month-first with month word: "June 8, 2026", "Jun 8 2026", "July 8 '26"
  if ((m = /^([A-Za-z]+)[-\s]+(\d{1,2})\s*(?:st|nd|rd|th)?[-,'\s]+(\d{2,4})$/i.exec(s))) {
    const month = MONTHS.get(m[1].toLowerCase());
    if (!month) return null;
    let year = Number(m[3]);
    if (m[3].length === 2) {
      year += 2000;
    }
    return buildIso(year, month, Number(m[2]));
  }

  return null;
}

/**
 * Composite dedup key for a rate slab. Missing/null fields render as ''.
 */
function slabDedupKey(slab) {
  if (slab == null || typeof slab !== 'object') {
    // Defensive: non-object entries dedup on their JSON form so two
    // identical stray values still collapse.
    return `__nonobject__|${JSON.stringify(slab)}`;
  }
  return DEDUP_KEY_FIELDS.map((f) => (slab[f] == null ? '' : String(slab[f]))).join('|');
}

/**
 * Run the QC pass over a rates payload.
 *
 * @param {object} payload — parsed *_rates.json content (not mutated)
 * @param {object} [opts]
 * @param {string} [opts.extractionMethod] — defaults to payload.extraction_method
 * @param {object} [opts.logger]           — optional logger with .warn / .info
 * @param {number} [opts.priorSlabCount]   — slab count of the existing file at
 *                                           the target path (for Q4); omit/null when unknown
 * @param {Date}   [opts.now]              — injectable clock for the Q3 year window
 * @returns {{ payload: object, changes: { dupes_removed: number, date_normalised: boolean, date_rejected: boolean, under_extraction_suspected: boolean }, bypassed: boolean }}
 */
function qcRatesPayload(payload, opts = {}) {
  const { logger = null, priorSlabCount = null, now = new Date() } = opts;
  const changes = {
    dupes_removed: 0,
    date_normalised: false,
    date_rejected: false,
    under_extraction_suspected: false,
  };

  if (!payload || typeof payload !== 'object') {
    return { payload, changes, bypassed: false };
  }

  const out = { ...payload };
  const extractionMethod = opts.extractionMethod || payload.extraction_method || null;

  // Compute data_quality for all files (including curated)
  if (out.effective_date) {
    const effDate = new Date(out.effective_date);
    if (!isNaN(effDate.getTime())) {
      const diffMs = now.getTime() - effDate.getTime();
      const daysSinceEffective = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      let freshnessStatus = 'FRESH';
      if (daysSinceEffective > 365) {
        freshnessStatus = 'EXTREMELY_STALE';
      } else if (daysSinceEffective > 180) {
        freshnessStatus = 'VERY_STALE';
      } else if (daysSinceEffective > 90) {
        freshnessStatus = 'STALE';
      }
      out.data_quality = {
        freshness_status: freshnessStatus,
        days_since_effective: daysSinceEffective,
        last_scraped_at: out.scraped_at || now.toISOString(),
        manual_verification_needed: freshnessStatus !== 'FRESH'
      };
    }
  }

  // Curated bypass: operator-entered data (manual_data_entry & friends) is
  // authoritative as-is — no dedup, no date rewriting, no warnings.
  if (isCurated(extractionMethod)) {
    return { payload: out, changes, bypassed: true };
  }

  const warnings = Array.isArray(out.warnings) ? [...out.warnings] : [];
  const warningsBefore = warnings.length;
  const isLlm = extractionMethod === 'llm_inline_extraction';
  const staleYearFloor = now.getFullYear() - 2;

  // ── Q1 (+Q3): effective_date normalisation / sanitisation ──
  if (out.effective_date != null && out.effective_date !== '') {
    const original = out.effective_date;
    const iso = normalizeEffectiveDate(original);
    if (iso === null) {
      out.effective_date = null;
      changes.date_rejected = true;
      warnings.push(`rates-qc: effective_date ${JSON.stringify(original)} is not a parseable date; set to null`);
      if (logger && logger.warn) {
        logger.warn(`rates-qc: unparseable effective_date ${JSON.stringify(original)} for ${out.bank_code || 'unknown-bank'}; set to null`);
      }
    } else {
      const wasIso = typeof original === 'string' && ISO_DATE_RE.test(original.trim());
      const year = Number(iso.slice(0, 4));
      const legaleseYearFloor = 2015; // Only pre-2015 dates (e.g. 1995) are considered legalese
      if (isLlm && !wasIso && year < legaleseYearFloor) {
        // The BoB "1st July 1995" class: prose date far in the past is product legalese
        out.effective_date = null;
        changes.date_rejected = true;
        warnings.push(
          `rates-qc: effective_date ${JSON.stringify(original)} parses to ${iso} `
          + `(year ${year} < ${legaleseYearFloor}) — likely page legalese, not a rate date; set to null`,
        );
        if (logger && logger.warn) {
          logger.warn(`rates-qc: legalese-year effective_date ${JSON.stringify(original)} for ${out.bank_code || 'unknown-bank'}; set to null`);
        }
      } else {
        out.effective_date = iso;
        if (iso !== original) {
          changes.date_normalised = true;
        }
        if (year < staleYearFloor) {
          warnings.push(
            `rates-qc: effective_date ${JSON.stringify(original)} parses to ${iso} `
            + `(year ${year} < ${staleYearFloor}) — EXTREMELY STALE rate date retained`,
          );
        }
        if (logger && logger.info) {
          logger.info(`rates-qc: effective_date ${JSON.stringify(original)} normalised to ${iso} for ${out.bank_code || 'unknown-bank'}`);
        }
      }
    }
  }

  // ── Q2: dedup by composite key — LLM path only ──
  if (isLlm && Array.isArray(out.rate_slabs) && out.rate_slabs.length > 1) {
    const seen = new Set();
    const deduped = [];
    for (const slab of out.rate_slabs) {
      const key = slabDedupKey(slab);
      if (seen.has(key)) {
        changes.dupes_removed += 1;
        continue; // first wins
      }
      seen.add(key);
      deduped.push(slab);
    }
    if (changes.dupes_removed > 0) {
      out.rate_slabs = deduped;
      if (logger && logger.warn) {
        logger.warn(`rates-qc: removed ${changes.dupes_removed} duplicate slab(s) for ${out.bank_code || 'unknown-bank'} (${deduped.length} unique retained)`);
      }
    }
  }

  // ── Q4: under-extraction flag — LLM path only ──
  // newCount === 0 is deliberately excluded: safe-write Rule 2
  // (empty_overwrite_blocked) already owns the zero-slab destructive case.
  if (isLlm && typeof priorSlabCount === 'number' && priorSlabCount > 0) {
    const newCount = Array.isArray(out.rate_slabs) ? out.rate_slabs.length : 0;
    if (newCount > 0 && newCount < priorSlabCount * 0.5) {
      changes.under_extraction_suspected = true;
      warnings.push(
        `quality_warning: under_extraction_suspected — ${newCount} slab(s) extracted vs ${priorSlabCount} prior (<50%)`,
      );
      if (logger && logger.warn) {
        logger.warn(`rates-qc: under_extraction_suspected for ${out.bank_code || 'unknown-bank'} (${newCount} vs prior ${priorSlabCount})`);
      }
    }
  }

  // ── Q5: Structured data_quality & freshness metadata ──
  if (out.effective_date) {
    const effDate = new Date(out.effective_date);
    if (!isNaN(effDate.getTime())) {
      const diffMs = now.getTime() - effDate.getTime();
      const daysSinceEffective = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      let freshnessStatus = 'FRESH';
      if (daysSinceEffective > 365) {
        freshnessStatus = 'EXTREMELY_STALE';
      } else if (daysSinceEffective > 180) {
        freshnessStatus = 'VERY_STALE';
      } else if (daysSinceEffective > 90) {
        freshnessStatus = 'STALE';
      }
      out.data_quality = {
        freshness_status: freshnessStatus,
        days_since_effective: daysSinceEffective,
        last_scraped_at: out.scraped_at || now.toISOString(),
        manual_verification_needed: freshnessStatus !== 'FRESH'
      };
    }
  }

  if (warnings.length !== warningsBefore || Array.isArray(payload.warnings)) {
    out.warnings = warnings;
  }

  return { payload: out, changes, bypassed: false };
}

module.exports = {
  qcRatesPayload,
  normalizeEffectiveDate,
  slabDedupKey,
  DEDUP_KEY_FIELDS,
};

/**
 * Normalize agent-produced rate files to the canonical schema.
 *
 * The LLM agent often guesses shorter/more natural field names (e.g., "slabs"
 * instead of "rate_slabs") when it writes rate JSON files. Downstream
 * consumers (run-discovery.js slab counter, validate-rates.js, the BIRD
 * import pipeline) all expect the canonical names. This normalizer renames
 * known aliases in place so downstream code sees a consistent shape.
 *
 * Canonical schema — see packages/scraper/src/import/import-discovery.ts
 * and scripts/extract_rates.js for the source of truth.
 *
 *   {
 *     bank_code, bank_name,
 *     product_type: "FD",             // not "product", always uppercase
 *     variant: "regular"|"nre"|"nro"|"fcnr"|"gift",
 *     effective_date, source_url,
 *     scraped_at,                     // not "extracted_at"
 *     extraction_confidence,
 *     rate_slabs: [                   // not "slabs"
 *       {
 *         tenure_text,
 *         tenure_min_days,            // not "min_days"
 *         tenure_max_days,            // not "max_days"
 *         rate_general_pct,
 *         rate_senior_pct?,
 *         rate_super_senior_pct?,
 *         currency?,                  // for fcnr/gift
 *         deposit_range?,
 *       }
 *     ],
 *     special_schemes?, warnings?, errors?
 *   }
 */

const fs = require("fs");

// Sprint 010 Phase K (2026-06-09): lazy-require parseTenure to keep
// normalize-rates.js cheap when callers don't have rates files to
// reparse. Used by the "null tenure_min/max recompute" pass below.
let _parseTenureLazy = null;
function getParseTenure() {
  if (!_parseTenureLazy) {
    _parseTenureLazy = require("./parse-tenure").parseTenure;
  }
  return _parseTenureLazy;
}

/** Top-level key aliases: alias → canonical. */
const TOP_LEVEL_ALIASES = {
  slabs: "rate_slabs",
  product: "product_type",
  extracted_at: "scraped_at",
  fetched_at: "scraped_at",
  retrieved_at: "scraped_at",
};

/** Per-slab key aliases: alias → canonical. */
const SLAB_ALIASES = {
  min_days: "tenure_min_days",
  max_days: "tenure_max_days",
  tenure_days_min: "tenure_min_days",
  tenure_days_max: "tenure_max_days",
  tenure_from_days: "tenure_min_days",
  tenure_to_days: "tenure_max_days",
};

/**
 * Rename a key on an object in place if the canonical key is absent.
 * Returns true if a rename happened.
 */
function renameKey(obj, alias, canonical) {
  if (obj == null || typeof obj !== "object") return false;
  if (!(alias in obj)) return false;
  if (canonical in obj) {
    // Canonical already present — drop the alias to avoid ambiguity
    delete obj[alias];
    return true;
  }
  obj[canonical] = obj[alias];
  delete obj[alias];
  return true;
}

/**
 * Normalize a parsed rates object in place.
 * @param {object} data - Parsed JSON from a *_rates.json file
 * @returns {{ changed: boolean, fieldsRenamed: string[] }}
 */
function normalizeRatesObject(data) {
  if (data == null || typeof data !== "object") {
    return { changed: false, fieldsRenamed: [] };
  }

  const fieldsRenamed = [];

  // Top-level key renames
  for (const [alias, canonical] of Object.entries(TOP_LEVEL_ALIASES)) {
    if (renameKey(data, alias, canonical)) {
      fieldsRenamed.push(`${alias}→${canonical}`);
    }
  }

  // product_type value: ensure uppercase (agent writes "fd", canonical is "FD")
  if (typeof data.product_type === "string" && data.product_type !== data.product_type.toUpperCase()) {
    data.product_type = data.product_type.toUpperCase();
    fieldsRenamed.push("product_type→UPPER");
  }

  // Per-slab key renames
  const slabs = data.rate_slabs;
  if (Array.isArray(slabs)) {
    for (const slab of slabs) {
      for (const [alias, canonical] of Object.entries(SLAB_ALIASES)) {
        if (renameKey(slab, alias, canonical)) {
          if (!fieldsRenamed.includes(`slab.${alias}→${canonical}`)) {
            fieldsRenamed.push(`slab.${alias}→${canonical}`);
          }
        }
      }
      // Sprint 010 Phase K (2026-06-09) — recompute tenure_min/max_days
      // from tenure_text when both are null and the text is parseable.
      // Surfaced by the n55y5dr cohort:
      //   - dbs-bank-india-limited regular: LLM emitted "1Y to <2Y" with
      //     null tenure days (LLM didn't fill them; parser would).
      //   - barclays-bank-plc regular: html_static extractor left "Overnight"
      //     with null days (parser now has preset; recompute picks it up).
      //   - misc LLM-fallback banks where the extractor emitted slabs but
      //     skipped day-computation.
      // Doesn't override existing non-null values (operator/extractor wins
      // when present); only patches null/null pairs.
      if (
        slab
        && typeof slab.tenure_text === 'string'
        && slab.tenure_text.trim() !== ''
        && slab.tenure_min_days == null
        && slab.tenure_max_days == null
      ) {
        const parsed = getParseTenure()(slab.tenure_text);
        if (parsed && typeof parsed.minDays === 'number' && typeof parsed.maxDays === 'number') {
          slab.tenure_min_days = parsed.minDays;
          slab.tenure_max_days = parsed.maxDays;
          if (!fieldsRenamed.includes('slab.tenure_recomputed_from_text')) {
            fieldsRenamed.push('slab.tenure_recomputed_from_text');
          }
        }
      }

      // Sprint 010 C (2026-06-09) — tenure_min_below_1 bug fix.
      // LLM-emitted slabs for "Up to N days/months" / "UPTO N" / "<= N"
      // patterns commonly set tenure_min_days=0 because the model
      // interprets "up to" as starting at 0. Indian FD tenures are always
      // >= 1 day (banks don't accept 0-day deposits — overnight is the
      // floor at 1 day for most). Fix: when tenure_min_days <= 0 AND the
      // tenure_text matches an "up to" pattern AND tenure_max_days > 0,
      // bump min to 1. Surfaced by Sprint 008 Phase 7 quality gate as
      // tenure_min_below_1 anomalies on 4 banks in the 513-cohort:
      // maninagar-co-op-bank ("UPTO 24 MONTHS"), sharad-sahakari ("Up to
      // 30 Days"), surat-peoples, sri-potti-sriramulu. Doesn't touch
      // null/missing values (those are separately legitimate signals).
      if (
        typeof slab.tenure_min_days === 'number'
        && slab.tenure_min_days < 1
        && typeof slab.tenure_max_days === 'number'
        && slab.tenure_max_days > 0
        && typeof slab.tenure_text === 'string'
        && /^\s*(?:(?:up\s*to|upto)\b|<=?\s|<=?\d)/i.test(slab.tenure_text)
      ) {
        slab.tenure_min_days = 1;
        if (!fieldsRenamed.includes('slab.tenure_min_days→1(up_to_pattern)')) {
          fieldsRenamed.push('slab.tenure_min_days→1(up_to_pattern)');
        }
      }
    }
  }

  return { changed: fieldsRenamed.length > 0, fieldsRenamed };
}

/**
 * Read, normalize, and re-write a rates file if any keys changed.
 * Safe to call on already-canonical files — it's a no-op in that case.
 * @param {string} filePath - Absolute path to a *_rates.json file
 * @returns {{ changed: boolean, fieldsRenamed: string[], slabCount: number }|null}
 *   Returns null on read/parse error.
 */
function normalizeRatesFile(filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }

  const result = normalizeRatesObject(data);
  const slabCount = Array.isArray(data.rate_slabs) ? data.rate_slabs.length : 0;

  if (result.changed) {
    // safe-write-exempt: TODO migrate per ADR-012 — rates normalization writes back the same _rates.json with field renames (kind: 'rates'). Called from many sites; migration needs caller-by-caller source inference. Queued for follow-up.
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  }

  return { changed: result.changed, fieldsRenamed: result.fieldsRenamed, slabCount };
}

module.exports = {
  normalizeRatesObject,
  normalizeRatesFile,
  TOP_LEVEL_ALIASES,
  SLAB_ALIASES,
};

'use strict';

/**
 * lib/diff-engine.js  — Phase 4: Anomaly Detection & Quality Gates
 *
 * A pre-save diffing engine that compares the incoming scrape result
 * against the existing file on disk before allowing a write through.
 *
 * Three independent checks, each returns a structured result:
 *
 *   1. VOLUME DROP   — new slab count is 0 but old had slabs → REJECT
 *   2. STALE REGRESS — new effective_date is OLDER than current → REJECT
 *   3. RATE VARIANCE — any individual slab rate differs by > THRESHOLD → WARN
 *
 * Usage:
 *   const { runDiffChecks } = require('./diff-engine');
 *   const result = runDiffChecks({ incoming, existingPath, variant, logger });
 *   if (result.reject) { // skip write }
 *   if (result.warnings.length) { // log warnings }
 */

const fs = require('node:fs');
const path = require('node:path');

/** Maximum allowed rate change (pct points) before flagging for review. */
const RATE_VARIANCE_THRESHOLD = 2.0;

/**
 * Compare two ISO date strings.
 * Returns  1 if a > b,  -1 if a < b,  0 if equal or either is null.
 */
function compareDates(a, b) {
  if (!a || !b) return 0;
  const da = new Date(a);
  const db = new Date(b);
  if (isNaN(da) || isNaN(db)) return 0;
  if (da > db) return 1;
  if (da < db) return -1;
  return 0;
}

/**
 * Build a lookup map from tenure key → rate for fast diff.
 * Key: `${currency}|${tenure_min_days}-${tenure_max_days}`
 */
function buildRateMap(slabs) {
  const map = new Map();
  for (const slab of (slabs || [])) {
    const key = `${slab.currency || 'INR'}|${slab.tenure_min_days}-${slab.tenure_max_days}`;
    // Store general rate (prefer that over senior for the diff baseline)
    const rate = slab.rate_general_pct ?? slab.rate_senior_pct;
    if (rate != null) map.set(key, rate);
  }
  return map;
}

/**
 * Run all diff checks.
 *
 * @param {object} opts
 * @param {object}   opts.incoming      — the new payload (with rate_slabs, effective_date)
 * @param {string}   opts.existingPath  — absolute path to the current on-disk file
 * @param {string}   [opts.variant]     — e.g. 'nre', 'regular' (for log messages)
 * @param {object}   [opts.logger]      — optional logger with .warn / .info
 * @returns {{ reject: boolean, rejectReason: string|null, warnings: string[] }}
 */
function runDiffChecks({ incoming, existingPath, variant = 'unknown', logger }) {
  const log = logger || { warn: (m) => console.warn(m), info: (m) => console.info(m) };
  const label = path.basename(existingPath);

  const warnings = [];
  let reject = false;
  let rejectReason = null;

  // Read the existing on-disk file (if any)
  let existing = null;
  try {
    if (fs.existsSync(existingPath)) {
      existing = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
    }
  } catch {
    // If we can't read the existing file, it's corrupted or missing — allow the write
    log.info(`[diff-engine] ${label}: no readable existing file — diff checks skipped`);
    return { reject: false, rejectReason: null, warnings: [] };
  }

  if (!existing) {
    // First-ever write — nothing to diff against
    return { reject: false, rejectReason: null, warnings: [] };
  }

  const existingSlabs = existing.rate_slabs || [];
  const incomingSlabs = incoming.rate_slabs || [];

  // ── Check 1: Volume Drop ──────────────────────────────────────────────────
  // If the existing file has real slabs, and the new scrape found ZERO,
  // this is almost certainly a scraper failure. REJECT.
  if (existingSlabs.length > 0 && incomingSlabs.length === 0) {
    rejectReason = `volume_drop: existing=${existingSlabs.length} slabs, incoming=0 slabs`;
    reject = true;
    log.warn(`[diff-engine] REJECT ${label} (${variant}): ${rejectReason}`);
    return { reject, rejectReason, warnings };
  }

  // ── Check 2: Stale Regression ─────────────────────────────────────────────
  // If the new effective_date is OLDER than what we already have, the scraper
  // is hallucinating or fetching a stale PDF. REJECT.
  const dateComparison = compareDates(incoming.effective_date, existing.effective_date);
  if (dateComparison < 0) {
    rejectReason = `stale_regression: incoming=${incoming.effective_date} is older than existing=${existing.effective_date}`;
    reject = true;
    log.warn(`[diff-engine] REJECT ${label} (${variant}): ${rejectReason}`);
    return { reject, rejectReason, warnings };
  }

  // ── Check 3: Rate Variance Threshold ─────────────────────────────────────
  // If any individual slab rate jumps or drops by more than the threshold,
  // flag it for human review (WARNING — does NOT block the write).
  if (existingSlabs.length > 0 && incomingSlabs.length > 0) {
    const existingMap = buildRateMap(existingSlabs);
    const incomingMap = buildRateMap(incomingSlabs);

    for (const [key, incomingRate] of incomingMap.entries()) {
      const existingRate = existingMap.get(key);
      if (existingRate == null) continue; // new tenure — not a red flag
      const delta = Math.abs(incomingRate - existingRate);
      if (delta > RATE_VARIANCE_THRESHOLD) {
        const msg = `[diff-engine] VARIANCE WARNING ${label} (${variant}): tenure=${key} changed ${existingRate}% → ${incomingRate}% (delta=${delta.toFixed(2)}%)`;
        warnings.push(msg);
        log.warn(msg);
      }
    }
  }

  return { reject, rejectReason, warnings };
}

module.exports = { runDiffChecks, RATE_VARIANCE_THRESHOLD };

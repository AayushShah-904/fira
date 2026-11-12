'use strict';
//
// Composite per-variant confidence score (Sprint 008, Phase 5).
//
// Combines the independent signals the program now produces into one
// 0–100 score + a verified|needs_review tier the PM can act on. Pure function;
// build-pack.js stays LLM-free by reading precomputed sidecars that carry these
// signals. See ADR-016 + design.
//
// Signals (all optional; absence is treated as "unknown", not "good"):
//   extractionMethod        'template' | 'tier2' | 'static' | null
//   crossCheckAgreement     'FULL'|'PARTIAL'|'DISAGREE'|'LLM_NO_DATA'|'SKIPPED'|null  (Phase 4)
//   structuralBlocking      count of ANOMALY-class structural findings (Phase 3)
//   structuralWarnings      count of WARN-class structural findings (Phase 3)
//   stale                   boolean — effective_date older than the freshness window
//   measuredMethodErrorRate 0..1 — the stratum error rate for this method (Phase 2), or null

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function computeVariantConfidence(signals = {}) {
  const {
    extractionMethod = null,
    crossCheckAgreement = null,
    structuralBlocking = 0,
    structuralWarnings = 0,
    stale = false,
    measuredMethodErrorRate = null,
  } = signals;

  let score = 100;
  const contributors = [];
  const add = (label, delta) => { if (delta) { score += delta; contributors.push({ signal: label, effect: delta }); } };

  // Structural checks (Phase 3) — strongest negative signal.
  if (structuralBlocking > 0) add('structural_anomaly', -40);
  else if (structuralWarnings > 0) add('structural_warning', -10);

  // Independent cross-check (Phase 4).
  switch (crossCheckAgreement) {
    case 'FULL': add('crosscheck_full', +0); break;
    case 'PARTIAL': add('crosscheck_partial', -10); break;
    case 'DISAGREE': add('crosscheck_disagree', -35); break;
    case 'LLM_NO_DATA': add('crosscheck_no_data', -20); break;
    case 'SKIPPED': add('crosscheck_skipped', -5); break;
    default: add('crosscheck_absent', -5); break;
  }

  // Extraction method — static is neither auto-refreshed nor operator-curated.
  if (extractionMethod === 'static') add('method_static', -10);

  // Freshness.
  if (stale) add('stale', -15);

  // Measured error rate for this method/stratum (Phase 2), half-weighted.
  if (typeof measuredMethodErrorRate === 'number') {
    const penalty = Math.round(measuredMethodErrorRate * 100 * 0.5);
    add('measured_error_rate', -penalty);
  }

  score = clamp(Math.round(score), 0, 100);

  // Tier: "verified" requires no structural anomaly, not stale, and either an
  // independent FULL cross-check OR (no cross-check available AND a low measured
  // error rate for this method). Everything else is "needs_review".
  const crossOk = crossCheckAgreement === 'FULL'
    || (crossCheckAgreement == null && (measuredMethodErrorRate == null || measuredMethodErrorRate < 0.1));
  const tier = (structuralBlocking === 0 && !stale && crossOk && score >= 70) ? 'verified' : 'needs_review';

  return { score, tier, contributors };
}

module.exports = { computeVariantConfidence };

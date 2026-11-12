'use strict';

/**
 * Two-tier failure classification for per-bank discovery results.
 *
 * Tier 1 — phase_outcomes: three independent enums describing what happened
 *   in each phase (Website discovery → Rate-page discovery → Extraction).
 * Tier 2 — failure_class: a small rolled-up label derived from the triple,
 *   used as the headline classification in run reports.
 *
 * Spec: sdlc/sprints/sprint-002/design/failure-class-taxonomy.md
 */

const fs = require('node:fs');
const path = require('node:path');

const WEBSITE_OUTCOMES = Object.freeze([
  'found_committed',         // config written with non-null website
  'reachable_uncommitted',   // ≥1 successful fetch but no config produced
  'candidates_all_failed',   // fetch attempts present, all errored
  'no_candidates',           // zero fetch attempts
]);

const RATE_PAGE_OUTCOMES = Object.freeze([
  'found',                   // config.rate_page_urls.fd is set
  'not_found',               // config exists but no rate URL
  'not_attempted',           // no config exists
]);

const EXTRACTION_OUTCOMES = Object.freeze([
  'succeeded',                  // ≥1 slab + confidence high/medium
  'succeeded_low_confidence',   // ≥1 slab + confidence low/none
  'failed',                     // 0 slabs
  'not_attempted',              // no rates file exists
]);

// Tier-2 rollup (Option A — 6 values + unclassified fallback).
//
// 'partial_silent' (Sprint 4 Track A 2026-05-20): extraction technically
// succeeded — config + ≥1 slab with high/medium confidence — but the
// per-variant slab count is below the operator-curated floor or the prior
// run's count, so the data is suspected of being incomplete. Marker file
// at <runDir>/<bank_code>.partial_silent.json is the signal. Downstream
// propagation (rates-pack, git-publish) excludes banks classified this way.
const FAILURE_CLASSES = Object.freeze([
  'success',
  'partial_success',
  'partial_silent',
  'discovery_failed',
  'extraction_failed',
  'no_rates_expected',
  'agent_error',
  'unclassified',
]);

// Tightened in Sprint 002 (L14). Earlier `/no\s+(fd|fixed deposit)/` over-matched
// notes like "No FD slab details available" or "No FD rates published online" —
// banks that DO offer FDs but just don't publish rates online. Those should route
// to `partial_success` (website found, rate page not), not `no_rates_expected`.
//
// True no_rates_expected requires explicit no-product phrasing OR the
// Payments Bank category (which by RBI rule can't offer term deposits).
const NO_RATES_NOTES_REGEX = new RegExp(
  [
    String.raw`\bdoes not offer\s+(fd|fixed deposit|term deposit)`,
    String.raw`\bno\s+(fixed\s+)?deposit\s+(product|scheme|account)\b`,
    String.raw`\bpayments?\s+bank\b`,
    String.raw`\bnot\s+a\s+(banking|deposit-taking)\s+institution\b`,
  ].join('|'),
  'i',
);

/**
 * Classify a single bank's discovery result.
 *
 * @param {object} ctx
 * @param {object} ctx.agentResult       - { success: bool, finalText?: string, model?: string }
 * @param {string} ctx.runDir            - directory containing per-bank artifacts
 * @param {string} ctx.bankCode          - canonical bank slug
 * @param {boolean} ctx.domainWasKnown   - whether bank-domains.json had an entry coming in
 * @param {1|2} ctx.initialTier          - tier of the first attempt
 * @param {boolean} ctx.retryAttempted   - whether a Tier 2 retry ran after Tier 1
 * @returns {{ failure_class: string, phase_outcomes: object, failure_signals: object }}
 */
function classifyResult(ctx) {
  const { agentResult, runDir, bankCode, domainWasKnown, initialTier, retryAttempted } = ctx;

  const signals = readSignals({ runDir, bankCode, agentResult, initialTier, retryAttempted });
  const phase_outcomes = derivePhaseOutcomes(signals);
  const failure_class = deriveFailureClass({ phase_outcomes, signals });

  return {
    failure_class,
    phase_outcomes,
    failure_signals: { ...signals, domain_was_known: !!domainWasKnown },
  };
}

function readSignals({ runDir, bankCode, agentResult, initialTier, retryAttempted }) {
  const configPath = path.join(runDir, `${bankCode}_config.json`);
  const ratesPath = path.join(runDir, `${bankCode}_rates.json`);
  const finalSummaryPath = retryAttempted
    ? path.join(runDir, `${bankCode}_attempt2.summary.json`)
    : path.join(runDir, `${bankCode}.summary.json`);
  // Sprint 4 Track A: drift-detected marker written by run-discovery.js when
  // MAX_ATTEMPTS exhausted and per-variant counts are still below the
  // operator floor / prior. Drives the partial_silent rollup below.
  const partialSilentMarker = readJsonSafe(path.join(runDir, `${bankCode}.partial_silent.json`));

  const config = readJsonSafe(configPath);
  const rates = readJsonSafe(ratesPath);
  const summary = readJsonSafe(finalSummaryPath);

  let fetchOkCount = 0;
  let fetchErrorCount = 0;
  if (summary && Array.isArray(summary.tool_calls)) {
    for (const tc of summary.tool_calls) {
      if (!tc || !isFetchTool(tc.name)) continue;
      if (tc.is_error) fetchErrorCount += 1;
      else fetchOkCount += 1;
    }
  }

  const websiteFromConfig = config && typeof config.website === 'string' && config.website && config.website !== '?'
    ? config.website
    : null;
  const rateUrlFromConfig = config && config.rate_page_urls && typeof config.rate_page_urls.fd === 'string' && config.rate_page_urls.fd
    ? config.rate_page_urls.fd
    : null;

  return {
    config_exists: !!config,
    rates_exists: !!rates,
    scraper_type: config ? config.scraper_type || null : null,
    notes: config ? config.notes || '' : '',
    website_url: websiteFromConfig,
    rate_url_fd: rateUrlFromConfig,
    slab_count: rates && Array.isArray(rates.rate_slabs) ? rates.rate_slabs.length : 0,
    extraction_confidence: rates ? rates.extraction_confidence || null : null,
    agent_success: !!(agentResult && agentResult.success),
    initial_tier: initialTier,
    retry_attempted: !!retryAttempted,
    fetch_ok_count: fetchOkCount,
    fetch_error_count: fetchErrorCount,
    slab_drift_detected: !!partialSilentMarker,
    slab_drift_reason: partialSilentMarker ? partialSilentMarker.reason || null : null,
  };
}

function derivePhaseOutcomes(signals) {
  // Phase 1 — Website discovery
  let website;
  if (signals.config_exists && signals.website_url) {
    website = 'found_committed';
  } else if (signals.fetch_ok_count > 0) {
    website = 'reachable_uncommitted';
  } else if (signals.fetch_error_count > 0) {
    website = 'candidates_all_failed';
  } else {
    website = 'no_candidates';
  }

  // Phase 2 — Rate-page discovery
  let rate_page;
  if (!signals.config_exists) {
    rate_page = 'not_attempted';
  } else if (signals.rate_url_fd) {
    rate_page = 'found';
  } else {
    rate_page = 'not_found';
  }

  // Phase 3 — Extraction
  let extraction;
  if (!signals.rates_exists) {
    extraction = 'not_attempted';
  } else if (signals.slab_count === 0) {
    extraction = 'failed';
  } else {
    const conf = (signals.extraction_confidence || '').toLowerCase();
    extraction = (conf === 'low' || conf === 'none') ? 'succeeded_low_confidence' : 'succeeded';
  }

  return { website, rate_page, extraction };
}

function deriveFailureClass({ phase_outcomes, signals }) {
  // Agent runtime failure trumps everything else.
  if (!signals.agent_success) return 'agent_error';

  const { website, rate_page, extraction } = phase_outcomes;

  // Manual scraper_type with no-rates-expected notes (e.g., payments bank).
  if (signals.scraper_type === 'manual' && NO_RATES_NOTES_REGEX.test(signals.notes)) {
    return 'no_rates_expected';
  }

  // Discovery never landed a website.
  if (website === 'candidates_all_failed' || website === 'no_candidates') {
    return 'discovery_failed';
  }

  // Website committed; pipeline outcome depends on later phases.
  if (website === 'found_committed') {
    if (rate_page === 'not_found') return 'partial_success';
    if (rate_page === 'found' && extraction === 'failed') return 'extraction_failed';
    if (extraction === 'succeeded' || extraction === 'succeeded_low_confidence') {
      // Sprint 4 Track A: slabs landed but per-variant count is below the
      // operator-curated floor (bank-domains.json#expected_slab_count_min)
      // or the prior run's count after MAX_ATTEMPTS retries. The data
      // technically exists but is suspected of being incomplete — surface
      // loudly so downstream propagation can exclude it.
      if (signals.slab_drift_detected) return 'partial_silent';
      return 'success';
    }
    // rate_page === 'found' but extraction === 'not_attempted' is unexpected; fall through.
    return 'unclassified';
  }

  // Reachable but uncommitted — agent fetched something but didn't pin a website.
  if (website === 'reachable_uncommitted') {
    return 'partial_success';
  }

  return 'unclassified';
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function isFetchTool(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  return n === 'fetch_url' || n === 'webfetch' || n === 'web_fetch';
}

module.exports = {
  classifyResult,
  FAILURE_CLASSES,
  WEBSITE_OUTCOMES,
  RATE_PAGE_OUTCOMES,
  EXTRACTION_OUTCOMES,
};

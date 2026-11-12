'use strict';

/**
 * Shared verdict/failure classifier for bulk-author reports.
 *
 * Used by both scripts/bulk-triage.js (to bucket a report for humans) and
 * scripts/bulk-author.js (to build a targeted worklist via --from-report, so
 * iteration hits only the problem group instead of re-running the full cohort).
 *
 * Keeping ONE copy means the two tools never disagree about what bucket a bank
 * is in — e.g. "waf_or_unreachable" must mean the same thing when triage prints
 * it and when --exclude-buckets skips it.
 */

// Failure buckets that are NOT worth an automatic re-run: the page is blocked,
// the URL/registry is missing, or the LLM picked a wrong table that re-running
// won't change without a config edit. Re-running these just burns fetches/LLM.
const DEAD_FAIL_BUCKETS = new Set([
  'waf_or_unreachable',
  'config_missing_url',
  'config_missing_entry',
]);

function classifyFailure(r) {
  const err = (r.error || '').toLowerCase();
  if (err.includes('fetch_failed') && r.final_strategy === 'llm-fallback') return 'waf_or_unreachable';
  if (err.includes('fetch_threw')) return 'fetch_threw';
  if (err.startsWith('fetch_')) return 'fetch_other';
  if (err.includes('llm_no_template')) return 'propose_no_template';
  if (err.includes('propose_failed')) return 'propose_error';
  if (err.includes('no_rate_url')) return 'config_missing_url';
  if (err.includes('no_registry_entry')) return 'config_missing_entry';
  if (r.failures && r.failures.length > 0) {
    if (r.failures.some(f => f.startsWith('zero_slabs'))) return 'extract_zero_slabs';
    if (r.failures.some(f => f.startsWith('anti_fabrication'))) return 'anti_fabrication';
    if (r.failures.some(f => f.startsWith('rate_out_of_range'))) return 'rate_out_of_range';
    return 'gate_failure_other';
  }
  return 'unknown';
}

function classifyReview(r) {
  if (!r.warnings || r.warnings.length === 0) return 'no_warnings';
  const w = r.warnings.join(' ');
  if (w.includes('slab_count_low')) return 'slab_count_low';
  if (w.includes('missing_long_tenure')) return 'missing_long_tenure';
  if (w.includes('baseline_drop')) return 'baseline_drop';
  return 'other';
}

/** Classification regardless of verdict (FAIL → failure bucket, REVIEW → review bucket). */
function classify(r) {
  if (r.verdict === 'FAIL') return classifyFailure(r);
  if (r.verdict === 'REVIEW') return classifyReview(r);
  return r.verdict; // PASS
}

module.exports = { classifyFailure, classifyReview, classify, DEAD_FAIL_BUCKETS };

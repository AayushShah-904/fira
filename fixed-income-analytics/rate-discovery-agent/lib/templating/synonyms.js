'use strict';

/**
 * Header-cell synonym map for template fingerprinting.
 *
 * Two banks publishing identical rate-table structure differ only in their
 * exact header wording — "General Rate" vs "Rate of Interest (%)", "Senior
 * Citizen" vs "Sr. Citizen Rate", "Period of Deposit" vs "Tenure". The
 * fingerprint algorithm maps both to a canonical token before hashing so the
 * banks land in the same cluster.
 *
 * Sprint 005 Phase A. Grows as new banks land — additions don't break
 * existing fingerprints because new entries only consolidate further;
 * removals or rewrites of existing entries WOULD invalidate prior
 * template_hash values and require an operator-supervised re-fingerprint.
 */

// Map from (normalized header token) → canonical token.
// Order doesn't matter; lookup is exact match after normalization.
const SYNONYM_MAP = new Map([
  // Tenure column variants
  ['tenure', 'tenure'],
  ['period', 'tenure'],
  ['period of deposit', 'tenure'],
  ['period of fixed deposit', 'tenure'],
  ['tenor', 'tenure'],
  ['duration', 'tenure'],
  ['maturity', 'tenure'],
  ['term', 'tenure'],
  ['deposit period', 'tenure'],

  // Regular / general rate column
  ['rate', 'regular'],
  ['rate of interest', 'regular'],
  ['interest rate', 'regular'],
  ['roi', 'regular'],
  ['general', 'regular'],
  ['general rate', 'regular'],
  ['regular', 'regular'],
  ['general public', 'regular'],
  ['non senior', 'regular'],
  ['below 60', 'regular'],

  // Senior citizen column
  ['senior', 'senior'],
  ['sr citizen', 'senior'],
  ['sr citizen rate', 'senior'],
  ['senior citizen', 'senior'],
  ['senior citizens', 'senior'],
  ['senior citizen rate', 'senior'],
  ['60 and above', 'senior'],
  ['60 plus', 'senior'],

  // Super senior (typically 80+)
  ['super senior', 'super_senior'],
  ['super sr citizen', 'super_senior'],
  ['super senior citizen', 'super_senior'],
  ['super senior citizens', 'super_senior'],
  ['80 and above', 'super_senior'],

  // FCNR / currency column
  ['currency', 'currency'],
  ['ccy', 'currency'],

  // Amount / deposit range
  ['amount', 'amount'],
  ['deposit amount', 'amount'],
  ['minimum deposit', 'amount'],
  ['min deposit', 'amount'],
  ['slab', 'amount'],

  // Effective date / notes (footnote columns we want to ignore in column map)
  ['effective from', 'effective_date'],
  ['effective date', 'effective_date'],
  ['wef', 'effective_date'],
  ['w e f', 'effective_date'],
  ['notes', 'notes'],
  ['remarks', 'notes'],
]);

/**
 * Normalize a header cell to a comparable token.
 * Strips punctuation, lowercases, collapses whitespace, strips parentheticals
 * like "(%)" or "(p.a.)" and trailing "rate" suffix where it's redundant.
 */
function normalizeHeader(text) {
  if (!text) return '';
  let s = String(text).toLowerCase();
  s = s.replace(/\(.*?\)/g, ' ');          // strip parentheticals
  s = s.replace(/[^a-z0-9\s]/g, ' ');       // strip punctuation
  s = s.replace(/\s+/g, ' ').trim();        // collapse whitespace
  return s;
}

/**
 * Map a normalized header to its canonical token, or return the normalized
 * input if no mapping exists (so unknown headers don't collapse silently).
 */
function canonicalize(normalized) {
  return SYNONYM_MAP.get(normalized) || normalized;
}

/**
 * Convenience: normalize + canonicalize in one call.
 */
function normalizeAndCanonicalize(text) {
  return canonicalize(normalizeHeader(text));
}

module.exports = {
  SYNONYM_MAP,
  normalizeHeader,
  canonicalize,
  normalizeAndCanonicalize,
};

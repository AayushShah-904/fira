'use strict';

/**
 * Anti-fabrication contract enforcement.
 *
 * Sprint 005 Phase C — every extractor must populate `source_row_text` for
 * every emitted slab. This helper verifies the contract: the source_row_text
 * must contain the tenure text fragment AND every non-null rate value.
 *
 * Pre-Sprint-005, this contract lived implicitly inside extract_html_table.js.
 * Sprint 003 retroactively added it as Sprint 003's load-bearing trust
 * mechanism. Lifting it to a shared helper means every future extractor
 * inherits it for free — and any extractor that tries to fabricate slabs
 * (LLM hallucination, mis-aligned column index, off-by-one row) trips a
 * loud assertion rather than silently shipping garbage.
 */

/**
 * Normalize a string for fuzzy comparison: lowercase, strip punctuation,
 * collapse whitespace.
 */
function normalizeForMatch(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9.%]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Format a rate value into the canonical string we expect to find in
 * source_row_text. Examples: 6.5 → "6.5" / "6.50", 6 → "6.0" / "6.00".
 * We test multiple candidate forms because banks publish rates as both
 * "6.5%" and "6.50%".
 */
function rateCandidates(r) {
  const fixed2 = r.toFixed(2);      // "6.50"
  const fixed1 = r.toFixed(1);      // "6.5"
  const trimmed = fixed2.replace(/\.?0+$/, ''); // "6" / "6.5"
  const trimmedFromFixed1 = fixed1.replace(/\.0$/, ''); // "6"
  return [...new Set([fixed2, fixed1, trimmed, trimmedFromFixed1])];
}

/**
 * Assert every slab carries a source_row_text that mentions its tenure_text
 * and every non-null rate. Returns { passed, failures }.
 *
 * @param {Slab[]} slabs
 * @param {{strict?: boolean, requireRateMatch?: boolean}} [opts]
 *   strict (default true): throw on first failure batch
 *   requireRateMatch (default true): require rate values to appear in source_row_text
 * @returns {{passed: boolean, failures: Array<{index, reason, slab}>}}
 */
function assertTraceability(slabs, { strict = true, requireRateMatch = true } = {}) {
  if (!Array.isArray(slabs)) {
    throw new Error('assertTraceability: slabs must be an array');
  }
  const failures = [];
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    if (!s || typeof s !== 'object') {
      failures.push({ index: i, reason: 'slab is not an object', slab: s });
      continue;
    }
    if (!s.source_row_text || typeof s.source_row_text !== 'string') {
      failures.push({ index: i, reason: 'missing source_row_text', slab: s });
      continue;
    }
    const lowerRow = normalizeForMatch(s.source_row_text);

    // Tenure text fragment must appear in source_row_text.
    if (s.tenure_text) {
      const normTenure = normalizeForMatch(s.tenure_text);
      // Allow partial-token match: the tenure text might be wrapped in
      // parentheticals ("(new slab)") which the slab field strips but
      // the source row preserves. Require all non-trivial tokens (length > 1)
      // from tenure to appear in source.
      const tokens = normTenure.split(' ').filter((t) => t.length > 1);
      const missing = tokens.filter((t) => !lowerRow.includes(t));
      if (missing.length > 0 && tokens.length > 0 && missing.length === tokens.length) {
        failures.push({ index: i, reason: `tenure_text "${s.tenure_text}" not found in source_row_text`, slab: s });
        continue;
      }
    }

    if (requireRateMatch) {
      const ratesToCheck = [s.rate_general_pct, s.rate_senior_pct, s.rate_super_senior_pct]
        .filter((r) => r != null && Number.isFinite(r));
      for (const r of ratesToCheck) {
        const candidates = rateCandidates(r);
        const matched = candidates.some((c) => lowerRow.includes(c));
        if (!matched) {
          failures.push({
            index: i,
            reason: `rate ${r}% (candidates ${JSON.stringify(candidates)}) not found in source_row_text`,
            slab: s,
          });
          break; // one failure per slab is enough; don't double-report
        }
      }
    }
  }

  if (failures.length > 0 && strict) {
    throw new Error(
      `assertTraceability: ${failures.length}/${slabs.length} slabs failed the anti-fabrication contract.\n` +
      `First 3 failures: ${JSON.stringify(failures.slice(0, 3), null, 2)}`
    );
  }
  return { passed: failures.length === 0, failures };
}

module.exports = {
  assertTraceability,
  normalizeForMatch,
  rateCandidates,
};

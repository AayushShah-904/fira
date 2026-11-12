'use strict';

/**
 * Sprint 009 Phase 5 — per-bank artifact merge.
 *
 * Pure function. Takes a cloud-side artifact and a local-side artifact
 * for one (bank, variant) and produces a single merged artifact with
 * provenance attached via a `source_runs` block.
 *
 * Operator decision (sprint open #3): "richer-set-wins for slab arrays;
 * local-wins for extraction_method / source_url / curated fields."
 *
 * Per-field rules — see sdlc/sprints/sprint-009/design/phase-5-merge-
 * mechanism.md for the full table. Reproduced here:
 *
 *   rate_slabs                  — winner = higher length. Tiebreak: local.
 *   extraction_method           — local wins (curated > re-extraction)
 *   source_url                  — local wins
 *   effective_date              — pick the more recent ISO date
 *   scraped_at                  — pick the more recent ISO timestamp
 *   extraction_confidence       — pick the higher of {high, medium, low, none}.
 *                                 Tiebreak: local.
 *   warnings                    — union, deduplicated by string equality
 *   bank_code / product_type /
 *     variant                   — identity fields; must match (assertion)
 *   any other field             — local wins (curated path is safer default)
 */

const CONFIDENCE_RANK = { high: 4, medium: 3, low: 2, none: 1 };
const IDENTITY_FIELDS = ['bank_code', 'product_type', 'variant'];

/**
 * Compare two ISO date/timestamp strings. Returns the more recent one,
 * or whichever is non-empty if the other is empty/invalid.
 */
function pickLaterIso(a, b) {
  const tA = a ? Date.parse(a) : NaN;
  const tB = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(tA) && !Number.isFinite(tB)) return a || b || null;
  if (!Number.isFinite(tA)) return b;
  if (!Number.isFinite(tB)) return a;
  return tA >= tB ? a : b;
}

/**
 * Pick the stronger confidence. Tiebreak: local (caller passes localValue second).
 */
function pickStrongerConfidence(cloudValue, localValue) {
  const cRank = CONFIDENCE_RANK[(cloudValue || '').toLowerCase()] || 0;
  const lRank = CONFIDENCE_RANK[(localValue || '').toLowerCase()] || 0;
  if (cRank === 0 && lRank === 0) return localValue || cloudValue || null;
  if (cRank > lRank) return cloudValue;
  return localValue; // includes tie → local wins
}

function dedupArray(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Merge one bank's (cloud, local) artifact into a single output with
 * provenance.
 *
 * @param {object} args
 * @param {object|null} args.cloud       — cloud-side artifact (rates/config). null if cloud did not run for this bank.
 * @param {object|null} args.local       — local-side artifact. null if local did not run for this bank.
 * @param {string|null} args.cloudRunId  — cloud run label / id for source_runs provenance
 * @param {string|null} args.localRunId  — local run label / id for source_runs provenance
 * @returns {{ merged: object|null, decisions: object, source_runs: Array }}
 */
function mergeArtifact({ cloud, local, cloudRunId, localRunId }) {
  if (!cloud && !local) return { merged: null, decisions: {}, source_runs: [] };

  // Identity-field consistency check (when both sides exist).
  if (cloud && local) {
    for (const f of IDENTITY_FIELDS) {
      const c = cloud[f];
      const l = local[f];
      if (c !== undefined && l !== undefined && c !== l) {
        throw new Error(
          `mergeArtifact: identity field "${f}" mismatch — cloud=${JSON.stringify(c)} local=${JSON.stringify(l)}`,
        );
      }
    }
  }

  const cloudOnly = cloud && !local;
  const localOnly = local && !cloud;

  if (cloudOnly) {
    return {
      merged: { ...cloud, source_runs: [{ run_id: cloudRunId || null, source: 'cloud', contributed_fields: Object.keys(cloud) }] },
      decisions: { side: 'cloud-only' },
      source_runs: [{ run_id: cloudRunId || null, source: 'cloud' }],
    };
  }
  if (localOnly) {
    return {
      merged: { ...local, source_runs: [{ run_id: localRunId || null, source: 'local', contributed_fields: Object.keys(local) }] },
      decisions: { side: 'local-only' },
      source_runs: [{ run_id: localRunId || null, source: 'local' }],
    };
  }

  // Both sides present. Field-by-field merge.
  const merged = {};
  const decisions = {};
  const cloudFields = [];
  const localFields = [];

  // Pre-compute the rate_slabs winner so per-array decisions stay coherent.
  let slabsWinner = null;
  if (Array.isArray(cloud.rate_slabs) || Array.isArray(local.rate_slabs)) {
    const cLen = Array.isArray(cloud.rate_slabs) ? cloud.rate_slabs.length : -1;
    const lLen = Array.isArray(local.rate_slabs) ? local.rate_slabs.length : -1;
    if (cLen > lLen) slabsWinner = 'cloud';
    else slabsWinner = 'local'; // tie or local-richer
  }

  // Union of keys; treat identity + special-case fields first, fall through to per-field default.
  const allKeys = new Set([...Object.keys(cloud), ...Object.keys(local)]);
  for (const k of allKeys) {
    if (k === 'source_runs') continue; // we rebuild this at the end

    const cV = cloud[k];
    const lV = local[k];

    // Identity fields — caller-asserted equal above; just pick local.
    if (IDENTITY_FIELDS.includes(k)) {
      merged[k] = lV !== undefined ? lV : cV;
      decisions[k] = lV !== undefined ? 'local' : 'cloud';
      continue;
    }

    if (k === 'rate_slabs') {
      merged[k] = slabsWinner === 'cloud' ? cloud.rate_slabs : local.rate_slabs;
      decisions[k] = `${slabsWinner} (richer-set)`;
      continue;
    }

    if (k === 'extraction_method' || k === 'source_url') {
      // local wins (curated)
      if (lV !== undefined && lV !== null) { merged[k] = lV; decisions[k] = 'local'; }
      else if (cV !== undefined) { merged[k] = cV; decisions[k] = 'cloud'; }
      continue;
    }

    if (k === 'effective_date' || k === 'scraped_at') {
      const picked = pickLaterIso(cV, lV);
      merged[k] = picked;
      // figure out which side it came from
      if (picked === cV && picked !== lV) decisions[k] = 'cloud (later iso)';
      else decisions[k] = 'local (later iso)';
      continue;
    }

    if (k === 'extraction_confidence') {
      const picked = pickStrongerConfidence(cV, lV);
      merged[k] = picked;
      if (picked === cV && picked !== lV) decisions[k] = 'cloud (stronger)';
      else decisions[k] = 'local (>= cloud)';
      continue;
    }

    if (k === 'warnings') {
      merged[k] = dedupArray([...(Array.isArray(cV) ? cV : []), ...(Array.isArray(lV) ? lV : [])]);
      decisions[k] = 'union';
      continue;
    }

    // Default: local wins.
    if (lV !== undefined) { merged[k] = lV; decisions[k] = 'local'; }
    else { merged[k] = cV; decisions[k] = 'cloud'; }
  }

  // Build contributed_fields per source from decisions.
  for (const [k, who] of Object.entries(decisions)) {
    if (who.startsWith('cloud')) cloudFields.push(k);
    if (who.startsWith('local')) localFields.push(k);
    if (who === 'union') { cloudFields.push(k); localFields.push(k); }
  }

  const source_runs = [];
  if (cloudFields.length > 0) source_runs.push({ run_id: cloudRunId || null, source: 'cloud', contributed_fields: cloudFields });
  if (localFields.length > 0) source_runs.push({ run_id: localRunId || null, source: 'local', contributed_fields: localFields });

  merged.source_runs = source_runs;

  return { merged, decisions, source_runs };
}

module.exports = {
  mergeArtifact,
  pickLaterIso,
  pickStrongerConfidence,
  dedupArray,
  _internal: { CONFIDENCE_RANK, IDENTITY_FIELDS },
};

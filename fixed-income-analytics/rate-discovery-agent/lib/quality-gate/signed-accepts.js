'use strict';

/**
 * Signed quality-gate accept entries.
 *
 * Sprint 005 Phase D2 — agent-immune quality gate. Replaces the prior
 * "any process that writes pack/quality-gate-accepts.json can flip BLOCK to
 * PASS" model with HMAC-signed entries whose signing key lives outside the
 * repo. The 2026-05-23 trust incident (sdlc/sprints/sprint-004/implementation/
 * cohort-pm-q2-passV1-2026-05-23.md, reverted in 3193746) is structurally
 * impossible under this design.
 *
 * Design: sdlc/sprints/sprint-005/design/observability-and-gate.md
 *
 * Pure functions only — no FS, no env-var lookups, no process exits. The CLI
 * (bin/approve-accept.js) and the gate (scripts/quality-gate.js) wrap these
 * with their own concerns.
 */

const crypto = require('node:crypto');

const SIGNED_FORMAT_VERSION = 1;
const HMAC_PREFIX = 'hmac-sha256:';
const FINDING_HASH_PREFIX = 'sha256:';

/**
 * Compute the canonical finding hash. The hash binds an accept entry to a
 * specific finding shape — if the pack regresses further (different baseline/
 * actual), the hash changes and the accept no longer matches.
 *
 * @param {object} finding {bank_code, variant, class, baseline, actual, check?}
 * @returns {string} "sha256:<hex>"
 */
function computeFindingHash(finding) {
  if (!finding || typeof finding !== 'object') {
    throw new Error('computeFindingHash: finding must be an object');
  }
  const canonical = canonicalizeForHash(finding);
  const h = crypto.createHash('sha256').update(canonical).digest('hex');
  return FINDING_HASH_PREFIX + h;
}

/**
 * Canonical JSON for finding_hash. Field order fixed; null/undefined omitted.
 */
function canonicalizeForHash(finding) {
  const out = {};
  if (finding.bank_code != null) out.bank_code = String(finding.bank_code);
  if (finding.variant != null) out.variant = String(finding.variant);
  if (finding.check != null) out.check = String(finding.check);
  if (finding.class != null) out.class = String(finding.class);
  if (finding.baseline != null) out.baseline = Number(finding.baseline);
  if (finding.actual != null) out.actual = Number(finding.actual);
  return JSON.stringify(out);
}

/**
 * Canonical JSON for signature. Field order fixed; null/undefined omitted.
 * Note: signature is over the entry MINUS the signature field itself.
 */
function canonicalizeForSig(entry) {
  const out = {};
  if (entry.bank_code != null) out.bank_code = String(entry.bank_code);
  if (entry.variant != null) out.variant = String(entry.variant);
  if (entry.check != null) out.check = String(entry.check);
  if (entry.finding_hash != null) out.finding_hash = String(entry.finding_hash);
  if (entry.approved_by != null) out.approved_by = String(entry.approved_by);
  if (entry.approved_at != null) out.approved_at = String(entry.approved_at);
  if (entry.reason != null) out.reason = String(entry.reason);
  return JSON.stringify(out);
}

/**
 * Sign an accept entry with the operator key. Returns a new object with
 * `signature` populated; input is not mutated.
 *
 * @param {object} entry {bank_code, variant, check?, finding_hash, approved_by, approved_at, reason}
 * @param {Buffer|string} key  operator key bytes (or hex string)
 * @returns {object} entry + { signature }
 */
function signAccept(entry, key) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('signAccept: entry must be an object');
  }
  const keyBuf = normalizeKey(key);
  if (!entry.bank_code) throw new Error('signAccept: entry.bank_code is required');
  if (!entry.finding_hash) throw new Error('signAccept: entry.finding_hash is required');
  if (!entry.approved_by) throw new Error('signAccept: entry.approved_by is required');
  if (!entry.approved_at) throw new Error('signAccept: entry.approved_at is required');
  if (!entry.reason) throw new Error('signAccept: entry.reason is required');

  const canonical = canonicalizeForSig(entry);
  const sig = crypto.createHmac('sha256', keyBuf).update(canonical).digest('hex');
  return { ...entry, signature: HMAC_PREFIX + sig };
}

/**
 * Verify an accept entry's signature using the operator key. Constant-time
 * comparison to defeat timing attacks.
 *
 * @param {object} entry
 * @param {Buffer|string} key
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyAccept(entry, key) {
  if (!entry || typeof entry !== 'object') {
    return { valid: false, reason: 'entry must be an object' };
  }
  if (typeof entry.signature !== 'string' || !entry.signature.startsWith(HMAC_PREFIX)) {
    return { valid: false, reason: 'signature missing or wrong prefix' };
  }
  let keyBuf;
  try { keyBuf = normalizeKey(key); }
  catch (e) { return { valid: false, reason: `key invalid: ${e.message}` }; }

  const claimed = entry.signature.slice(HMAC_PREFIX.length);
  let claimedBuf;
  try { claimedBuf = Buffer.from(claimed, 'hex'); }
  catch { return { valid: false, reason: 'signature is not valid hex' }; }
  if (claimedBuf.length !== 32) {
    return { valid: false, reason: `signature wrong length (got ${claimedBuf.length}, expected 32 bytes)` };
  }

  const canonical = canonicalizeForSig(entry);
  const computed = crypto.createHmac('sha256', keyBuf).update(canonical).digest();

  if (!crypto.timingSafeEqual(claimedBuf, computed)) {
    return { valid: false, reason: 'signature does not match canonical entry' };
  }
  return { valid: true };
}

/**
 * Normalize an operator key to a Buffer. Accepts:
 *  - Buffer (returned as-is)
 *  - hex string (decoded to Buffer)
 *  - Buffer-like object with .toString('hex')
 * Rejects keys shorter than 16 bytes after decoding (HMAC needs entropy).
 */
function normalizeKey(key) {
  if (!key) throw new Error('operator key is empty or missing');
  let buf;
  if (Buffer.isBuffer(key)) {
    buf = key;
  } else if (typeof key === 'string') {
    // Allow whitespace/newlines around hex (operator may have a trailing \n in the key file)
    const cleaned = key.trim().replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
      throw new Error('operator key string must be hex (whitespace tolerated)');
    }
    if (cleaned.length % 2 !== 0) throw new Error('operator key hex string must have even length');
    buf = Buffer.from(cleaned, 'hex');
  } else {
    throw new Error('operator key must be a Buffer or hex string');
  }
  if (buf.length < 16) {
    throw new Error(`operator key too short (${buf.length} bytes; need at least 16)`);
  }
  return buf;
}

/**
 * Detect whether the current process is running inside an AI-agent session.
 * Returns { isAgent, reason } where isAgent is true if any agent-identifying
 * env var is set. Used by bin/approve-accept.js to refuse to run under agents.
 *
 * Kept here (not in the CLI) so the rule is unit-testable.
 */
function detectAgentEnvironment(env = process.env) {
  if (env.CLAUDECODE) return { isAgent: true, reason: 'CLAUDECODE env var set' };
  if (env.CLAUDE_CODE_ENTRYPOINT) return { isAgent: true, reason: 'CLAUDE_CODE_ENTRYPOINT env var set' };
  if (env.CLAUDE_CODE_SESSION_ID) return { isAgent: true, reason: 'CLAUDE_CODE_SESSION_ID env var set' };
  if (env.CLAUDE_CODE_EXECPATH) return { isAgent: true, reason: 'CLAUDE_CODE_EXECPATH env var set' };
  if (env.AI_AGENT && /claude|cursor|copilot|codeium|aider|windsurf/i.test(env.AI_AGENT)) {
    return { isAgent: true, reason: `AI_AGENT env var matches agent pattern (${env.AI_AGENT})` };
  }
  if (env.CURSOR_TRACE_ID) return { isAgent: true, reason: 'CURSOR_TRACE_ID env var set' };
  if (env.CURSOR_AGENT) return { isAgent: true, reason: 'CURSOR_AGENT env var set' };
  if (env.ANTHROPIC_CLI) return { isAgent: true, reason: 'ANTHROPIC_CLI env var set' };
  return { isAgent: false };
}

/**
 * Detect CI environment. Returns { isCI, reason }.
 */
function detectCiEnvironment(env = process.env) {
  if (env.CI === '1' || env.CI === 'true' || env.CI === true) return { isCI: true, reason: 'CI env var truthy' };
  if (env.GITHUB_ACTIONS) return { isCI: true, reason: 'GITHUB_ACTIONS env var set' };
  if (env.GITLAB_CI) return { isCI: true, reason: 'GITLAB_CI env var set' };
  if (env.BUILDKITE) return { isCI: true, reason: 'BUILDKITE env var set' };
  if (env.JENKINS_URL) return { isCI: true, reason: 'JENKINS_URL env var set' };
  if (env.CIRCLECI) return { isCI: true, reason: 'CIRCLECI env var set' };
  return { isCI: false };
}

module.exports = {
  SIGNED_FORMAT_VERSION,
  HMAC_PREFIX,
  FINDING_HASH_PREFIX,
  computeFindingHash,
  canonicalizeForHash,
  canonicalizeForSig,
  signAccept,
  verifyAccept,
  normalizeKey,
  detectAgentEnvironment,
  detectCiEnvironment,
};

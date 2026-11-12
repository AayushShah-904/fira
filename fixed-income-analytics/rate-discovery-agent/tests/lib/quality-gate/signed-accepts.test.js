'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  signAccept,
  verifyAccept,
  computeFindingHash,
  canonicalizeForHash,
  canonicalizeForSig,
  detectAgentEnvironment,
  detectCiEnvironment,
  normalizeKey,
  HMAC_PREFIX,
  FINDING_HASH_PREFIX,
} = require('../../../lib/quality-gate/signed-accepts');

// Test operator key — DO NOT match production. Tests sign with this and verify
// with the same; signatures produced here are useless against real operator key.
const TEST_KEY = crypto.createHash('sha256').update('test-operator-key-sprint-005-phase-D').digest('hex');
const WRONG_KEY = crypto.createHash('sha256').update('wrong-operator-key').digest('hex');

const SAMPLE_FINDING = {
  bank_code: 'bandhan-bank-limited',
  variant: 'fcnr',
  class: 'REGRESSION',
  baseline: 24,
  actual: 19,
};

function buildEntry(overrides = {}) {
  return {
    bank_code: 'bandhan-bank-limited',
    variant: 'fcnr',
    finding_hash: computeFindingHash(SAMPLE_FINDING),
    approved_by: 'samirajoshi',
    approved_at: '2026-05-25T10:42:11.234Z',
    reason: 'FCNR cell-loss known; Phase C extractor target',
    ...overrides,
  };
}

// --- computeFindingHash + canonicalize ---

test('computeFindingHash is stable across calls with same finding', () => {
  const h1 = computeFindingHash(SAMPLE_FINDING);
  const h2 = computeFindingHash({ ...SAMPLE_FINDING });
  assert.equal(h1, h2);
  assert.ok(h1.startsWith(FINDING_HASH_PREFIX));
});

test('computeFindingHash differs when baseline or actual differs', () => {
  const h1 = computeFindingHash(SAMPLE_FINDING);
  const h2 = computeFindingHash({ ...SAMPLE_FINDING, actual: 10 });
  assert.notEqual(h1, h2, 'a different `actual` must produce a different hash');
});

test('computeFindingHash omits null/undefined fields rather than emitting them', () => {
  const a = computeFindingHash({ ...SAMPLE_FINDING, check: null });
  const b = computeFindingHash({ ...SAMPLE_FINDING /* no check */ });
  assert.equal(a, b, 'null check field must canonicalize identically to absent check field');
});

test('canonicalizeForSig is order-stable regardless of input field order', () => {
  const e1 = buildEntry();
  const e2 = {
    reason: e1.reason,
    approved_at: e1.approved_at,
    approved_by: e1.approved_by,
    finding_hash: e1.finding_hash,
    variant: e1.variant,
    bank_code: e1.bank_code,
  };
  assert.equal(canonicalizeForSig(e1), canonicalizeForSig(e2));
});

// --- sign / verify round-trip ---

test('signAccept + verifyAccept round-trip succeeds with matching key', () => {
  const entry = buildEntry();
  const signed = signAccept(entry, TEST_KEY);
  assert.ok(signed.signature.startsWith(HMAC_PREFIX));
  const v = verifyAccept(signed, TEST_KEY);
  assert.deepEqual(v, { valid: true });
});

test('verifyAccept rejects signature produced with a different key', () => {
  const signed = signAccept(buildEntry(), TEST_KEY);
  const v = verifyAccept(signed, WRONG_KEY);
  assert.equal(v.valid, false);
  assert.match(v.reason, /signature does not match/);
});

test('verifyAccept rejects entry with missing signature', () => {
  const entry = buildEntry();
  const v = verifyAccept(entry, TEST_KEY);
  assert.equal(v.valid, false);
  assert.match(v.reason, /signature missing/);
});

test('verifyAccept rejects entry whose bank_code was tampered post-signing', () => {
  const signed = signAccept(buildEntry(), TEST_KEY);
  signed.bank_code = 'tampered-bank';
  const v = verifyAccept(signed, TEST_KEY);
  assert.equal(v.valid, false);
});

test('verifyAccept rejects entry whose finding_hash was tampered post-signing', () => {
  const signed = signAccept(buildEntry(), TEST_KEY);
  signed.finding_hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const v = verifyAccept(signed, TEST_KEY);
  assert.equal(v.valid, false);
});

test('verifyAccept rejects entry whose approved_by was tampered post-signing', () => {
  const signed = signAccept(buildEntry(), TEST_KEY);
  signed.approved_by = 'attacker';
  const v = verifyAccept(signed, TEST_KEY);
  assert.equal(v.valid, false);
});

test('verifyAccept rejects entry whose reason was tampered post-signing', () => {
  const signed = signAccept(buildEntry(), TEST_KEY);
  signed.reason = 'tampered reason';
  const v = verifyAccept(signed, TEST_KEY);
  assert.equal(v.valid, false);
});

test('signAccept rejects entry missing required fields', () => {
  assert.throws(() => signAccept({}, TEST_KEY), /bank_code is required/);
  assert.throws(() => signAccept(buildEntry({ finding_hash: undefined }), TEST_KEY), /finding_hash is required/);
  assert.throws(() => signAccept(buildEntry({ approved_by: undefined }), TEST_KEY), /approved_by is required/);
  assert.throws(() => signAccept(buildEntry({ approved_at: undefined }), TEST_KEY), /approved_at is required/);
  assert.throws(() => signAccept(buildEntry({ reason: undefined }), TEST_KEY), /reason is required/);
});

test('verifyAccept rejects garbled signature gracefully', () => {
  const signed = signAccept(buildEntry(), TEST_KEY);
  signed.signature = 'hmac-sha256:not-hex-bytes!!';
  const v = verifyAccept(signed, TEST_KEY);
  assert.equal(v.valid, false);
});

test('verifyAccept rejects signature with wrong prefix', () => {
  const signed = signAccept(buildEntry(), TEST_KEY);
  signed.signature = 'plain:' + signed.signature.slice(HMAC_PREFIX.length);
  const v = verifyAccept(signed, TEST_KEY);
  assert.equal(v.valid, false);
  assert.match(v.reason, /wrong prefix/);
});

// --- key normalization ---

test('normalizeKey accepts hex string with whitespace', () => {
  const k = normalizeKey(`  ${TEST_KEY}\n`);
  assert.equal(Buffer.isBuffer(k), true);
  assert.equal(k.length, 32);
});

test('normalizeKey accepts Buffer directly', () => {
  const buf = Buffer.from(TEST_KEY, 'hex');
  const k = normalizeKey(buf);
  assert.equal(k, buf);
});

test('normalizeKey rejects empty / null / non-hex / short keys', () => {
  assert.throws(() => normalizeKey(null), /empty or missing/);
  assert.throws(() => normalizeKey(''), /empty or missing/);
  assert.throws(() => normalizeKey('not-hex-at-all-xyz'), /must be hex/);
  assert.throws(() => normalizeKey('abcd'), /too short/); // 2 bytes after decode
  assert.throws(() => normalizeKey(123), /must be a Buffer or hex string/);
});

// --- agent / CI detection ---

test('detectAgentEnvironment flags Claude Code session env vars', () => {
  assert.equal(detectAgentEnvironment({}).isAgent, false);
  assert.equal(detectAgentEnvironment({ CLAUDECODE: '1' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ CLAUDE_CODE_ENTRYPOINT: 'cli' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ CLAUDE_CODE_SESSION_ID: 'abc' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ CLAUDE_CODE_EXECPATH: '/usr/bin/claude' }).isAgent, true);
});

test('detectAgentEnvironment flags Cursor / Copilot / generic AI_AGENT', () => {
  assert.equal(detectAgentEnvironment({ CURSOR_TRACE_ID: 'x' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ CURSOR_AGENT: '1' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ AI_AGENT: 'claude-code_2.1' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ AI_AGENT: 'github-copilot-cli' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ AI_AGENT: 'cursor-composer' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ AI_AGENT: 'aider' }).isAgent, true);
  assert.equal(detectAgentEnvironment({ AI_AGENT: 'codeium-windsurf' }).isAgent, true);
});

test('detectAgentEnvironment does NOT flag benign env vars', () => {
  assert.equal(detectAgentEnvironment({ PATH: '/usr/bin', HOME: '/home/x', TERM: 'xterm' }).isAgent, false);
  assert.equal(detectAgentEnvironment({ AI_AGENT: 'unrelated-tool' }).isAgent, false);
});

test('detectCiEnvironment flags common CI markers', () => {
  assert.equal(detectCiEnvironment({}).isCI, false);
  assert.equal(detectCiEnvironment({ CI: '1' }).isCI, true);
  assert.equal(detectCiEnvironment({ CI: 'true' }).isCI, true);
  assert.equal(detectCiEnvironment({ GITHUB_ACTIONS: 'true' }).isCI, true);
  assert.equal(detectCiEnvironment({ GITLAB_CI: 'true' }).isCI, true);
  assert.equal(detectCiEnvironment({ BUILDKITE: 'true' }).isCI, true);
  assert.equal(detectCiEnvironment({ JENKINS_URL: 'http://x' }).isCI, true);
  assert.equal(detectCiEnvironment({ CIRCLECI: 'true' }).isCI, true);
});

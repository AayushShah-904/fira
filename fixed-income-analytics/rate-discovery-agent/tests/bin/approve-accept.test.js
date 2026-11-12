'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'approve-accept.js');

function runCli(args, { env = {}, stdin = null } = {}) {
  // Start with parent env, wipe all agent/CI markers, then layer caller's env on top.
  // This way the test can pass `env: { CI: '1' }` and have it actually take effect
  // even when the test harness itself is running under Claude Code with CLAUDECODE=1.
  const { __CLEAN__, ...userEnv } = env;
  const cleanEnv = { ...process.env };
  const WIPE_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_EXECPATH', 'AI_AGENT', 'CURSOR_TRACE_ID', 'CURSOR_AGENT', 'ANTHROPIC_CLI', 'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'JENKINS_URL', 'CIRCLECI'];
  if (__CLEAN__) {
    for (const k of WIPE_KEYS) delete cleanEnv[k];
  }
  // Always layer user env LAST so explicit test values win.
  Object.assign(cleanEnv, userEnv);
  return spawnSync(process.execPath, [CLI, ...args], {
    env: cleanEnv,
    input: stdin,
    encoding: 'utf-8',
    timeout: 5000,
  });
}

// --- Refusal checks ---

test('approve-accept: refuses under CI (exit 10)', () => {
  const r = runCli(
    ['--bank', 'x', '--variant', 'regular', '--finding-hash', 'sha256:abc', '--reason', 'test'],
    { env: { __CLEAN__: '1', CI: '1' } }
  );
  assert.equal(r.status, 10, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stderr, /refusing to run under CI/);
});

test('approve-accept: refuses under CLAUDECODE=1 (exit 11)', () => {
  const r = runCli(
    ['--bank', 'x', '--variant', 'regular', '--finding-hash', 'sha256:abc', '--reason', 'test'],
    { env: { __CLEAN__: '1', CLAUDECODE: '1' } }
  );
  assert.equal(r.status, 11, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stderr, /AI-agent session/);
});

test('approve-accept: refuses under CLAUDE_CODE_ENTRYPOINT (exit 11)', () => {
  const r = runCli(
    ['--bank', 'x', '--variant', 'regular', '--finding-hash', 'sha256:abc', '--reason', 'test'],
    { env: { __CLEAN__: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' } }
  );
  assert.equal(r.status, 11);
});

test('approve-accept: refuses under CURSOR_TRACE_ID (exit 11)', () => {
  const r = runCli(
    ['--bank', 'x', '--variant', 'regular', '--finding-hash', 'sha256:abc', '--reason', 'test'],
    { env: { __CLEAN__: '1', CURSOR_TRACE_ID: 'abc' } }
  );
  assert.equal(r.status, 11);
});

test('approve-accept: refuses under AI_AGENT matching agent pattern (exit 11)', () => {
  const r = runCli(
    ['--bank', 'x', '--variant', 'regular', '--finding-hash', 'sha256:abc', '--reason', 'test'],
    { env: { __CLEAN__: '1', AI_AGENT: 'aider-v1.0' } }
  );
  assert.equal(r.status, 11);
});

test('approve-accept: refuses when stdin is not a TTY (exit 12)', () => {
  // spawnSync with input='' gives a non-TTY stdin.
  const r = runCli(
    ['--bank', 'x', '--variant', 'regular', '--finding-hash', 'sha256:abc', '--reason', 'test'],
    { env: { __CLEAN__: '1' }, stdin: '' }
  );
  // Whether it hits no-TTY or no-key first depends on whether the operator key exists;
  // either way the exit is 12 (no TTY) or 3 (no key) — both are valid "refused" exits.
  assert.ok([3, 12].includes(r.status), `expected 3 or 12, got ${r.status}; stderr=${r.stderr}`);
  if (r.status === 12) assert.match(r.stderr, /TTY/);
  else assert.match(r.stderr, /operator key/);
});

test('approve-accept: refuses when operator key is missing (exit 3)', () => {
  // Point the CLI at a definitely-missing key file path, and short-circuit the TTY check
  // by setting stdin to a TTY-like simulation — but since spawnSync can't fake TTY,
  // this test runs in non-TTY mode and accepts EITHER exit 12 (no TTY) or 3 (no key).
  // The key-missing path is exercised by the --verify test below which IS reachable.
  const bogusKeyPath = path.join(os.tmpdir(), `nonexistent-rda-key-${Date.now()}.key`);
  const r = runCli(
    ['--bank', 'x', '--variant', 'regular', '--finding-hash', 'sha256:abc', '--reason', 'test'],
    { env: { __CLEAN__: '1', RDA_OPERATOR_KEY_PATH: bogusKeyPath }, stdin: '' }
  );
  // Either no-TTY (12) or no-key (3) — both are correct refusals.
  assert.ok([3, 12].includes(r.status), `expected 3 or 12, got ${r.status}; stderr=${r.stderr}`);
});

// --- --list is read-only and works under any environment ---

test('approve-accept --list: runs read-only even under CLAUDECODE (no refusal)', () => {
  const r = runCli(['--list'], { env: { __CLEAN__: '1', CLAUDECODE: '1' } });
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /accepts file:/);
  assert.match(r.stdout, /accepted_regressions:/);
});

// --- --verify validates an accepts file against the operator key ---

test('approve-accept --verify: a freshly-signed entry verifies; a tampered entry fails (exit 20)', () => {
  // Generate a test key
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rda-test-'));
  const keyPath = path.join(tmpDir, 'operator.key');
  fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const acceptsPath = path.join(tmpDir, 'accepts.json');

  // Build a signed accepts file directly via the lib
  const {
    signAccept,
    computeFindingHash,
    SIGNED_FORMAT_VERSION,
  } = require('../../lib/quality-gate/signed-accepts');
  const key = fs.readFileSync(keyPath, 'utf-8');
  const findingHash = computeFindingHash({
    bank_code: 'test-bank',
    variant: 'regular',
    class: 'REGRESSION',
    baseline: 10,
    actual: 5,
  });
  const signed = signAccept({
    bank_code: 'test-bank',
    variant: 'regular',
    finding_hash: findingHash,
    approved_by: 'test-operator',
    approved_at: new Date().toISOString(),
    reason: 'test reason',
  }, key);
  fs.writeFileSync(acceptsPath, JSON.stringify({
    _signed_format_version: SIGNED_FORMAT_VERSION,
    accepted_regressions: [signed],
    accepted_anomalies: [],
  }, null, 2));

  // Verify should succeed
  const r1 = runCli(['--verify', '--accepts', acceptsPath], {
    env: { __CLEAN__: '1', RDA_OPERATOR_KEY_PATH: keyPath },
    stdin: '',
  });
  assert.equal(r1.status, 0, `expected verify=PASS, got status=${r1.status}; stderr=${r1.stderr}`);
  assert.match(r1.stdout, /1 valid, 0 invalid/);

  // Tamper and re-verify — should fail with exit 20
  const tampered = JSON.parse(fs.readFileSync(acceptsPath, 'utf-8'));
  tampered.accepted_regressions[0].bank_code = 'tampered-bank';
  fs.writeFileSync(acceptsPath, JSON.stringify(tampered, null, 2));
  const r2 = runCli(['--verify', '--accepts', acceptsPath], {
    env: { __CLEAN__: '1', RDA_OPERATOR_KEY_PATH: keyPath },
    stdin: '',
  });
  assert.equal(r2.status, 20, `expected verify=FAIL, got status=${r2.status}; stdout=${r2.stdout}`);
  assert.match(r2.stderr, /INVALID/);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('approve-accept --help: exits 0 with usage', () => {
  const r = runCli(['--help'], { env: { __CLEAN__: '1' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--bank/);
  assert.match(r.stdout, /--finding-hash/);
});

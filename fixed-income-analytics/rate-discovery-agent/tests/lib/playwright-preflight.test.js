const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { preflightPlaywright, PREFLIGHT_TIMEOUT_MS } = require('../../lib/playwright-preflight');

test('PREFLIGHT_TIMEOUT_MS is conservative (≤ 60s)', () => {
  assert.ok(PREFLIGHT_TIMEOUT_MS > 0);
  assert.ok(PREFLIGHT_TIMEOUT_MS <= 60_000);
});

test('preflightPlaywright returns ok=true on a healthy install', { timeout: 45_000 }, () => {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const out = preflightPlaywright(projectRoot);
  assert.equal(typeof out.elapsedMs, 'number');
  // Strict: if Playwright is wired correctly, the preflight against a data:
  // URL MUST succeed. A previous version of this test only asserted
  // typeof ok === 'boolean' which let a broken regex pass locally and only
  // fail in the cloud (Sprint 009 cloud-validation-2, 2026-06-04).
  if (!out.ok) {
    assert.fail(`preflight failed: reason=${out.reason} detail=${out.detail}`);
  }
});

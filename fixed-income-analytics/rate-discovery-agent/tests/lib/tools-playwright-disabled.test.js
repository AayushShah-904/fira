'use strict';

/**
 * Tests for the playwright_disabled per-bank flag (Sprint 009 cloud-validation-3,
 * 2026-06-04). When the bank-domains entry declares `playwright_disabled: true`,
 * lib/tools.js#runPlaywright should fast-fail with a clear message so the LLM
 * picks a fetch_url / fetch_pdf fallback instead of burning 7 × 120s in
 * spawn-timeout loops (the SBI + BoI-IBU pattern).
 *
 * Test the public executeTool dispatcher with a synthetic registry rather
 * than the real one, so we can verify the contract without touching
 * data/bank-domains.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { executeTool } = require('../../lib/tools');

test('run_playwright returns fast-fail when playwright_disabled=true', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwdis-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  // safe-write-exempt: temp fixture for unit test (ADR-012 tests-use-fs carve-out).
  fs.writeFileSync(
    path.join(dataDir, 'bank-domains.json'),
    JSON.stringify({
      'fake-bank': { domain: 'fake.bank.in', playwright_disabled: true },
    }),
  );
  // safe-write-exempt: temp fixture script — never executed because flag short-circuits.
  fs.writeFileSync(path.join(tmp, 'scripts', 'fetch_rates_playwright.js'), '/* fixture */');

  const context = { projectRoot: tmp, bankCode: 'fake-bank' };
  const out = await executeTool('run_playwright', { url: 'https://fake.bank.in/' }, context);
  const parsed = JSON.parse(out);
  assert.equal(parsed.playwright_disabled, true);
  assert.match(parsed.error, /Playwright is disabled for this bank/);
  assert.match(parsed.error, /fetch_url|fetch_pdf/);
});

test('run_playwright proceeds normally when playwright_disabled is unset', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwdis-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  // safe-write-exempt: temp fixture for unit test (ADR-012 tests-use-fs carve-out).
  fs.writeFileSync(
    path.join(dataDir, 'bank-domains.json'),
    JSON.stringify({ 'other-bank': { domain: 'other.bank.in' } }),
  );
  // safe-write-exempt: temp fixture script — will be exec'd by spawnSync, expected to fail with exit 1 (acceptable; we only assert the not-short-circuited path).
  fs.writeFileSync(path.join(tmp, 'scripts', 'fetch_rates_playwright.js'), 'process.exit(1);');

  const context = { projectRoot: tmp, bankCode: 'other-bank' };
  const out = await executeTool('run_playwright', { url: 'https://other.bank.in/' }, context);
  const parsed = JSON.parse(out);
  // Either the spawn happened and exited non-zero, OR the spawn failed for
  // some other reason — either way, NOT the playwright_disabled fast-fail.
  assert.notEqual(parsed.playwright_disabled, true);
});

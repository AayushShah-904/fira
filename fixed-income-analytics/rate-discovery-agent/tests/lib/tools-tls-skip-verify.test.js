'use strict';

/**
 * Tests for the per-bank tls_skip_verify flag plumbed into Playwright + fetch_url.
 * Sprint 009 Phase 9.5 (2026-06-05).
 *
 * The flag's purpose: some bank sites (aprb.bank.in, amco.bank.in) publish
 * rate data behind expired/self-signed TLS certs. Local dev env masks via
 * Norton MITM CA; cloud Container Apps strict-rejects. Operator-opt-in
 * per-bank flag bypasses cert verification for THIS bank only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _buildPlaywrightCmdArgs } = require('../../lib/tools');

const SCRIPT = '/proj/scripts/fetch_rates_playwright.js';
const URL = 'https://aprb.bank.in/interest.php';

test('buildPlaywrightCmdArgs adds --ignore-https-errors when tls_skip_verify=true', () => {
  const argv = _buildPlaywrightCmdArgs(
    SCRIPT,
    { url: URL },
    60000,
    { tls_skip_verify: true },
  );
  assert.ok(argv.includes('--ignore-https-errors'),
    `Expected --ignore-https-errors in argv when tls_skip_verify=true; got ${JSON.stringify(argv)}`);
});

test('buildPlaywrightCmdArgs omits --ignore-https-errors when flag unset', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, 60000, {});
  assert.ok(!argv.includes('--ignore-https-errors'),
    `Expected no --ignore-https-errors when flag unset; got ${JSON.stringify(argv)}`);
});

test('buildPlaywrightCmdArgs omits --ignore-https-errors when flag is false', () => {
  const argv = _buildPlaywrightCmdArgs(
    SCRIPT, { url: URL }, 60000, { tls_skip_verify: false },
  );
  assert.ok(!argv.includes('--ignore-https-errors'));
});

test('fetch_rates_playwright.js script accepts --ignore-https-errors and applies to context', () => {
  // Source-level contract: verify the CLI flag is parsed and threaded to
  // browser.newContext({ ignoreHTTPSErrors }). Avoids spawning playwright.
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'fetch_rates_playwright.js');
  const src = fs.readFileSync(scriptPath, 'utf-8');
  assert.match(src, /--ignore-https-errors/, 'CLI arg must be parsed');
  assert.match(src, /ignoreHTTPSErrors/, 'newContext must receive ignoreHTTPSErrors');
});

test('data/bank-domains.json — Arunachal + Ahmedabad carry tls_skip_verify=true', () => {
  const reg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'data', 'bank-domains.json'),
    'utf-8',
  ));
  assert.equal(reg['arunachal-pradesh-rural-bank']?.tls_skip_verify, true,
    'Arunachal must declare tls_skip_verify=true post-9.5');
  assert.equal(reg['ahmedabad-mercantile-co-op-bank-ltd']?.tls_skip_verify, true,
    'Ahmedabad Mercantile must declare tls_skip_verify=true post-9.5');
});

test('CSB Bank is operator-curated (Radware-blocked, preserves local data)', () => {
  const reg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'data', 'bank-domains.json'),
    'utf-8',
  ));
  assert.equal(reg['csb-bank-limited']?.extraction_method,
    'manual_transcription_from_rendered_text',
    'CSB must be operator-curated post-9.6 (Radware-blocked in cloud)');
});

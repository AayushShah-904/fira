'use strict';

/**
 * Tests for the default-on Playwright flags in lib/tools.js#runPlaywright.
 * Added in Sprint 4 Track A (2026-05-20) after the AU SFB cloud regression:
 * the LLM was calling run_playwright without --tabs/--selects/--scroll and
 * stopping at the first amount-tier table. Defaults flipped to ON; the LLM
 * can still opt out explicitly with `false`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _buildPlaywrightCmdArgs } = require('../../lib/tools');

const SCRIPT = '/proj/scripts/fetch_rates_playwright.js';
const URL = 'https://example.bank.in/fd-rates';

test('defaults --scroll, --tabs, --selects all ON when args omitted', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL });
  assert.deepEqual(argv, [SCRIPT, URL, '--scroll', '--tabs', '--selects']);
});

test('LLM can opt out by passing scroll:false', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, scroll: false });
  assert.deepEqual(argv, [SCRIPT, URL, '--tabs', '--selects']);
});

test('LLM can opt out of all three defaults explicitly', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, scroll: false, tabs: false, selects: false });
  assert.deepEqual(argv, [SCRIPT, URL]);
});

test('--accordions and --intercept stay opt-in (require explicit true)', () => {
  const argvNo = _buildPlaywrightCmdArgs(SCRIPT, { url: URL });
  assert.equal(argvNo.includes('--accordions'), false);
  assert.equal(argvNo.includes('--intercept'), false);

  const argvYes = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, accordions: true, intercept: true });
  assert.equal(argvYes.includes('--accordions'), true);
  assert.equal(argvYes.includes('--intercept'), true);
});

test('truthy values (true) keep flags on', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, scroll: true, tabs: true, selects: true });
  assert.deepEqual(argv, [SCRIPT, URL, '--scroll', '--tabs', '--selects']);
});

test('flag order is stable: --scroll, --tabs, --accordions, --selects, --intercept', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, accordions: true, intercept: true });
  assert.deepEqual(argv, [SCRIPT, URL, '--scroll', '--tabs', '--accordions', '--selects', '--intercept']);
});

test('no --timeout when innerTimeoutMs is omitted (preserves pre-override behavior)', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL });
  assert.equal(argv.includes('--timeout'), false);
});

test('--timeout appended when innerTimeoutMs is positive', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, 180000);
  const idx = argv.indexOf('--timeout');
  assert.notEqual(idx, -1);
  assert.equal(argv[idx + 1], '180000');
});

test('per-bank overrides: --browser appended only when non-chromium', () => {
  const argvDefault = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, null, { playwright_browser: 'chromium' });
  assert.equal(argvDefault.includes('--browser'), false);

  const argvFirefox = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, null, { playwright_browser: 'firefox' });
  const idx = argvFirefox.indexOf('--browser');
  assert.notEqual(idx, -1);
  assert.equal(argvFirefox[idx + 1], 'firefox');
});

test('per-bank overrides: --stealth appended only when truthy', () => {
  const argvOff = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, null, { playwright_stealth: false });
  assert.equal(argvOff.includes('--stealth'), false);

  const argvOn = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, null, { playwright_stealth: true });
  assert.equal(argvOn.includes('--stealth'), true);
});

test('per-bank overrides: no overrides object → no --browser/--stealth', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL });
  assert.equal(argv.includes('--browser'), false);
  assert.equal(argv.includes('--stealth'), false);
});

test('playwright_skip suppresses --selects and --tabs (SBI/BoI case)', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, accordions: true }, null, { playwright_skip: ['selects', 'tabs'] });
  assert.equal(argv.includes('--selects'), false);
  assert.equal(argv.includes('--tabs'), false);
  // scroll and accordions remain on
  assert.equal(argv.includes('--scroll'), true);
  assert.equal(argv.includes('--accordions'), true);
});

test('playwright_skip "scroll" / "accordions" suppress those default-on actions', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, accordions: true }, null, { playwright_skip: ['scroll', 'accordions'] });
  assert.equal(argv.includes('--scroll'), false);
  assert.equal(argv.includes('--accordions'), false);
  assert.equal(argv.includes('--tabs'), true);
  assert.equal(argv.includes('--selects'), true);
});

test('playwright_skip "intercept" beats explicit intercept:true from LLM', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL, intercept: true }, null, { playwright_skip: ['intercept'] });
  assert.equal(argv.includes('--intercept'), false);
});

test('playwright_skip ignored when not an array', () => {
  const argv = _buildPlaywrightCmdArgs(SCRIPT, { url: URL }, null, { playwright_skip: 'selects' });
  // string not array → treated as empty skip set, all defaults apply
  assert.equal(argv.includes('--selects'), true);
});

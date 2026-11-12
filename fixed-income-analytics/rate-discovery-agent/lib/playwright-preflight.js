/**
 * Playwright pre-flight check — verify chromium can launch BEFORE the batch
 * starts processing banks. Sprint 009 cloud-validation-2 (2026-06-04):
 * the 12-bank cohort burned 14 min on SBI alone with 7 consecutive
 * Playwright spawn ETIMEDOUT failures. A 5-second pre-flight up front
 * surfaces the same fault before any bank-budget is spent.
 *
 * The check spawns the same scripts/fetch_rates_playwright.js the agent
 * uses, against a data:URL (no network), with a tight timeout. If it
 * succeeds, browsers are healthy. If it fails, the batch should abort
 * with a clear diagnostic so the operator (or this re-run loop) doesn't
 * waste cohort time.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PREFLIGHT_TIMEOUT_MS = 30_000;
const PREFLIGHT_URL = 'data:text/html,<html><body><h1>preflight</h1></body></html>';

/**
 * Runs one Playwright launch against a data:URL.
 * Returns { ok: true } on success, { ok: false, reason, detail } on failure.
 */
function preflightPlaywright(projectRoot) {
  const root = projectRoot || path.dirname(__dirname);
  const scriptPath = path.join(root, 'scripts', 'fetch_rates_playwright.js');
  const args = [scriptPath, PREFLIGHT_URL, '--no-scroll', '--no-accordions', '--timeout', '10000'];

  const t0 = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    timeout: PREFLIGHT_TIMEOUT_MS,
    maxBuffer: 1 * 1024 * 1024,
    encoding: 'utf-8',
  });
  const elapsedMs = Date.now() - t0;

  if (result.error) {
    return {
      ok: false,
      elapsedMs,
      reason: 'spawn_failed',
      detail: result.error.message || String(result.error),
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      elapsedMs,
      reason: 'exit_nonzero',
      detail: `exit ${result.status}: ${(result.stderr || '').slice(0, 500)}`,
    };
  }

  // scripts/fetch_rates_playwright.js emits one of two markers depending on
  // path: "JSON_OUTPUT:" (early-return for PDF URLs) or "=== JSON_OUTPUT ==="
  // (normal extraction path; data: URLs hit this one). Either marker proves
  // the chromium child completed cleanly and got to the post-extraction log.
  if (!/JSON_OUTPUT/.test(result.stdout || '')) {
    return {
      ok: false,
      elapsedMs,
      reason: 'no_json_marker',
      detail: 'Playwright exited 0 but produced no JSON_OUTPUT marker',
    };
  }

  return { ok: true, elapsedMs };
}

module.exports = { preflightPlaywright, PREFLIGHT_TIMEOUT_MS };

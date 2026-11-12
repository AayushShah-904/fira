'use strict';

/**
 * Tests for the cohort-level no-progress watchdog in run-batch.js.
 * Sprint 009 Phase 9.7 (2026-06-05).
 *
 * The pm-refresh-2026-q2 cohort (exec 5kz1vm8) froze silently on bank
 * #315 after ~7h. spawnSync's 15-min per-bank timeout didn't fire — the
 * freeze was at a layer below Node's timeout handling. The watchdog
 * gives a clean exit path so silent hangs become a fast partial-success
 * receipt instead of a 20-hour wait for replicaTimeoutSec.
 *
 * run-batch.js's watchdog wires are not directly importable (the file
 * is a script, not a module). These tests therefore validate the
 * source-level contract: the watchdog code paths exist with the right
 * shape. End-to-end behavior is validated by the next cloud cohort run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RUN_BATCH = path.resolve(__dirname, '..', '..', 'run-batch.js');

test('run-batch.js declares the cohort-watchdog env var with a sensible default', () => {
  const src = fs.readFileSync(RUN_BATCH, 'utf-8');
  // env var name (so operator can tune without code change)
  assert.match(src, /BIRD_COHORT_NO_PROGRESS_TIMEOUT_MS/,
    'BIRD_COHORT_NO_PROGRESS_TIMEOUT_MS env var must be readable');
  // default: 25 minutes = 1_500_000 ms (= 25 * 60 * 1000)
  assert.match(src, /25 \* 60 \* 1000/,
    'default watchdog timeout must be 25 minutes (per-bank 15min + 10min buffer)');
});

test('watchdog starts before the per-bank loop and tracks per-bank progress', () => {
  const src = fs.readFileSync(RUN_BATCH, 'utf-8');
  // Must declare progress tracker
  assert.match(src, /let lastCohortProgressMs/,
    'lastCohortProgressMs module variable must exist');
  assert.match(src, /function markCohortProgress\(/,
    'markCohortProgress helper must exist');
  // Must call startCohortWatchdog before the loop
  assert.match(src, /startCohortWatchdog\(\);[\s\S]{0,300}for \(let i = 0; i < banks\.length; i\+\+\)/,
    'startCohortWatchdog must fire before the sequential per-bank loop');
});

test('watchdog updates progress on bank completion (sync + skip paths)', () => {
  const src = fs.readFileSync(RUN_BATCH, 'utf-8');
  // The sync loop must call markCohortProgress after bank completes
  // and on the skip continuation path. Count occurrences.
  const calls = (src.match(/markCohortProgress\(/g) || []).length;
  // Expected sites: 1 declaration + at least 2 sync-path call sites (skip + completion)
  // + at least 2 parallel-path call sites (skip + then-handler)
  assert.ok(calls >= 5,
    `Expected markCohortProgress to be called at least 4 times (declaration + 4 sites); got ${calls}`);
});

test('watchdog abort handler flushes receipt and exits with code 7', () => {
  const src = fs.readFileSync(RUN_BATCH, 'utf-8');
  assert.match(src, /publishFinalExecutionReceiptLoud\(['"]aborted_no_progress['"]\)/,
    'abort handler must publish receipt with the aborted_no_progress outcome');
  assert.match(src, /process\.exit\(7\)/,
    'abort must use exit code 7 (distinct from 0=success, 1=fail, 2=cloud-sync, 8=preflight)');
});

test('watchdog has a hard-exit deadline if the receipt flush itself hangs', () => {
  const src = fs.readFileSync(RUN_BATCH, 'utf-8');
  // The async flush path is the very thing we're catching if it hangs;
  // there must be a setTimeout race to force-exit even if the flush stalls.
  assert.match(src, /hardExit[\s\S]{0,200}setTimeout/,
    'must have a setTimeout race to hard-exit even if receipt flush hangs');
  assert.match(src, /hardExit\.unref\(\)/,
    'the hard-exit timer must be unref()ed so it does not keep the process alive');
});

test('watchdog covers both sequential and parallel cohort modes', () => {
  const src = fs.readFileSync(RUN_BATCH, 'utf-8');
  // Both code paths (concurrency=1 and concurrency>1) must call startCohortWatchdog
  const startCalls = (src.match(/startCohortWatchdog\(\)/g) || []).length;
  assert.ok(startCalls >= 2,
    `Expected startCohortWatchdog to be called in both sequential and parallel paths; got ${startCalls}`);
  // Parallel path must respect watchdogAborted in its while/inner-while gates
  assert.match(src, /watchdogAborted[\s\S]{0,150}break/,
    'parallel path must break out of its work loop when watchdog fires');
});

test('emits structured FAILED event with cohort_no_progress kind on abort', () => {
  const src = fs.readFileSync(RUN_BATCH, 'utf-8');
  assert.match(src, /kind:\s*['"]cohort_no_progress['"]/,
    'abort must emit a FAILED event with kind=cohort_no_progress for Phase 1 KQL reconciliation');
  assert.match(src, /bank_code:\s*['"]_cohort_watchdog['"]/,
    'abort event must use _cohort_watchdog as the synthetic bank_code (not a real bank slug)');
});

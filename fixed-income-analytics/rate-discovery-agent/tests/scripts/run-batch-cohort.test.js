'use strict';

/**
 * Integration test for run-batch.js's --cohort mode (Sprint 4 Track A 2026-05-20).
 *
 * Spawns run-batch.js with --cohort <name> --dry-run and asserts:
 *  - exit 0
 *  - resolves the expected count of banks
 *  - prints "mode=cohort"
 *  - bank list reflects the cohort file slugs
 *
 * Uses an existing on-disk cohort (data/cohorts/top-12.json) — keeps the test
 * trivially deterministic without needing a temp project root.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUN_BATCH = path.join(PROJECT_ROOT, 'run-batch.js');
const TOP_12 = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'data', 'cohorts', 'top-12.json'), 'utf-8'));

function runBatch(args, env = {}) {
  return spawnSync(process.execPath, [RUN_BATCH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

test('--cohort top-12 --dry-run resolves all 12 banks', () => {
  const r = runBatch(['--cohort', 'top-12', '--dry-run']);
  assert.equal(r.status, 0, `non-zero exit: stderr=${r.stderr}`);
  // "Resolved 12 bank(s) [mode=cohort]:"
  assert.match(r.stdout, /Resolved 12 bank\(s\) \[mode=cohort\]/);
  // Every slug in the cohort JSON should appear in the dry-run output
  for (const e of TOP_12) {
    assert.match(r.stdout, new RegExp(e.bank_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('--cohort=<name>= form is accepted', () => {
  const r = runBatch(['--cohort=top-12', '--dry-run']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Resolved 12 bank\(s\) \[mode=cohort\]/);
});

test('--cohort with unknown name exits 1 and lists available cohorts', () => {
  const r = runBatch(['--cohort', 'does-not-exist-cohort-xyz', '--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cohort.*not found|Cohort load failed/);
  assert.match(r.stderr, /Available cohorts/i);
});

test('--cohort takes precedence over CSV / category mode detection', () => {
  // Even if a stray positional looks slug-like, --cohort wins.
  const r = runBatch(['some-stray-slug', '--cohort', 'top-12', '--dry-run']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[mode=cohort\]/);
});

#!/usr/bin/env node
'use strict';

/**
 * Sprint 009 Phase 4 — run-local-only.
 *
 * Convenience wrapper around run-batch.js for the local side of a
 * split-execution flow. Reads data/peer-runs/<cohort>.json (written by
 * scripts/cohort/split.js), runs the <cohort>-local sub-cohort in local
 * mode (BIRD_STORAGE unset → local fs), and patches local_run_label +
 * local_finished_at back into the beacon so Phase 5 can find the run.
 *
 * Usage:
 *   node scripts/cohort/run-local-only.js --cohort <name> [run-batch-flags...]
 *
 * Any flags after --cohort <name> are forwarded to run-batch.js verbatim
 * (other than --cohort, which we own).
 *
 * Exit codes:
 *   0  run-batch.js returned 0 (success or no_work with no failures)
 *   1  run-batch.js returned non-zero (failure / partial / no_work)
 *   2  pre-flight failure (cohort beacon missing, local cohort missing)
 *   3  cohort has zero local banks (no-op success, exit 0 by convention)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PEER_RUNS_DIR = path.join(PROJECT_ROOT, 'data', 'peer-runs');
const COHORTS_DIR = path.join(PROJECT_ROOT, 'data', 'cohorts');
const RUN_BATCH = path.join(PROJECT_ROOT, 'run-batch.js');

function parseArgs(argv) {
  const opts = { cohort: null, help: false, passthrough: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cohort') { opts.cohort = argv[++i]; continue; }
    if (a.startsWith('--cohort=')) { opts.cohort = a.slice(9); continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    opts.passthrough.push(a);
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/cohort/run-local-only.js --cohort <name> [run-batch-flags...]

Runs the local side of a split-execution cohort. Reads data/peer-runs/<name>.json
written by scripts/cohort/split.js, executes data/cohorts/<name>-local.json via
run-batch.js with BIRD_STORAGE unset (local mode), and patches local_run_label
+ local_finished_at back into the beacon so Phase 5 can find this run.

Any flags after --cohort <name> are forwarded to run-batch.js.`);
}

// run-batch.js writes per-run output to output/runs/<batchLabel>/_batch_results.json.
// batchLabel is currently the agent's chosen run-id (timestamp-ish). We can't
// know it in advance, so we snapshot output/runs/ before + after and take the
// new entry. Cheap (one readdir each side).
function snapshotRunDirs() {
  const dir = path.join(PROJECT_ROOT, 'output', 'runs');
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir));
}

function diffNewRunDirs(before, after) {
  const newDirs = [];
  for (const name of after) if (!before.has(name)) newDirs.push(name);
  return newDirs;
}

function patchBeacon(cohort, patch) {
  const file = path.join(PEER_RUNS_DIR, `${cohort}.json`);
  let payload = {};
  if (fs.existsSync(file)) {
    try { payload = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* fresh */ }
  }
  payload = { ...payload, ...patch };
  // safe-write-exempt: peer-run beacon, not a per-bank canonical artifact.
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return file;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    printUsage();
    process.exit(2);
  }
  if (opts.help) { printUsage(); process.exit(0); }
  if (!opts.cohort) { printUsage(); process.exit(2); }

  // Pre-flight: beacon + local sub-cohort must exist (split must have run).
  const beaconFile = path.join(PEER_RUNS_DIR, `${opts.cohort}.json`);
  const localCohortFile = path.join(COHORTS_DIR, `${opts.cohort}-local.json`);
  if (!fs.existsSync(beaconFile)) {
    console.error(`error: peer-run beacon not found at ${beaconFile}`);
    console.error(`       Run scripts/cohort/split.js --cohort ${opts.cohort} first.`);
    process.exit(2);
  }
  if (!fs.existsSync(localCohortFile)) {
    console.error(`error: local sub-cohort not found at ${localCohortFile}`);
    console.error(`       Run scripts/cohort/split.js --cohort ${opts.cohort} first.`);
    process.exit(2);
  }

  // Short-circuit: empty local cohort = nothing to run = success.
  let localEntries = [];
  try { localEntries = JSON.parse(fs.readFileSync(localCohortFile, 'utf-8')); } catch {}
  if (!Array.isArray(localEntries) || localEntries.length === 0) {
    console.log(`Local cohort "${opts.cohort}-local" is empty; nothing to run.`);
    patchBeacon(opts.cohort, {
      local_run_label: null,
      local_finished_at: new Date().toISOString(),
      local_skipped_reason: 'empty_local_cohort',
    });
    process.exit(3);
  }

  console.log('──────────────────────────────────────────────────────────────');
  console.log(` run-local-only: ${opts.cohort}`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` local entries: ${localEntries.length}`);
  console.log(` cohort file:   ${localCohortFile}`);
  console.log(` beacon:        ${beaconFile}`);
  console.log();

  const startedAt = new Date().toISOString();
  const before = snapshotRunDirs();

  // Ensure BIRD_STORAGE is unset (local fs mode). Inherit everything else.
  const env = { ...process.env };
  delete env.BIRD_STORAGE;

  const args = [RUN_BATCH, '--cohort', `${opts.cohort}-local`, ...opts.passthrough];
  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });

  const finishedAt = new Date().toISOString();
  const after = snapshotRunDirs();
  const newRuns = diffNewRunDirs(before, after);

  // Pick the newest entry if multiple (shouldn't happen for a single run-batch
  // call, but be defensive — sort by name as run labels are time-ordered).
  const localRunLabel = newRuns.length > 0 ? newRuns.sort().pop() : null;
  patchBeacon(opts.cohort, {
    local_run_label: localRunLabel,
    local_finished_at: finishedAt,
    local_started_at: startedAt,
    local_exit_code: result.status,
  });

  console.log(`\n[run-local-only] local_run_label=${localRunLabel || '<unknown>'}, exit=${result.status}`);

  process.exit(result.status === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { parseArgs, patchBeacon, snapshotRunDirs, diffNewRunDirs };

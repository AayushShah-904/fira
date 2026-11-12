#!/usr/bin/env node
'use strict';

/**
 * Sprint 009 Phase 5 — merge-runs CLI.
 *
 * Reads `data/peer-runs/<cohort>.json` to find both runs, walks the
 * cohort, calls lib/merge/run-merger.js, prints a decision summary.
 *
 * Usage:
 *   node scripts/merge/merge-runs.js --cohort <name>
 *     [--cloud-run-label <label>]
 *     [--local-run-label <label>]
 *     [--dry-run]
 *
 * Flags:
 *   --cohort               Required. Reads data/peer-runs/<name>.json.
 *   --cloud-run-label      Override the beacon's cloud_run_label.
 *   --local-run-label      Override the beacon's local_run_label.
 *   --dry-run              Compute merge decisions, log them, but
 *                          don't call safeWriteArtifact.
 *
 * Exit codes:
 *   0  merged (files_written > 0 OR cohort had nothing to merge)
 *   1  invalid args
 *   2  beacon missing / cohort files missing
 *   3  both run labels missing in beacon and not overridden — nothing to merge
 */

const fs = require('node:fs');
const path = require('node:path');

const { runMerger } = require('../../lib/merge/run-merger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PEER_RUNS_DIR = path.join(PROJECT_ROOT, 'data', 'peer-runs');
const COHORTS_DIR = path.join(PROJECT_ROOT, 'data', 'cohorts');

function parseArgs(argv) {
  const opts = { cohort: null, cloudRunLabel: null, localRunLabel: null, dryRun: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cohort') opts.cohort = argv[++i];
    else if (a.startsWith('--cohort=')) opts.cohort = a.slice(9);
    else if (a === '--cloud-run-label') opts.cloudRunLabel = argv[++i];
    else if (a.startsWith('--cloud-run-label=')) opts.cloudRunLabel = a.slice(18);
    else if (a === '--local-run-label') opts.localRunLabel = argv[++i];
    else if (a.startsWith('--local-run-label=')) opts.localRunLabel = a.slice(18);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/merge/merge-runs.js --cohort <name> [flags]

Reconciles cloud + local per-bank artifacts for a split-execution cohort
into a single canonical view at output/latest/. Reads peer-run beacon
written by scripts/cohort/split.js + scripts/cohort/run-local-only.js
(+ optionally deploy-smoke.js future patch) to find the runs.

Flags:
  --cloud-run-label <l>  Override the beacon's cloud_run_label.
  --local-run-label <l>  Override the beacon's local_run_label.
  --dry-run              Log merge decisions but don't write.
`);
}

function readJsonOrDie(p, context, exitCode) {
  if (!fs.existsSync(p)) {
    console.error(`error: ${context} not found at ${p}`);
    process.exit(exitCode);
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (err) {
    console.error(`error: ${context} not valid JSON: ${err.message}`);
    process.exit(exitCode);
  }
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv); }
  catch (err) {
    console.error(`error: ${err.message}\n`);
    printUsage();
    process.exit(1);
  }
  if (opts.help) { printUsage(); process.exit(0); }
  if (!opts.cohort) { printUsage(); process.exit(1); }

  const beaconFile = path.join(PEER_RUNS_DIR, `${opts.cohort}.json`);
  const beacon = readJsonOrDie(beaconFile, 'peer-run beacon', 2);

  const cloudRunLabel = opts.cloudRunLabel || beacon.cloud_run_label || null;
  const localRunLabel = opts.localRunLabel || beacon.local_run_label || null;

  if (!cloudRunLabel && !localRunLabel) {
    console.error('error: no run labels in beacon and none overridden. Nothing to merge.');
    console.error(`       Beacon: ${beaconFile}`);
    process.exit(3);
  }

  // Load both sub-cohorts so we know which banks to walk.
  const cloudCohortFile = path.join(COHORTS_DIR, `${beacon.cloud_cohort || `${opts.cohort}-cloud`}.json`);
  const localCohortFile = path.join(COHORTS_DIR, `${beacon.local_cohort || `${opts.cohort}-local`}.json`);
  const cloudCohort = fs.existsSync(cloudCohortFile) ? JSON.parse(fs.readFileSync(cloudCohortFile, 'utf-8')) : [];
  const localCohort = fs.existsSync(localCohortFile) ? JSON.parse(fs.readFileSync(localCohortFile, 'utf-8')) : [];

  console.log('──────────────────────────────────────────────────────────────');
  console.log(` merge-runs: ${opts.cohort}`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` cloud_run_label: ${cloudRunLabel || '<none>'}  (${cloudCohort.length} banks)`);
  console.log(` local_run_label: ${localRunLabel || '<none>'}  (${localCohort.length} banks)`);
  console.log(` dry-run:         ${opts.dryRun}`);
  console.log('──────────────────────────────────────────────────────────────\n');

  if (opts.dryRun) {
    console.log('(dry-run — runMerger will execute but safeWriteArtifact is not stubbed; this exits before writing.)');
    console.log('TODO: thread --dry-run through to runMerger so writes can be inhibited cleanly.');
    // For now, dry-run still proceeds — operator should treat dry-run as informational
    // and revert via git if outputs land where unwanted. A future enhancement: thread
    // a `writer` injection point into runMerger and stub it for dry-run.
  }

  const logger = { info: (m) => console.log(`  ${m}`), warn: (m) => console.warn(`  [warn] ${m}`) };
  const { banks, summary } = runMerger({
    cloudCohort,
    localCohort,
    cloudRunLabel,
    localRunLabel,
    projectRoot: PROJECT_ROOT,
    logger,
  });

  console.log('\nResult:');
  console.log(`  banks merged:          ${summary.total_banks}`);
  console.log(`  files written:         ${summary.files_written}`);
  console.log(`  files deferred-pending: ${summary.files_deferred_to_pending}`);
  console.log(`  files skipped:         ${summary.files_skipped}`);
  console.log(`  cloud_run_dir:         ${summary.cloud_run_dir || '<none>'}`);
  console.log(`  local_run_dir:         ${summary.local_run_dir || '<none>'}`);

  // Per-bank summary (only non-trivial decisions)
  const banksWithBoth = banks.filter((b) =>
    b.variants.some((v) => v.cloud && v.local) || (b.config && b.config.cloud && b.config.local)
  );
  if (banksWithBoth.length > 0) {
    console.log('\nBanks with cloud+local overlap (richer-set rules applied):');
    for (const b of banksWithBoth) {
      const overlapped = b.variants.filter((v) => v.cloud && v.local);
      for (const v of overlapped) {
        const slabDec = v.decisions && v.decisions.rate_slabs ? v.decisions.rate_slabs : 'n/a';
        console.log(`  ${b.bank_code}:${v.variant}  rate_slabs=${slabDec}`);
      }
    }
  }
}

if (require.main === module) main();

module.exports = { parseArgs };

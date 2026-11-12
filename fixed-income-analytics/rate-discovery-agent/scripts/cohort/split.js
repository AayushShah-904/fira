#!/usr/bin/env node
'use strict';

/**
 * Sprint 009 Phase 4 — cohort splitter CLI.
 *
 * Reads `data/cohorts/<name>.json` + `data/bank-domains.json`, splits via
 * lib/cohort/splitter.js, writes:
 *   - data/cohorts/<name>-cloud.json
 *   - data/cohorts/<name>-local.json
 *   - data/peer-runs/<name>.json   (peer-run beacon for Phase 5)
 *
 * Usage:
 *   node scripts/cohort/split.js --cohort <name>
 *
 * Exit codes:
 *   0  splitter ran (both outputs written, even if one is empty)
 *   1  invalid args
 *   2  cohort not found
 *   3  bank-domains.json missing or invalid
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadCohort, cohortPath, CohortLoadError } = require('../utils/load-cohort');
const { splitCohort, summarizeDecisions } = require('../../lib/cohort/splitter');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DOMAINS_FILE = path.join(PROJECT_ROOT, 'data', 'bank-domains.json');
const COHORTS_DIR = path.join(PROJECT_ROOT, 'data', 'cohorts');
const PEER_RUNS_DIR = path.join(PROJECT_ROOT, 'data', 'peer-runs');

function parseArgs(argv) {
  const opts = { cohort: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cohort') opts.cohort = argv[++i];
    else if (a.startsWith('--cohort=')) opts.cohort = a.slice(9);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/cohort/split.js --cohort <name>

Splits data/cohorts/<name>.json into <name>-cloud.json + <name>-local.json
based on data/bank-domains.json#cloud_block_status (Phase 3 registry).

Also writes data/peer-runs/<name>.json — the peer-run beacon Phase 5
reads to find both the cloud and local runs for merging.`);
}

function readDomains() {
  if (!fs.existsSync(DOMAINS_FILE)) {
    throw new Error(`bank-domains.json not found at ${DOMAINS_FILE}`);
  }
  try {
    return JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf-8'));
  } catch (err) {
    throw new Error(`bank-domains.json is not valid JSON: ${err.message}`);
  }
}

function writeJsonPretty(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // safe-write-exempt: derived cohort artifact (output of the splitter, not a per-bank canonical config/rates/summary); overwritten each split run by design.
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
}

function writePeerBeacon(cohort) {
  fs.mkdirSync(PEER_RUNS_DIR, { recursive: true });
  const file = path.join(PEER_RUNS_DIR, `${cohort}.json`);
  let existing = null;
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* fresh-start on malformed */ }
  }
  const payload = {
    ...existing,
    cohort,
    split_at: new Date().toISOString(),
    cloud_cohort: `${cohort}-cloud`,
    local_cohort: `${cohort}-local`,
    // Pre-clear run-side fields if this is a fresh split (operator re-running
    // split after a successful cloud+local merge cycle expects a clean slate).
    cloud_run_label: existing && existing.cloud_run_label ? existing.cloud_run_label : null,
    cloud_execution_name: existing && existing.cloud_execution_name ? existing.cloud_execution_name : null,
    cloud_finished_at: existing && existing.cloud_finished_at ? existing.cloud_finished_at : null,
    local_run_label: existing && existing.local_run_label ? existing.local_run_label : null,
    local_finished_at: existing && existing.local_finished_at ? existing.local_finished_at : null,
  };
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
    process.exit(1);
  }
  if (opts.help) { printUsage(); process.exit(0); }
  if (!opts.cohort) { printUsage(); process.exit(1); }

  let entries;
  try {
    entries = loadCohort(opts.cohort);
  } catch (err) {
    if (err instanceof CohortLoadError && err.code === 'not_found') {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  let domains;
  try { domains = readDomains(); }
  catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(3);
  }

  const { cloud, local, decisions } = splitCohort({ entries, domains });

  const cloudFile = path.join(COHORTS_DIR, `${opts.cohort}-cloud.json`);
  const localFile = path.join(COHORTS_DIR, `${opts.cohort}-local.json`);
  writeJsonPretty(cloudFile, cloud);
  writeJsonPretty(localFile, local);
  const beaconFile = writePeerBeacon(opts.cohort);

  console.log(`Split cohort "${opts.cohort}":`);
  console.log(`  → ${cloudFile}  (${cloud.length} banks)`);
  console.log(`  → ${localFile}  (${local.length} banks)`);
  console.log(`  → ${beaconFile}  (peer-run beacon)`);
  console.log();
  console.log(summarizeDecisions(decisions));

  if (local.length === 0) {
    console.log('\nAll banks route to cloud; no local run needed.');
  } else if (cloud.length === 0) {
    console.log('\nAll banks route to local; cloud run will be skipped.');
  }
}

if (require.main === module) main();

module.exports = { parseArgs, writePeerBeacon };

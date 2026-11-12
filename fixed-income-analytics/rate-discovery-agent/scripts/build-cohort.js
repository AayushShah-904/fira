#!/usr/bin/env node
'use strict';

/**
 * Merge multiple cohort JSON files into one, dedup by bank_code.
 *
 * Usage:
 *   node scripts/build-cohort.js [--out <path>] <file1.json> <file2.json> [...]
 *
 * Each input file is the standard cohort shape (per scripts/utils/load-cohort.js):
 *   [ { "bank_code": "<slug>", "category": "<...>", "state": "<...>" }, ... ]
 *
 * On bank_code collision, the FIRST occurrence wins (subsequent files' category/state
 * are ignored for that slug). Order of input files matters when categories disagree
 * — pass the authoritative source first.
 *
 * Sprint 4 Track A 2026-05-20 — ships alongside PM rate-pack refresh cohort assembly
 * (see sdlc/sprints/sprint-004/plan/pm-rate-pack-refresh-2026-q2.md).
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const opts = { inputs: [], out: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (a.startsWith('--')) { console.error('Unknown flag:', a); opts.help = true; }
    else opts.inputs.push(a);
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/build-cohort.js [--out <path>] <file1.json> <file2.json> [...]

Merge multiple cohort JSON files into one, dedup by bank_code (first wins).
Output: JSON array on stdout, or to --out path.

Example:
  node scripts/build-cohort.js \\
    --out data/cohorts/pm-refresh-2026-q2.json \\
    data/cohorts/_small-categories.json \\
    data/cohorts/_top-100-dccb-by-aum.json \\
    data/cohorts/_top-100-nsucb-by-aum.json
`);
}

function loadCohortFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: expected JSON array, got ${typeof parsed}`);
  }
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e || typeof e !== 'object') throw new Error(`${file}[${i}]: not an object`);
    if (!e.bank_code || typeof e.bank_code !== 'string') {
      throw new Error(`${file}[${i}]: bank_code is required (got ${JSON.stringify(e.bank_code)})`);
    }
  }
  return parsed;
}

function mergeCohorts(arrays) {
  const out = [];
  const seen = new Map();  // bank_code → source index
  for (let srcIdx = 0; srcIdx < arrays.length; srcIdx++) {
    for (const e of arrays[srcIdx]) {
      if (seen.has(e.bank_code)) continue;
      seen.set(e.bank_code, srcIdx);
      out.push({
        bank_code: e.bank_code,
        category: e.category || '',
        state: e.state || '',
      });
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); return 0; }
  if (opts.inputs.length === 0) { console.error('At least one input file is required'); printUsage(); return 1; }

  const arrays = [];
  for (const f of opts.inputs) {
    try {
      arrays.push(loadCohortFile(f));
    } catch (err) {
      console.error(`Failed to load ${f}: ${err.message}`);
      return 1;
    }
  }

  const merged = mergeCohorts(arrays);

  const json = JSON.stringify(merged, null, 2) + '\n';
  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    // safe-write-exempt: operator-driven merged cohort JSON output (not a per-bank artifact). ADR-012 §"NOT in scope".
    fs.writeFileSync(opts.out, json, 'utf-8');
    console.error(`Wrote ${merged.length} entries to ${path.relative(process.cwd(), opts.out)}`);
  } else {
    process.stdout.write(json);
  }
  for (let i = 0; i < opts.inputs.length; i++) {
    console.error(`  Source ${i}: ${path.basename(opts.inputs[i])} → ${arrays[i].length} entries`);
  }
  console.error(`  Total merged (unique by bank_code): ${merged.length}`);
  return 0;
}

if (require.main === module) {
  process.exit(main() || 0);
}

module.exports = { mergeCohorts, loadCohortFile };

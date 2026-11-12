#!/usr/bin/env node
'use strict';

/**
 * Run the pack quality gate against TWO baselines and emit side-by-side
 * verdicts.
 *
 * Phase 3b (sprint-004 2026-05-22) — pre-flight for pm-q2 re-run.
 *
 * Why two baselines:
 *   - April 16 = PM-published floor. The previous Claude-Code-internal-
 *     tooling run is what currently ships. New cohort MUST meet or beat
 *     this quality bar.
 *   - May 14 = prior pm-refresh-2026-q2 attempt (never shipped). Measures
 *     this session's engine improvements.
 *
 * Usage:
 *   node scripts/run-dual-gate.js [<new-pack>] [<april16-baseline>] [<may14-baseline>]
 *
 *   Defaults:
 *     new-pack          → pack/dist/rates-pack.json
 *     april16-baseline  → pack/history/rates-pack-2026-04-16.json
 *     may14-baseline    → pack/history/rates-pack-2026-05-14.json
 *
 * Exit code: 1 if the April-16 gate (PM floor) fails; 0 otherwise.
 * The May-14 verdict is informational and never blocks.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'quality-gate.js');

const args = process.argv.slice(2);
const NEW_PACK = args[0] || path.join(ROOT, 'pack', 'dist', 'rates-pack.json');
const APR16    = args[1] || path.join(ROOT, 'pack', 'history', 'rates-pack-2026-04-16.json');
const MAY14    = args[2] || path.join(ROOT, 'pack', 'history', 'rates-pack-2026-05-14.json');

function check(file, label) {
  if (!fs.existsSync(file)) {
    console.error(`ERROR: ${label} not found: ${file}`);
    process.exit(2);
  }
}

check(NEW_PACK, 'new pack');
check(APR16, 'April 16 baseline');
check(MAY14, 'May 14 baseline');

function runGate(baseline, label) {
  console.log(`\n${'='.repeat(72)}\nGate run: ${label}\nBaseline: ${path.relative(ROOT, baseline)}\n${'='.repeat(72)}`);
  const r = spawnSync('node', [GATE, NEW_PACK, baseline], { stdio: 'inherit' });
  return r.status;
}

const aprCode = runGate(APR16, 'PM-published floor (April 16)');
const mayCode = runGate(MAY14, 'Engine efficacy (May 14)');

console.log(`\n${'='.repeat(72)}\nDUAL-GATE SUMMARY\n${'='.repeat(72)}`);
console.log(`  April 16 (PM floor):       ${aprCode === 0 ? 'PASS' : 'BLOCK'}`);
console.log(`  May 14 (engine efficacy):  ${mayCode === 0 ? 'PASS' : 'BLOCK'}`);
console.log();
if (aprCode === 0) {
  console.log('Decision: PM floor met. Pack is shippable.');
  if (mayCode !== 0) {
    console.log('Note: May 14 gate blocks (likely intentional engine reshapes; review report).');
  }
} else {
  console.log('Decision: PM floor NOT met. Review April-16 gate report before shipping.');
}

process.exit(aprCode === 0 ? 0 : 1);

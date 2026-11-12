#!/usr/bin/env node

/**
 * pack/quality-gate.js — pre-publish slab-coverage gate.
 *
 * Sprint 010 Phase 1. Reads the just-built pack at `pack/dist/rates-pack.json`,
 * compares it against the immutable floor baseline at
 * `logs/sprint-009/baseline-pack-2026-05-28.json`, and blocks publish if
 * either:
 *
 *   1. `total_slabs` drops more than 10 % vs the floor, OR
 *   2. Any bank whose floor-baseline `confidence` was 'high' loses more than
 *      50 % of its slabs in the new pack.
 *
 * Why two checks: (1) catches whole-class regressions like Sprint 009's
 * partial_silent storm; (2) catches surgical regressions on top banks
 * (Axis, BoB, ICICI) where even a small percentage drop is operationally
 * disastrous.
 *
 * Output: writes `pack/dist/QUALITY-GATE.json` (machine) and a section in
 * `pack/dist/REPORT.md` (human). Exits non-zero on block; the operator
 * can override with `--accept-regression "<reason>"` (records the reason
 * to `QUALITY-GATE.json#operator_override`).
 *
 * pack/publish.js refuses to upload unless `QUALITY-GATE.json#pass` is true
 * or `operator_override` is set with a non-empty reason.
 *
 * Usage:
 *   node pack/quality-gate.js
 *   node pack/quality-gate.js --accept-regression "axis re-extraction known"
 *
 * Exit codes:
 *   0  pass (or override accepted)
 *   1  block (regression beyond threshold, no override)
 *   2  missing inputs (pack/dist/rates-pack.json or baseline not present)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = process.env.BIRD_DIST_DIR
  ? path.resolve(process.env.BIRD_DIST_DIR)
  : path.join(__dirname, 'dist');
const CURRENT_PACK = path.join(DIST_DIR, 'rates-pack.json');
// Baseline lives under pack/baseline/ (moved from logs/sprint-009/ on
// 2026-07-08) so it ships in the container image — the cloud finalize path
// runs this gate before publish, and logs/ is dockerignored.
const BASELINE = process.env.BIRD_QUALITY_GATE_BASELINE
  ? path.resolve(process.env.BIRD_QUALITY_GATE_BASELINE)
  : path.join(__dirname, 'baseline', 'baseline-pack-2026-05-28.json');

const GLOBAL_SLAB_DROP_THRESHOLD = 0.10;          // 10 %
const HIGH_CONFIDENCE_BANK_SLAB_DROP_THRESHOLD = 0.50; // 50 %

function read(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

function slabsIn(bank) {
  let n = 0;
  for (const p of Object.values(bank.products || {})) {
    for (const v of Object.values(p || {})) {
      n += (v && v.slabs ? v.slabs.length : 0);
    }
  }
  return n;
}

// A bank's "confidence" for gating purposes = the max confidence across its
// variants. We use the *baseline* confidence (the pre-cohort state) so that a
// bank dropping from high to nothing still triggers the high-confidence rule.
function bankConfidence(bank) {
  return bank.confidence || 'none';
}

function parseArgs(argv) {
  const out = { acceptRegression: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--accept-regression') {
      out.acceptRegression = argv[i + 1] || '';
      i++;
    }
  }
  return out;
}

function appendReportSection(distDir, payload) {
  const reportPath = path.join(distDir, 'REPORT.md');
  const head = fs.existsSync(reportPath) ? '\n\n' : '';
  const lines = [];
  lines.push(`${head}## Pre-publish quality gate — ${payload.checked_at}`);
  lines.push('');
  lines.push(`- Verdict: **${payload.pass ? 'PASS' : 'BLOCK'}**${payload.operator_override ? ' (operator override)' : ''}`);
  lines.push(`- Baseline (floor): \`${payload.baseline_file.replace(PROJECT_ROOT, '.')}\` (${payload.baseline_summary.total_slabs} slabs)`);
  lines.push(`- Current pack: ${payload.current_summary.total_slabs} slabs across ${payload.current_summary.banks_total} banks`);
  lines.push(`- Global delta: ${payload.checks.global.delta_pct >= 0 ? '+' : ''}${(payload.checks.global.delta_pct * 100).toFixed(1)} %`);
  if (payload.checks.high_confidence_regressions.length) {
    lines.push('- HIGH-confidence bank regressions:');
    for (const r of payload.checks.high_confidence_regressions.slice(0, 10)) {
      lines.push(`  - \`${r.bank_code}\` ${r.baseline_slabs} → ${r.current_slabs} (${(r.delta_pct * 100).toFixed(1)} %)`);
    }
    if (payload.checks.high_confidence_regressions.length > 10) {
      lines.push(`  - …and ${payload.checks.high_confidence_regressions.length - 10} more`);
    }
  } else {
    lines.push('- HIGH-confidence bank regressions: none beyond threshold');
  }
  if (payload.operator_override) {
    lines.push('');
    lines.push(`**Operator override reason:** ${payload.operator_override}`);
  }
  fs.appendFileSync(reportPath, lines.join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(CURRENT_PACK)) {
    console.error(`[quality-gate] missing: ${CURRENT_PACK} — run 'node pack/build-pack.js' first`);
    process.exit(2);
  }
  if (!fs.existsSync(BASELINE)) {
    console.error(`[quality-gate] missing baseline: ${BASELINE}`);
    process.exit(2);
  }

  const current = read(CURRENT_PACK);
  const baseline = read(BASELINE);

  // Global check
  const baselineSlabs = baseline.counts.total_slabs;
  const currentSlabs = current.counts.total_slabs;
  const globalDelta = currentSlabs - baselineSlabs;
  const globalDeltaPct = baselineSlabs > 0 ? globalDelta / baselineSlabs : 0;
  const globalBlock = globalDeltaPct < -GLOBAL_SLAB_DROP_THRESHOLD;

  // HIGH-confidence per-bank check
  const baselineByCode = new Map(baseline.banks.map((b) => [b.bank_code, b]));
  const currentByCode = new Map(current.banks.map((b) => [b.bank_code, b]));
  const highConfRegressions = [];
  for (const [code, baselineBank] of baselineByCode) {
    if (bankConfidence(baselineBank) !== 'high') continue;
    const bSlabs = slabsIn(baselineBank);
    if (bSlabs === 0) continue;
    const cur = currentByCode.get(code);
    const cSlabs = cur ? slabsIn(cur) : 0;
    const deltaPct = (cSlabs - bSlabs) / bSlabs;
    if (deltaPct < -HIGH_CONFIDENCE_BANK_SLAB_DROP_THRESHOLD) {
      highConfRegressions.push({
        bank_code: code,
        baseline_slabs: bSlabs,
        current_slabs: cSlabs,
        delta_pct: deltaPct,
      });
    }
  }

  const wouldBlock = globalBlock || highConfRegressions.length > 0;
  const pass = !wouldBlock;
  const operatorOverride = args.acceptRegression && args.acceptRegression.length > 0
    ? args.acceptRegression
    : null;
  const effectivePass = pass || !!operatorOverride;

  const payload = {
    pack_version: current.pack_version || null,
    checked_at: new Date().toISOString(),
    pass,
    operator_override: operatorOverride,
    effective_pass: effectivePass,
    baseline_file: BASELINE,
    baseline_summary: {
      total_slabs: baselineSlabs,
      banks_total: baseline.counts.banks_total,
    },
    current_summary: {
      total_slabs: currentSlabs,
      banks_total: current.counts.banks_total,
    },
    thresholds: {
      global_slab_drop: GLOBAL_SLAB_DROP_THRESHOLD,
      high_confidence_bank_slab_drop: HIGH_CONFIDENCE_BANK_SLAB_DROP_THRESHOLD,
    },
    checks: {
      global: {
        baseline_slabs: baselineSlabs,
        current_slabs: currentSlabs,
        delta: globalDelta,
        delta_pct: globalDeltaPct,
        block: globalBlock,
        reason: globalBlock ? 'global_slab_drop' : null,
      },
      high_confidence_regressions: highConfRegressions.sort((a, b) => a.delta_pct - b.delta_pct),
    },
    block_reasons: [
      globalBlock ? 'global_slab_drop' : null,
      highConfRegressions.length > 0 ? 'high_confidence_bank_regression' : null,
    ].filter(Boolean),
  };

  fs.writeFileSync(path.join(DIST_DIR, 'QUALITY-GATE.json'), JSON.stringify(payload, null, 2) + '\n', 'utf-8'); // safe-write-exempt: pre-publish quality-gate verdict artifact under pack/dist/, not a per-bank rates/config/summary file.
  appendReportSection(DIST_DIR, payload);

  if (effectivePass) {
    const verdict = pass ? 'PASS' : `OVERRIDE accepted: "${operatorOverride}"`;
    console.log(`[quality-gate] ${verdict}`);
    console.log(`[quality-gate]   global delta: ${(globalDeltaPct * 100).toFixed(2)} %  (${globalDelta >= 0 ? '+' : ''}${globalDelta} slabs)`);
    console.log(`[quality-gate]   high-conf regressions: ${highConfRegressions.length}`);
    process.exit(0);
  }

  console.error(`[quality-gate] BLOCK — reasons: ${payload.block_reasons.join(', ')}`);
  if (globalBlock) {
    console.error(`[quality-gate]   global slab delta: ${(globalDeltaPct * 100).toFixed(2)} % (threshold: -${GLOBAL_SLAB_DROP_THRESHOLD * 100} %)`);
  }
  if (highConfRegressions.length > 0) {
    console.error(`[quality-gate]   ${highConfRegressions.length} HIGH-confidence bank(s) regressed > ${HIGH_CONFIDENCE_BANK_SLAB_DROP_THRESHOLD * 100} %:`);
    for (const r of highConfRegressions.slice(0, 10)) {
      console.error(`[quality-gate]     ${r.bank_code}: ${r.baseline_slabs} → ${r.current_slabs} (${(r.delta_pct * 100).toFixed(1)} %)`);
    }
  }
  console.error(`[quality-gate] override with --accept-regression "<reason>" if intentional.`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = { main, GLOBAL_SLAB_DROP_THRESHOLD, HIGH_CONFIDENCE_BANK_SLAB_DROP_THRESHOLD };

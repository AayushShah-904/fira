#!/usr/bin/env node

/**
 * Sprint 009 close-out: build the cloud-incapable candidate list for Sprint 010.
 *
 * Unions three signals collected during the Sprint 009 cohort closeout:
 *
 *   A. Explicit cloud failures in 9zulerb's batch_results (status=failed)
 *   B. partial_silent fingerprint files left in output/latest/
 *   C. Banks whose slab count dropped to 0 between the May-28 baseline pack
 *      and today's rebuilt pack
 *
 * Emits a single deduped JSON map to:
 *   data/sprint-009-cloud-incapable-candidates.json
 *
 * The output is a *candidate* list — Sprint 010's first task is to validate
 * each candidate (local-run probe vs cloud re-probe) before flipping it to
 * cloud_capability=false in the registry.
 *
 * No code paths consume this file yet; the splitter (lib/cohort/splitter.js)
 * still only reads cloud_block_status. Sprint 010 wires capability in.
 *
 * Usage:
 *   node scripts/analysis/sprint-009-cloud-incapable-candidates.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const BATCH_9ZULERB = path.join(ROOT, 'logs', 'sprint-009', 'batch-9zulerb.json');
const BASELINE_PACK = path.join(ROOT, 'pack', 'baseline', 'baseline-pack-2026-05-28.json');
const CURRENT_PACK  = path.join(ROOT, 'pack', 'dist', 'rates-pack.json');
const LATEST_DIR    = path.join(ROOT, 'output', 'latest');
const OUT_PATH      = path.join(ROOT, 'data', 'sprint-009-cloud-incapable-candidates.json');

function slabsIn(bank) {
  let n = 0;
  for (const p of Object.values(bank.products || {})) {
    for (const v of Object.values(p || {})) {
      n += (v && v.slabs ? v.slabs.length : 0);
    }
  }
  return n;
}

function read(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

function collectA_batchFailures() {
  const batch = read(BATCH_9ZULERB);
  const fails = (batch.results || []).filter(r => r.status === 'failed');
  return fails.map(f => ({
    bank_code: f.name,
    failure_class: f.failure_class || null,
    reason: f.reason || null,
    exit_code: f.exitCode || null,
    elapsed_sec: f.elapsed_sec || null,
  }));
}

function collectB_partialSilent() {
  const out = [];
  for (const f of fs.readdirSync(LATEST_DIR)) {
    if (!f.endsWith('.partial_silent.json')) continue;
    const bank_code = f.slice(0, -'.partial_silent.json'.length);
    let payload = null;
    try { payload = read(path.join(LATEST_DIR, f)); } catch { /* tolerate */ }
    out.push({
      bank_code,
      fingerprint_kind: (payload && payload.kind) || null,
      observed_at: (payload && (payload.observed_at || payload.timestamp)) || null,
    });
  }
  return out;
}

function collectC_slabRegressions() {
  const a = read(BASELINE_PACK);
  const b = read(CURRENT_PACK);
  const aMap = new Map(a.banks.map(x => [x.bank_code, x]));
  const bMap = new Map(b.banks.map(x => [x.bank_code, x]));
  const out = [];
  for (const [code, ab] of aMap) {
    const bb = bMap.get(code);
    if (!bb) continue;
    const aSlabs = slabsIn(ab);
    const bSlabs = slabsIn(bb);
    if (aSlabs > 0 && bSlabs === 0) {
      out.push({
        bank_code: code,
        baseline_slabs: aSlabs,
        current_slabs: 0,
        baseline_confidence: ab.confidence || null,
        current_confidence: bb.confidence || null,
        category: ab.category || null,
      });
    }
  }
  return out;
}

function main() {
  const a = collectA_batchFailures();
  const b = collectB_partialSilent();
  const c = collectC_slabRegressions();

  const map = new Map();
  function add(bankCode, signal, payload) {
    if (!bankCode) return;
    if (!map.has(bankCode)) map.set(bankCode, { bank_code: bankCode, signals: [], details: {} });
    const entry = map.get(bankCode);
    if (!entry.signals.includes(signal)) entry.signals.push(signal);
    entry.details[signal] = payload;
  }
  for (const x of a) add(x.bank_code, 'batch_failure', x);
  for (const x of b) add(x.bank_code, 'partial_silent_fingerprint', x);
  for (const x of c) add(x.bank_code, 'regressed_to_zero_slabs', x);

  const candidates = [...map.values()].sort((x, y) =>
    y.signals.length - x.signals.length || x.bank_code.localeCompare(y.bank_code)
  );

  const out = {
    generated_at: new Date().toISOString(),
    source: 'scripts/analysis/sprint-009-cloud-incapable-candidates.js',
    inputs: {
      batch_failures_from: BATCH_9ZULERB.replace(ROOT, '.'),
      partial_silent_from: LATEST_DIR.replace(ROOT, '.'),
      baseline_pack:       BASELINE_PACK.replace(ROOT, '.'),
      current_pack:        CURRENT_PACK.replace(ROOT, '.'),
    },
    summary: {
      total_candidates:                  candidates.length,
      with_batch_failure:                candidates.filter(c => c.signals.includes('batch_failure')).length,
      with_partial_silent_fingerprint:   candidates.filter(c => c.signals.includes('partial_silent_fingerprint')).length,
      with_regressed_to_zero_slabs:      candidates.filter(c => c.signals.includes('regressed_to_zero_slabs')).length,
      with_two_or_more_signals:          candidates.filter(c => c.signals.length >= 2).length,
      with_all_three_signals:            candidates.filter(c => c.signals.length === 3).length,
    },
    candidates,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8'); // safe-write-exempt: one-shot analysis output under data/, not a per-bank rates/config/summary file.
  console.log(`Wrote ${OUT_PATH.replace(ROOT, '.')}`);
  console.log(`  total candidates:               ${out.summary.total_candidates}`);
  console.log(`  - with batch_failure:           ${out.summary.with_batch_failure}`);
  console.log(`  - with partial_silent fp:       ${out.summary.with_partial_silent_fingerprint}`);
  console.log(`  - with regressed_to_zero:       ${out.summary.with_regressed_to_zero_slabs}`);
  console.log(`  - with >=2 signals (priority):  ${out.summary.with_two_or_more_signals}`);
  console.log(`  - with all 3 signals (urgent):  ${out.summary.with_all_three_signals}`);
}

main();

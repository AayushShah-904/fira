'use strict';

/**
 * Tests for pack/quality-gate.js — Sprint 010 Phase 1.
 *
 * The gate is invoked as a subprocess (its `if (require.main === module)`
 * guard calls process.exit, which kills the test runner if required
 * in-process). Each test spawns `node pack/quality-gate.js` with the env
 * vars BIRD_DIST_DIR + BIRD_QUALITY_GATE_BASELINE pointing at a temp
 * fixture, asserts on exit code, and on the QUALITY-GATE.json output.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const GATE = path.resolve(__dirname, '..', '..', 'pack', 'quality-gate.js');

const tmpDirs = [];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-test-'));
  tmpDirs.push(dir);
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  return { dir, distDir };
}

function writePack(file, banks) {
  const totalSlabs = banks.reduce((s, b) => s + countSlabs(b), 0);
  const payload = {
    pack_version: '1.0.0',
    generated_at: new Date().toISOString(),
    counts: {
      banks_total: banks.length,
      banks_with_regular_fd: banks.length,
      banks_with_any_variant: banks.length,
      banks_with_nri: 0,
      banks_with_gift: 0,
      total_slabs: totalSlabs,
    },
    banks,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function countSlabs(bank) {
  let n = 0;
  for (const p of Object.values(bank.products || {})) {
    for (const v of Object.values(p || {})) {
      n += (v && v.slabs ? v.slabs.length : 0);
    }
  }
  return n;
}

function bank(code, { confidence = 'high', slabCount = 10 } = {}) {
  return {
    bank_code: code,
    confidence,
    products: {
      fd: {
        regular: {
          slabs: Array.from({ length: slabCount }, (_, i) => ({ tenure: i + 1 })),
        },
      },
    },
  };
}

function run(distDir, baselineFile, extraArgs = []) {
  const args = [GATE, ...extraArgs];
  const res = spawnSync(process.execPath, args, {
    env: {
      ...process.env,
      BIRD_DIST_DIR: distDir,
      BIRD_QUALITY_GATE_BASELINE: baselineFile,
    },
    encoding: 'utf-8',
  });
  let verdict = null;
  const verdictPath = path.join(distDir, 'QUALITY-GATE.json');
  if (fs.existsSync(verdictPath)) {
    try { verdict = JSON.parse(fs.readFileSync(verdictPath, 'utf-8')); } catch {}
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, verdict };
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test('gate passes when current pack is within tolerance vs baseline', () => {
  const { dir, distDir } = makeFixture();
  // baseline: 5 banks * 20 slabs = 100 slabs
  const baselineBanks = Array.from({ length: 5 }, (_, i) => bank(`bank-${i}`, { slabCount: 20 }));
  const baselineFile = path.join(dir, 'baseline.json');
  writePack(baselineFile, baselineBanks);
  // current: same shape (no regression)
  writePack(path.join(distDir, 'rates-pack.json'), baselineBanks);

  const r = run(distDir, baselineFile);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);
  assert.ok(r.verdict, 'QUALITY-GATE.json should be written');
  assert.equal(r.verdict.pass, true);
  assert.equal(r.verdict.effective_pass, true);
  assert.equal(r.verdict.checks.high_confidence_regressions.length, 0);
});

test('gate blocks on >10% global slab drop', () => {
  const { dir, distDir } = makeFixture();
  // baseline: 5 banks * 20 slabs = 100 slabs
  const baselineBanks = Array.from({ length: 5 }, (_, i) => bank(`bank-${i}`, { slabCount: 20 }));
  const baselineFile = path.join(dir, 'baseline.json');
  writePack(baselineFile, baselineBanks);
  // current: 5 banks * 14 slabs = 70 slabs — 30 % drop, well past 10 %
  const currentBanks = Array.from({ length: 5 }, (_, i) => bank(`bank-${i}`, { slabCount: 14 }));
  writePack(path.join(distDir, 'rates-pack.json'), currentBanks);

  const r = run(distDir, baselineFile);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert.equal(r.verdict.pass, false);
  assert.equal(r.verdict.effective_pass, false);
  assert.ok(r.verdict.block_reasons.includes('global_slab_drop'), 'must report global_slab_drop');
});

test('gate blocks on a single HIGH-confidence bank losing >50% of slabs', () => {
  const { dir, distDir } = makeFixture();
  // 10 banks, big enough that one bank's drop doesn't trip the global check
  const baselineBanks = [
    bank('axis-bank-limited', { slabCount: 100, confidence: 'high' }),
    ...Array.from({ length: 9 }, (_, i) => bank(`bank-${i}`, { slabCount: 20, confidence: 'high' })),
  ];
  // total: 100 + 9*20 = 280
  const baselineFile = path.join(dir, 'baseline.json');
  writePack(baselineFile, baselineBanks);
  // axis loses 60 % (100 → 40), others unchanged. Global drop: 60/280 = 21 % — would
  // also trip the global check. Trim others slightly to make global stay under threshold.
  const currentBanks = [
    bank('axis-bank-limited', { slabCount: 40, confidence: 'high' }),
    ...Array.from({ length: 9 }, (_, i) => bank(`bank-${i}`, { slabCount: 22, confidence: 'high' })),
  ];
  // total: 40 + 9*22 = 238  → global drop 42/280 = 15 % (would also trip global)
  // Pump non-axis banks higher so global is healthy and only axis fails the gate.
  const currentBanksBalanced = [
    bank('axis-bank-limited', { slabCount: 40, confidence: 'high' }),
    ...Array.from({ length: 9 }, (_, i) => bank(`bank-${i}`, { slabCount: 27, confidence: 'high' })),
  ];
  // total: 40 + 9*27 = 283 → +3 vs baseline 280 → global is fine; axis is the only fail
  writePack(path.join(distDir, 'rates-pack.json'), currentBanksBalanced);

  const r = run(distDir, baselineFile);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\nstderr: ${r.stderr}`);
  assert.equal(r.verdict.pass, false);
  assert.ok(r.verdict.block_reasons.includes('high_confidence_bank_regression'), 'must report high_confidence_bank_regression');
  assert.ok(!r.verdict.block_reasons.includes('global_slab_drop'), 'global slab drop should NOT be tripped');
  const axisReg = r.verdict.checks.high_confidence_regressions.find((x) => x.bank_code === 'axis-bank-limited');
  assert.ok(axisReg, 'axis regression must be listed');
  assert.equal(axisReg.baseline_slabs, 100);
  assert.equal(axisReg.current_slabs, 40);
});

test('gate does NOT block on medium/none-confidence banks losing slabs (only HIGH gated)', () => {
  const { dir, distDir } = makeFixture();
  const baselineBanks = [
    bank('high-conf-bank', { slabCount: 50, confidence: 'high' }),
    bank('med-conf-bank',  { slabCount: 50, confidence: 'medium' }),
    bank('low-conf-bank',  { slabCount: 50, confidence: 'low' }),
  ];
  // total: 150
  const baselineFile = path.join(dir, 'baseline.json');
  writePack(baselineFile, baselineBanks);
  const currentBanks = [
    bank('high-conf-bank', { slabCount: 60, confidence: 'high' }),  // +20 %
    bank('med-conf-bank',  { slabCount: 10, confidence: 'medium' }), // -80 %, but medium → not gated
    bank('low-conf-bank',  { slabCount: 50, confidence: 'low' }),
  ];
  // total: 120 → global -20 % which trips global. Boost high to compensate.
  const balanced = [
    bank('high-conf-bank', { slabCount: 90, confidence: 'high' }),
    bank('med-conf-bank',  { slabCount: 10, confidence: 'medium' }),
    bank('low-conf-bank',  { slabCount: 50, confidence: 'low' }),
  ];
  // total: 150 — global unchanged; medium bank dropped 80 % but medium isn't gated
  writePack(path.join(distDir, 'rates-pack.json'), balanced);

  const r = run(distDir, baselineFile);
  assert.equal(r.code, 0, `expected exit 0 (medium-conf not gated), got ${r.code}\nstderr: ${r.stderr}`);
  assert.equal(r.verdict.pass, true);
});

test('--accept-regression overrides a blocking verdict and records the reason', () => {
  const { dir, distDir } = makeFixture();
  const baselineBanks = Array.from({ length: 5 }, (_, i) => bank(`bank-${i}`, { slabCount: 20 }));
  const baselineFile = path.join(dir, 'baseline.json');
  writePack(baselineFile, baselineBanks);
  const currentBanks = Array.from({ length: 5 }, (_, i) => bank(`bank-${i}`, { slabCount: 12 }));
  writePack(path.join(distDir, 'rates-pack.json'), currentBanks);

  const r = run(distDir, baselineFile, ['--accept-regression', 'axis re-extraction known']);
  assert.equal(r.code, 0, `override should pass; got ${r.code}\nstderr: ${r.stderr}`);
  assert.equal(r.verdict.pass, false, 'underlying pass is still false');
  assert.equal(r.verdict.effective_pass, true);
  assert.equal(r.verdict.operator_override, 'axis re-extraction known');
});

test('gate exits 2 when pack file is missing', () => {
  const { dir, distDir } = makeFixture();
  const baselineFile = path.join(dir, 'baseline.json');
  writePack(baselineFile, [bank('any', { slabCount: 10 })]);
  // no rates-pack.json in distDir

  const r = run(distDir, baselineFile);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}`);
  assert.match(r.stderr, /missing/i);
});

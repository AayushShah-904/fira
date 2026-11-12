'use strict';

/**
 * Tests for the slab-drift quality check added to lib/tier-router.js#checkQuality
 * in Sprint 4 Track A (2026-05-20). Cloud AU SFB regressed 23→12 slabs while
 * still reporting "high confidence"; the drift check catches this so the
 * unified retry loop in run-discovery.js can re-attempt with the full model.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { checkQuality } = require('../../lib/tier-router');

const tmpDirs = [];
function makeRun() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-drift-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

function writeArtifacts(runDir, bankCode, { domesticSlabs, nreSlabs, scraperType = 'html_js', confidence = 'high' }) {
  fs.writeFileSync(path.join(runDir, `${bankCode}_config.json`), JSON.stringify({
    bank_code: bankCode,
    scraper_type: scraperType,
  }));
  fs.writeFileSync(path.join(runDir, `${bankCode}_rates.json`), JSON.stringify({
    bank_code: bankCode,
    extraction_confidence: confidence,
    rate_slabs: Array.from({ length: domesticSlabs }, (_, i) => ({ tenure_text: `slab ${i}` })),
  }));
  if (typeof nreSlabs === 'number') {
    fs.writeFileSync(path.join(runDir, `${bankCode}_nre_rates.json`), JSON.stringify({
      bank_code: bankCode,
      extraction_confidence: confidence,
      rate_slabs: Array.from({ length: nreSlabs }, (_, i) => ({ tenure_text: `slab ${i}` })),
    }));
  }
}

const agentResult = { success: true, finalText: 'ok' };

test('passes when no priorSlabCounts (first-ever run)', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'sample-bank', { domesticSlabs: 12 });
  const q = checkQuality({ agentResult, runDir, bankCode: 'sample-bank', domainWasKnown: true });
  assert.equal(q.pass, true);
});

test('passes when actual >= 0.8 * prior on every variant', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'sample-bank', { domesticSlabs: 20, nreSlabs: 5 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'sample-bank', domainWasKnown: true,
    priorSlabCounts: { regular: 22, nre: 5 },
    driftThreshold: 0.8,
  });
  // 20 / 22 = 0.909 >= 0.8 ✓ ; 5 / 5 = 1.0 ✓
  assert.equal(q.pass, true, q.reason);
});

test('fails with drift reason when domestic count drops below threshold', () => {
  // AU SFB regression: 23 → 12 = 0.52 < 0.8
  const runDir = makeRun();
  writeArtifacts(runDir, 'au-sfb', { domesticSlabs: 12 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'au-sfb', domainWasKnown: true,
    priorSlabCounts: { regular: 23 },
    driftThreshold: 0.8,
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on regular/);
  assert.match(q.reason, /12/);
  assert.match(q.reason, /23/);
});

test('fails on a variant other than regular (NRE drift)', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'big-bank', { domesticSlabs: 20, nreSlabs: 2 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'big-bank', domainWasKnown: true,
    priorSlabCounts: { regular: 22, nre: 5 },
    driftThreshold: 0.8,
  });
  // regular 20/22=0.909 ✓ ; nre 2/5=0.4 < 0.8 → fail on nre
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on nre/);
});

test('drift check skipped when prior count is 0 / non-positive', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'sample-bank', { domesticSlabs: 3 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'sample-bank', domainWasKnown: true,
    priorSlabCounts: { regular: 0 }, // no usable prior signal
    driftThreshold: 0.8,
  });
  assert.equal(q.pass, true);
});

test('existing 0-slab check still trips before drift evaluation', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'sample-bank', { domesticSlabs: 0 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'sample-bank', domainWasKnown: true,
    priorSlabCounts: { regular: 10 },
    driftThreshold: 0.8,
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /0 rate slabs/);
});

test('driftThreshold defaults to 0.8 when not provided', () => {
  // 7 / 10 = 0.7 < 0.8 → should fail under the default threshold
  const runDir = makeRun();
  writeArtifacts(runDir, 'sample-bank', { domesticSlabs: 7 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'sample-bank', domainWasKnown: true,
    priorSlabCounts: { regular: 10 },
    // driftThreshold omitted → default 0.8
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on regular/);
});

// ─── Sprint 4 Track A 2026-05-20: operator-curated floors (chicken-and-egg fix) ───

test('floor only (no prior) — fails when actual < 0.8 * floor', () => {
  // First-cloud-run scenario: PNB cloud got 19, local baseline floor 21,
  // no prior cloud data → drift must still fire on the floor signal.
  const runDir = makeRun();
  writeArtifacts(runDir, 'pnb', { domesticSlabs: 19 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'pnb', domainWasKnown: true,
    floorSlabCounts: { regular: 84 },  // local baseline aspiration
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on regular: 19/);
  assert.match(q.reason, /floor/);  // source = floor (not prior)
});

test('floor only — passes when actual >= 0.8 * floor', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'pnb', { domesticSlabs: 70 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'pnb', domainWasKnown: true,
    floorSlabCounts: { regular: 84 },
  });
  // 70 / 84 = 0.833 ≥ 0.8 ✓
  assert.equal(q.pass, true, q.reason);
});

test('prior + floor — uses the max of the two as expected', () => {
  // Floor 84, prior 19 → expected = 84. Actual 30 / 84 = 0.36 → fail with source 'floor'.
  const runDir = makeRun();
  writeArtifacts(runDir, 'pnb', { domesticSlabs: 30 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'pnb', domainWasKnown: true,
    priorSlabCounts: { regular: 19 },
    floorSlabCounts: { regular: 84 },
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on regular: 30/);
  assert.match(q.reason, /\(floor\)/);  // floor won
});

test('prior > floor — drift uses prior as expected', () => {
  // After a few good runs, prior 30 > floor 21. Actual 15 / 30 = 0.5 → fail with source 'prior'.
  const runDir = makeRun();
  writeArtifacts(runDir, 'bank-x', { domesticSlabs: 15 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'bank-x', domainWasKnown: true,
    priorSlabCounts: { regular: 30 },
    floorSlabCounts: { regular: 21 },
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /\(prior\)/);
});

test('floor on variant that prior is missing — fires correctly', () => {
  // AU SFB-style: prior has only regular (12 from bad cloud run), floor
  // covers regular + nre + nro (22 each from local). nre actual 0 < 0.8 * 22 → drift.
  const runDir = makeRun();
  writeArtifacts(runDir, 'au-sfb', { domesticSlabs: 22, nreSlabs: 0 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'au-sfb', domainWasKnown: true,
    priorSlabCounts: { regular: 12 },
    floorSlabCounts: { regular: 22, nre: 22, nro: 22 },
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on nre: 0/);
  assert.match(q.reason, /\(floor\)/);
});

test('floor with zero / non-positive — variant skipped (no signal)', () => {
  // Equitas local baseline had 0 across the board → no usable floor.
  const runDir = makeRun();
  writeArtifacts(runDir, 'equitas', { domesticSlabs: 0 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'equitas', domainWasKnown: true,
    floorSlabCounts: { regular: 0 },  // operator left it zero
  });
  // Falls through to the existing 0-slab check (which DOES fire), not the floor block
  assert.equal(q.pass, false);
  assert.match(q.reason, /0 rate slabs/);
});

// ── expectedVariants — default-required floor of 1 per declared variant ──
// Added 2026-05-20 after the PSB run shipped Canara/BoM/IB/UCO with only
// domestic slabs and no NRI files; none of those banks had explicit
// expected-slab-floors.json entries so the existing drift check was silent.

test('expectedVariants: PSB-style default fires drift when NRE/NRO/FCNR missing', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'psb-bank', { domesticSlabs: 12 });  // only domestic
  const q = checkQuality({
    agentResult, runDir, bankCode: 'psb-bank', domainWasKnown: true,
    expectedVariants: ['regular', 'nre', 'nro', 'fcnr'],
  });
  assert.equal(q.pass, false);
  // First missing variant (iteration order is regular,nre,nro,fcnr) is nre
  assert.match(q.reason, /slab drift on nre: 0 < 0\.8 \* 1 \(expected\)/);
});

test('expectedVariants: passes when every default variant has ≥1 slab', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'psb-bank', { domesticSlabs: 12, nreSlabs: 3 });
  // Also write NRO and FCNR rate files with 1 slab each
  fs.writeFileSync(path.join(runDir, 'psb-bank_nro_rates.json'), JSON.stringify({ rate_slabs: [{ tenure_text: 't' }] }));
  fs.writeFileSync(path.join(runDir, 'psb-bank_fcnr_rates.json'), JSON.stringify({ rate_slabs: [{ tenure_text: 't' }] }));
  const q = checkQuality({
    agentResult, runDir, bankCode: 'psb-bank', domainWasKnown: true,
    expectedVariants: ['regular', 'nre', 'nro', 'fcnr'],
  });
  assert.equal(q.pass, true);
});

test('expectedVariants: explicit floor=0 opts a variant out (BoM-style NRO=domestic)', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'bom', { domesticSlabs: 12, nreSlabs: 1 });
  fs.writeFileSync(path.join(runDir, 'bom_fcnr_rates.json'), JSON.stringify({ rate_slabs: [{ tenure_text: 't' }] }));
  // No bom_nro_rates.json — floor=0 should opt out
  const q = checkQuality({
    agentResult, runDir, bankCode: 'bom', domainWasKnown: true,
    expectedVariants: ['regular', 'nre', 'nro', 'fcnr'],
    floorSlabCounts: { nro: 0 },
  });
  assert.equal(q.pass, true);
});

test('expectedVariants: explicit floor wins over default-1 (uses the higher floor)', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'sucb', { domesticSlabs: 5 });  // bank shipped 5 domestic
  const q = checkQuality({
    agentResult, runDir, bankCode: 'sucb', domainWasKnown: true,
    expectedVariants: ['regular'],
    floorSlabCounts: { regular: 10 },  // operator says expect 10
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on regular: 5 < 0\.8 \* 10 \(floor\)/);
});

test('expectedVariants: co-op bank (only regular expected) passes with no NRI files', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'coop-bank', { domesticSlabs: 8 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'coop-bank', domainWasKnown: true,
    expectedVariants: ['regular'],  // co-op banks expect domestic only
  });
  assert.equal(q.pass, true);
});

test('expectedVariants: IBU expects only gift variant', () => {
  const runDir = makeRun();
  // Write a config and rates with empty rate_slabs (gift slabs live in _gift_rates)
  fs.writeFileSync(path.join(runDir, 'ibu_config.json'), JSON.stringify({ bank_code: 'ibu', scraper_type: 'html_static' }));
  fs.writeFileSync(path.join(runDir, 'ibu_rates.json'), JSON.stringify({ rate_slabs: [{ tenure_text: 'placeholder' }] }));
  // Missing _gift_rates.json → drift fires on gift
  const q = checkQuality({
    agentResult, runDir, bankCode: 'ibu', domainWasKnown: true,
    expectedVariants: ['gift'],
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /slab drift on gift: 0/);
});

// ─── M2.1 (sprint-004 2026-05-21) variant-scoped drifted array ───

test('M2.1: passing run returns drifted as empty array', () => {
  const runDir = makeRun();
  writeArtifacts(runDir, 'sample-bank', { domesticSlabs: 20 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'sample-bank', domainWasKnown: true,
    floorSlabCounts: { regular: 20 },
  });
  assert.equal(q.pass, true);
  assert.deepEqual(q.drifted, []);
});

test('M2.1: single-variant drift returns drifted=[{variant}]', () => {
  // Citibank-shaped case: only regular drifts.
  const runDir = makeRun();
  writeArtifacts(runDir, 'citi', { domesticSlabs: 17, nreSlabs: 17 });
  const q = checkQuality({
    agentResult, runDir, bankCode: 'citi', domainWasKnown: true,
    floorSlabCounts: { regular: 34, nre: 17 },
  });
  assert.equal(q.pass, false);
  assert.equal(q.drifted.length, 1);
  assert.equal(q.drifted[0].variant, 'regular');
  assert.equal(q.drifted[0].actual, 17);
  assert.equal(q.drifted[0].expected, 34);
  assert.equal(q.drifted[0].source, 'floor');
});

test('M2.1: multi-variant drift collects all drifted entries (PSB missing NRE+NRO+FCNR)', () => {
  // Single regression returned only the first one in `reason`; M2.1 ensures
  // `drifted[]` lists all of them so pack/build-pack can apply variant-scoped
  // exclusion across every dropped variant.
  const runDir = makeRun();
  writeArtifacts(runDir, 'psb', { domesticSlabs: 12 }); // only domestic
  const q = checkQuality({
    agentResult, runDir, bankCode: 'psb', domainWasKnown: true,
    expectedVariants: ['regular', 'nre', 'nro', 'fcnr'],
  });
  assert.equal(q.pass, false);
  // reason still names the first (regular passes; nre is the first drifted)
  assert.match(q.reason, /slab drift on nre/);
  // But drifted[] enumerates nre + nro + fcnr (all three missing)
  const variants = q.drifted.map((d) => d.variant).sort();
  assert.deepEqual(variants, ['fcnr', 'nre', 'nro']);
});

// ─── Sprint 010 Phase 5 (2026-06-07) — partial_silent root cause fix ───
// Registry-skip / curated banks intentionally produce empty rate files.
// Without this carve-out, drift fires (0 << priorSlabCounts=N) → triggers
// LLM retries that have no chance of finding rates the registry already
// says don't exist on the live site (axis-bank-limited cohort case).

test('Phase 5: rates.extraction_method=registry_skip → pass (no drift)', () => {
  const runDir = makeRun();
  const bankCode = 'axis-bank-limited';
  fs.writeFileSync(path.join(runDir, `${bankCode}_config.json`), JSON.stringify({
    bank_code: bankCode,
    scraper_type: 'manual',
  }));
  fs.writeFileSync(path.join(runDir, `${bankCode}_rates.json`), JSON.stringify({
    bank_code: bankCode,
    extraction_method: 'registry_skip',
    extraction_confidence: 'none',
    rate_slabs: [],
  }));
  const q = checkQuality({
    agentResult, runDir, bankCode, domainWasKnown: true,
    priorSlabCounts: { regular: 162, nre: 72, nro: 162, fcnr: 53 },
    driftThreshold: 0.8,
  });
  assert.equal(q.pass, true);
  assert.match(q.reason, /registry_skip/);
  assert.deepEqual(q.drifted, []);
});

test('Phase 5: rates.extraction_method=manual_pdf_transcription (curated) → pass', () => {
  // The actual axis-bank-limited case: registry entry has extraction_method
  // 'manual_pdf_transcription' (curated). When the cohort runs and writes a
  // rates file inheriting that method with zero extracted slabs, the drift
  // check must not fire.
  const runDir = makeRun();
  const bankCode = 'axis-bank-limited';
  fs.writeFileSync(path.join(runDir, `${bankCode}_config.json`), JSON.stringify({
    bank_code: bankCode,
    scraper_type: 'pdf',
    extraction_method: 'manual_pdf_transcription',
  }));
  fs.writeFileSync(path.join(runDir, `${bankCode}_rates.json`), JSON.stringify({
    bank_code: bankCode,
    extraction_method: 'manual_pdf_transcription',
    extraction_confidence: 'none',
    rate_slabs: [],
  }));
  const q = checkQuality({
    agentResult, runDir, bankCode, domainWasKnown: true,
    priorSlabCounts: { regular: 162 },
    floorSlabCounts: { regular: 162, nre: 72, nro: 162, fcnr: 53 },
    driftThreshold: 0.8,
  });
  assert.equal(q.pass, true, q.reason);
  assert.match(q.reason, /manual_pdf_transcription/);
});

test('Phase 5: extraction_method=registry_skip on config (not rates) → pass', () => {
  // Older runs may write extraction_method on the config but not on the rates
  // file. Cover both.
  const runDir = makeRun();
  const bankCode = 'curated-bank';
  fs.writeFileSync(path.join(runDir, `${bankCode}_config.json`), JSON.stringify({
    bank_code: bankCode,
    scraper_type: 'pdf',
    extraction_method: 'registry_skip',
  }));
  fs.writeFileSync(path.join(runDir, `${bankCode}_rates.json`), JSON.stringify({
    bank_code: bankCode,
    extraction_confidence: 'none',
    rate_slabs: [],
  }));
  const q = checkQuality({
    agentResult, runDir, bankCode, domainWasKnown: true,
    priorSlabCounts: { regular: 100 },
  });
  assert.equal(q.pass, true);
  assert.match(q.reason, /registry_skip/);
});

test('Phase 5: non-curated method with 0 slabs still fails (regression-safety)', () => {
  // Don't accidentally widen the carve-out: a normal extraction that produced
  // 0 slabs is still a failure.
  const runDir = makeRun();
  const bankCode = 'normal-bank';
  fs.writeFileSync(path.join(runDir, `${bankCode}_config.json`), JSON.stringify({
    bank_code: bankCode,
    scraper_type: 'html_static',
  }));
  fs.writeFileSync(path.join(runDir, `${bankCode}_rates.json`), JSON.stringify({
    bank_code: bankCode,
    extraction_method: 'automatic_html_static',
    extraction_confidence: 'high',
    rate_slabs: [],
  }));
  const q = checkQuality({
    agentResult, runDir, bankCode, domainWasKnown: true,
    priorSlabCounts: { regular: 10 },
  });
  assert.equal(q.pass, false);
  assert.match(q.reason, /0 rate slabs/);
});

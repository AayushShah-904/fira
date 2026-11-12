'use strict';

/**
 * Tests for M2.1 (sprint-004 2026-05-21) — variant-scoped partial_silent
 * marker handling in pack/build-pack.js.
 *
 * Before M2.1: any presence of `<slug>.partial_silent.json` excluded the
 * whole bank from the pack — costing 34 healthy NRE+NRO slabs for Citibank
 * when only `regular` drifted, and 25 healthy regular+NRE+NRO slabs for
 * Ujjivan when only `fcnr` drifted.
 *
 * After M2.1: marker carries `drifted_variants: [...]`; build-pack skips
 * only those variants' rate files. Bank's config + healthy-variant rate
 * files still ship. Legacy markers (no `drifted_variants` field) keep the
 * whole-bank-exclusion semantics for back-compat.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmpDirs = [];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-pack-variant-'));
  tmpDirs.push(dir);
  const latestDir = path.join(dir, 'latest');
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(latestDir, { recursive: true });
  return { dir, latestDir, distDir };
}

function writeBank(latestDir, slug, { regular, nre, nro, fcnr } = {}) {
  fs.writeFileSync(
    path.join(latestDir, `${slug}_config.json`),
    JSON.stringify({ bank_code: slug, scraper_type: 'html_static', bank_type: 'FB' }, null, 2),
  );
  for (const [variant, n] of Object.entries({ regular, nre, nro, fcnr })) {
    if (typeof n !== 'number') continue;
    const suffix = variant === 'regular' ? '' : `_${variant}`;
    fs.writeFileSync(
      path.join(latestDir, `${slug}${suffix}_rates.json`),
      JSON.stringify({
        bank_code: slug,
        variant,
        rate_slabs: Array.from({ length: n }, (_, i) => ({ tenure_text: `t${i}`, rate_general_pct: 6 + i * 0.1 })),
        effective_date: '2026-05-01',
        extraction_confidence: 'high',
      }, null, 2),
    );
  }
}

function writeMarker(latestDir, slug, payload) {
  fs.writeFileSync(
    path.join(latestDir, `${slug}.partial_silent.json`),
    JSON.stringify(payload, null, 2),
  );
}

function loadFreshBuildPack(latestDir, distDir) {
  process.env.BIRD_LATEST_DIR = latestDir;
  process.env.BIRD_DIST_DIR = distDir;
  delete require.cache[require.resolve('../../pack/build-pack.js')];
  return require('../../pack/build-pack.js');
}

test.after(() => {
  delete process.env.BIRD_LATEST_DIR;
  delete process.env.BIRD_DIST_DIR;
  try { delete require.cache[require.resolve('../../pack/build-pack.js')]; } catch (_) {}
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Variant-scoped marker: only listed variants are skipped ──────────

test('M2.1 marker with drifted_variants=[regular] keeps NRE+NRO in pack', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'citi-style', { regular: 17, nre: 17, nro: 17 });
  writeMarker(latestDir, 'citi-style', {
    bank_code: 'citi-style',
    reason: 'slab drift on regular: 17 < 0.8 * 34 (floor)',
    drifted_variants: ['regular'],
    detected_at: '2026-05-21T05:38:00Z',
    attempts: 3,
    marker_schema_version: 2,
  });

  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();
  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  const bank = pack.banks.find((b) => b.bank_code === 'citi-style');
  assert.ok(bank, 'bank should still appear in pack with variant-scoped marker');
  assert.equal(Object.keys(bank.products.fd).length, 2, 'only nre + nro should ship');
  assert.ok(bank.products.fd.nre, 'nre should ship');
  assert.ok(bank.products.fd.nro, 'nro should ship');
  assert.equal(bank.products.fd.regular, undefined, 'regular should be held back');
  assert.equal(bank.products.fd.nre.slabs.length, 17);
});

test('M2.1 marker with drifted_variants=[fcnr] keeps regular+NRE+NRO (Ujjivan case)', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'ujjivan-style', { regular: 10, nre: 5, nro: 10, fcnr: 0 });
  writeMarker(latestDir, 'ujjivan-style', {
    bank_code: 'ujjivan-style',
    reason: 'slab drift on fcnr: 0 < 0.8 * 6 (prior)',
    drifted_variants: ['fcnr'],
    detected_at: '2026-05-21T05:41:13Z',
    attempts: 3,
    marker_schema_version: 2,
  });

  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();
  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  const bank = pack.banks.find((b) => b.bank_code === 'ujjivan-style');
  assert.ok(bank);
  assert.ok(bank.products.fd.regular);
  assert.ok(bank.products.fd.nre);
  assert.ok(bank.products.fd.nro);
  // fcnr had 0 slabs anyway, so buildVariant filters it; either way it must not ship
  assert.equal(bank.products.fd.fcnr, undefined);
  // Healthy slab counts preserved
  assert.equal(bank.products.fd.regular.slabs.length, 10);
  assert.equal(bank.products.fd.nro.slabs.length, 10);
});

test('M2.1 marker with multiple drifted variants skips all of them, keeps the rest', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'multi-drift', { regular: 18, nre: 8, nro: 18, fcnr: 30 });
  writeMarker(latestDir, 'multi-drift', {
    bank_code: 'multi-drift',
    reason: 'slab drift on nre: 8 < 0.8 * 16 (floor)',
    drifted_variants: ['nre', 'nro'],
    detected_at: '2026-05-21T06:00:00Z',
    attempts: 3,
    marker_schema_version: 2,
  });

  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();
  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  const bank = pack.banks.find((b) => b.bank_code === 'multi-drift');
  assert.ok(bank);
  assert.ok(bank.products.fd.regular);
  assert.ok(bank.products.fd.fcnr);
  assert.equal(bank.products.fd.nre, undefined);
  assert.equal(bank.products.fd.nro, undefined);
});

// ── Back-compat: legacy markers without drifted_variants ─────────────

test('M2.1 legacy marker (no drifted_variants field) excludes whole bank', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'legacy-marker', { regular: 17, nre: 17, nro: 17 });
  writeMarker(latestDir, 'legacy-marker', {
    bank_code: 'legacy-marker',
    reason: 'slab drift on regular',
    detected_at: '2026-05-20T19:02:00Z',
    attempts: 3,
    // no drifted_variants — legacy shape from before M2.1
  });

  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();
  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  // Bank should NOT appear in pack at all
  const bank = pack.banks.find((b) => b.bank_code === 'legacy-marker');
  assert.equal(bank, undefined, 'legacy marker should fully exclude the bank (back-compat)');
});

test('M2.1 marker with empty drifted_variants treated as legacy (whole-bank exclude)', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'empty-list', { regular: 10 });
  writeMarker(latestDir, 'empty-list', {
    bank_code: 'empty-list',
    reason: 'unknown',
    drifted_variants: [], // defensive: empty array
    detected_at: '2026-05-21T05:38:00Z',
    attempts: 3,
    marker_schema_version: 2,
  });

  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();
  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  const bank = pack.banks.find((b) => b.bank_code === 'empty-list');
  assert.equal(bank, undefined, 'empty drifted_variants is treated as whole-bank exclusion');
});

// ── No marker present: nothing skipped ──────────────────────────────

test('M2.1 bank with no marker ships all variants', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'no-marker', { regular: 18, nre: 8 });

  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();
  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  const bank = pack.banks.find((b) => b.bank_code === 'no-marker');
  assert.ok(bank);
  assert.ok(bank.products.fd.regular);
  assert.ok(bank.products.fd.nre);
});

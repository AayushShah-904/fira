'use strict';

/**
 * Tests for pack/build-pack.js — Sprint 002 #11.
 *
 * Verifies that the pack rebuild walks the full output/latest/ dir and
 * produces a pack containing every bank present in the fixture. This is
 * the verification step that ADR-011 + Sprint 002 #10 unblock: once
 * cloud/sync.js pull() hydrates output/latest/ from blob, the existing
 * pack rebuild already does the right thing — pack count grows
 * monotonically across cloud runs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmpDirs = [];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-pack-test-'));
  tmpDirs.push(dir);
  const latestDir = path.join(dir, 'latest');
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(latestDir, { recursive: true });
  return { dir, latestDir, distDir };
}

function writeBank(latestDir, slug, { config, rates, nreRates, fcnrRates } = {}) {
  if (config) {
    fs.writeFileSync(
      path.join(latestDir, `${slug}_config.json`),
      JSON.stringify({ bank_code: slug, ...config }, null, 2),
    );
  }
  if (rates) {
    fs.writeFileSync(
      path.join(latestDir, `${slug}_rates.json`),
      JSON.stringify({ bank_code: slug, variant: 'regular', ...rates }, null, 2),
    );
  }
  if (nreRates) {
    fs.writeFileSync(
      path.join(latestDir, `${slug}_nre_rates.json`),
      JSON.stringify({ bank_code: slug, variant: 'nre', ...nreRates }, null, 2),
    );
  }
  if (fcnrRates) {
    fs.writeFileSync(
      path.join(latestDir, `${slug}_fcnr_rates.json`),
      JSON.stringify({ bank_code: slug, variant: 'fcnr', ...fcnrRates }, null, 2),
    );
  }
}

function loadFreshBuildPack(latestDir, distDir) {
  // build-pack.js reads BIRD_LATEST_DIR / BIRD_DIST_DIR at module load
  // time. Reset the cache so each test gets a fresh module with its env.
  process.env.BIRD_LATEST_DIR = latestDir;
  process.env.BIRD_DIST_DIR = distDir;
  delete require.cache[require.resolve('../../pack/build-pack.js')];
  return require('../../pack/build-pack.js');
}

test.after(() => {
  delete process.env.BIRD_LATEST_DIR;
  delete process.env.BIRD_DIST_DIR;
  // Also flush the module cache so a non-test require() picks up real defaults
  try { delete require.cache[require.resolve('../../pack/build-pack.js')]; } catch (_) { /* best-effort */ }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

// ── Sanity: env-var overrides ───────────────────────────────────────

test('build-pack honors BIRD_LATEST_DIR and BIRD_DIST_DIR env overrides', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'one-bank', {
    config: { scraper_type: 'html_static', bank_type: 'DCCB' },
    rates: {
      rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }],
      effective_date: '2026-05-01',
      extraction_confidence: 'high',
    },
  });
  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();
  assert.ok(fs.existsSync(path.join(distDir, 'rates-pack.json')));
  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  assert.equal(pack.banks.length, 1);
  assert.equal(pack.banks[0].bank_code, 'one-bank');
});

// ── Core property: pack contains all banks in the fixture ──────────

test('pack rebuild includes every bank present in output/latest/ (the #10 cascade)', () => {
  const { latestDir, distDir } = makeFixture();
  // Five banks: simulating accumulated state from prior cloud runs hydrated by #10
  const banks = [
    'hdfc-bank-limited',
    'state-bank-of-india',
    'abhyudaya-co-operative-bank-ltd-mumbai',
    'banswara-central-co-operative-bank-ltd',
    'nizamabad-district-co-operative-central-bank-ltd',
  ];
  for (const slug of banks) {
    writeBank(latestDir, slug, {
      config: { scraper_type: 'html_static', bank_type: 'DCCB' },
      rates: {
        rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.0 }],
        effective_date: '2026-05-01',
        extraction_confidence: 'high',
      },
    });
  }
  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();

  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  assert.equal(pack.banks.length, banks.length);
  const slugsInPack = pack.banks.map((b) => b.bank_code).sort();
  assert.deepEqual(slugsInPack, [...banks].sort());
});

// ── Multi-variant: NRE, NRO, FCNR all picked up per-bank ───────────

test('pack rebuild picks up multi-variant rates per bank (regular + nre + fcnr)', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'multi-variant-bank', {
    config: { scraper_type: 'html_static', bank_type: 'PSB' },
    rates: {
      rate_slabs: [{ tenure_text: '1y', rate_general_pct: 7.0 }],
      effective_date: '2026-05-01',
      extraction_confidence: 'high',
    },
    nreRates: {
      rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }],
      effective_date: '2026-05-01',
      extraction_confidence: 'high',
    },
    fcnrRates: {
      rate_slabs: [{ tenure_text: '1y', rate_general_pct: 4.5, currency: 'USD' }],
      effective_date: '2026-05-01',
      extraction_confidence: 'high',
    },
  });
  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();

  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  assert.equal(pack.banks.length, 1);
  const entry = pack.banks[0];
  assert.ok(entry.products.fd.regular, 'regular variant');
  assert.ok(entry.products.fd.nre,     'nre variant');
  assert.ok(entry.products.fd.fcnr,    'fcnr variant');
  assert.equal(entry.products.fd.regular.slabs[0].rate_general_pct, 7.0);
  assert.equal(entry.products.fd.nre.slabs[0].rate_general_pct, 6.5);
  assert.equal(entry.products.fd.fcnr.slabs[0].currency, 'USD');
});

// ── #10 cascade: simulate the Sprint 001 HDFC + DCCB scenario ──────

test('after-hydration pack contains BOTH the prior-run bank AND this-run banks (HDFC + DCCB regression)', () => {
  // This is exactly the failure mode Sprint 001 hit: the cloud bot's DCCB
  // run dropped HDFC because pull() only fetched bank-domains.json. With #10
  // hydrating output/latest/, both should be in the pack.
  const { latestDir, distDir } = makeFixture();
  // "Prior run" bank
  writeBank(latestDir, 'hdfc-bank-limited', {
    config: { scraper_type: 'html_static', bank_type: 'PVB' },
    rates: {
      rate_slabs: [{ tenure_text: '1y', rate_general_pct: 7.1 }],
      effective_date: '2026-05-08',
      extraction_confidence: 'high',
    },
  });
  // "This run's" DCCBs
  for (const slug of ['agra-zilla-sahakari-bank-ltd', 'bhatinda-central-co-operative-bank-ltd']) {
    writeBank(latestDir, slug, {
      config: { scraper_type: 'html_static', bank_type: 'DCCB' },
      rates: {
        rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }],
        effective_date: '2026-05-11',
        extraction_confidence: 'medium',
      },
    });
  }
  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();

  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  const slugs = new Set(pack.banks.map((b) => b.bank_code));
  assert.ok(slugs.has('hdfc-bank-limited'), 'HDFC survived the DCCB run (regression check)');
  assert.ok(slugs.has('agra-zilla-sahakari-bank-ltd'));
  assert.ok(slugs.has('bhatinda-central-co-operative-bank-ltd'));
  assert.equal(pack.banks.length, 3);
});

// ── Pack derived outputs written next to rates-pack.json ──────────

test('pack rebuild produces rates-pack.json + schema + README in distDir', () => {
  const { latestDir, distDir } = makeFixture();
  writeBank(latestDir, 'one-bank', {
    config: { scraper_type: 'html_static', bank_type: 'DCCB' },
    rates: {
      rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }],
      effective_date: '2026-05-01',
      extraction_confidence: 'high',
    },
  });
  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();

  assert.ok(fs.existsSync(path.join(distDir, 'rates-pack.json')));
  assert.ok(fs.existsSync(path.join(distDir, 'rates-pack.schema.json')));
  assert.ok(fs.existsSync(path.join(distDir, 'README.md')));
});

// ── Empty fixture (first cloud run / nothing in latest yet) ────────

test('pack rebuild against empty latest/ produces a pack with banks=[]', () => {
  const { latestDir, distDir } = makeFixture();
  // No banks written
  const { buildPack } = loadFreshBuildPack(latestDir, distDir);
  buildPack();

  const pack = JSON.parse(fs.readFileSync(path.join(distDir, 'rates-pack.json'), 'utf-8'));
  assert.equal(pack.banks.length, 0);
  assert.ok(pack.pack_version, 'pack still has version metadata');
  assert.ok(pack.generated_at, 'pack still has generated_at');
});

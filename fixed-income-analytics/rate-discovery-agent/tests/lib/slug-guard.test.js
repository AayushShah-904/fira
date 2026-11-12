'use strict';

/**
 * Tests for lib/slug-guard.js — Sprint 002 #6 (slug-ghost fix).
 *
 * Uses os.tmpdir() per test (never touches output/latest/).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enforceSlug,
  isCanonicalRateFilename,
  isCanonicalNonRateFilename,
  inferArtifactKind,
} = require('../../lib/slug-guard');

const tmpDirs = [];

function makeRunDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-guard-test-'));
  tmpDirs.push(d);
  return d;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

function write(dir, name, obj) {
  const full = path.join(dir, name);
  if (typeof obj === 'string') fs.writeFileSync(full, obj);
  else fs.writeFileSync(full, JSON.stringify(obj));
  return full;
}

test('isCanonicalRateFilename accepts the five allowed shapes', () => {
  const slug = 'state-bank-of-india';
  assert.equal(isCanonicalRateFilename(`${slug}_rates.json`, slug), true);
  assert.equal(isCanonicalRateFilename(`${slug}_nre_rates.json`, slug), true);
  assert.equal(isCanonicalRateFilename(`${slug}_nro_rates.json`, slug), true);
  assert.equal(isCanonicalRateFilename(`${slug}_fcnr_rates.json`, slug), true);
  assert.equal(isCanonicalRateFilename(`${slug}_gift_rates.json`, slug), true);
});

test('isCanonicalRateFilename rejects product-variant ghosts', () => {
  const slug = 'central-co-operative-bank-ltd-ara';
  assert.equal(isCanonicalRateFilename(`${slug}_current_rates.json`, slug), false);
  assert.equal(isCanonicalRateFilename(`${slug}_dds_rates.json`, slug), false);
  assert.equal(isCanonicalRateFilename(`${slug}_rd_rates.json`, slug), false);
  assert.equal(isCanonicalRateFilename(`${slug}_savings_rates.json`, slug), false);
});

test('isCanonicalNonRateFilename accepts standard companions', () => {
  const slug = 'hdfc-bank-limited';
  assert.equal(isCanonicalNonRateFilename(`${slug}_config.json`, slug), true);
  assert.equal(isCanonicalNonRateFilename(`${slug}.summary.json`, slug), true);
  assert.equal(isCanonicalNonRateFilename(`${slug}_attempt2.summary.json`, slug), true);
  assert.equal(isCanonicalNonRateFilename(`${slug}.trace.jsonl`, slug), true);
  assert.equal(isCanonicalNonRateFilename(`${slug}.log`, slug), true);
});

test('enforceSlug moves rogue product-variant rate files to _rogue/', () => {
  const dir = makeRunDir();
  const slug = 'central-co-operative-bank-ltd-ara';

  // Canonical rates file
  write(dir, `${slug}_rates.json`, { bank_code: slug, rate_slabs: [] });
  // Rogue product-variant files the agent should not have minted
  write(dir, `${slug}_current_rates.json`, { bank_code: slug, rate_slabs: [{}] });
  write(dir, `${slug}_dds_rates.json`, { bank_code: slug });
  write(dir, `${slug}_savings_rates.json`, { bank_code: slug });

  const report = enforceSlug({ runDir: dir, bankCode: slug });

  assert.deepEqual(
    [...report.rogueFilesMoved].sort(),
    [`${slug}_current_rates.json`, `${slug}_dds_rates.json`, `${slug}_savings_rates.json`],
  );
  // Canonical file stays put
  assert.ok(fs.existsSync(path.join(dir, `${slug}_rates.json`)));
  // Rogue files moved into _rogue/
  assert.ok(fs.existsSync(path.join(dir, '_rogue', `${slug}_current_rates.json`)));
  assert.ok(fs.existsSync(path.join(dir, '_rogue', `${slug}_dds_rates.json`)));
  assert.ok(fs.existsSync(path.join(dir, '_rogue', `${slug}_savings_rates.json`)));
  // ...and removed from the run dir top level
  assert.ok(!fs.existsSync(path.join(dir, `${slug}_current_rates.json`)));
});

test('enforceSlug corrects mismatched bank_code inside JSON files', () => {
  const dir = makeRunDir();
  const slug = 'banswara-central-co-operative-bank-ltd';

  write(dir, `${slug}_config.json`, { bank_code: 'banswara-bank', scraper_type: 'html_static' });
  write(dir, `${slug}_rates.json`, { bank_code: 'banswara-bank', rate_slabs: [] });

  const report = enforceSlug({ runDir: dir, bankCode: slug });

  assert.equal(report.slugCorrections.length, 2);
  assert.equal(report.slugCorrections[0].to, slug);

  const config = JSON.parse(fs.readFileSync(path.join(dir, `${slug}_config.json`), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(dir, `${slug}_rates.json`), 'utf8'));
  assert.equal(config.bank_code, slug);
  assert.equal(rates.bank_code, slug);
});

test('enforceSlug leaves canonical, well-formed files untouched', () => {
  const dir = makeRunDir();
  const slug = 'hdfc-bank-limited';

  const configBefore = { bank_code: slug, scraper_type: 'html_static', website: 'https://hdfc.example' };
  write(dir, `${slug}_config.json`, configBefore);
  write(dir, `${slug}_rates.json`, { bank_code: slug, rate_slabs: [{ tenure_text: '1y' }] });

  const report = enforceSlug({ runDir: dir, bankCode: slug });

  assert.equal(report.rogueFilesMoved.length, 0);
  assert.equal(report.slugCorrections.length, 0);
});

test('enforceSlug counts files belonging to other banks but does not touch them', () => {
  const dir = makeRunDir();
  const slug = 'bank-a';

  write(dir, `${slug}_config.json`, { bank_code: slug });
  write(dir, 'bank-b_config.json', { bank_code: 'bank-b' });
  write(dir, 'bank-c_rates.json', { bank_code: 'bank-c', rate_slabs: [] });

  const report = enforceSlug({ runDir: dir, bankCode: slug });

  assert.deepEqual(
    [...report.otherBankFiles].sort(),
    ['bank-b_config.json', 'bank-c_rates.json'],
  );
  // Files still there, untouched
  assert.ok(fs.existsSync(path.join(dir, 'bank-b_config.json')));
});

test('enforceSlug tolerates malformed JSON without crashing', () => {
  const dir = makeRunDir();
  const slug = 'broken-bank';
  write(dir, `${slug}_config.json`, '{this is not json');

  const report = enforceSlug({ runDir: dir, bankCode: slug });
  assert.equal(report.slugCorrections.length, 0);
});

test('enforceSlug correctly handles a slug that contains hyphens (no false rogue detection)', () => {
  const dir = makeRunDir();
  const slug = 'co-operative-central-bank-of-aurangabad';
  write(dir, `${slug}_config.json`, { bank_code: slug });
  write(dir, `${slug}_rates.json`, { bank_code: slug, rate_slabs: [] });
  write(dir, `${slug}_nre_rates.json`, { bank_code: slug, rate_slabs: [] });

  const report = enforceSlug({ runDir: dir, bankCode: slug });
  assert.equal(report.rogueFilesMoved.length, 0);
  assert.equal(report.slugCorrections.length, 0);
});

test('enforceSlug missing runDir returns empty report (no crash)', () => {
  const r = enforceSlug({ runDir: '/this/dir/does/not/exist', bankCode: 'x' });
  assert.equal(r.rogueFilesMoved.length, 0);
  assert.equal(r.slugCorrections.length, 0);
});

test('inferArtifactKind maps filenames to safe-write kinds', () => {
  const slug = 'state-bank-of-india';
  assert.equal(inferArtifactKind(`${slug}_config.json`), 'config');
  assert.equal(inferArtifactKind(`${slug}_rates.json`), 'rates');
  assert.equal(inferArtifactKind(`${slug}_nre_rates.json`), 'rates');
  assert.equal(inferArtifactKind(`${slug}_fcnr_rates.json`), 'rates');
  assert.equal(inferArtifactKind(`${slug}.summary.json`), 'summary');
  assert.equal(inferArtifactKind(`${slug}_attempt2.summary.json`), 'summary');
  // Unknown companions return null (caller falls back to direct write).
  assert.equal(inferArtifactKind(`${slug}.trace.jsonl`), null);
  assert.equal(inferArtifactKind(`${slug}.log`), null);
});

test('slug-guard preserves operator-curated rates on bank_code correction (ADR-012)', () => {
  // ADR-012 non-destruction guarantee: even slug-guard's benign in-place
  // bank_code rewrite must not overwrite a curated rates artifact. The
  // bank_code-corrected payload should land at <filePath>.pending.json
  // and the on-disk file should retain its curated state untouched.
  const dir = makeRunDir();
  const slug = 'angul-united-central-co-operative-bank-ltd';

  const curated = {
    bank_code: 'angul-bank', // wrong slug — what slug-guard would normally "fix"
    extraction_method: 'manual_image_transcription',
    rate_slabs: [
      { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 7.25 },
    ],
  };
  const filePath = write(dir, `${slug}_rates.json`, curated);

  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), info: () => {} };

  const report = enforceSlug({ runDir: dir, bankCode: slug, logger });

  // The curated file must survive unchanged on disk.
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.bank_code, 'angul-bank', 'curated bank_code must NOT be rewritten');
  assert.equal(onDisk.extraction_method, 'manual_image_transcription');
  assert.equal(onDisk.rate_slabs.length, 1);
  assert.equal(onDisk.rate_slabs[0].rate_general_pct, 7.25);

  // The bank_code-corrected incoming payload must land at the pending sidecar.
  const pendingPath = `${filePath}.pending.json`;
  assert.ok(fs.existsSync(pendingPath), 'incoming should be routed to .pending.json');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  assert.equal(pending.bank_code, slug, 'pending sidecar carries the corrected bank_code');
  assert.equal(pending.extraction_method, 'manual_image_transcription');

  // slug-guard should NOT have recorded a correction (the in-place rewrite
  // never happened); it should have logged the deferral.
  assert.equal(report.slugCorrections.length, 0, 'no slugCorrection recorded when deferred');
  assert.ok(
    warnings.some((m) => m.includes('deferred to pending') || m.includes('preserving curated')),
    'expected a warning about pending-sidecar deferral',
  );
});

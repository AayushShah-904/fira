'use strict';

/**
 * Tests for lib/actions/commit_rates.js — Sprint 003 #1b (A8).
 *
 * Coverage:
 *   - Happy path (valid slabs, writes through safe-write).
 *   - Slug mismatch → ok:false, error_class:"slug_mismatch", structured log_entry.
 *   - Validation failure (tenure_min > tenure_max) → wrote:false, rejected payload captured.
 *   - Curated-target preservation (existing manual_image_transcription) → deferred_to_pending.
 *   - Variant routing (regular / nre / nro / fcnr / gift filenames).
 *   - Input contract violations throw.
 *   - Warnings (non-critical) embedded into the written JSON's `validation` block.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { commitRates, ratesFilenameFor } = require('../../../lib/actions/commit_rates');

const tmpDirs = [];

function makeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-rates-test-'));
  tmpDirs.push(d);
  return d;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

const silentLogger = { warn: () => {}, info: () => {}, debug: () => {} };

function validSlab(overrides = {}) {
  return {
    tenure_text: '7 days to 14 days',
    tenure_min_days: 7,
    tenure_max_days: 14,
    rate_general_pct: 3.5,
    rate_senior_pct: 4.0,
    rate_super_senior_pct: null,
    ...overrides,
  };
}

function validPayload(bank_code, variant, overrides = {}) {
  return {
    bank_code,
    bank_name: 'Test Bank Limited',
    product_type: 'FD',
    variant,
    effective_date: '2026-05-15',
    source_url: 'https://test.bank.in/rates',
    scraped_at: '2026-05-15T00:00:00Z',
    extraction_confidence: 'high',
    rate_slabs: [validSlab(), validSlab({ tenure_text: '15 days to 30 days', tenure_min_days: 15, tenure_max_days: 30, rate_general_pct: 4.0, rate_senior_pct: 4.5 })],
    special_schemes: [],
    warnings: [],
    errors: [],
    ...overrides,
  };
}

// ── Filename helper ────────────────────────────────────────────────────

test('ratesFilenameFor: regular uses bare _rates suffix', () => {
  assert.equal(ratesFilenameFor('state-bank-of-india', 'regular'), 'state-bank-of-india_rates.json');
});

test('ratesFilenameFor: nre/nro/fcnr/gift include variant suffix', () => {
  assert.equal(ratesFilenameFor('hdfc-bank-limited', 'nre'), 'hdfc-bank-limited_nre_rates.json');
  assert.equal(ratesFilenameFor('hdfc-bank-limited', 'nro'), 'hdfc-bank-limited_nro_rates.json');
  assert.equal(ratesFilenameFor('hdfc-bank-limited', 'fcnr'), 'hdfc-bank-limited_fcnr_rates.json');
  assert.equal(ratesFilenameFor('hdfc-bank-limited', 'gift'), 'hdfc-bank-limited_gift_rates.json');
});

// ── Happy path ─────────────────────────────────────────────────────────

test('happy path: valid payload writes to <bank_code>_rates.json via safe-write', async () => {
  const output_dir = makeDir();
  const result = await commitRates({
    bank_code: 'test-bank',
    variant: 'regular',
    payload: validPayload('test-bank', 'regular'),
    extraction_method: 'automatic_html_static',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.equal(result.deferred_to_pending, false);
  assert.equal(result.validation.passed, true);
  assert.equal(result.validation.critical_count, 0);
  // File exists with expected payload
  const written = JSON.parse(fs.readFileSync(path.join(output_dir, 'test-bank_rates.json'), 'utf-8'));
  assert.equal(written.bank_code, 'test-bank');
  assert.equal(written.extraction_method, 'automatic_html_static');
  assert.equal(written.rate_slabs.length, 2);
});

test('happy path: variant=nre lands in <code>_nre_rates.json', async () => {
  const output_dir = makeDir();
  const result = await commitRates({
    bank_code: 'test-bank',
    variant: 'nre',
    payload: validPayload('test-bank', 'nre', { effective_date: '2026-05-15' }),
    extraction_method: 'automatic_html_static',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.ok(fs.existsSync(path.join(output_dir, 'test-bank_nre_rates.json')));
  assert.ok(!fs.existsSync(path.join(output_dir, 'test-bank_rates.json')));
});

// ── Slug discipline ────────────────────────────────────────────────────

test('slug mismatch: payload.bank_code differs from input.bank_code → ok:false slug_mismatch', async () => {
  const output_dir = makeDir();
  const result = await commitRates({
    bank_code: 'state-bank-of-india',
    variant: 'regular',
    payload: validPayload('sbi-the-wrong-slug', 'regular'),
    extraction_method: 'automatic_html_static',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_class, 'slug_mismatch');
  assert.deepEqual(result.log_entry.mismatched_fields, ['bank_code']);
  assert.equal(result.log_entry.bank_code_expected, 'state-bank-of-india');
  assert.equal(result.log_entry.bank_code_received, 'sbi-the-wrong-slug');
  // No file written
  assert.equal(fs.existsSync(path.join(output_dir, 'state-bank-of-india_rates.json')), false);
});

test('non-canonical input.bank_code throws (caller bug)', async () => {
  const output_dir = makeDir();
  await assert.rejects(
    commitRates({
      bank_code: 'State Bank of India', // not canonical
      variant: 'regular',
      payload: validPayload('State Bank of India', 'regular'),
      extraction_method: 'automatic_html_static',
      output_dir,
    }),
    /not canonical/,
  );
});

// ── Validation gate (closes deferred A1) ──────────────────────────────

test('validation failure: tenure_min > tenure_max → wrote:false, validation report populated', async () => {
  const output_dir = makeDir();
  const payload = validPayload('test-bank', 'regular');
  payload.rate_slabs[0].tenure_min_days = 500;
  payload.rate_slabs[0].tenure_max_days = 100; // < min, triggers errors[]
  const result = await commitRates({
    bank_code: 'test-bank',
    variant: 'regular',
    payload,
    extraction_method: 'automatic_html_static',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, false);
  assert.equal(result.validation.passed, false);
  assert.ok(result.validation.critical_count > 0, 'at least one critical flag');
  // No canonical file written
  assert.equal(fs.existsSync(path.join(output_dir, 'test-bank_rates.json')), false);
});

test('validation failure with rejected_dir: rejected payload + validation captured', async () => {
  const output_dir = makeDir();
  const rejected_dir = path.join(makeDir(), '_rejected');
  const payload = validPayload('test-bank', 'regular');
  payload.rate_slabs[0].tenure_min_days = 500;
  payload.rate_slabs[0].tenure_max_days = 100;
  const result = await commitRates({
    bank_code: 'test-bank',
    variant: 'regular',
    payload,
    extraction_method: 'automatic_html_static',
    output_dir,
    rejected_dir,
    logger: silentLogger,
  });
  assert.equal(result.wrote, false);
  assert.ok(result.rejected_path, 'rejected_path returned');
  const rejected = JSON.parse(fs.readFileSync(result.rejected_path, 'utf-8'));
  assert.equal(rejected.bank_code, 'test-bank');
  assert.equal(rejected.variant, 'regular');
  assert.equal(rejected.validation.passed, false);
  assert.ok(Array.isArray(rejected.validation.flags));
  assert.ok(rejected.payload, 'full payload preserved for tracking');
});

// ── Warnings (non-critical) embedded into written JSON ─────────────────

test('warnings only (non-critical): writes the file AND embeds validation block', async () => {
  const output_dir = makeDir();
  const payload = validPayload('test-bank', 'regular');
  // rate_general_pct 15% is above ceiling (9.5%) → produces a warning, no error
  payload.rate_slabs[0].rate_general_pct = 15.0;
  const result = await commitRates({
    bank_code: 'test-bank',
    variant: 'regular',
    payload,
    extraction_method: 'automatic_html_static',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.wrote, true);
  assert.equal(result.validation.passed, true); // valid = no critical errors
  assert.ok(result.validation.warning_count > 0);
  const written = JSON.parse(fs.readFileSync(path.join(output_dir, 'test-bank_rates.json'), 'utf-8'));
  assert.ok(written.validation, 'validation block embedded');
  assert.ok(written.validation.warning_count > 0);
});

// ── Curated target preservation (safe-write integration) ──────────────

test('curated target: existing manual_image_transcription routes to .pending.json', async () => {
  const output_dir = makeDir();
  const targetPath = path.join(output_dir, 'test-bank_rates.json');
  // Pre-populate with a curated artifact
  fs.writeFileSync(targetPath, JSON.stringify({
    bank_code: 'test-bank',
    extraction_method: 'manual_image_transcription',
    rate_slabs: [validSlab()],
  }, null, 2));

  const result = await commitRates({
    bank_code: 'test-bank',
    variant: 'regular',
    payload: validPayload('test-bank', 'regular'),
    extraction_method: 'automatic_html_static',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.wrote, false);
  assert.equal(result.deferred_to_pending, true);
  assert.ok(result.pending_path && result.pending_path.endsWith('.pending.json'));
  // Canonical untouched
  const stillCurated = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  assert.equal(stillCurated.extraction_method, 'manual_image_transcription');
});

// ── Input contract violations ──────────────────────────────────────────

test('throws on missing bank_code', async () => {
  await assert.rejects(
    commitRates({ variant: 'regular', payload: {}, extraction_method: 'automatic_html_static', output_dir: makeDir() }),
    /bank_code is required/,
  );
});

test('throws on invalid variant', async () => {
  await assert.rejects(
    commitRates({ bank_code: 'x', variant: 'bogus', payload: {}, extraction_method: 'automatic_html_static', output_dir: makeDir() }),
    /variant must be one of/,
  );
});

test('accepts custom_parser extraction_method (e.g. custom_parser_saraswat)', async () => {
  const output_dir = makeDir();
  const payload = validPayload('saraswat-co-operative-bank-ltd', 'regular');
  const result = await commitRates({
    bank_code: 'saraswat-co-operative-bank-ltd',
    variant: 'regular',
    payload,
    extraction_method: 'custom_parser_saraswat',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
});

test('throws on disallowed extraction_method', async () => {
  await assert.rejects(
    commitRates({ bank_code: 'x', variant: 'regular', payload: validPayload('x', 'regular'), extraction_method: 'fictional_method', output_dir: makeDir() }),
    /ALLOWED_EXTRACTION_METHODS/,
  );
});

test('throws on missing output_dir', async () => {
  await assert.rejects(
    commitRates({ bank_code: 'x', variant: 'regular', payload: validPayload('x', 'regular'), extraction_method: 'automatic_html_static' }),
    /output_dir is required/,
  );
});

// ── FCNR currency-aware integration ────────────────────────────────────

test('FCNR variant: per-slab currency field accepted', async () => {
  const output_dir = makeDir();
  const payload = validPayload('test-bank', 'fcnr', {
    rate_slabs: [
      { tenure_text: '1 Year to less than 2 Years', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: 4.5, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'USD' },
      { tenure_text: '1 Year to less than 2 Years', tenure_min_days: 365, tenure_max_days: 729, rate_general_pct: 3.0, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'GBP' },
    ],
  });
  const result = await commitRates({
    bank_code: 'test-bank',
    variant: 'fcnr',
    payload,
    extraction_method: 'automatic_html_static',
    output_dir,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  const written = JSON.parse(fs.readFileSync(path.join(output_dir, 'test-bank_fcnr_rates.json'), 'utf-8'));
  assert.equal(written.rate_slabs.length, 2);
  assert.equal(written.rate_slabs[0].currency, 'USD');
  assert.equal(written.rate_slabs[1].currency, 'GBP');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inspectExtractionOutput,
  isZeroSlabFailure,
} = require('../../lib/extraction-inspector');

// Each test creates its own tmp dir so the suite is parallel-safe and
// doesn't touch real output/latest/ ([[feedback_preserve_scraped_artifacts]]).
function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-inspector-'));
}

function writeRates(dir, bankCode, variant, body) {
  const file = path.join(dir, `${bankCode}${variant}_rates.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
}

function writeSummary(dir, bankCode, body, { retry = false } = {}) {
  const name = retry ? `${bankCode}_attempt2.summary.json` : `${bankCode}.summary.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2));
}

test('inspectExtractionOutput', async (t) => {
  await t.test('sums slabs across bare + every variant', () => {
    const dir = makeTmp();
    writeRates(dir, 'hdfc-bank-limited', '', {
      rate_slabs: new Array(34).fill({ tenure_min_days: 7 }),
      extraction_confidence: 'high',
    });
    writeRates(dir, 'hdfc-bank-limited', '_nre', { rate_slabs: new Array(10).fill({}) });
    writeRates(dir, 'hdfc-bank-limited', '_nro', { rate_slabs: new Array(10).fill({}) });
    writeRates(dir, 'hdfc-bank-limited', '_fcnr', { rate_slabs: new Array(8).fill({}) });

    const out = inspectExtractionOutput('hdfc-bank-limited', dir);
    assert.strictEqual(out.totalSlabs, 62);
    assert.strictEqual(out.filesPresent, 4);
    assert.strictEqual(out.bareConfidence, 'high');
  });

  await t.test('lowercases bareConfidence', () => {
    const dir = makeTmp();
    writeRates(dir, 'foo', '', { rate_slabs: [], extraction_confidence: 'NONE' });
    const out = inspectExtractionOutput('foo', dir);
    assert.strictEqual(out.bareConfidence, 'none');
  });

  await t.test('detects HDFC-style zero-slab-with-confidence-none', () => {
    const dir = makeTmp();
    writeRates(dir, 'hdfc-bank-limited', '', { rate_slabs: [], extraction_confidence: 'none' });
    writeRates(dir, 'hdfc-bank-limited', '_nre', { rate_slabs: [] });
    writeRates(dir, 'hdfc-bank-limited', '_nro', { rate_slabs: [] });
    writeRates(dir, 'hdfc-bank-limited', '_fcnr', { rate_slabs: [] });
    writeSummary(dir, 'hdfc-bank-limited', { failure_class: 'extraction_failed' });

    const out = inspectExtractionOutput('hdfc-bank-limited', dir);
    assert.strictEqual(out.totalSlabs, 0);
    assert.strictEqual(out.bareConfidence, 'none');
    assert.strictEqual(out.failureClass, 'extraction_failed');
    assert.strictEqual(isZeroSlabFailure(out), true);
  });

  await t.test('prefers the retry summary when both exist', () => {
    const dir = makeTmp();
    writeSummary(dir, 'foo', { failure_class: 'extraction_failed' });
    writeSummary(dir, 'foo', { failure_class: 'success' }, { retry: true });
    const out = inspectExtractionOutput('foo', dir);
    assert.strictEqual(out.failureClass, 'success');
  });

  await t.test('returns zero/null when no files exist', () => {
    const dir = makeTmp();
    const out = inspectExtractionOutput('ghost-bank', dir);
    assert.deepStrictEqual(out, {
      totalSlabs: 0,
      bareConfidence: null,
      failureClass: null,
      filesPresent: 0,
      bareExtractionMethod: null,
    });
  });

  await t.test('ignores malformed rate files without throwing', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'foo_rates.json'), '{not json');
    const out = inspectExtractionOutput('foo', dir);
    assert.strictEqual(out.filesPresent, 1);
    assert.strictEqual(out.totalSlabs, 0);
    assert.strictEqual(out.bareConfidence, null);
  });
});

test('isZeroSlabFailure', async (t) => {
  await t.test('true when files present, zero slabs, confidence none, not no_rates_expected', () => {
    assert.strictEqual(
      isZeroSlabFailure({ totalSlabs: 0, bareConfidence: 'none', failureClass: 'extraction_failed', filesPresent: 3 }),
      true,
    );
  });

  await t.test('false when slabs > 0 (successful extraction)', () => {
    assert.strictEqual(
      isZeroSlabFailure({ totalSlabs: 34, bareConfidence: 'high', failureClass: 'success', filesPresent: 1 }),
      false,
    );
  });

  await t.test('false when confidence is medium/low/high even with zero slabs', () => {
    // The doc's rule is intentionally strict — only `none` qualifies.
    assert.strictEqual(
      isZeroSlabFailure({ totalSlabs: 0, bareConfidence: 'low', failureClass: 'partial_success', filesPresent: 1 }),
      false,
    );
  });

  await t.test('false for legitimate no-FD banks (Payments Banks)', () => {
    assert.strictEqual(
      isZeroSlabFailure({ totalSlabs: 0, bareConfidence: 'none', failureClass: 'no_rates_expected', filesPresent: 0 }),
      false,
    );
  });

  await t.test('false when no rate files were produced at all', () => {
    // Different failure mode (discovery_failed / agent_error). Those should
    // surface through their own signals (nonzero exit, summary class), not
    // get conflated with zero-slab extraction.
    assert.strictEqual(
      isZeroSlabFailure({ totalSlabs: 0, bareConfidence: null, failureClass: 'discovery_failed', filesPresent: 0 }),
      false,
    );
  });

  // Sprint 009 Phase 9.2 (2026-06-05): skip-source carve-out.
  await t.test('false when bare file is registry_skip (tier-router synthetic skip)', () => {
    // Axis/Kotak/Equitas pattern: bank skipped via tier-router, synthetic
    // bare rate file written with method=registry_skip and conf=none.
    // The bank's real (curated/curated-elsewhere) data is preserved
    // separately — this is not an extraction failure.
    assert.strictEqual(
      isZeroSlabFailure({
        totalSlabs: 0,
        bareConfidence: 'none',
        failureClass: null,
        filesPresent: 1,
        bareExtractionMethod: 'registry_skip',
      }),
      false,
    );
  });

  await t.test('false when bare file is manual_transcription_from_rendered_text', () => {
    // Operator-curated rate file with hand-transcribed slabs.
    // Even if the slab count came back as 0 in this run (unlikely but
    // possible if the curated data was emptied for some reason), the
    // file's curated status means the operator owns it — don't reclassify.
    assert.strictEqual(
      isZeroSlabFailure({
        totalSlabs: 0,
        bareConfidence: 'none',
        failureClass: null,
        filesPresent: 1,
        bareExtractionMethod: 'manual_transcription_from_rendered_text',
      }),
      false,
    );
  });

  await t.test('true when bare file is automatic_html_static + zero slabs (regression guard)', () => {
    // Make sure the carve-out only triggers for known-skip methods — a
    // legitimate auto-extraction that produced 0 slabs still flags.
    assert.strictEqual(
      isZeroSlabFailure({
        totalSlabs: 0,
        bareConfidence: 'none',
        failureClass: null,
        filesPresent: 1,
        bareExtractionMethod: 'automatic_html_static',
      }),
      true,
    );
  });

  await t.test('end-to-end via tmp dir: bare with registry_skip method does not flag', () => {
    const dir = makeTmp();
    writeRates(dir, 'fake-bank', '', {
      bank_code: 'fake-bank',
      product_type: 'FD',
      variant: 'regular',
      extraction_method: 'registry_skip',
      extraction_confidence: 'none',
      rate_slabs: [],
    });
    const out = inspectExtractionOutput('fake-bank', dir);
    assert.strictEqual(out.bareExtractionMethod, 'registry_skip');
    assert.strictEqual(isZeroSlabFailure(out), false);
  });
});

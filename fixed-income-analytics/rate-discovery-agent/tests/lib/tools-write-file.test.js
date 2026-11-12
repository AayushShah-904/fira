'use strict';

/**
 * Tests for the `write_file` tool exposed by lib/tools.js — verifies the
 * ADR-012 safe-write migration:
 *
 *   1. Per-bank artifacts (config / rates / summary) route through
 *      safeWriteArtifact, which means curated targets are preserved and
 *      the incoming write is deferred to a `<path>.pending.json` sidecar.
 *   2. Non-per-bank JSON paths (aggregator/batch outputs, ad-hoc files)
 *      fall through to a direct fs.writeFileSync — ADR-012 explicitly
 *      excludes these.
 *   3. The registry file (`data/bank-domains.json`) is REJECTED outright;
 *      the LLM must go through updateDomainEntry's merge flow instead.
 *   4. Writing onto a curated target returns a `deferred_to_pending`
 *      JSON response the LLM can parse and act on.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { executeTool, inferArtifactKind } = require('../../lib/tools');

const tmpDirs = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-write-file-'));
  tmpDirs.push(root);
  const outputDir = path.join(root, 'output', 'latest');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return { projectRoot: root, outputDir };
}

const silentLogger = { warn: () => {}, info: () => {} };

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

// ── Helper: filename → kind mapping ────────────────────────────────

test('inferArtifactKind maps per-bank artifact filenames to safe-write kinds', () => {
  assert.equal(inferArtifactKind('foo_config.json'), 'config');
  assert.equal(inferArtifactKind('foo_rates.json'), 'rates');
  assert.equal(inferArtifactKind('foo_nre_rates.json'), 'rates');
  assert.equal(inferArtifactKind('foo_fcnr_rates.json'), 'rates');
  assert.equal(inferArtifactKind('foo_gift_rates.json'), 'rates');
  assert.equal(inferArtifactKind('foo.summary.json'), 'summary');
  assert.equal(inferArtifactKind('foo_attempt2.summary.json'), 'summary');

  // Non-per-bank / aggregator outputs → null (passthrough to direct fs)
  assert.equal(inferArtifactKind('_batch_results_2026-05-09.json'), null);
  assert.equal(inferArtifactKind('_run_analysis.json'), null);
  assert.equal(inferArtifactKind('_bank_index.json'), null);
  assert.equal(inferArtifactKind('_sample.json'), null);
  assert.equal(inferArtifactKind('arbitrary.json'), null);
});

// ── Per-bank artifact routes through safe-write ────────────────────

test('write_file: per-bank config goes through safe-write (atomic temp+rename)', async () => {
  const { projectRoot, outputDir } = makeProject();
  const payload = JSON.stringify({
    bank_code: 'test-bank',
    bank_name: 'Test Bank',
    extraction_method: 'llm_inline_extraction',
  });

  const raw = await executeTool(
    'write_file',
    { file_path: 'test-bank_config.json', content: payload },
    { projectRoot, outputDir, logger: silentLogger },
  );

  assert.match(raw, /Wrote \d+ bytes to test-bank_config\.json/);

  const target = path.join(outputDir, 'test-bank_config.json');
  assert.ok(fs.existsSync(target));
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.bank_code, 'test-bank');
  assert.equal(written.extraction_method, 'llm_inline_extraction');
});

test('write_file: per-bank rates lacking extraction_method is lazy-tagged by safe-write', async () => {
  const { projectRoot, outputDir } = makeProject();
  const payload = JSON.stringify({
    bank_code: 'untagged-bank',
    product_type: 'FD',
    variant: 'regular',
    rate_slabs: [],
  });

  await executeTool(
    'write_file',
    { file_path: 'untagged-bank_rates.json', content: payload },
    { projectRoot, outputDir, logger: silentLogger },
  );

  const target = path.join(outputDir, 'untagged-bank_rates.json');
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  // safe-write should have lazy-tagged this with the default
  assert.equal(written.extraction_method, 'llm_inline_extraction');
});

// ── Non-per-bank artifact uses direct fs.writeFileSync ─────────────

test('write_file: aggregator/batch JSON path bypasses safe-write (direct fs)', async () => {
  const { projectRoot, outputDir } = makeProject();

  // Pre-place a "curated" artifact at the SAME directory under a different
  // name. The aggregator-path write should succeed unconditionally — it's
  // a different file entirely, and safe-write has nothing to say about it.
  const raw = await executeTool(
    'write_file',
    {
      file_path: '_batch_results_2026-05-09.json',
      content: JSON.stringify({ batch: 'results', n: 17 }),
    },
    { projectRoot, outputDir, logger: silentLogger },
  );

  assert.match(raw, /Wrote \d+ bytes to _batch_results_2026-05-09\.json/);

  const target = path.join(outputDir, '_batch_results_2026-05-09.json');
  assert.ok(fs.existsSync(target));
  // Aggregator path goes through plain fs.writeFileSync — no extraction_method
  // tagging, no temp-rename atomic write semantics required.
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.batch, 'results');
  assert.equal(written.n, 17);
  assert.equal(written.extraction_method, undefined);
});

// ── Registry file write is REJECTED ────────────────────────────────

test('write_file: writing data/bank-domains.json is rejected outright', async () => {
  const { projectRoot, outputDir } = makeProject();

  // The tool resolves file_path against outputDir, so to hit data/ we have
  // to climb out via a relative path. This mirrors what a misguided LLM
  // call would look like.
  const escape = path.relative(outputDir, path.join(projectRoot, 'data', 'bank-domains.json'));
  const raw = await executeTool(
    'write_file',
    { file_path: escape, content: '{"hacked": true}' },
    { projectRoot, outputDir, logger: silentLogger },
  );

  const parsed = JSON.parse(raw);
  // Either rejected by the data-path guard or by the outputDir security
  // guard (depending on path normalization). Both are acceptable rejections.
  assert.ok(parsed.error, `expected error, got ${raw}`);

  // Either way: the file MUST NOT exist on disk.
  const target = path.join(projectRoot, 'data', 'bank-domains.json');
  assert.equal(fs.existsSync(target), false);
});

test('write_file: explicit data/bank-domains.json resolution is rejected with registry-specific error', async () => {
  const { projectRoot, outputDir } = makeProject();

  // Bypass the relative-path escape: pass an absolute target by configuring
  // outputDir to coincide with data/. This is a contrived case but it
  // exercises the data/bank-domains.json check directly.
  const dataDir = path.join(projectRoot, 'data');
  const raw = await executeTool(
    'write_file',
    { file_path: 'bank-domains.json', content: '{"hacked": true}' },
    { projectRoot, outputDir: dataDir, logger: silentLogger },
  );

  const parsed = JSON.parse(raw);
  assert.ok(parsed.error);
  assert.match(parsed.error, /registry|updateDomainEntry/i);
  assert.equal(fs.existsSync(path.join(dataDir, 'bank-domains.json')), false);
});

// ── Curated-target write returns deferred_to_pending ───────────────

test('write_file: curated target preserves existing and routes write to pending sidecar', async () => {
  const { projectRoot, outputDir } = makeProject();

  // Seed a curated rates file (extraction_method = manual_image_transcription).
  const target = path.join(outputDir, 'curated-bank_rates.json');
  const curated = {
    bank_code: 'curated-bank',
    bank_name: 'Curated Bank',
    product_type: 'FD',
    variant: 'regular',
    extraction_method: 'manual_image_transcription',
    rate_slabs: [
      { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 7.5 },
    ],
  };
  fs.writeFileSync(target, JSON.stringify(curated, null, 2));

  // Agent now tries to overwrite with an auto-extracted 0-slab file (the
  // classic regression from Sprint 002 Phase B — Angul's lost transcription).
  const incoming = JSON.stringify({
    bank_code: 'curated-bank',
    bank_name: 'Curated Bank',
    product_type: 'FD',
    variant: 'regular',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: [],
    warnings: ['extraction failed'],
  });

  const raw = await executeTool(
    'write_file',
    { file_path: 'curated-bank_rates.json', content: incoming },
    { projectRoot, outputDir, logger: silentLogger },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.deferred_to_pending, true);
  assert.ok(parsed.pending_path);
  assert.match(parsed.note, /operator-curated|pending/i);

  // Curated file UNCHANGED.
  const stillThere = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(stillThere.extraction_method, 'manual_image_transcription');
  assert.equal(stillThere.rate_slabs.length, 1);

  // Pending sidecar carries the incoming.
  const pending = JSON.parse(fs.readFileSync(parsed.pending_path, 'utf-8'));
  assert.equal(pending.extraction_method, 'llm_inline_extraction');
  assert.equal(pending.rate_slabs.length, 0);
});

test('write_file: variant-naming guardrail redirects fcnr/gift/nre/nro payload to suffixed filename (no const-reassignment crash)', async () => {
  // Regression guard for the bug introduced in e357f48: the guardrail at
  // lib/tools.js mutated a `const`-declared `resolved` → "Assignment to
  // constant variable", silently swallowing the entire write. IDBI-IBU GIFT
  // 48→0 in cohort #3 traced back to this. Fix: declare `resolved` with
  // `let`. This test exercises the guardrail's redirect path end-to-end and
  // asserts the file lands at the variant-suffixed name.
  const { projectRoot, outputDir } = makeProject();
  const payload = JSON.stringify({
    bank_code: 'idbi-bank-ibu',
    product_type: 'FD',
    variant: 'gift',
    rate_slabs: [{ tenure_text: '1 year', rate_general_pct: 4.5, currency: 'USD' }],
  });

  // Caller writes to the wrong filename (the bare `_rates.json`); the
  // guardrail should redirect to `_gift_rates.json`.
  const raw = await executeTool(
    'write_file',
    { file_path: 'idbi-bank-ibu_rates.json', content: payload },
    { projectRoot, outputDir, logger: silentLogger },
  );

  // Tolerate either a success string or a deferred-to-pending JSON (both
  // indicate the write succeeded without crashing on `const`-reassign).
  assert.ok(typeof raw === 'string' && raw.length > 0);
  assert.doesNotMatch(raw, /Assignment to constant variable/);
  // The redirected file lands at the suffixed name.
  const expected = path.join(outputDir, 'idbi-bank-ibu_gift_rates.json');
  assert.ok(fs.existsSync(expected), 'guardrail redirected to _gift_rates.json');
  // The bare filename was NOT written.
  const wrong = path.join(outputDir, 'idbi-bank-ibu_rates.json');
  assert.ok(!fs.existsSync(wrong), 'wrong-name file was not written');
});

test('write_file: per-run dir (output/runs/<label>/) also routes through safe-write', async () => {
  const { projectRoot } = makeProject();
  // Per-run dir as outputDir, not output/latest/
  const runDir = path.join(projectRoot, 'output', 'runs', '2026-05-09-test');
  fs.mkdirSync(runDir, { recursive: true });

  // Seed curated rates inside the run dir
  const target = path.join(runDir, 'curated-bank_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'curated-bank',
    extraction_method: 'manual_pdf_transcription',
    rate_slabs: [{ tenure_text: '3y', rate_general_pct: 8.0 }],
  }, null, 2));

  const raw = await executeTool(
    'write_file',
    {
      file_path: 'curated-bank_rates.json',
      content: JSON.stringify({
        bank_code: 'curated-bank',
        extraction_method: 'llm_inline_extraction',
        rate_slabs: [],
      }),
    },
    { projectRoot, outputDir: runDir, logger: silentLogger },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.deferred_to_pending, true);
  // Curated artifact in run dir survives
  const survived = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(survived.extraction_method, 'manual_pdf_transcription');
});

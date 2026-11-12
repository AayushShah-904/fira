'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMerger, mergeOneBank, RATE_FILE_VARIANTS } = require('../../../lib/merge/run-merger');

function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-merger-'));
  fs.mkdirSync(path.join(root, 'output', 'latest'), { recursive: true });
  fs.mkdirSync(path.join(root, 'output', 'runs'), { recursive: true });
  return root;
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function ratesArtifact({ bankCode = 'foo', slabCount = 10, variant = 'regular', extraction_method = 'llm_inline_extraction', extraction_confidence = 'medium', scraped_at = '2026-06-04T10:00:00Z' } = {}) {
  return {
    bank_code: bankCode,
    product_type: 'FD',
    variant,
    source_url: `https://${variant}.${bankCode}.in/fd`,
    extraction_method,
    extraction_confidence,
    scraped_at,
    effective_date: '2026-06-04',
    rate_slabs: Array.from({ length: slabCount }, (_, i) => ({ tenure_text: `slab-${i}`, tenure_min_days: i + 1, tenure_max_days: i + 10, rate_general_pct: 7.0 + i * 0.05 })),
    warnings: [],
  };
}

function setupCloudRun(root, label, perBank) {
  const dir = path.join(root, 'output', 'runs', label);
  for (const [bankCode, files] of Object.entries(perBank)) {
    for (const [filename, payload] of Object.entries(files)) {
      writeJson(path.join(dir, `${bankCode}${filename}`), payload);
    }
  }
}

test('mergeOneBank', async (t) => {
  await t.test('writes a merged bare-rates file when both sides present', () => {
    const root = makeProjectRoot();
    const cloudDir = path.join(root, 'output', 'runs', 'cloud-1');
    const localDir = path.join(root, 'output', 'runs', 'local-1');
    writeJson(path.join(cloudDir, 'foo_rates.json'), ratesArtifact({ slabCount: 8 }));
    writeJson(path.join(localDir, 'foo_rates.json'), ratesArtifact({ slabCount: 15, extraction_method: 'manual_image_transcription' }));

    const r = mergeOneBank({
      bankCode: 'foo',
      cloudRunDir: cloudDir,
      localRunDir: localDir,
      cloudRunId: 'cloud-1',
      localRunId: 'local-1',
      latestDir: path.join(root, 'output', 'latest'),
    });

    assert.strictEqual(r.written, 1);
    assert.strictEqual(r.deferred, 0);
    const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'foo_rates.json'), 'utf-8'));
    assert.strictEqual(merged.rate_slabs.length, 15, 'richer-set wins');
    assert.strictEqual(merged.extraction_method, 'manual_image_transcription', 'local wins on curated');
    assert.ok(Array.isArray(merged.source_runs), 'source_runs attached');
    assert.strictEqual(merged.source_runs.length, 2);
  });

  await t.test('cloud-only bank: copies cloud artifact with cloud-only provenance', () => {
    const root = makeProjectRoot();
    const cloudDir = path.join(root, 'output', 'runs', 'cloud-2');
    writeJson(path.join(cloudDir, 'cloudonly_rates.json'), ratesArtifact({ bankCode: 'cloudonly', slabCount: 12 }));

    const r = mergeOneBank({
      bankCode: 'cloudonly',
      cloudRunDir: cloudDir,
      localRunDir: null,
      cloudRunId: 'cloud-2',
      localRunId: null,
      latestDir: path.join(root, 'output', 'latest'),
    });

    assert.strictEqual(r.written, 1);
    const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'cloudonly_rates.json'), 'utf-8'));
    assert.strictEqual(merged.rate_slabs.length, 12);
    assert.strictEqual(merged.source_runs.length, 1);
    assert.strictEqual(merged.source_runs[0].source, 'cloud');
  });

  await t.test('merges multiple variants per bank', () => {
    const root = makeProjectRoot();
    const cloudDir = path.join(root, 'output', 'runs', 'cloud-3');
    const localDir = path.join(root, 'output', 'runs', 'local-3');
    for (const v of ['', '_nre', '_nro']) {
      writeJson(path.join(cloudDir, `multi${v}_rates.json`), ratesArtifact({ bankCode: 'multi', variant: v || 'regular', slabCount: 5 }));
      writeJson(path.join(localDir, `multi${v}_rates.json`), ratesArtifact({ bankCode: 'multi', variant: v || 'regular', slabCount: 10 }));
    }
    const r = mergeOneBank({
      bankCode: 'multi',
      cloudRunDir: cloudDir, localRunDir: localDir,
      cloudRunId: 'c', localRunId: 'l',
      latestDir: path.join(root, 'output', 'latest'),
    });
    assert.strictEqual(r.written, 3);
    assert.strictEqual(r.variants.length, 3);
    for (const v of ['', '_nre', '_nro']) {
      const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', `multi${v}_rates.json`), 'utf-8'));
      assert.strictEqual(merged.rate_slabs.length, 10, `local wins for variant ${v || 'bare'}`);
    }
  });

  await t.test('merges config file too', () => {
    const root = makeProjectRoot();
    const cloudDir = path.join(root, 'output', 'runs', 'cloud-4');
    const localDir = path.join(root, 'output', 'runs', 'local-4');
    writeJson(path.join(cloudDir, 'foo_config.json'), { bank_code: 'foo', website: 'https://cloud-url.in', extraction_method: 'llm_inline_extraction' });
    writeJson(path.join(localDir, 'foo_config.json'), { bank_code: 'foo', website: 'https://local-url.in', extraction_method: 'manual_image_transcription' });
    const r = mergeOneBank({
      bankCode: 'foo',
      cloudRunDir: cloudDir, localRunDir: localDir,
      cloudRunId: 'c', localRunId: 'l',
      latestDir: path.join(root, 'output', 'latest'),
    });
    assert.strictEqual(r.written, 1); // just the config (no rates files in this fixture)
    const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'foo_config.json'), 'utf-8'));
    assert.strictEqual(merged.website, 'https://local-url.in', 'local wins on default fields');
    assert.strictEqual(merged.extraction_method, 'manual_image_transcription');
  });

  await t.test('no inputs for any variant → 0 written', () => {
    const root = makeProjectRoot();
    const r = mergeOneBank({
      bankCode: 'ghost',
      cloudRunDir: null, localRunDir: null,
      cloudRunId: null, localRunId: null,
      latestDir: path.join(root, 'output', 'latest'),
    });
    assert.strictEqual(r.written, 0);
    assert.strictEqual(r.variants.length, 0);
  });

  await t.test('curated existing local rates → ADR-012 routes incoming to pending', () => {
    const root = makeProjectRoot();
    const latestDir = path.join(root, 'output', 'latest');
    // Plant a curated existing local artifact at output/latest.
    writeJson(path.join(latestDir, 'foo_rates.json'), {
      bank_code: 'foo',
      product_type: 'FD',
      variant: 'regular',
      extraction_method: 'manual_image_transcription', // curated → NOT auto-overwriteable
      rate_slabs: Array.from({ length: 20 }, (_, i) => ({ tenure_text: 's-' + i })),
    });

    // Cloud run wants to drop in 30 slabs but with llm_inline (auto).
    const cloudDir = path.join(root, 'output', 'runs', 'cloud-5');
    writeJson(path.join(cloudDir, 'foo_rates.json'), ratesArtifact({ slabCount: 30, extraction_method: 'llm_inline_extraction' }));

    const r = mergeOneBank({
      bankCode: 'foo',
      cloudRunDir: cloudDir,
      localRunDir: null, // pure cloud, but a curated local exists at output/latest/
      cloudRunId: 'c', localRunId: null,
      latestDir,
    });

    // ADR-012 routes to .pending.json — written counter at 0, deferred at 1
    assert.strictEqual(r.deferred, 1, 'merge deferred to .pending');
    assert.strictEqual(r.written, 0);
    assert.ok(fs.existsSync(path.join(latestDir, 'foo_rates.json.pending.json')));
    const curated = JSON.parse(fs.readFileSync(path.join(latestDir, 'foo_rates.json'), 'utf-8'));
    assert.strictEqual(curated.extraction_method, 'manual_image_transcription', 'curated artifact untouched');
  });
});

test('runMerger', async (t) => {
  await t.test('walks both sub-cohorts and merges every bank in either', () => {
    const root = makeProjectRoot();
    const cloudLabel = 'cloud-run-A';
    const localLabel = 'local-run-A';
    setupCloudRun(root, cloudLabel, {
      cloud_bank: { '_rates.json': ratesArtifact({ bankCode: 'cloud_bank', slabCount: 5 }) },
      both_bank:  { '_rates.json': ratesArtifact({ bankCode: 'both_bank', slabCount: 5 }) },
    });
    setupCloudRun(root, localLabel, {
      local_bank: { '_rates.json': ratesArtifact({ bankCode: 'local_bank', slabCount: 10 }) },
      both_bank:  { '_rates.json': ratesArtifact({ bankCode: 'both_bank', slabCount: 15 }) },
    });

    const { banks, summary } = runMerger({
      cloudCohort: [{ bank_code: 'cloud_bank' }, { bank_code: 'both_bank' }],
      localCohort: [{ bank_code: 'local_bank' }, { bank_code: 'both_bank' }],
      cloudRunLabel: cloudLabel,
      localRunLabel: localLabel,
      projectRoot: root,
    });

    assert.strictEqual(summary.total_banks, 3);
    assert.strictEqual(summary.files_written, 3);
    // cloud_bank file came from cloud only
    const cb = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'cloud_bank_rates.json'), 'utf-8'));
    assert.strictEqual(cb.source_runs[0].source, 'cloud');
    // local_bank file came from local only
    const lb = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'local_bank_rates.json'), 'utf-8'));
    assert.strictEqual(lb.source_runs[0].source, 'local');
    // both_bank: local (richer set) wins
    const bb = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'both_bank_rates.json'), 'utf-8'));
    assert.strictEqual(bb.rate_slabs.length, 15);
    assert.strictEqual(bb.source_runs.length, 2);
  });

  await t.test('handles a missing run dir gracefully (empty input)', () => {
    const root = makeProjectRoot();
    const { summary } = runMerger({
      cloudCohort: [{ bank_code: 'foo' }],
      localCohort: [],
      cloudRunLabel: 'nonexistent-run',
      localRunLabel: null,
      projectRoot: root,
    });
    assert.strictEqual(summary.total_banks, 1);
    assert.strictEqual(summary.files_written, 0);
    assert.strictEqual(summary.cloud_run_dir, null);
  });
});

test('RATE_FILE_VARIANTS', () => {
  // Mirror lib/extraction-inspector.js's set so merge stays aligned with
  // Phase 2.5's zero-slab classifier.
  assert.deepStrictEqual([...RATE_FILE_VARIANTS], ['', '_nre', '_nro', '_fcnr', '_gift']);
});

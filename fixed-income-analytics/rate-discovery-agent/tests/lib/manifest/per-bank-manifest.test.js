'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCHEMA_VERSION,
  buildManifest,
  buildSummary,
  classifyDelta,
  detectMethodDrift,
  detectTemplateDrift,
  writeManifest,
  loadManifest,
  listManifests,
  writeSummary,
} = require('../../../lib/manifest/per-bank-manifest');

// --- Test fixtures --------------------------------------------------------

const sampleFetchResult = {
  status: 'success',
  html: '<html>...</html>',
  attempts: [
    { rung: 'default', browser: 'chromium', outcome: 'success', status_code: 200, ms: 2100 },
  ],
  challenge_detected: null,
  final_strategy: 'default',
  iframe_traversed: false,
  ms: 2150,
};

const sampleExtractResult = {
  slabs: [
    { tenure_text: '1y', rate_general_pct: 6.5, source_row_text: '1y 6.5%' },
    { tenure_text: '2y', rate_general_pct: 6.75, source_row_text: '2y 6.75%' },
    { tenure_text: '3y', rate_general_pct: 7.0, source_row_text: '3y 7%' },
  ],
  warnings: [],
  diagnostics: { rows_seen: 5, rows_kept: 3, rows_dropped_reasons: { unparseable_tenure: 2 } },
};

const sampleDispatchResult = {
  template_id: 'coop-bankin-3col-tenure-general-senior',
  resolution: 'registry',
  needs_template_authoring: false,
  reason: 'matched template_id from registry',
};

// --- buildManifest --------------------------------------------------------

test('buildManifest: happy path populates all top-level fields', () => {
  const m = buildManifest({
    bank_code: 'apna-sahakari-bank-ltd',
    fetch_result: sampleFetchResult,
    extract_result: sampleExtractResult,
    dispatch_result: sampleDispatchResult,
  });
  assert.equal(m._schema_version, SCHEMA_VERSION);
  assert.equal(m.bank_code, 'apna-sahakari-bank-ltd');
  assert.ok(m.run_id);
  assert.ok(m.ts);
  assert.equal(m.fetch.fetcher, 'fetch_html');
  assert.equal(m.fetch.final_strategy, 'default');
  assert.equal(m.extract.template_id, 'coop-bankin-3col-tenure-general-senior');
  assert.equal(m.extract.rows_kept, 3);
  assert.equal(m.extract.rows_seen, 5);
  assert.equal(m.extract.fallback_engaged, null);
  assert.equal(m.baseline.current_slab_count, 3);
  assert.equal(m.baseline.status, 'NEW'); // no baseline_slabs passed
});

test('buildManifest: missing bank_code throws', () => {
  assert.throws(() => buildManifest({}), /bank_code is required/);
});

test('buildManifest: with baseline_slabs computes delta + status', () => {
  const m = buildManifest({
    bank_code: 'x',
    fetch_result: sampleFetchResult,
    extract_result: sampleExtractResult,           // 3 slabs
    dispatch_result: sampleDispatchResult,
    baseline_slabs: [{}, {}, {}],                  // 3 prior slabs → STABLE
  });
  assert.equal(m.baseline.prior_slab_count, 3);
  assert.equal(m.baseline.current_slab_count, 3);
  assert.equal(m.baseline.delta, 0);
  assert.equal(m.baseline.status, 'STABLE');
});

test('buildManifest: baseline shows REGRESSION when current < prior by >20%', () => {
  const m = buildManifest({
    bank_code: 'x',
    fetch_result: sampleFetchResult,
    extract_result: sampleExtractResult,           // 3 slabs
    dispatch_result: sampleDispatchResult,
    baseline_slabs: new Array(10).fill({}),        // 10 prior → -70% → REGRESSION
  });
  assert.equal(m.baseline.status, 'REGRESSION');
  assert.equal(m.baseline.delta, -7);
});

test('buildManifest: baseline shows GAIN when current > prior by >5% (but < 200%)', () => {
  const m = buildManifest({
    bank_code: 'x',
    fetch_result: sampleFetchResult,
    extract_result: sampleExtractResult,           // 3 slabs
    dispatch_result: sampleDispatchResult,
    baseline_slabs: [{}, {}],                      // 2 prior → +50% → GAIN
  });
  assert.equal(m.baseline.status, 'GAIN');
});

test('buildManifest: dispatch needs_template_authoring=true → warning surfaces it', () => {
  const m = buildManifest({
    bank_code: 'x',
    fetch_result: sampleFetchResult,
    extract_result: { slabs: [], warnings: [], diagnostics: {} },
    dispatch_result: {
      template_id: null,
      resolution: 'fallback-llm',
      needs_template_authoring: true,
      reason: 'no template_id',
    },
  });
  assert.equal(m.extract.needs_template_authoring, true);
  assert.equal(m.extract.fallback_engaged, 'llm');
  assert.ok(m.warnings.some(w => w.includes('needs_template_authoring')));
});

test('buildManifest: extract warnings containing llm_fallback → fallback_engaged=llm', () => {
  const m = buildManifest({
    bank_code: 'x',
    fetch_result: sampleFetchResult,
    extract_result: {
      slabs: [{ tenure_text: '1y', rate_general_pct: 6.5, source_row_text: '1y 6.5%' }],
      warnings: ['llm_fallback: deterministic returned 0 slabs; LLM extracted 1'],
      diagnostics: { rows_seen: 1, rows_kept: 1 },
    },
    dispatch_result: sampleDispatchResult,
  });
  assert.equal(m.extract.fallback_engaged, 'llm');
});

test('buildManifest: silent_drop warning when rows_seen > 0 but rows_kept == 0', () => {
  const m = buildManifest({
    bank_code: 'x',
    fetch_result: sampleFetchResult,
    extract_result: { slabs: [], warnings: [], diagnostics: { rows_seen: 7, rows_kept: 0 } },
    dispatch_result: sampleDispatchResult,
  });
  assert.ok(m.warnings.some(w => w.includes('silent_drop')));
});

test('buildManifest: fetch_pdf shape is detected and recorded correctly', () => {
  const m = buildManifest({
    bank_code: 'x',
    fetch_result: { method: 'doc_intelligence', pdfText: null, slabsPreview: 5, ms: 3500, fallback_reason: 'pdfjs_too_few_slabs: 1 < 3' },
    extract_result: sampleExtractResult,
    dispatch_result: sampleDispatchResult,
  });
  assert.equal(m.fetch.fetcher, 'fetch_pdf');
  assert.equal(m.fetch.final_strategy, 'doc_intelligence');
  assert.match(m.fetch.fallback_reason, /pdfjs_too_few_slabs/);
});

test('buildManifest: no fetch_result → fetch block is empty-shaped', () => {
  const m = buildManifest({
    bank_code: 'x',
    extract_result: sampleExtractResult,
  });
  assert.equal(m.fetch.fetcher, null);
  assert.deepEqual(m.fetch.attempts, []);
});

test('buildManifest: prior_manifest with different extraction_method → drift detected', () => {
  const prior = {
    extract: { extraction_method: 'automatic_template', template_id: 'coop-bankin-3col-tenure-general-senior' },
  };
  const m = buildManifest({
    bank_code: 'x',
    extract_result: { slabs: [], warnings: ['llm_fallback: ...'], diagnostics: {} },
    dispatch_result: { template_id: null, resolution: 'fallback-llm' },
    prior_manifest: prior,
  });
  assert.ok(m.drift.extraction_method_drift);
  assert.equal(m.drift.extraction_method_drift.from, 'automatic_template');
  assert.equal(m.drift.extraction_method_drift.to, 'llm_fallback');
});

test('buildManifest: prior_manifest with same method → no drift', () => {
  const prior = {
    extract: { extraction_method: 'automatic_template', template_id: 'coop-bankin-3col-tenure-general-senior' },
  };
  const m = buildManifest({
    bank_code: 'x',
    extract_result: sampleExtractResult,
    dispatch_result: sampleDispatchResult,
    prior_manifest: prior,
  });
  assert.equal(m.drift.extraction_method_drift, null);
});

// --- classifyDelta --------------------------------------------------------

test('classifyDelta: matrix', () => {
  assert.equal(classifyDelta({ current: 0, prior: 0 }).status, 'STABLE');
  assert.equal(classifyDelta({ current: 5, prior: 0 }).status, 'NEW');
  assert.equal(classifyDelta({ current: 0, prior: 5 }).status, 'REGRESSION');
  assert.equal(classifyDelta({ current: 3, prior: 10 }).status, 'REGRESSION'); // -70%
  assert.equal(classifyDelta({ current: 9, prior: 10 }).status, 'WARN');       // -10%
  assert.equal(classifyDelta({ current: 10, prior: 10 }).status, 'STABLE');    //   0%
  assert.equal(classifyDelta({ current: 11, prior: 10 }).status, 'GAIN');      // +10%
  assert.equal(classifyDelta({ current: 70, prior: 10 }).status, 'ANOMALY_GAIN'); // +600%
});

// --- detectMethodDrift / detectTemplateDrift -----------------------------

test('detectMethodDrift: same method → null', () => {
  assert.equal(
    detectMethodDrift({
      current: { extraction_method: 'automatic_template' },
      prior:   { extraction_method: 'automatic_template' },
    }),
    null,
  );
});

test('detectMethodDrift: different method → object with from/to', () => {
  const d = detectMethodDrift({
    current: { extraction_method: 'llm_fallback' },
    prior:   { extraction_method: 'automatic_template' },
  });
  assert.equal(d.from, 'automatic_template');
  assert.equal(d.to, 'llm_fallback');
});

test('detectTemplateDrift: template_id change → object', () => {
  const d = detectTemplateDrift({
    current: { template_id: 'coop-bankin-3col-tenure-general-senior' },
    prior:   { template_id: 'psb-pdf-rate-card-3col' },
  });
  assert.ok(d);
  assert.equal(d.from, 'psb-pdf-rate-card-3col');
});

// --- buildSummary --------------------------------------------------------

test('buildSummary aggregates across N manifests', () => {
  const manifests = [
    buildManifest({ bank_code: 'a', fetch_result: sampleFetchResult, extract_result: sampleExtractResult, dispatch_result: sampleDispatchResult, baseline_slabs: [{}, {}, {}] }),
    buildManifest({ bank_code: 'b', fetch_result: sampleFetchResult, extract_result: sampleExtractResult, dispatch_result: sampleDispatchResult, baseline_slabs: new Array(10).fill({}) }),
    buildManifest({ bank_code: 'c', fetch_result: sampleFetchResult, extract_result: { slabs: [], warnings: [], diagnostics: {} }, dispatch_result: { template_id: null, resolution: 'fallback-llm', needs_template_authoring: true } }),
  ];
  const s = buildSummary({ manifests });
  assert.equal(s.manifests_loaded, 3);
  // 'a' = 3 vs 3 → STABLE; 'b' = 3 vs 10 → REGRESSION; 'c' = 0 vs no-baseline → STABLE (per buildBaselineBlock)
  assert.equal(s.by_status.STABLE, 2);
  assert.equal(s.by_status.REGRESSION, 1);
  assert.equal(s.by_extractor['coop-bankin-3col-tenure-general-senior'], 2);
  assert.equal(s.by_fallback.deterministic, 2);
  assert.equal(s.by_fallback.fallback_llm, 1);
  assert.equal(s.by_fallback.needs_template_authoring, 1);
  assert.equal(s.deterministic_pct, 67);  // 2/3 = 67%
});

test('buildSummary handles empty input', () => {
  const s = buildSummary({ manifests: [] });
  assert.equal(s.manifests_loaded, 0);
  assert.equal(s.deterministic_pct, 0);
});

test('buildSummary counts challenge vendors + iframe + drift', () => {
  const manifests = [
    buildManifest({
      bank_code: 'a',
      fetch_result: { ...sampleFetchResult, challenge_detected: { vendor: 'cloudflare', signal: 'x' }, iframe_traversed: true, final_strategy: 'stealth' },
      extract_result: sampleExtractResult,
      dispatch_result: sampleDispatchResult,
      prior_manifest: { extract: { extraction_method: 'llm_fallback', template_id: 'old-id' } },
    }),
  ];
  const s = buildSummary({ manifests });
  assert.equal(s.by_challenge_vendor.cloudflare, 1);
  assert.equal(s.iframe_traversed_count, 1);
  assert.equal(s.method_drift_count, 1);
  assert.equal(s.template_drift_count, 1);
});

// --- IO -----

test('writeManifest + loadManifest + listManifests round-trip', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rda-manifest-test-'));
  try {
    const m = buildManifest({
      bank_code: 'test-bank',
      fetch_result: sampleFetchResult,
      extract_result: sampleExtractResult,
      dispatch_result: sampleDispatchResult,
    });
    const writtenPath = writeManifest({ manifest: m, outputDir: tmp });
    assert.ok(fs.existsSync(writtenPath));
    const loaded = loadManifest({ bank_code: 'test-bank', outputDir: tmp });
    assert.equal(loaded.bank_code, 'test-bank');
    assert.equal(loaded.extract.rows_kept, 3);
    assert.deepEqual(listManifests({ outputDir: tmp }), ['test-bank']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadManifest returns null for missing bank', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rda-manifest-test-'));
  try {
    const r = loadManifest({ bank_code: 'nope', outputDir: tmp });
    assert.equal(r, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeSummary writes _manifest_summary.json with expected shape', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rda-manifest-test-'));
  try {
    const s = buildSummary({ manifests: [] });
    const p = writeSummary({ summary: s, outputDir: tmp });
    assert.equal(path.basename(p), '_manifest_summary.json');
    const reloaded = JSON.parse(fs.readFileSync(p, 'utf-8'));
    assert.equal(reloaded._schema_version, SCHEMA_VERSION);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeManifest validates inputs', () => {
  assert.throws(() => writeManifest({}), /manifest with bank_code required/);
  assert.throws(() => writeManifest({ manifest: { bank_code: 'x' } }), /outputDir required/);
});

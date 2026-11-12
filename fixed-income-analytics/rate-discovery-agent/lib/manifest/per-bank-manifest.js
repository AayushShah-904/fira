'use strict';

/**
 * Per-bank manifest (Phase D1).
 *
 * Sprint 006 Step 2. Emits a per-bank manifest after every run that surfaces
 * the fetch path, extractor path, baseline delta, and run-over-run drift.
 * Closes the silent-success gap identified in Phase 0.2 failure inventory:
 * "a successful run that produced no data is indistinguishable from a
 * successful run that produced real data" — until this module landed.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/per-bank-manifest.md
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeWriteArtifact } = require('../safe-write');

const SCHEMA_VERSION = 1;

// Lifts from scripts/quality-gate.js for consistency. The pack gate uses these
// same thresholds for its findings; the manifest just records the per-bank
// classification for at-a-glance review.
const THRESHOLDS = {
  REGRESSION_DELTA: -0.20,
  WARN_DELTA_UPPER: -0.05,
  STABLE_BAND: 0.05,
  GAIN_DELTA_UPPER: 2.0,
  ANOMALY_GAIN_DELTA: 5.0,
};

/**
 * Build a per-bank manifest object. Pure function — no I/O.
 *
 * @param {object} args
 * @param {string} args.bank_code           required
 * @param {string} [args.run_id]            auto-generated if absent
 * @param {object} [args.fetch_result]      from lib/fetch/fetch_html.js or fetch_pdf.js
 * @param {object} [args.extract_result]    from a lib/extractors/<id>.js .extract() call
 * @param {object} [args.dispatch_result]   from lib/extractors/dispatch.js
 * @param {Array}  [args.baseline_slabs]    prior baseline slab array (for delta calc)
 * @param {object} [args.prior_manifest]    last run's manifest for drift detection
 * @param {string} [args.ts]                ISO timestamp; defaults to now
 * @returns {object} manifest
 */
function buildManifest({
  bank_code,
  run_id,
  fetch_result,
  extract_result,
  dispatch_result,
  baseline_slabs,
  prior_manifest,
  ts,
}) {
  if (!bank_code || typeof bank_code !== 'string') {
    throw new Error('buildManifest: bank_code is required (string)');
  }

  const tsValue = ts || new Date().toISOString();
  const runIdValue = run_id || generateRunId(tsValue);

  const fetchBlock = buildFetchBlock(fetch_result);
  const extractBlock = buildExtractBlock(extract_result, dispatch_result);
  const baselineBlock = buildBaselineBlock(extract_result, baseline_slabs);
  const driftBlock = buildDriftBlock(extractBlock, prior_manifest);

  const warnings = collectWarnings(extract_result, extractBlock, fetchBlock);
  const errors = collectErrors(extract_result, fetch_result);

  return {
    _schema_version: SCHEMA_VERSION,
    bank_code,
    run_id: runIdValue,
    ts: tsValue,
    fetch: fetchBlock,
    extract: extractBlock,
    baseline: baselineBlock,
    drift: driftBlock,
    warnings,
    errors,
  };
}

function buildFetchBlock(fetch_result) {
  if (!fetch_result) {
    return {
      fetcher: null,
      attempts: [],
      final_strategy: null,
      challenge_detected: null,
      iframe_traversed: false,
      ms: 0,
    };
  }
  // Distinguish fetch_html (has `attempts` + `challenge_detected`) from
  // fetch_pdf (has `method` + `slabsPreview`) by shape.
  const isPdf = 'method' in fetch_result && !Array.isArray(fetch_result.attempts);
  if (isPdf) {
    return {
      fetcher: 'fetch_pdf',
      attempts: [{ rung: fetch_result.method, browser: null, outcome: fetch_result.method !== 'failed' ? 'success' : 'error', ms: fetch_result.ms || 0 }],
      final_strategy: fetch_result.method,
      challenge_detected: null,
      iframe_traversed: false,
      ms: fetch_result.ms || 0,
      slabs_preview: fetch_result.slabsPreview,
      fallback_reason: fetch_result.fallback_reason || null,
    };
  }
  return {
    fetcher: 'fetch_html',
    attempts: Array.isArray(fetch_result.attempts) ? fetch_result.attempts : [],
    final_strategy: fetch_result.final_strategy || null,
    challenge_detected: fetch_result.challenge_detected || null,
    iframe_traversed: !!fetch_result.iframe_traversed,
    ms: fetch_result.ms || 0,
  };
}

function buildExtractBlock(extract_result, dispatch_result) {
  const dispatch = dispatch_result || {};
  const result = extract_result || {};
  const diagnostics = result.diagnostics || {};
  const slabs = Array.isArray(result.slabs) ? result.slabs : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const joinedWarnings = warnings.join(' ').toLowerCase();

  // Detect fallback engagement from warnings + dispatch resolution
  let fallback_engaged = null;
  if (joinedWarnings.includes('llm_fallback') || dispatch.resolution === 'fallback-llm') {
    fallback_engaged = 'llm';
  } else if (dispatch.resolution === 'fallback-generic') {
    fallback_engaged = 'generic-3col';
  }

  return {
    extractor: dispatch.template_id || null,
    template_id: dispatch.template_id || null,
    extraction_method: pickExtractionMethod(joinedWarnings, dispatch.resolution),
    rows_seen: typeof diagnostics.rows_seen === 'number' ? diagnostics.rows_seen : slabs.length,
    rows_kept: slabs.length,
    fallback_engaged,
    needs_template_authoring: !!dispatch.needs_template_authoring,
    diagnostics,
  };
}

function pickExtractionMethod(joinedWarnings, resolution) {
  if (joinedWarnings.includes('llm_fallback')) return 'llm_fallback';
  if (resolution === 'registry') return 'automatic_template';
  if (resolution === 'fallback-generic') return 'automatic_generic_3col';
  if (resolution === 'fallback-llm') return 'llm_fallback';
  return 'unknown';
}

function buildBaselineBlock(extract_result, baseline_slabs) {
  const current = Array.isArray(extract_result && extract_result.slabs) ? extract_result.slabs.length : 0;
  if (!Array.isArray(baseline_slabs)) {
    return {
      prior_slab_count: null,
      current_slab_count: current,
      delta: null,
      delta_pct: null,
      status: current > 0 ? 'NEW' : 'STABLE',
    };
  }
  const prior = baseline_slabs.length;
  const { status, delta, delta_pct } = classifyDelta({ current, prior });
  return {
    prior_slab_count: prior,
    current_slab_count: current,
    delta,
    delta_pct,
    status,
  };
}

function classifyDelta({ current, prior }) {
  if (prior === 0 && current === 0) return { status: 'STABLE', delta: 0, delta_pct: null };
  if (prior === 0 && current > 0) return { status: 'NEW', delta: current, delta_pct: null };
  const delta = current - prior;
  const delta_pct = (current - prior) / prior;
  if (current === 0) return { status: 'REGRESSION', delta, delta_pct };
  if (delta_pct >= THRESHOLDS.ANOMALY_GAIN_DELTA) return { status: 'ANOMALY_GAIN', delta, delta_pct };
  if (delta_pct >= THRESHOLDS.STABLE_BAND) return { status: 'GAIN', delta, delta_pct };
  if (delta_pct <= THRESHOLDS.REGRESSION_DELTA) return { status: 'REGRESSION', delta, delta_pct };
  if (delta_pct <= THRESHOLDS.WARN_DELTA_UPPER) return { status: 'WARN', delta, delta_pct };
  return { status: 'STABLE', delta, delta_pct };
}

function buildDriftBlock(currentExtract, priorManifest) {
  if (!priorManifest || !priorManifest.extract) {
    return { extraction_method_drift: null, template_id_drift: null };
  }
  const methodDrift = detectMethodDrift({ current: currentExtract, prior: priorManifest.extract });
  const templateDrift = detectTemplateDrift({ current: currentExtract, prior: priorManifest.extract });
  return { extraction_method_drift: methodDrift, template_id_drift: templateDrift };
}

function detectMethodDrift({ current, prior }) {
  if (!current || !prior) return null;
  const a = current.extraction_method;
  const b = prior.extraction_method;
  if (!a || !b || a === b) return null;
  return {
    from: b,
    to: a,
    reason: `extraction_method changed from "${b}" to "${a}" between runs — may indicate template regression or template recovery`,
  };
}

function detectTemplateDrift({ current, prior }) {
  if (!current || !prior) return null;
  const a = current.template_id;
  const b = prior.template_id;
  if (a === b) return null;
  return {
    from: b,
    to: a,
    reason: `template_id changed from "${b}" to "${a}" between runs`,
  };
}

function collectWarnings(extract_result, extractBlock, fetchBlock) {
  const w = [];
  if (extract_result && Array.isArray(extract_result.warnings)) {
    for (const x of extract_result.warnings) w.push(String(x));
  }
  if (extractBlock.needs_template_authoring) {
    w.push('needs_template_authoring: no template matched; ran fallback. Operator should run scripts/author-template.js.');
  }
  if (extractBlock.rows_seen > 0 && extractBlock.rows_kept === 0) {
    w.push(`silent_drop: rows_seen=${extractBlock.rows_seen} but rows_kept=0 — extractor saw rows but dropped all`);
  }
  if (fetchBlock.challenge_detected && fetchBlock.final_strategy !== 'stealth') {
    w.push(`challenge_detected vendor=${fetchBlock.challenge_detected.vendor} but final_strategy=${fetchBlock.final_strategy} — stealth rung not used`);
  }
  return w;
}

function collectErrors(extract_result, fetch_result) {
  const e = [];
  if (extract_result && Array.isArray(extract_result.errors)) {
    for (const x of extract_result.errors) e.push(String(x));
  }
  if (fetch_result && fetch_result.error) {
    e.push(`fetch_error: ${fetch_result.error.code}: ${fetch_result.error.message}`);
  }
  return e;
}

function generateRunId(ts) {
  const rand = crypto.randomBytes(4).toString('hex');
  return `${(ts || new Date().toISOString()).slice(0, 19)}Z-${rand}`;
}

// --- IO -----

function writeManifest({ manifest, outputDir }) {
  if (!manifest || !manifest.bank_code) throw new Error('writeManifest: manifest with bank_code required');
  if (!outputDir) throw new Error('writeManifest: outputDir required');
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${manifest.bank_code}_manifest.json`);
  // safe-write-exempt: per-bank manifest is an aggregator-like artifact (one-per-run, not a per-bank canonical config/rates/summary write); ADR-012 carve-out for non-canonical outputs.
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n');
  return filePath;
}

function loadManifest({ bank_code, outputDir }) {
  const filePath = path.join(outputDir, `${bank_code}_manifest.json`);
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function listManifests({ outputDir }) {
  if (!fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir)
    .filter((f) => f.endsWith('_manifest.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'_manifest.json'.length));
}

function writeSummary({ summary, outputDir }) {
  if (!outputDir) throw new Error('writeSummary: outputDir required');
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, '_manifest_summary.json');
  // safe-write-exempt: aggregator output (cohort-level summary roll-up); not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2) + '\n');
  return filePath;
}

// --- Summary -----

function buildSummary({ manifests }) {
  const byStatus = {};
  const byExtractor = {};
  const byFallback = { deterministic: 0, fallback_generic_3col: 0, fallback_llm: 0, needs_template_authoring: 0 };
  const byFinalStrategy = {};
  const byChallengeVendor = {};
  let iframeCount = 0;
  let methodDriftCount = 0;
  let templateDriftCount = 0;

  for (const m of (manifests || [])) {
    const status = m.baseline && m.baseline.status;
    if (status) byStatus[status] = (byStatus[status] || 0) + 1;

    const ext = m.extract && m.extract.extractor;
    if (ext) byExtractor[ext] = (byExtractor[ext] || 0) + 1;

    if (m.extract) {
      if (m.extract.fallback_engaged === 'llm') byFallback.fallback_llm++;
      else if (m.extract.fallback_engaged === 'generic-3col') byFallback.fallback_generic_3col++;
      else byFallback.deterministic++;
      if (m.extract.needs_template_authoring) byFallback.needs_template_authoring++;
    }

    if (m.fetch) {
      const fs_ = m.fetch.final_strategy;
      if (fs_) byFinalStrategy[fs_] = (byFinalStrategy[fs_] || 0) + 1;
      if (m.fetch.challenge_detected && m.fetch.challenge_detected.vendor) {
        const v = m.fetch.challenge_detected.vendor;
        byChallengeVendor[v] = (byChallengeVendor[v] || 0) + 1;
      }
      if (m.fetch.iframe_traversed) iframeCount++;
    }

    if (m.drift) {
      if (m.drift.extraction_method_drift) methodDriftCount++;
      if (m.drift.template_id_drift) templateDriftCount++;
    }
  }

  const total = (manifests || []).length || 1; // avoid /0
  const deterministic_pct = Math.round(((byFallback.deterministic + byFallback.fallback_generic_3col) / total) * 100);
  const needs_template_authoring_pct = Math.round((byFallback.needs_template_authoring / total) * 100);

  return {
    _schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    manifests_loaded: (manifests || []).length,
    by_status: byStatus,
    by_extractor: byExtractor,
    by_fallback: byFallback,
    by_final_strategy: byFinalStrategy,
    by_challenge_vendor: byChallengeVendor,
    iframe_traversed_count: iframeCount,
    method_drift_count: methodDriftCount,
    template_drift_count: templateDriftCount,
    deterministic_pct,
    needs_template_authoring_pct,
  };
}

module.exports = {
  SCHEMA_VERSION,
  THRESHOLDS,
  buildManifest,
  buildSummary,
  classifyDelta,
  detectMethodDrift,
  detectTemplateDrift,
  writeManifest,
  loadManifest,
  listManifests,
  writeSummary,
};

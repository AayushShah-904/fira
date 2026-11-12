#!/usr/bin/env node
'use strict';

/**
 * Phase 3 — extract candidate rates from cached bodies, diff against current.
 *
 * Reads `_change_signals.json` from the refresh run dir, and for every record
 * whose status is `likely_changed`, `signals_missing`, or `needs_playwright`:
 *
 *   1. Reads the cached body from Phase 2 (no re-fetch).
 *   2. Routes to the appropriate extractor:
 *        - html_static / html_js with cached body  → require()'d parseHtmlTables
 *        - PDF (cached on disk)                    → extract_rates_pdf.mjs <path>
 *        - needs_playwright (no usable body)       → fetch_rates_playwright.js (fresh)
 *   3. Diffs the new slabs against the current `output/latest/<slug>_<variant>_rates.json`.
 *   4. Writes candidate `extracted/<slug>__<variant>_rates.json` + `diffs/<slug>__<variant>_diff.json`
 *      inside the run dir.
 *
 * DOES NOT touch `output/latest/`. The separate `promote.js` step does that
 * after operator review.
 *
 * Run:
 *   node scripts/refresh/extract-and-diff.js
 *   node scripts/refresh/extract-and-diff.js --slug state-bank-of-india
 *   node scripts/refresh/extract-and-diff.js --run-ts 2026-05-13T17-29-11
 *   node scripts/refresh/extract-and-diff.js --concurrency 4
 *   node scripts/refresh/extract-and-diff.js --status likely_changed   # filter
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseHtmlTables,
  extractSlabsFromTable,
  extractEffectiveDateFromHtml,
} = require('../extract_rates.js');
const { parseTenure } = require('../utils/parse-tenure.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REFRESH_ROOT = path.join(REPO_ROOT, 'output', 'refresh');
const LATEST_DIR = path.join(REPO_ROOT, 'output', 'latest');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

const EXTRACT_STATUSES = new Set(['likely_changed', 'signals_missing', 'needs_playwright']);
const PLAYWRIGHT_TIMEOUT_MS = 120_000;
const PDF_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const args = { runTs: null, slug: null, status: null, concurrency: 4 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-ts') args.runTs = argv[++i];
    else if (a === '--slug') args.slug = argv[++i];
    else if (a === '--status') args.status = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || 4;
  }
  return args;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // safe-write-exempt: refresh-pipeline run-meta artifacts (_extract_errors.json, _extract_summary.json) under runs/<ts>/; not per-bank canonical writes.
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function resolveRunTs(explicit) {
  if (explicit) return explicit;
  const pointer = path.join(REFRESH_ROOT, 'latest', '_run_ts.txt');
  if (fs.existsSync(pointer)) return fs.readFileSync(pointer, 'utf-8').trim();
  throw new Error('No run-ts and no latest pointer.');
}

// ── Extractors ──────────────────────────────────────────────────────

function extractFromHtmlBody(bodyPath, config, variant) {
  const html = fs.readFileSync(bodyPath, 'utf-8');
  const effectiveDate = extractEffectiveDateFromHtml(html);
  const tables = parseHtmlTables(html);
  if (tables.length === 0) {
    return { slabs: [], effectiveDate, warnings: ['No HTML tables found in cached body'] };
  }
  // Column mapping: prefer variant-specific if config carries it, else fall back
  // to the FD column_mapping, else the default 3-column shape.
  const columnMapping = pickColumnMapping(config, variant);
  let best = [];
  for (const t of tables) {
    const slabs = extractSlabsFromTable(t, columnMapping);
    if (slabs.length > best.length) best = slabs;
  }
  return { slabs: best, effectiveDate, warnings: [] };
}

function pickColumnMapping(config, variant) {
  if (config && config.column_mapping && Object.keys(config.column_mapping).length > 0) {
    return config.column_mapping;
  }
  return { '0': 'tenure_text', '1': 'rate_general_pct', '2': 'rate_senior_pct' };
}

function extractFromPdfPath(pdfPath, bankCode, variant) {
  const args = [
    path.join(SCRIPTS_DIR, 'extract_rates_pdf.mjs'),
    pdfPath,
    '--bank-code',
    bankCode,
  ];
  if (variant && variant !== 'regular') args.push('--variant', variant);
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    timeout: PDF_TIMEOUT_MS,
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    return {
      slabs: [],
      effectiveDate: null,
      warnings: [`PDF extractor exit ${res.status}: ${(res.stderr || '').slice(-300)}`],
    };
  }
  const out = res.stdout || '';
  const marker = out.indexOf('=== JSON_OUTPUT ===');
  if (marker === -1) {
    return { slabs: [], effectiveDate: null, warnings: ['PDF output missing JSON_OUTPUT marker'] };
  }
  try {
    const json = JSON.parse(out.slice(marker + 19).trim());
    return {
      slabs: json.rate_slabs || [],
      effectiveDate: json.effective_date || null,
      warnings: json.warnings || [],
    };
  } catch (err) {
    return { slabs: [], effectiveDate: null, warnings: [`PDF JSON parse: ${err.message}`] };
  }
}

function extractViaPlaywright(url, config) {
  // No body cache exists for needs_playwright (Phase 2 fetched scaffolding); we
  // accept one fresh Playwright launch per such bank — currently a handful.
  const args = [path.join(SCRIPTS_DIR, 'fetch_rates_playwright.js'), url];
  const notes = (config && config.scraper_notes) || {};
  if (notes.has_tabs) args.push('--tabs');
  if (notes.has_lazy_loading) args.push('--scroll');
  if (notes.has_dropdowns) args.push('--selects');
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    timeout: PLAYWRIGHT_TIMEOUT_MS,
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    return {
      slabs: [],
      effectiveDate: null,
      warnings: [`Playwright exit ${res.status}: ${(res.stderr || '').slice(-300)}`],
    };
  }
  const out = res.stdout || '';
  const marker = out.indexOf('=== JSON_OUTPUT ===');
  if (marker === -1) {
    return { slabs: [], effectiveDate: null, warnings: ['Playwright missing JSON_OUTPUT marker'] };
  }
  try {
    const json = JSON.parse(out.slice(marker + 19).trim());
    const slabs = (json.rate_slabs || []).map((s) => {
      const parsed = parseTenure(s.tenure_text || '');
      return {
        tenure_text: s.tenure_text,
        tenure_min_days: parsed ? parsed.minDays : null,
        tenure_max_days: parsed ? parsed.maxDays : null,
        rate_general_pct: parseFloat(String(s.rate_general_pct || '0').replace('%', '')),
        rate_senior_pct: s.rate_senior_pct ? parseFloat(String(s.rate_senior_pct).replace('%', '')) : null,
        rate_super_senior_pct: null,
      };
    });
    const effectiveDate = (json.effective_dates || [])[0] || null;
    return { slabs, effectiveDate, warnings: [] };
  } catch (err) {
    return { slabs: [], effectiveDate: null, warnings: [`Playwright JSON parse: ${err.message}`] };
  }
}

// ── Slab diff ───────────────────────────────────────────────────────

function normalizeTenureText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Primary key: numeric day-range tuple (tenure_min_days, tenure_max_days).
// Tenure text wording varies between scrapes — sometimes the same band reads as
// "211 days to 364 days" on one source and "211 days to less than 1 year" on
// another. Day numbers are stable.
//
// `currency` is part of the key for FCNR/GIFT (USD vs GBP vs EUR are distinct
// slabs). `deposit_range` is NOT — most banks have one tier and including it
// would falsely segment slabs whose prior copy lacks the field.
function slabKey(slab) {
  const variant = slab.currency || null;
  let body;
  if (slab.tenure_min_days != null && slab.tenure_max_days != null) {
    body = `d:${slab.tenure_min_days}-${slab.tenure_max_days}`;
  } else if (slab.tenure_min_days != null) {
    body = `d:${slab.tenure_min_days}+`;
  } else if (slab.tenure_max_days != null) {
    body = `d:-${slab.tenure_max_days}`;
  } else {
    body = `t:${normalizeTenureText(slab.tenure_text)}`;
  }
  return variant ? `${variant}|${body}` : body;
}

function rateDeltaBps(oldPct, newPct) {
  if (oldPct == null || newPct == null) return null;
  return Math.round((newPct - oldPct) * 100);
}

function diffSlabs(prior, next) {
  const priorMap = new Map();
  for (const s of prior || []) priorMap.set(slabKey(s), s);
  const nextMap = new Map();
  for (const s of next || []) nextMap.set(slabKey(s), s);

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [k, n] of nextMap.entries()) {
    const p = priorMap.get(k);
    if (!p) {
      added.push(n);
      continue;
    }
    const changes = {};
    for (const field of ['rate_general_pct', 'rate_senior_pct', 'rate_super_senior_pct']) {
      const ov = p[field];
      const nv = n[field];
      if (ov == null && nv == null) continue;
      if (ov === nv) continue;
      changes[field] = {
        old: ov == null ? null : Number(ov),
        new: nv == null ? null : Number(nv),
        delta_bps: rateDeltaBps(ov, nv),
      };
    }
    if (Object.keys(changes).length > 0) {
      changed.push({
        tenure_text: n.tenure_text,
        tenure_min_days: n.tenure_min_days,
        tenure_max_days: n.tenure_max_days,
        currency: n.currency || null,
        deposit_range: n.deposit_range || null,
        changes,
      });
    } else {
      unchanged.push(k);
    }
  }
  for (const [k, p] of priorMap.entries()) {
    if (!nextMap.has(k)) removed.push(p);
  }

  return {
    added,
    removed,
    changed,
    unchanged_count: unchanged.length,
    summary: {
      slabs_added: added.length,
      slabs_removed: removed.length,
      slabs_changed: changed.length,
      slabs_unchanged: unchanged.length,
      slabs_prior: priorMap.size,
      slabs_next: nextMap.size,
    },
  };
}

// ── Main loop ───────────────────────────────────────────────────────

function ratesFileName(bankCode, variant) {
  return variant === 'regular' ? `${bankCode}_rates.json` : `${bankCode}_${variant}_rates.json`;
}

async function runWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function pump() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: `worker:${err.message}` };
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

function loadConfig(bankCode) {
  return readJsonSafe(path.join(LATEST_DIR, `${bankCode}_config.json`));
}

function loadPriorRates(bankCode, variant) {
  return readJsonSafe(path.join(LATEST_DIR, ratesFileName(bankCode, variant)));
}

function buildSidecarPayload({
  bankCode,
  bankName,
  variant,
  result,
  sourceUrl,
  bodyKind,
  priorRates,
}) {
  const extractionMethod = inferExtractionMethod(bodyKind, variant);
  return {
    bank_code: bankCode,
    bank_name: bankName || (priorRates && priorRates.bank_name) || bankCode,
    product_type: 'FD',
    variant,
    effective_date: result.effectiveDate || (priorRates && priorRates.effective_date) || null,
    source_url: sourceUrl,
    scraped_at: new Date().toISOString(),
    extraction_method: extractionMethod,
    extraction_confidence: result.slabs.length > 0 ? 'high' : 'none',
    rate_slabs: result.slabs.map((s) => ({
      ...s,
      deposit_range: s.deposit_range || 'below_3cr',
    })),
    special_schemes: [],
    warnings: result.warnings || [],
    errors: result.slabs.length === 0 ? ['Extraction yielded zero slabs'] : [],
  };
}

function inferExtractionMethod(bodyKind, variant) {
  if (bodyKind === 'pdf') return 'automatic_pdf';
  if (bodyKind === 'playwright') return 'automatic_html_js';
  if (bodyKind === 'html') return 'automatic_html_static';
  return 'llm_inline_extraction';
}

async function main() {
  const args = parseArgs(process.argv);
  const runTs = resolveRunTs(args.runTs);
  const runDir = path.join(REFRESH_ROOT, runTs);
  const signalsPath = path.join(runDir, '_change_signals.json');
  const signals = readJsonSafe(signalsPath);
  if (!signals) throw new Error(`No signals at ${signalsPath}. Run detect-changes.js first.`);

  let records = signals.records.filter((r) => EXTRACT_STATUSES.has(r.status));
  if (args.slug) records = records.filter((r) => r.bank_code === args.slug);
  if (args.status) records = records.filter((r) => r.status === args.status);

  console.log(`extract-and-diff: run_ts=${runTs}`);
  console.log(`  candidates=${records.length}  concurrency=${args.concurrency}`);

  const extractedDir = path.join(runDir, 'extracted');
  const diffsDir = path.join(runDir, 'diffs');
  fs.mkdirSync(extractedDir, { recursive: true });
  fs.mkdirSync(diffsDir, { recursive: true });

  const results = await runWithConcurrency(records, args.concurrency, async (r) => {
    const config = loadConfig(r.bank_code);
    const priorRates = loadPriorRates(r.bank_code, r.variant);
    let extraction;
    let bodyKind;

    if (r.status === 'needs_playwright') {
      bodyKind = 'playwright';
      extraction = extractViaPlaywright(r.source_url, config);
    } else if (r.kind === 'pdf') {
      bodyKind = 'pdf';
      const bodyPath = path.join(REPO_ROOT, r.body_cache_path);
      if (!fs.existsSync(bodyPath)) {
        return { record: r, error: `cached PDF missing at ${bodyPath}` };
      }
      extraction = extractFromPdfPath(bodyPath, r.bank_code, r.variant);
    } else if (r.kind === 'html') {
      bodyKind = 'html';
      const bodyPath = path.join(REPO_ROOT, r.body_cache_path);
      if (!fs.existsSync(bodyPath)) {
        return { record: r, error: `cached HTML missing at ${bodyPath}` };
      }
      extraction = extractFromHtmlBody(bodyPath, config, r.variant);
    } else {
      return { record: r, error: `unsupported kind: ${r.kind}` };
    }

    const sidecar = buildSidecarPayload({
      bankCode: r.bank_code,
      bankName: r.bank_name,
      variant: r.variant,
      result: extraction,
      sourceUrl: r.source_url,
      bodyKind,
      priorRates,
    });

    const sidecarPath = path.join(extractedDir, ratesFileName(r.bank_code, r.variant));
    writeJson(sidecarPath, sidecar);

    const diff = diffSlabs(priorRates && priorRates.rate_slabs, sidecar.rate_slabs);
    const diffPath = path.join(diffsDir, `${r.bank_code}__${r.variant}.diff.json`);
    writeJson(diffPath, {
      bank_code: r.bank_code,
      bank_name: sidecar.bank_name,
      variant: r.variant,
      bank_type: r.bank_type,
      detection_status: r.status,
      detection_reason: r.reason,
      stored_effective_date: r.stored_effective_date,
      candidate_effective_date: sidecar.effective_date,
      source_url: r.source_url,
      extraction_method: sidecar.extraction_method,
      extraction_confidence: sidecar.extraction_confidence,
      warnings: sidecar.warnings,
      errors: sidecar.errors,
      diff,
    });

    return {
      record: r,
      slab_count: sidecar.rate_slabs.length,
      effective_date: sidecar.effective_date,
      diff_summary: diff.summary,
      warnings_count: (sidecar.warnings || []).length,
      errors_count: (sidecar.errors || []).length,
      body_kind: bodyKind,
    };
  }, (done, total) => {
    if (done % 10 === 0 || done === total) {
      process.stdout.write(`  progress: ${done}/${total}\n`);
    }
  });

  const errors = [];
  const okList = [];
  const zeroSlab = [];
  for (const r of results) {
    if (!r) continue;
    if (r.error) { errors.push(r); continue; }
    okList.push(r);
    if (r.slab_count === 0) zeroSlab.push(r);
  }

  const summary = {
    run_ts: runTs,
    generated_at: new Date().toISOString(),
    candidates: records.length,
    extracted_ok: okList.length,
    extraction_errors: errors.length,
    zero_slab_candidates: zeroSlab.length,
    by_body_kind: countBy(okList, (r) => r.body_kind),
    by_detection_status: countBy(okList, (r) => r.record.status),
    total_slabs_added: sum(okList, (r) => r.diff_summary.slabs_added),
    total_slabs_removed: sum(okList, (r) => r.diff_summary.slabs_removed),
    total_slabs_changed: sum(okList, (r) => r.diff_summary.slabs_changed),
  };

  writeJson(path.join(runDir, '_extract_summary.json'), summary);
  writeJson(path.join(runDir, '_extract_errors.json'), errors);

  console.log('extract-and-diff: done');
  console.log(`  ok=${summary.extracted_ok}  errors=${summary.extraction_errors}  zero_slab=${summary.zero_slab_candidates}`);
  console.log(`  by_body_kind=${JSON.stringify(summary.by_body_kind)}`);
  console.log(`  totals: +${summary.total_slabs_added} / -${summary.total_slabs_removed} / Δ${summary.total_slabs_changed}`);
}

function countBy(arr, key) {
  const out = {};
  for (const x of arr) {
    const k = key(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function sum(arr, key) {
  let s = 0;
  for (const x of arr) s += key(x) || 0;
  return s;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('extract-and-diff: FAILED', err);
    process.exit(1);
  });
}

module.exports = { diffSlabs, slabKey, normalizeTenureText };

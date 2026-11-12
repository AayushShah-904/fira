#!/usr/bin/env node
'use strict';

/**
 * Phase 3a' — LLM verification of sanity-gate-flagged candidates.
 *
 * Reads `_suspicious.json`, and for each flagged (bank, variant) pair, re-runs
 * extraction through gpt-4.1-mini against the SAME cached body that Phase 2
 * already fetched (no re-fetch). The LLM reads page semantics, so it's robust
 * to the column-mapping drift that broke the deterministic extractor.
 *
 * Outcome of each verification:
 *   - LLM_REPLACED  — LLM produced plausible rates that differ from deterministic;
 *                     the candidate sidecar + diff are overwritten with LLM values.
 *   - LLM_CONFIRMS  — LLM and deterministic agreed (within tolerance); the
 *                     suspicion was a false alarm. No replacement.
 *   - LLM_REJECTED  — LLM also produced implausible values; flagged for manual
 *                     review. No replacement.
 *   - LLM_NO_DATA   — LLM returned empty / unparseable. Manual review.
 *   - SKIPPED       — PDF/other unsupported body kind, or body cache missing.
 *
 * Cost budget: caps at MAX_CALLS to prevent runaway spend.
 *
 * Run:
 *   node scripts/refresh/verify-with-llm.js
 *   node scripts/refresh/verify-with-llm.js --concurrency 4 --max-calls 200
 *   node scripts/refresh/verify-with-llm.js --slug punjab-national-bank   # single bank smoke
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');

const { createClient, chatCompletion } = require('../../lib/azure-openai-client.js');
const { parseTenure } = require('../utils/parse-tenure.js');
const { diffSlabs } = require('./extract-and-diff.js');
const { classify: sanityClassify } = require('./sanity-gate.js');
// Shared re-extraction prompt (Sprint 008 Phase 4) — single source of truth so
// the cross-check (scripts/audit/cross-check-all.js) cannot fork the prompt.
const { buildExtractionPrompt: buildPrompt, variantInstructions } = require('../../lib/llm/reextract-prompt.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REFRESH_ROOT = path.join(REPO_ROOT, 'output', 'refresh');
const LATEST_DIR = path.join(REPO_ROOT, 'output', 'latest');

const HTML_TEXT_CAP = 30000;   // ~7-8K tokens after stripping tags
const PDF_TEXT_CAP = 30000;
const DEFAULT_MAX_CALLS = 200;
const DEFAULT_CONCURRENCY = 4;
const LLM_TEMPERATURE = 0.05;
const MODEL =
  process.env.AZURE_OPENAI_DEPLOYMENT_MINI ||
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  'gpt-4.1-mini';

function parseArgs(argv) {
  const args = {
    runTs: null,
    slug: null,
    concurrency: DEFAULT_CONCURRENCY,
    maxCalls: DEFAULT_MAX_CALLS,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-ts') args.runTs = argv[++i];
    else if (a === '--slug') args.slug = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || DEFAULT_CONCURRENCY;
    else if (a === '--max-calls') args.maxCalls = Number(argv[++i]) || DEFAULT_MAX_CALLS;
  }
  return args;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // safe-write-exempt: refresh-pipeline run-meta artifact (_llm_verification.json) under runs/<ts>/; not a per-bank canonical write.
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function resolveRunTs(explicit) {
  if (explicit) return explicit;
  const pointer = path.join(REFRESH_ROOT, 'latest', '_run_ts.txt');
  if (fs.existsSync(pointer)) return fs.readFileSync(pointer, 'utf-8').trim();
  throw new Error('No run-ts and no latest pointer.');
}

function ratesFileName(bankCode, variant) {
  return variant === 'regular' ? `${bankCode}_rates.json` : `${bankCode}_${variant}_rates.json`;
}

function stripHtmlForLlm(html) {
  // Drop scripts/styles/comments + collapse whitespace. Keep tags so the LLM
  // can see table structure (which is the whole point — it needs to read
  // <th> headers to disambiguate columns).
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Try to isolate the <body> if present.
  const bodyMatch = s.match(/<body[\s\S]*?<\/body>/i);
  if (bodyMatch) s = bodyMatch[0];
  // Decode common entities
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ');
  if (s.length > HTML_TEXT_CAP) s = s.slice(0, HTML_TEXT_CAP) + '\n[...truncated...]';
  return s;
}

async function extractTextFromPdf(pdfPath) {
  // Lazy-load pdfjs to keep require() cheap for HTML-only paths.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = fs.readFileSync(pdfPath);
  const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const doc = await getDocument({ data: uint8 }).promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const txt = await page.getTextContent();
    const items = txt.items.map((it) => it.str);
    lines.push(items.join(' '));
    if (lines.join('\n').length > PDF_TEXT_CAP) break;
  }
  let text = lines.join('\n');
  if (text.length > PDF_TEXT_CAP) text = text.slice(0, PDF_TEXT_CAP) + '\n[...truncated...]';
  return text;
}

function stripJsonEnvelope(text) {
  // Handle ```json fences and leading commentary if the model slips.
  if (!text) return '';
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s.trim();
}

function normalizeLlmSlabs(rawSlabs, variant) {
  if (!Array.isArray(rawSlabs)) return [];
  const out = [];
  for (const s of rawSlabs) {
    if (!s || typeof s !== 'object') continue;
    let minD = numOrNull(s.tenure_min_days);
    let maxD = numOrNull(s.tenure_max_days);
    if (minD == null && maxD == null && s.tenure_text) {
      const parsed = parseTenure(String(s.tenure_text));
      if (parsed) {
        minD = parsed.minDays;
        maxD = parsed.maxDays;
      }
    }
    const slab = {
      tenure_text: s.tenure_text || '',
      tenure_min_days: minD,
      tenure_max_days: maxD,
      rate_general_pct: numOrNull(s.rate_general_pct),
      rate_senior_pct: numOrNull(s.rate_senior_pct),
      rate_super_senior_pct: numOrNull(s.rate_super_senior_pct),
      deposit_range: 'below_3cr',
    };
    if (variant === 'fcnr' || variant === 'gift') {
      slab.currency = s.currency ? String(s.currency).toUpperCase() : null;
    }
    out.push(slab);
  }
  return out;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v.replace('%', '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function plausibleLlmResult(slabs, variant) {
  if (!slabs || slabs.length === 0) return false;
  const isInr = variant === 'regular' || variant === 'nre' || variant === 'nro';
  if (!isInr) return true;   // FCNR/GIFT rates can legitimately be sub-1%
  // For INR: at least one slab with general in 1..10
  let okGen = 0;
  for (const s of slabs) {
    if (s.rate_general_pct != null && s.rate_general_pct >= 1.0 && s.rate_general_pct <= 10) okGen++;
  }
  return okGen >= Math.min(3, slabs.length);
}

async function callLlm(client, prompt, logger) {
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  const params = {
    messages,
    temperature: LLM_TEMPERATURE,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
  };
  const resp = await chatCompletion(client, params, { logger, model: MODEL });
  const text = (resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
  const usage = (resp && resp.usage) || {};
  return { text, usage };
}

async function verifyOne({ entry, runDir, extractedDir, diffsDir, client, logger }) {
  const bodyBase = path.join(REPO_ROOT, entry.body_cache_path);
  const htmlPath = bodyBase + '.html';
  const pdfPath = bodyBase + '.pdf';
  let content;
  let contentKind;
  if (fs.existsSync(htmlPath)) {
    contentKind = 'HTML (tags preserved for column-header context)';
    content = stripHtmlForLlm(fs.readFileSync(htmlPath, 'utf-8'));
  } else if (fs.existsSync(pdfPath)) {
    contentKind = 'PDF (extracted text)';
    try {
      content = await extractTextFromPdf(pdfPath);
    } catch (err) {
      return { outcome: 'SKIPPED', reason: `pdf_text_extract_failed:${err.message}` };
    }
  } else {
    return { outcome: 'SKIPPED', reason: 'no_cached_body' };
  }

  const sourceUrl = entry.source_url;
  const prompt = buildPrompt(entry.variant, sourceUrl, content, contentKind);

  let llm;
  try {
    llm = await callLlm(client, prompt, logger);
  } catch (err) {
    return { outcome: 'SKIPPED', reason: `llm_error:${err.status || ''}:${(err.message || '').slice(0, 120)}` };
  }
  const raw = stripJsonEnvelope(llm.text);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { outcome: 'LLM_NO_DATA', reason: `json_parse_failed`, usage: llm.usage };
  }
  const slabs = normalizeLlmSlabs(parsed.rate_slabs, entry.variant);
  if (!plausibleLlmResult(slabs, entry.variant)) {
    return {
      outcome: 'LLM_REJECTED',
      reason: 'implausible_rates_after_llm',
      llm_slab_count: slabs.length,
      usage: llm.usage,
    };
  }

  // Build the corrected sidecar payload.
  const candidatePath = path.join(extractedDir, ratesFileName(entry.bank_code, entry.variant));
  const oldCandidate = readJsonSafe(candidatePath) || {};
  const correctedSidecar = {
    ...oldCandidate,
    bank_code: entry.bank_code,
    bank_name: oldCandidate.bank_name || entry.bank_name || entry.bank_code,
    product_type: 'FD',
    variant: entry.variant,
    effective_date: parsed.effective_date || oldCandidate.effective_date || null,
    source_url: sourceUrl,
    scraped_at: new Date().toISOString(),
    extraction_method: 'llm_verified',
    extraction_confidence: slabs.length > 0 ? 'high' : 'none',
    rate_slabs: slabs,
    special_schemes: oldCandidate.special_schemes || [],
    warnings: [...(oldCandidate.warnings || []), 'LLM-verified after sanity-gate flagged deterministic output.', ...(parsed.warnings || [])],
    errors: slabs.length === 0 ? ['LLM also returned zero slabs'] : [],
  };

  // Decide: replace or confirm. Compare LLM slabs vs old candidate slabs.
  const sameAsCandidate = slabsAreClose(slabs, oldCandidate.rate_slabs || []);
  if (sameAsCandidate) {
    return {
      outcome: 'LLM_CONFIRMS',
      reason: 'matches_deterministic',
      llm_slab_count: slabs.length,
      usage: llm.usage,
    };
  }

  // Compute the LLM diff and re-run the sanity gate against it. If the LLM
  // result STILL trips the gate (e.g., the page is structurally weird like
  // PNB's "Existing vs Revised" comparison table where neither extractor can
  // unambiguously identify general vs senior columns), hold it back from
  // promotion — promoting LLM-still-suspicious is worse than preserving prior.
  const priorRatesPath = path.join(LATEST_DIR, ratesFileName(entry.bank_code, entry.variant));
  const priorRates = readJsonSafe(priorRatesPath);
  const diff = diffSlabs(priorRates && priorRates.rate_slabs, correctedSidecar.rate_slabs);

  const postLlmDiffRecord = {
    bank_code: entry.bank_code,
    variant: entry.variant,
    diff: { ...diff, changed: diff.changed },
  };
  const reSanity = sanityClassify(postLlmDiffRecord, correctedSidecar, priorRates);
  if (reSanity) {
    return {
      outcome: 'LLM_STILL_SUSPICIOUS',
      reason: 'sanity_gate_re_flags_llm_result',
      sanity_reasons: Object.keys(reSanity),
      llm_slab_count: slabs.length,
      usage: llm.usage,
    };
  }

  // Replace candidate + regenerate diff.
  writeJson(candidatePath, correctedSidecar);

  // Build the diff record matching the shape extract-and-diff.js wrote.
  const diffPath = path.join(diffsDir, `${entry.bank_code}__${entry.variant}.diff.json`);
  const oldDiff = readJsonSafe(diffPath) || {};
  writeJson(diffPath, {
    ...oldDiff,
    candidate_effective_date: correctedSidecar.effective_date,
    extraction_method: correctedSidecar.extraction_method,
    extraction_confidence: correctedSidecar.extraction_confidence,
    warnings: correctedSidecar.warnings,
    errors: correctedSidecar.errors,
    diff,
    llm_verified: true,
  });

  return {
    outcome: 'LLM_REPLACED',
    reason: 'rates_differ_after_llm',
    llm_slab_count: slabs.length,
    diff_summary: diff.summary,
    usage: llm.usage,
  };
}

function slabsAreClose(a, b) {
  if (a.length !== b.length) return false;
  // Match by tenure-day range; tolerate 0.05 percent drift (LLM rounding).
  const map = new Map();
  for (const s of b) {
    const key = `${s.tenure_min_days}-${s.tenure_max_days}-${s.currency || ''}`;
    map.set(key, s);
  }
  for (const s of a) {
    const key = `${s.tenure_min_days}-${s.tenure_max_days}-${s.currency || ''}`;
    const o = map.get(key);
    if (!o) return false;
    for (const f of ['rate_general_pct', 'rate_senior_pct']) {
      const av = s[f], bv = o[f];
      if (av == null && bv == null) continue;
      if (av == null || bv == null) return false;
      if (Math.abs(av - bv) > 0.05) return false;
    }
  }
  return true;
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
        results[i] = { outcome: 'SKIPPED', reason: `worker_error:${err.message}` };
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const runTs = resolveRunTs(args.runTs);
  const runDir = path.join(REFRESH_ROOT, runTs);
  const suspicious = readJsonSafe(path.join(runDir, '_suspicious.json'));
  if (!suspicious) throw new Error('Missing _suspicious.json — run sanity-gate.js first.');

  let entries = suspicious.suspicious || [];
  if (args.slug) entries = entries.filter((e) => e.bank_code === args.slug);
  if (entries.length > args.maxCalls) {
    console.log(`verify-with-llm: capping ${entries.length} -> ${args.maxCalls} (raise with --max-calls)`);
    entries = entries.slice(0, args.maxCalls);
  }

  console.log(`verify-with-llm: model=${MODEL}  candidates=${entries.length}  concurrency=${args.concurrency}`);

  const extractedDir = path.join(runDir, 'extracted');
  const diffsDir = path.join(runDir, 'diffs');

  const client = createClient();
  const startedAt = new Date().toISOString();

  let promptTokens = 0;
  let completionTokens = 0;

  const results = await runWithConcurrency(
    entries,
    args.concurrency,
    async (entry) => {
      const r = await verifyOne({ entry, runDir, extractedDir, diffsDir, client, logger: console });
      if (r && r.usage) {
        promptTokens += r.usage.prompt_tokens || 0;
        completionTokens += r.usage.completion_tokens || 0;
      }
      return { entry, ...r };
    },
    (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`  progress: ${done}/${total}  (prompt=${promptTokens} completion=${completionTokens} tokens)\n`);
      }
    },
  );

  const outcomeCounts = {};
  for (const r of results) {
    outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] || 0) + 1;
  }

  // Estimated cost for gpt-4.1-mini: $0.40/MTok in, $1.60/MTok out (as of 2026-Q1).
  const estCostUsd = (promptTokens / 1e6) * 0.40 + (completionTokens / 1e6) * 1.60;

  const summary = {
    run_ts: runTs,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    model: MODEL,
    candidates_attempted: entries.length,
    outcomes: outcomeCounts,
    tokens: { prompt: promptTokens, completion: completionTokens },
    est_cost_usd: Number(estCostUsd.toFixed(4)),
    results,
  };

  writeJson(path.join(runDir, '_llm_verification.json'), summary);

  console.log(`verify-with-llm: done`);
  console.log(`  outcomes: ${JSON.stringify(outcomeCounts)}`);
  console.log(`  tokens: prompt=${promptTokens} completion=${completionTokens}  est_cost=$${estCostUsd.toFixed(3)}`);
  console.log(`  wrote: ${path.join(runDir, '_llm_verification.json')}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('verify-with-llm: FAILED', err);
    process.exit(1);
  });
}

module.exports = { stripHtmlForLlm, normalizeLlmSlabs, plausibleLlmResult };

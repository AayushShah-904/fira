#!/usr/bin/env node
'use strict';
//
// Systematic independent cross-check (Sprint 008, Phase 4).
//
// For every variant with a Phase-1 snapshot, re-extract the rates with an
// independent LLM read and compare to the shipped slabs via diffSlabs(). Emits
// a per-(bank,variant) agreement (FULL / PARTIAL / DISAGREE / LLM_NO_DATA) and
// a per-extraction-method roll-up — a second, independent confidence signal
// beside the Phase-2 audit. MEASURES ONLY; never auto-replaces (that stays in
// scripts/refresh/verify-with-llm.js). See design/cross-check.md.
//
// Usage:
//   node -r dotenv/config scripts/audit/cross-check-all.js \
//        [--strata template,tier2,static] [--only slug,slug] [--max-calls 200] \
//        [--concurrency 4] [--model gpt-4.1-mini] [--force] [--dry-run]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const LATEST = path.join(REPO, 'output', 'latest');
const AUDIT_ROOT = path.join(REPO, 'output', 'audit');
const STATE_PATH = path.join(REPO, 'output', 'audit', '_crosscheck_state.json');

const store = require('../../lib/snapshot/snapshot-store.js');
const { diffSlabs } = require('../refresh/extract-and-diff.js');
const { normalizeLlmSlabs, plausibleLlmResult } = require('../refresh/verify-with-llm.js');
const { buildExtractionPrompt, classifyAgreement } = require('../../lib/llm/reextract-prompt.js');
const { classifyExtraction, stripJsonEnvelope } = require('./sample-correctness-audit.js');

const VARIANT_FILE_SUFFIX = { regular: '', nre: '_nre', nro: '_nro', fcnr: '_fcnr', gift: '_gift' };

function parseArgs(argv) {
  const a = { strata: null, only: null, maxCalls: 200, concurrency: 4, model: null, force: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--strata') a.strata = new Set(argv[++i].split(','));
    else if (x === '--only') a.only = new Set(argv[++i].split(','));
    else if (x === '--max-calls') a.maxCalls = Number(argv[++i]) || 200;
    else if (x === '--concurrency') a.concurrency = Number(argv[++i]) || 4;
    else if (x === '--model') a.model = argv[++i];
    else if (x === '--force') a.force = true;
    else if (x === '--dry-run') a.dryRun = true;
  }
  return a;
}

function parseKey(key) {
  const m = key.match(/^(.*)__(regular|nre|nro|fcnr|gift)$/);
  if (!m) return null;
  return { slug: m[1], variant: m[2] };
}

function readShipped(slug, variant) {
  const p = path.join(LATEST, `${slug}${VARIANT_FILE_SUFFIX[variant]}_rates.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function hashSlabs(slabs) {
  return crypto.createHash('sha1').update(JSON.stringify(slabs || [])).digest('hex').slice(0, 12);
}

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // safe-write-exempt: cross-check audit output/state under output/audit/, aggregator artifact, not a per-bank canonical file.
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i]); }
  });
  await Promise.all(runners);
}

async function reextract(unit, sourceText, deps) {
  const { client, chatCompletion, model } = deps;
  const prompt = buildExtractionPrompt(unit.variant, unit.source_url, sourceText, unit.contentKind);
  const resp = await chatCompletion(client, {
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.0, response_format: { type: 'json_object' }, max_tokens: 4000,
  }, { model });
  const text = (resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
  let parsed; try { parsed = JSON.parse(stripJsonEnvelope(text)); } catch { return { slabs: null, usage: resp && resp.usage }; }
  const slabs = normalizeLlmSlabs(parsed.rate_slabs, unit.variant);
  return { slabs, usage: (resp && resp.usage) || {} };
}

async function main() {
  const args = parseArgs(process.argv);
  const reg = readJsonSafe(path.join(REPO, 'data', 'bank-domains.json')) || {};

  // enumerate variants that have a snapshot
  const variants = store.listVariants();
  const units = [];
  for (const v of variants) {
    const pk = parseKey(v.key);
    if (!pk || !v.latest) continue;
    if (args.only && !args.only.has(pk.slug)) continue;
    const shipped = readShipped(pk.slug, pk.variant);
    if (!shipped || !Array.isArray(shipped.rate_slabs) || shipped.rate_slabs.length === 0) continue;
    const cls = classifyExtraction(reg[pk.slug], shipped);
    if (args.strata && !args.strata.has(cls)) continue;
    units.push({
      slug: pk.slug, variant: pk.variant, extraction_class: cls,
      source_url: shipped.source_url || (v.latest && v.latest.source_url) || null,
      contentKind: v.latest.content_kind === 'pdf' ? 'PDF (extracted text)' : 'HTML (tags preserved for column-header context)',
      snapshot_sha: v.latest.blob_sha256, post_hoc: !!v.latest.post_hoc,
      shipped_slabs: shipped.rate_slabs, slabs_hash: hashSlabs(shipped.rate_slabs),
    });
  }

  const state = args.force ? {} : (readJsonSafe(STATE_PATH) || {});
  const toRun = units.filter((u) => {
    const prev = state[`${u.slug}|${u.variant}`];
    return !(prev && prev.snapshot_sha === u.snapshot_sha && prev.slabs_hash === u.slabs_hash);
  });
  const capped = toRun.slice(0, args.maxCalls);

  console.log(`cross-check-all: ${units.length} variants with snapshots; ${toRun.length} stale; running ${capped.length} (cap ${args.maxCalls}, concurrency ${args.concurrency})`);
  if (args.dryRun) {
    const byCls = {}; for (const u of capped) byCls[u.extraction_class] = (byCls[u.extraction_class] || 0) + 1;
    console.log('  by method:', JSON.stringify(byCls)); return;
  }

  const { createClient, chatCompletion } = require('../../lib/azure-openai-client.js');
  const client = createClient();
  const model = args.model || process.env.AZURE_OPENAI_DEPLOYMENT_MINI || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1-mini';

  const results = [];
  await runWithConcurrency(capped, args.concurrency, async (u) => {
    let agreement, nLlm = 0, diffSummary = null, note = null;
    try {
      const snap = store.getLatestSnapshot(u.slug, u.variant);
      const text = store.readTextForLlm(snap);
      const { slabs } = await reextract(u, text, { client, chatCompletion, model });
      if (!slabs || !plausibleLlmResult(slabs, u.variant)) { agreement = 'LLM_NO_DATA'; note = slabs ? 'implausible' : 'parse_failed'; }
      else {
        nLlm = slabs.length;
        const diff = diffSlabs(u.shipped_slabs, slabs);
        agreement = classifyAgreement(diff, nLlm);
        diffSummary = diff.summary;
      }
    } catch (err) { agreement = 'SKIPPED'; note = (err.message || '').slice(0, 100); }
    const rec = { bank_code: u.slug, variant: u.variant, extraction_class: u.extraction_class, agreement, n_shipped: u.shipped_slabs.length, n_llm: nLlm, post_hoc: u.post_hoc, snapshot_sha: u.snapshot_sha, diff: diffSummary, note };
    results.push(rec);
    state[`${u.slug}|${u.variant}`] = { snapshot_sha: u.snapshot_sha, slabs_hash: u.slabs_hash, agreement };
  });

  writeJson(STATE_PATH, state);
  const runDir = path.join(AUDIT_ROOT, `crosscheck-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  writeJson(path.join(runDir, 'cross-check.json'), { generated_at: new Date().toISOString(), model, results });

  // roll-up: % FULL agreement per extraction method
  const rollup = {};
  for (const r of results) {
    const b = (rollup[r.extraction_class] ||= { FULL: 0, PARTIAL: 0, DISAGREE: 0, LLM_NO_DATA: 0, SKIPPED: 0, total: 0 });
    b[r.agreement] = (b[r.agreement] || 0) + 1; b.total++;
  }
  console.log('\nAgreement by extraction method:');
  for (const [cls, b] of Object.entries(rollup)) {
    const fullPct = b.total ? ((b.FULL / b.total) * 100).toFixed(0) : 0;
    console.log(`  ${cls.padEnd(10)} FULL ${fullPct}%  (FULL ${b.FULL} / PARTIAL ${b.PARTIAL} / DISAGREE ${b.DISAGREE} / NO_DATA ${b.LLM_NO_DATA} / SKIP ${b.SKIPPED}, n=${b.total})`);
  }
  console.log(`\nReport: ${path.relative(REPO, runDir)}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { parseKey, hashSlabs };

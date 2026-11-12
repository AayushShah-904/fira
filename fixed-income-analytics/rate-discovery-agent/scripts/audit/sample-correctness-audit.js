#!/usr/bin/env node
'use strict';
//
// Sampling correctness audit (Sprint 008, Phase 2 — hybrid).
//
// Measures a per-(bank_type × extraction_method) error rate by verifying a
// stratified random sample of slabs against the Phase-1 source snapshots.
// Hybrid: an LLM judges each sampled slab; a human adjudicates the CONTRADICT
// cases via the emitted worklist. Converts "I don't have full faith" into a
// number with a confidence interval. See design/sampling-audit.md.
//
// Usage:
//   node -r dotenv/config scripts/audit/sample-correctness-audit.js \
//        [--n 20] [--seed 42] [--judge llm|none] [--only slug,slug] \
//        [--model gpt-4.1-mini] [--max-units N] [--ingest worklist.md] [--dry-run]
//
// Pure functions are exported for unit testing; the LLM judge is injectable.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const LATEST = path.join(REPO, 'output', 'latest');
const AUDIT_ROOT = path.join(REPO, 'output', 'audit');

const CURATED = new Set(['manual_image_transcription', 'manual_pdf_transcription', 'manual_transcription_from_rendered_text', 'pending_vision', 'pending_ocr', 'manual_data_entry']);
const VARIANT_SUFFIX = { '': 'regular', '_nre': 'nre', '_nro': 'nro', '_fcnr': 'fcnr', '_gift': 'gift' };
const KEY_TENURE_DAYS = [365, 730, 1095, 1825];

// ── pure helpers ────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Wilson score interval for a binomial proportion (default 95%, z=1.96).
function wilson(success, n, z = 1.96) {
  if (n === 0) return { p: 0, lo: 0, hi: 0, n: 0 };
  const p = success / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), n };
}

function slugAndVariant(file) {
  const base = file.replace(/_rates\.json$/, '');
  for (const [suf, v] of Object.entries(VARIANT_SUFFIX)) {
    if (suf && base.endsWith(suf)) return { slug: base.slice(0, -suf.length), variant: v };
  }
  return { slug: base, variant: 'regular' };
}

function classifyExtraction(regEntry, rateFile) {
  const e = regEntry || {};
  if (e.template || e.template_fcnr || e.template_gift) return 'template';
  const rm = (rateFile && rateFile.discovery_metadata && rateFile.discovery_metadata.run_method) || null;
  if (e.tier2 || (e.extraction_method && CURATED.has(e.extraction_method)) || rm === 'tier-2' || rm === 'tier2') return 'tier2';
  return 'static';
}

// Pick a bounded, representative set of slabs to verify.
function pickFocusSlabs(slabs, rand, max = 6) {
  if (!Array.isArray(slabs) || slabs.length === 0) return [];
  const withIdx = slabs.map((s, i) => ({ s, i }));
  const picked = new Map();
  // key tenures: the slab whose [min,max] covers each key day
  for (const day of KEY_TENURE_DAYS) {
    const hit = withIdx.find(({ s }) => typeof s.tenure_min_days === 'number' && typeof s.tenure_max_days === 'number' && s.tenure_min_days <= day && day <= s.tenure_max_days);
    if (hit) picked.set(hit.i, hit.s);
  }
  // top up with random slabs
  const remaining = withIdx.filter(({ i }) => !picked.has(i));
  while (picked.size < Math.min(max, slabs.length) && remaining.length) {
    const idx = Math.floor((rand ? rand() : Math.random()) * remaining.length);
    const [chosen] = remaining.splice(idx, 1);
    picked.set(chosen.i, chosen.s);
  }
  return [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => ({ index: i, slab: s }));
}

function stratify(units) {
  const strata = new Map();
  for (const u of units) {
    const key = `${u.bank_type || '(unknown)'} | ${u.extraction_class}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(u);
  }
  return strata;
}

function sampleStrata(strata, { n, seed }) {
  const rand = mulberry32(seed);
  const sample = [];
  for (const [key, members] of [...strata.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pool = [...members];
    // Fisher–Yates with the seeded RNG
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const u of pool.slice(0, n)) sample.push({ ...u, stratum: key });
  }
  return { sample, rand };
}

function parseJudgeResponse(text, focus) {
  let parsed;
  try { parsed = JSON.parse(stripJsonEnvelope(text)); } catch { return null; }
  const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  return focus.map((f, i) => {
    const v = verdicts.find((x) => x.i === i) || verdicts[i] || {};
    const verdict = ['CONFIRM', 'CONTRADICT', 'NOT_FOUND'].includes(v.verdict) ? v.verdict : 'NOT_FOUND';
    return {
      tenure_text: f.slab.tenure_text,
      claimed_general: f.slab.rate_general_pct,
      verdict,
      actual: typeof v.actual === 'number' ? v.actual : null,
      note: (v.note || '').slice(0, 200),
    };
  });
}

function stripJsonEnvelope(text) {
  const t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const brace = t.indexOf('{');
  return brace >= 0 ? t.slice(brace) : t;
}

function summarize(records) {
  // records: [{ stratum, post_hoc, slabs:[{verdict}] }]
  const byStratum = new Map();
  const all = { confirm: 0, contradict: 0, not_found: 0, contradict_posthoc: 0 };
  for (const r of records) {
    if (!byStratum.has(r.stratum)) byStratum.set(r.stratum, { confirm: 0, contradict: 0, not_found: 0, contradict_posthoc: 0, units: 0 });
    const b = byStratum.get(r.stratum);
    b.units++;
    for (const s of r.slabs) {
      if (s.verdict === 'CONFIRM') { b.confirm++; all.confirm++; }
      else if (s.verdict === 'CONTRADICT') {
        b.contradict++; all.contradict++;
        if (r.post_hoc) { b.contradict_posthoc++; all.contradict_posthoc++; }
      } else { b.not_found++; all.not_found++; }
    }
  }
  const strata = [];
  for (const [key, b] of [...byStratum.entries()].sort((a, b2) => a[0].localeCompare(b2[0]))) {
    const decided = b.confirm + b.contradict;
    const ci = wilson(b.contradict, decided);
    strata.push({
      stratum: key, units: b.units, confirm: b.confirm, contradict: b.contradict, not_found: b.not_found,
      contradict_posthoc: b.contradict_posthoc,
      error_rate: ci.p, ci_lo: ci.lo, ci_hi: ci.hi, decided,
    });
  }
  const decidedAll = all.confirm + all.contradict;
  const ciAll = wilson(all.contradict, decidedAll);
  return { strata, overall: { ...all, error_rate: ciAll.p, ci_lo: ciAll.lo, ci_hi: ciAll.hi, decided: decidedAll } };
}

// ── orchestration (I/O) ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { n: 20, seed: 42, judge: 'llm', only: null, model: null, maxUnits: Infinity, ingest: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--n') a.n = Number(argv[++i]) || 20;
    else if (x === '--seed') a.seed = Number(argv[++i]) || 42;
    else if (x === '--judge') a.judge = argv[++i];
    else if (x === '--only') a.only = new Set(argv[++i].split(','));
    else if (x === '--model') a.model = argv[++i];
    else if (x === '--max-units') a.maxUnits = Number(argv[++i]) || Infinity;
    else if (x === '--ingest') a.ingest = argv[++i];
    else if (x === '--dry-run') a.dryRun = true;
  }
  return a;
}

function loadUnits(only) {
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'bank-domains.json'), 'utf-8'));
  const cfgCache = new Map();
  const bankTypeOf = (slug) => {
    if (cfgCache.has(slug)) return cfgCache.get(slug);
    let bt = null;
    try { bt = JSON.parse(fs.readFileSync(path.join(LATEST, `${slug}_config.json`), 'utf-8')).bank_type || null; } catch { /* none */ }
    cfgCache.set(slug, bt); return bt;
  };
  const units = [];
  for (const f of fs.readdirSync(LATEST).filter((x) => x.endsWith('_rates.json'))) {
    const { slug, variant } = slugAndVariant(f);
    if (only && !only.has(slug)) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(LATEST, f), 'utf-8')); } catch { continue; }
    if (!Array.isArray(d.rate_slabs) || d.rate_slabs.length === 0) continue;
    units.push({
      slug, variant, bank_type: bankTypeOf(slug),
      extraction_class: classifyExtraction(reg[slug], d),
      slabs: d.rate_slabs, scraped_at: d.scraped_at || null, source_url: d.source_url || null,
    });
  }
  return units;
}

function buildJudgePrompt(unit, focus, sourceText) {
  const entries = focus.map((f, i) => {
    const dr = f.slab.deposit_range ? ` deposit_amount_tier=${f.slab.deposit_range}` : '';
    const cur = f.slab.currency ? ` currency=${f.slab.currency}` : '';
    return `  ${i}. tenure="${f.slab.tenure_text}" claimed_general_rate=${f.slab.rate_general_pct}${dr}${cur}`;
  }).join('\n');
  return [
    { role: 'system', content: 'You audit extracted bank fixed-deposit rates against the bank\'s own published page text. For each claimed (tenure, rate), decide whether the SOURCE TEXT supports the claimed GENERAL (non-senior) rate for that tenure. IMPORTANT: many pages publish multiple DEPOSIT-AMOUNT TIERS (e.g. "up to Rs.1 crore" vs "above Rs.1 crore", "<$5 MIO" vs ">$5 MIO") and CALLABLE vs NON-CALLABLE columns, each with a different rate for the same tenure. If the entry has a deposit_amount_tier or currency, judge the claim against THAT tier/currency\'s rate, NOT the headline retail rate. Only CONTRADICT when the value is wrong for its OWN tier. Reply ONLY JSON: {"verdicts":[{"i":<index>,"verdict":"CONFIRM|CONTRADICT|NOT_FOUND","actual":<number|null>,"note":"<short>"}]}. CONFIRM = source supports this rate for this tenure+tier (within 0.05). CONTRADICT = source shows a DIFFERENT rate for this tenure+tier (put it in actual). NOT_FOUND = tenure/rate not locatable.' },
    { role: 'user', content: `Variant: ${unit.variant}\nSource: ${unit.source_url}\n\nClaimed entries:\n${entries}\n\n--- SOURCE TEXT (truncated) ---\n${String(sourceText || '').slice(0, 14000)}` },
  ];
}

async function main() {
  const args = parseArgs(process.argv);
  const store = require('../../lib/snapshot/snapshot-store.js');

  const units = loadUnits(args.only).map((u) => u); // all candidate units
  const strata = stratify(units);
  const { sample } = sampleStrata(strata, { n: args.n, seed: args.seed });
  const limited = sample.slice(0, args.maxUnits);

  console.log(`sample-correctness-audit: ${units.length} units across ${strata.size} strata → sampling ${limited.length} (n=${args.n}/stratum, seed=${args.seed}, judge=${args.judge})`);
  if (args.dryRun) {
    const counts = {};
    for (const u of limited) counts[u.stratum] = (counts[u.stratum] || 0) + 1;
    for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
    return;
  }

  // Build the judge: injectable; default uses the snapshot + Azure OpenAI.
  let judge = audit_judge_llm;
  let client = null;
  if (args.judge === 'none') judge = audit_judge_stub;
  else {
    const { createClient, chatCompletion } = require('../../lib/azure-openai-client.js');
    client = createClient();
    const model = args.model || process.env.AZURE_OPENAI_DEPLOYMENT_MINI || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1-mini';
    judge = (unit, focus) => audit_judge_llm(unit, focus, { store, client, chatCompletion, model });
  }

  const records = [];
  const rand = mulberry32(args.seed ^ 0x9e3779b9);
  for (const u of limited) {
    const focus = pickFocusSlabs(u.slabs, rand);
    if (focus.length === 0) continue;
    const snap = store.getSnapshotAtScrapedAt(u.slug, u.variant, u.scraped_at);
    let slabVerdicts; let snapSha = null; let postHoc = false;
    if (!snap) {
      slabVerdicts = focus.map((f) => ({ tenure_text: f.slab.tenure_text, claimed_general: f.slab.rate_general_pct, verdict: 'NOT_FOUND', actual: null, note: 'no snapshot' }));
    } else {
      snapSha = snap.blob_sha256; postHoc = !!snap.post_hoc;
      slabVerdicts = await judge(u, focus, { snap });
    }
    records.push({ bank_code: u.slug, variant: u.variant, stratum: u.stratum, bank_type: u.bank_type, extraction_class: u.extraction_class, snapshot_sha: snapSha, post_hoc: postHoc, slabs: slabVerdicts });
  }

  if (args.ingest) ingestWorklist(args.ingest, records);

  const summary = summarize(records);
  const runDir = path.join(AUDIT_ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, 'records.json'), { generated_at: new Date().toISOString(), seed: args.seed, n: args.n, judge: args.judge, records });
  writeJson(path.join(runDir, 'summary.json'), summary);
  fs.writeFileSync(path.join(runDir, 'report.md'), renderReport(summary, args)); // safe-write-exempt: audit report aggregator output, not a per-bank artifact.
  fs.writeFileSync(path.join(runDir, 'worklist.md'), renderWorklist(records)); // safe-write-exempt: human adjudication worklist aggregator output.

  console.log(`\nOverall error rate: ${(summary.overall.error_rate * 100).toFixed(1)}% [${(summary.overall.ci_lo * 100).toFixed(1)}–${(summary.overall.ci_hi * 100).toFixed(1)}%] over ${summary.overall.decided} decided slabs (NOT_FOUND ${summary.overall.not_found}).`);
  for (const s of summary.strata) console.log(`  ${s.stratum.padEnd(48)} err ${(s.error_rate * 100).toFixed(1)}% [${(s.ci_lo * 100).toFixed(0)}–${(s.ci_hi * 100).toFixed(0)}] n=${s.decided} units=${s.units}`);
  console.log(`\nReport: ${path.relative(REPO, runDir)}`);
}

// LLM judge over the snapshot.
async function audit_judge_llm(unit, focus, deps) {
  const { store, client, chatCompletion, model, snap } = deps || {};
  try {
    const text = store.readTextForLlm(snap || store.getLatestSnapshot(unit.slug, unit.variant));
    const resp = await chatCompletion(client, { messages: buildJudgePrompt(unit, focus, text), temperature: 0.0, response_format: { type: 'json_object' }, max_tokens: 1500 }, { model });
    const out = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
    const parsed = parseJudgeResponse(out, focus);
    return parsed || focus.map((f) => ({ tenure_text: f.slab.tenure_text, claimed_general: f.slab.rate_general_pct, verdict: 'NOT_FOUND', actual: null, note: 'judge_parse_failed' }));
  } catch (err) {
    return focus.map((f) => ({ tenure_text: f.slab.tenure_text, claimed_general: f.slab.rate_general_pct, verdict: 'NOT_FOUND', actual: null, note: `judge_error:${(err.message || '').slice(0, 80)}` }));
  }
}
function audit_judge_stub(unit, focus) {
  return focus.map((f) => ({ tenure_text: f.slab.tenure_text, claimed_general: f.slab.rate_general_pct, verdict: 'NOT_FOUND', actual: null, note: 'judge=none' }));
}

function ingestWorklist(file, records) {
  // Worklist rows: `bank | variant | tenure | claimed | LLM-actual | HUMAN_VERDICT`
  let lines; try { lines = fs.readFileSync(file, 'utf-8').split('\n'); } catch { return; }
  const human = new Map();
  for (const ln of lines) {
    const m = ln.split('|').map((s) => s.trim());
    if (m.length >= 6 && /^(CONFIRM|CONTRADICT|NOT_FOUND)$/i.test(m[5])) human.set(`${m[0]}|${m[1]}|${m[2]}`, m[5].toUpperCase());
  }
  for (const r of records) for (const s of r.slabs) {
    const k = `${r.bank_code}|${r.variant}|${s.tenure_text}`;
    if (human.has(k)) { s.verdict = human.get(k); s.note = `${s.note} [human-adjudicated]`; }
  }
}

function renderWorklist(records) {
  const rows = [];
  for (const r of records) for (const s of r.slabs) {
    if (s.verdict === 'CONTRADICT') rows.push(`${r.bank_code} | ${r.variant} | ${s.tenure_text} | ${s.claimed_general} | ${s.actual == null ? '?' : s.actual}${r.post_hoc ? ' | (post_hoc snapshot — may be page drift)' : ' |'} | <CONFIRM|CONTRADICT|NOT_FOUND>`);
  }
  return ['# Human adjudication worklist (CONTRADICT cases)', '', 'Fill the last column, then re-run with `--ingest <thisfile>`.', '', 'bank | variant | tenure | claimed | llm_actual | note | HUMAN_VERDICT', ...rows, ''].join('\n');
}

function renderReport(summary, args) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    '# Correctness audit — measured error rate', '',
    `Seed ${args.seed}, n=${args.n}/stratum, judge=${args.judge}, generated ${new Date().toISOString()}.`,
    '', '## Overall',
    `**Error rate: ${pct(summary.overall.error_rate)}** (Wilson 95% CI ${pct(summary.overall.ci_lo)}–${pct(summary.overall.ci_hi)}) over ${summary.overall.decided} decided slabs.`,
    `NOT_FOUND: ${summary.overall.not_found}. Post-hoc CONTRADICTs (possible page drift): ${summary.overall.contradict_posthoc}.`,
    '', '## By stratum (bank_type × extraction method)', '',
    '| stratum | units | decided | error rate | 95% CI | NOT_FOUND |',
    '|---|--:|--:|--:|--:|--:|',
    ...summary.strata.map((s) => `| ${s.stratum} | ${s.units} | ${s.decided} | ${pct(s.error_rate)} | ${pct(s.ci_lo)}–${pct(s.ci_hi)} | ${s.not_found} |`),
    '',
    'Error rate = CONTRADICT / (CONFIRM + CONTRADICT). NOT_FOUND excluded from the denominator (snapshot/extraction misalignment, not a confirmed error). CONTRADICTs on `post_hoc` snapshots may be page drift — adjudicate via the worklist.',
    '',
  ];
  return lines.join('\n');
}

function writeJson(p, v) {
  // safe-write-exempt: audit output under output/audit/<ts>/, aggregator artifact, not a per-bank canonical file.
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { mulberry32, wilson, slugAndVariant, classifyExtraction, pickFocusSlabs, stratify, sampleStrata, parseJudgeResponse, summarize, stripJsonEnvelope };

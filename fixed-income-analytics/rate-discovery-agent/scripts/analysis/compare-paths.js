#!/usr/bin/env node
'use strict';

/**
 * Dual-path comparison harness.
 *
 * Runs run-discovery.js twice per bank — once with --path llm, once with
 * --path orchestrator — into separate output directories, then walks both
 * dirs and produces a markdown report comparing:
 *
 *   - Did each path complete? (config + rates files present)
 *   - Slab counts per variant
 *   - rate_general_pct per matched tenure (within ±5 bps tolerance)
 *   - extraction_method recorded in _rates.json
 *   - effective_date populated?
 *   - AOAI tokens used (from <bank_code>.summary.json)
 *   - Wall-clock per attempt
 *
 * Two modes:
 *
 *   --live  Spawns run-discovery.js for each bank under both paths. Requires
 *           Azure OpenAI credentials in env. AOAI tokens cost real money.
 *           Each bank runs sequentially to keep the comparison clean.
 *
 *   --dry   No spawning. Reads two pre-existing run directories and diffs
 *           them. Useful for re-running the report logic against captured
 *           runs without re-paying AOAI costs.
 *
 * Usage:
 *
 *   node scripts/analysis/compare-paths.js \
 *     --banks "State Bank of India:PSB:Maharashtra,HDFC Bank Limited:PVB:" \
 *     --live \
 *     --out output/runs/compare-<ts>/
 *
 *   node scripts/analysis/compare-paths.js --dry \
 *     --llm-dir output/runs/llm-batch-2026-05-16/ \
 *     --orch-dir output/runs/orch-batch-2026-05-16/ \
 *     --out output/runs/compare-2026-05-16/
 *
 * The --banks list is a comma-separated set of "Name:type:state" tuples.
 * type is the bank_type code (PSB, PVB, IBU, SUCB, ...). state is optional.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function usage(msg) {
  if (msg) console.error('error:', msg);
  console.error('See header of', __filename, 'for usage.');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { live: false, dry: false, banks: '', llmDir: '', orchDir: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') opts.live = true;
    else if (a === '--dry') opts.dry = true;
    else if (a === '--banks' && argv[i + 1]) opts.banks = argv[++i];
    else if (a === '--llm-dir' && argv[i + 1]) opts.llmDir = argv[++i];
    else if (a === '--orch-dir' && argv[i + 1]) opts.orchDir = argv[++i];
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
  }
  return opts;
}

// ── live mode: spawn run-discovery.js per bank under each path ─────────
async function runLive(opts) {
  const banks = parseBanks(opts.banks);
  if (banks.length === 0) usage('--banks parsed to empty list');

  const llmRoot = path.join(opts.out, 'llm');
  const orchRoot = path.join(opts.out, 'orch');
  fs.mkdirSync(llmRoot, { recursive: true });
  fs.mkdirSync(orchRoot, { recursive: true });

  for (const b of banks) {
    for (const pathChoice of ['llm', 'orchestrator']) {
      const slug = slugifyForFolder(b.name);
      const targetRoot = pathChoice === 'llm' ? llmRoot : orchRoot;
      const runDir = path.join(targetRoot, slug);
      fs.mkdirSync(runDir, { recursive: true });
      const argv = [
        path.join(REPO_ROOT, 'run-discovery.js'),
        b.name,
        '--path', pathChoice,
        '--output-dir', runDir,
      ];
      if (b.category) argv.push('--category', b.category);
      if (b.state) argv.push('--state', b.state);
      console.log(`>>> ${pathChoice.padEnd(13)} ${b.name}`);
      const t0 = Date.now();
      const r = spawnSync(process.execPath, argv, {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 600000, // 10 min per bank per path
      });
      const ms = Date.now() - t0;
      console.log(`<<< ${pathChoice.padEnd(13)} ${b.name}  exit=${r.status}  ${ms}ms`);
    }
  }

  return { llmDir: llmRoot, orchDir: orchRoot };
}

function parseBanks(s) {
  return s.split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    const [name, type, state] = t.split(':').map((x) => (x || '').trim());
    return { name, category: type ? typeToCategory(type) : '', state: state || '', bank_type: type || '' };
  });
}

const TYPE_TO_CATEGORY = {
  PSB: 'Public Sector Bank',
  PVB: 'Private Sector Bank (Indian)',
  SFB: 'Small Finance Bank',
  PB: 'Payments Bank',
  FB: 'Foreign Bank',
  RRB: 'Regional Rural Bank',
  SUCB: 'Scheduled Urban Co-operative Bank',
  NSUCB: 'Non-Scheduled Urban Co-operative Bank',
  SSCB: 'Scheduled State Co-operative Bank',
  DCCB: 'District Central Co-operative Bank',
  LAB: 'Local Area Bank',
  FI: 'Financial Institution',
  IBU: 'IFSC Banking Unit (IFSCA)',
};
function typeToCategory(t) { return TYPE_TO_CATEGORY[t] || t; }

function slugifyForFolder(name) {
  return name.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

// ── compare two run dirs ──────────────────────────────────────────────
function compareDirs(llmDir, orchDir) {
  // Each dir contains one subdir per bank, or files directly. We support both.
  const llmBanks = collectBankSlugs(llmDir);
  const orchBanks = collectBankSlugs(orchDir);
  const allSlugs = new Set([...llmBanks.keys(), ...orchBanks.keys()]);

  const perBank = [];
  for (const slug of [...allSlugs].sort()) {
    perBank.push(compareBank(slug, llmBanks.get(slug), orchBanks.get(slug)));
  }
  return perBank;
}

/**
 * Walk a root and return a map slug → {root, files: Set<filename>}. We
 * accept two layouts:
 *   1. root/<slug>/<files>          (per-bank subfolder, used by --live)
 *   2. root/<slug>_config.json...   (flat dir, used by batch runs)
 */
function collectBankSlugs(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  // Pass 1: per-bank subdirectories
  for (const e of entries) {
    if (e.isDirectory()) {
      const subRoot = path.join(root, e.name);
      const files = fs.readdirSync(subRoot);
      const slug = inferSlug(files) || e.name;
      map.set(slug, { root: subRoot, files: new Set(files) });
    }
  }
  // Pass 2: flat layout — collect all files, then derive slugs from _config.json
  // or *_rates.json (orchestrator-only runs may lack _config.json — see
  // sdlc/sprints/sprint-003/design/two-path-architecture.md).
  const flatFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  const slugSet = new Set();
  for (const f of flatFiles) {
    if (f.endsWith('_config.json')) slugSet.add(f.replace(/_config\.json$/, ''));
    else {
      const m = f.match(/^(.+?)(_(?:nre|nro|fcnr|gift))?_rates\.json$/);
      if (m) slugSet.add(m[1]);
    }
  }
  for (const slug of slugSet) {
    if (map.has(slug)) continue; // subdirectory already claimed it
    const allFiles = flatFiles.filter((f) => f.startsWith(slug + '_') || f === `${slug}.log` || f === `${slug}.summary.json` || f === `${slug}.trace.jsonl`);
    map.set(slug, { root, files: new Set(allFiles) });
  }
  return map;
}

function inferSlug(files) {
  const configFile = files.find((f) => f.endsWith('_config.json'));
  if (configFile) return configFile.replace(/_config\.json$/, '');
  const ratesFile = files.find((f) => /_rates\.json$/.test(f));
  if (ratesFile) return ratesFile.replace(/(_(?:nre|nro|fcnr|gift))?_rates\.json$/, '');
  return null;
}

function compareBank(slug, llm, orch) {
  const row = {
    slug,
    llm_present: !!llm,
    orch_present: !!orch,
    variants: {}, // variant → { llm_slabs, orch_slabs, slab_diffs[], extraction_method_match }
    summary: {},  // {llm: {tokens,wall_ms,path}, orch: {...}}
  };

  // ── Per-variant slab comparison ─────────────────────────────────
  const variants = ['regular', 'nre', 'nro', 'fcnr', 'gift'];
  for (const v of variants) {
    const llmRates = llm ? loadRatesFor(llm, slug, v) : null;
    const orchRates = orch ? loadRatesFor(orch, slug, v) : null;
    if (!llmRates && !orchRates) continue;
    row.variants[v] = compareVariantRates(llmRates, orchRates);
  }

  // ── Summary comparison ─────────────────────────────────────────
  row.summary.llm = loadSummaryFor(llm, slug);
  row.summary.orch = loadSummaryFor(orch, slug);

  return row;
}

function loadRatesFor(dirInfo, slug, variant) {
  if (!dirInfo) return null;
  const fname = variant === 'regular' ? `${slug}_rates.json` : `${slug}_${variant}_rates.json`;
  const p = path.join(dirInfo.root, fname);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadSummaryFor(dirInfo, slug) {
  if (!dirInfo) return null;
  const p = path.join(dirInfo.root, `${slug}.summary.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function compareVariantRates(llmRates, orchRates) {
  const out = {
    llm_slabs: llmRates?.rate_slabs?.length || 0,
    orch_slabs: orchRates?.rate_slabs?.length || 0,
    slab_diffs: [],
    extraction_method_llm: llmRates?.extraction_method || null,
    extraction_method_orch: orchRates?.extraction_method || null,
    effective_date_llm: llmRates?.effective_date || null,
    effective_date_orch: orchRates?.effective_date || null,
  };
  if (!llmRates || !orchRates) return out;

  // Slab identity = (tenure_min, tenure_max, currency, deposit_range). Many
  // banks publish multiple deposit-range tiers (below_3cr / 3cr_to_5cr / ...)
  // for the same tenure × currency, so deposit_range is essential to keying.
  // Map → array per key handles intra-file ties.
  const key = (s) => `${s.tenure_min_days}|${s.tenure_max_days}|${s.currency || 'INR'}|${s.deposit_range || 'below_3cr'}`;
  const orchByKey = new Map();
  for (const s of (orchRates.rate_slabs || [])) {
    const k = key(s);
    if (!orchByKey.has(k)) orchByKey.set(k, []);
    orchByKey.get(k).push(s);
  }

  for (const lSlab of llmRates.rate_slabs || []) {
    const k = key(lSlab);
    const bucket = orchByKey.get(k);
    if (!bucket || bucket.length === 0) {
      out.slab_diffs.push({ tenure: lSlab.tenure_text, currency: lSlab.currency || 'INR', deposit_range: lSlab.deposit_range || 'below_3cr', kind: 'orch_missing' });
      continue;
    }
    const oSlab = bucket.shift(); // consume one match
    const general_diff_bps = bpsDiff(lSlab.rate_general_pct, oSlab.rate_general_pct);
    const senior_diff_bps = bpsDiff(lSlab.rate_senior_pct, oSlab.rate_senior_pct);
    if (general_diff_bps > 5 || senior_diff_bps > 5) {
      out.slab_diffs.push({
        tenure: lSlab.tenure_text, currency: lSlab.currency || 'INR', deposit_range: lSlab.deposit_range || 'below_3cr',
        kind: 'rate_drift', general_bps: general_diff_bps, senior_bps: senior_diff_bps,
        llm: { gen: lSlab.rate_general_pct, sr: lSlab.rate_senior_pct },
        orch: { gen: oSlab.rate_general_pct, sr: oSlab.rate_senior_pct },
      });
    }
  }
  for (const bucket of orchByKey.values()) {
    for (const oSlab of bucket) {
      out.slab_diffs.push({ tenure: oSlab.tenure_text, currency: oSlab.currency || 'INR', deposit_range: oSlab.deposit_range || 'below_3cr', kind: 'llm_missing' });
    }
  }
  return out;
}

function bpsDiff(a, b) {
  if (a == null && b == null) return 0;
  if (a == null || b == null) return 9999;
  return Math.round(Math.abs(a - b) * 100); // 1% = 100 bps
}

// ── Markdown report ───────────────────────────────────────────────────
function renderReport(rows, llmDir, orchDir) {
  const lines = [];
  lines.push(`# Dual-path comparison report`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`LLM runs:           \`${llmDir}\``);
  lines.push(`Orchestrator runs:  \`${orchDir}\``);
  lines.push('');

  // Aggregate
  const totals = aggregate(rows);
  lines.push(`## Aggregate`);
  lines.push('');
  lines.push(`| Metric | LLM | Orchestrator |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| Banks present | ${totals.banks_with_llm} | ${totals.banks_with_orch} |`);
  lines.push(`| Banks both paths produced output | ${totals.banks_both} | — |`);
  lines.push(`| Total variant rate-files | ${totals.variants_llm} | ${totals.variants_orch} |`);
  lines.push(`| Total slabs | ${totals.slabs_llm} | ${totals.slabs_orch} |`);
  lines.push(`| Banks with rate drift > 5bps on any slab | ${totals.banks_with_drift} | — |`);
  lines.push(`| Banks where one path missing slabs the other has | ${totals.banks_with_missing} | — |`);
  if (totals.tokens_llm != null || totals.tokens_orch != null) {
    lines.push(`| AOAI total prompt tokens | ${totals.tokens_llm ?? '?'} | ${totals.tokens_orch ?? '?'} |`);
    lines.push(`| AOAI total completion tokens | ${totals.completion_llm ?? '?'} | ${totals.completion_orch ?? '?'} |`);
  }
  lines.push(`| Mean wall-clock per bank (ms) | ${totals.mean_wall_llm} | ${totals.mean_wall_orch} |`);
  lines.push('');

  // Per-bank
  lines.push(`## Per-bank detail`);
  lines.push('');
  for (const row of rows) {
    lines.push(`### ${row.slug}`);
    if (!row.llm_present || !row.orch_present) {
      lines.push(`- present in LLM: ${row.llm_present}, present in orch: ${row.orch_present}`);
      lines.push('');
      continue;
    }
    lines.push(`| variant | LLM slabs | orch slabs | drift slabs | missing slabs |`);
    lines.push(`|---|---:|---:|---:|---|`);
    for (const [v, vd] of Object.entries(row.variants)) {
      const drift = vd.slab_diffs.filter((d) => d.kind === 'rate_drift').length;
      const missing = vd.slab_diffs.filter((d) => d.kind !== 'rate_drift').length;
      lines.push(`| ${v} | ${vd.llm_slabs} | ${vd.orch_slabs} | ${drift} | ${missing} |`);
    }
    const lSum = row.summary.llm, oSum = row.summary.orch;
    if (lSum || oSum) {
      lines.push('');
      lines.push(`Tokens — LLM: ${lSum?.input_tokens ?? '?'} in / ${lSum?.output_tokens ?? '?'} out, orch: ${oSum?.input_tokens ?? '?'} in / ${oSum?.output_tokens ?? '?'} out`);
      lines.push(`Wall-clock — LLM: ${lSum?.wall_clock_ms ?? '?'}ms, orch: ${oSum?.wall_clock_ms ?? '?'}ms`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function aggregate(rows) {
  const t = {
    banks_with_llm: 0, banks_with_orch: 0, banks_both: 0,
    variants_llm: 0, variants_orch: 0,
    slabs_llm: 0, slabs_orch: 0,
    banks_with_drift: 0, banks_with_missing: 0,
    tokens_llm: 0, tokens_orch: 0,
    completion_llm: 0, completion_orch: 0,
    sum_wall_llm: 0, sum_wall_orch: 0, count_wall_llm: 0, count_wall_orch: 0,
  };
  for (const r of rows) {
    if (r.llm_present) t.banks_with_llm++;
    if (r.orch_present) t.banks_with_orch++;
    if (r.llm_present && r.orch_present) t.banks_both++;
    let hadDrift = false, hadMissing = false;
    for (const [, vd] of Object.entries(r.variants)) {
      if (vd.llm_slabs > 0) { t.variants_llm++; t.slabs_llm += vd.llm_slabs; }
      if (vd.orch_slabs > 0) { t.variants_orch++; t.slabs_orch += vd.orch_slabs; }
      for (const d of vd.slab_diffs) {
        if (d.kind === 'rate_drift') hadDrift = true;
        else hadMissing = true;
      }
    }
    if (hadDrift) t.banks_with_drift++;
    if (hadMissing) t.banks_with_missing++;

    if (r.summary.llm) {
      t.tokens_llm += r.summary.llm.input_tokens || 0;
      t.completion_llm += r.summary.llm.output_tokens || 0;
      if (r.summary.llm.wall_clock_ms) { t.sum_wall_llm += r.summary.llm.wall_clock_ms; t.count_wall_llm++; }
    }
    if (r.summary.orch) {
      t.tokens_orch += r.summary.orch.input_tokens || 0;
      t.completion_orch += r.summary.orch.output_tokens || 0;
      if (r.summary.orch.wall_clock_ms) { t.sum_wall_orch += r.summary.orch.wall_clock_ms; t.count_wall_orch++; }
    }
  }
  t.mean_wall_llm = t.count_wall_llm ? Math.round(t.sum_wall_llm / t.count_wall_llm) : '?';
  t.mean_wall_orch = t.count_wall_orch ? Math.round(t.sum_wall_orch / t.count_wall_orch) : '?';
  return t;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.out) usage('--out is required');
  if (opts.live === opts.dry) usage('exactly one of --live or --dry required');
  if (opts.live && !opts.banks) usage('--live requires --banks');
  if (opts.dry && (!opts.llmDir || !opts.orchDir)) usage('--dry requires --llm-dir and --orch-dir');
  fs.mkdirSync(opts.out, { recursive: true });

  let llmDir, orchDir;
  if (opts.live) {
    const r = await runLive(opts);
    llmDir = r.llmDir;
    orchDir = r.orchDir;
  } else {
    llmDir = opts.llmDir;
    orchDir = opts.orchDir;
  }

  const rows = compareDirs(llmDir, orchDir);
  const report = renderReport(rows, llmDir, orchDir);
  const reportPath = path.join(opts.out, 'report.md');
  // safe-write-exempt: analysis report under output/runs/compare-<ts>/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(reportPath, report);
  console.log(`Wrote ${reportPath}`);

  // safe-write-exempt: machine-readable analysis dump (sibling of report.md); not a per-bank canonical artifact.
  fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify({ llmDir, orchDir, rows }, null, 2));
  console.log(`Wrote ${path.join(opts.out, 'report.json')}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

// Exports for unit testing.
module.exports = {
  _compareVariantRates: compareVariantRates,
  _bpsDiff: bpsDiff,
  _aggregate: aggregate,
  _inferSlug: inferSlug,
  _parseBanks: parseBanks,
};

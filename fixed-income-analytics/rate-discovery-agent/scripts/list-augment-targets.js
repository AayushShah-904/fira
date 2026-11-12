#!/usr/bin/env node
'use strict';

/**
 * Scan `output/latest/` after a cloud cohort run and emit the slug list
 * of banks that need a local-augment pass.
 *
 * A bank goes into the augment list if any of:
 *   1. `<slug>.partial_silent.json` marker exists (drift after MAX_ATTEMPTS).
 *   2. `<slug>_config.json` is missing (cloud failed before producing config).
 *   3. `<slug>_rates.json` has 0 slabs (extraction_failed).
 *   4. New total slab count (sum of all variants) is <0.8 × prior pack's
 *      count for the same bank (pack-comparison drift). Only checked when
 *      --previous-pack is provided.
 *
 * Also emits a per-bank tally report markdown for sdlc/sprints/.
 *
 * Usage:
 *   node scripts/list-augment-targets.js \
 *     --cohort pm-refresh-2026-q2 \
 *     [--previous-pack pack/dist/rates-pack.json] \
 *     [--latest-dir output/latest] \
 *     [--out output/runs/<label>/augment-list.txt] \
 *     [--report sdlc/sprints/sprint-004/implementation/<label>-cloud-tally.md]
 *
 * Sprint 4 Track A 2026-05-20 — ships alongside PM rate-pack refresh
 * (see sdlc/sprints/sprint-004/plan/pm-rate-pack-refresh-2026-q2.md).
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadCohort } = require('./utils/load-cohort');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_LATEST = path.join(PROJECT_ROOT, 'output', 'latest');
const DEFAULT_PACK = path.join(PROJECT_ROOT, 'pack', 'dist', 'rates-pack.json');

const VARIANT_SUFFIXES = {
  regular: '_rates.json',
  nre: '_nre_rates.json',
  nro: '_nro_rates.json',
  fcnr: '_fcnr_rates.json',
  gift: '_gift_rates.json',
};

const DRIFT_THRESHOLD = 0.8;  // same threshold as lib/tier-router.js#checkQuality

function parseArgs(argv) {
  const opts = {
    cohort: '',
    previousPack: '',  // empty = skip pack-comparison drift check
    latestDir: DEFAULT_LATEST,
    out: '',
    report: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--cohort' && argv[i + 1]) opts.cohort = argv[++i];
    else if (a === '--previous-pack' && argv[i + 1]) opts.previousPack = argv[++i];
    else if (a === '--latest-dir' && argv[i + 1]) opts.latestDir = argv[++i];
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (a === '--report' && argv[i + 1]) opts.report = argv[++i];
    else { console.error('Unknown arg:', a); opts.help = true; }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/list-augment-targets.js --cohort <name> [options]

Scan output/latest/ after a cloud cohort run; emit augment-list.txt + tally.

Required:
  --cohort <name>          Cohort name (reads data/cohorts/<name>.json)

Optional:
  --previous-pack <path>   Previous pack JSON for slab-count diff (default: pack/dist/rates-pack.json)
  --latest-dir <path>      Override output/latest/ location
  --out <path>             Write augment slug list (newline-separated)
  --report <path>          Write tally markdown report
`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function countVariantSlabs(latestDir, bankCode) {
  const counts = {};
  let total = 0;
  for (const [variant, suffix] of Object.entries(VARIANT_SUFFIXES)) {
    const f = path.join(latestDir, `${bankCode}${suffix}`);
    if (!fs.existsSync(f)) continue;
    const data = readJson(f);
    const n = (data?.rate_slabs || []).length;
    counts[variant] = n;
    total += n;
  }
  return { counts, total };
}

function loadPreviousPackCounts(packPath) {
  if (!packPath) return null;
  const data = readJson(packPath);
  if (!data || !Array.isArray(data.banks)) return null;
  // Pack shape: data.banks[].rates is { regular: { rate_slabs: [...] }, nre: {...} }
  // Compute total slab count per bank.
  const out = new Map();
  for (const b of data.banks) {
    const slug = b.bank_code || b.code || b.slug;
    if (!slug) continue;
    let total = 0;
    const variants = b.rates || {};
    for (const v of Object.values(variants)) {
      if (v && Array.isArray(v.rate_slabs)) total += v.rate_slabs.length;
    }
    out.set(slug, total);
  }
  return out;
}

function categoriseBank(latestDir, bankCode, prevTotals) {
  const reasons = [];

  const configExists = fs.existsSync(path.join(latestDir, `${bankCode}_config.json`));
  if (!configExists) reasons.push('no_config');

  const markerExists = fs.existsSync(path.join(latestDir, `${bankCode}.partial_silent.json`));
  if (markerExists) reasons.push('partial_silent');

  const { counts, total } = countVariantSlabs(latestDir, bankCode);
  if (configExists && total === 0) reasons.push('zero_slabs');

  let prevTotal = null;
  if (prevTotals && prevTotals.has(bankCode)) {
    prevTotal = prevTotals.get(bankCode);
    if (prevTotal > 0 && total < DRIFT_THRESHOLD * prevTotal) {
      reasons.push(`pack_drop(${total}/${prevTotal})`);
    }
  }

  return { reasons, total, prevTotal, counts };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); return 0; }
  if (!opts.cohort) { console.error('--cohort is required'); printUsage(); return 1; }

  let cohort;
  try {
    cohort = loadCohort(opts.cohort);
  } catch (err) {
    console.error(`Failed to load cohort: ${err.message}`);
    return 1;
  }

  const prevTotals = opts.previousPack
    ? loadPreviousPackCounts(opts.previousPack)
    : (fs.existsSync(DEFAULT_PACK) ? loadPreviousPackCounts(DEFAULT_PACK) : null);
  if (prevTotals) {
    console.error(`Loaded previous pack: ${prevTotals.size} banks`);
  } else {
    console.error('No previous pack loaded — pack-comparison drift check disabled');
  }

  const augment = [];
  const passed = [];
  const rows = [];

  for (const entry of cohort) {
    const slug = entry.bank_code;
    const cat = categoriseBank(opts.latestDir, slug, prevTotals);
    rows.push({ slug, category: entry.category || '', ...cat });
    if (cat.reasons.length > 0) augment.push({ slug, reasons: cat.reasons, total: cat.total, prev: cat.prevTotal });
    else passed.push({ slug, total: cat.total });
  }

  augment.sort((a, b) => a.slug.localeCompare(b.slug));

  // Write augment-list.txt
  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    // safe-write-exempt: operator-driven augment slug list (not a per-bank artifact). ADR-012 §"NOT in scope".
    fs.writeFileSync(opts.out, augment.map((a) => a.slug).join('\n') + '\n', 'utf-8');
    console.error(`Wrote ${augment.length} slug(s) to ${path.relative(process.cwd(), opts.out)}`);
  } else {
    for (const a of augment) {
      console.log(a.slug);
    }
  }

  // Console summary (also dumped if --report is set)
  console.error('');
  console.error(`Cohort:    ${opts.cohort} (${cohort.length} banks)`);
  console.error(`Passed:    ${passed.length}`);
  console.error(`Augment:   ${augment.length}`);
  const reasonCounts = {};
  for (const a of augment) for (const r of a.reasons) reasonCounts[r.split('(')[0]] = (reasonCounts[r.split('(')[0]] || 0) + 1;
  for (const [r, n] of Object.entries(reasonCounts).sort((x, y) => y[1] - x[1])) {
    console.error(`  ${r.padEnd(20)} ${n}`);
  }

  // Markdown report
  if (opts.report) {
    fs.mkdirSync(path.dirname(opts.report), { recursive: true });
    const lines = [];
    lines.push(`# Cohort tally — ${opts.cohort} (${new Date().toISOString()})`);
    lines.push('');
    lines.push(`- Cohort size: **${cohort.length}**`);
    lines.push(`- Passed: **${passed.length}**`);
    lines.push(`- Augment-list: **${augment.length}**`);
    lines.push('');
    lines.push('## Failure reasons');
    lines.push('');
    lines.push('| Reason | Count |');
    lines.push('|---|---:|');
    for (const [r, n] of Object.entries(reasonCounts).sort((x, y) => y[1] - x[1])) {
      lines.push(`| ${r} | ${n} |`);
    }
    lines.push('');
    if (prevTotals) {
      // top 10 gains, top 10 losses by absolute delta
      const deltas = rows
        .filter((r) => prevTotals.has(r.slug) && prevTotals.get(r.slug) > 0)
        .map((r) => ({ slug: r.slug, now: r.total, prev: prevTotals.get(r.slug), delta: r.total - prevTotals.get(r.slug) }));
      deltas.sort((a, b) => b.delta - a.delta);
      lines.push('## Top 10 slab GAINS vs previous pack');
      lines.push('');
      lines.push('| Bank | Prev | Now | Δ |');
      lines.push('|---|---:|---:|---:|');
      for (const d of deltas.slice(0, 10)) lines.push(`| ${d.slug} | ${d.prev} | ${d.now} | +${d.delta} |`);
      lines.push('');
      lines.push('## Top 10 slab LOSSES vs previous pack');
      lines.push('');
      lines.push('| Bank | Prev | Now | Δ |');
      lines.push('|---|---:|---:|---:|');
      deltas.sort((a, b) => a.delta - b.delta);
      for (const d of deltas.slice(0, 10)) lines.push(`| ${d.slug} | ${d.prev} | ${d.now} | ${d.delta} |`);
      lines.push('');
    }
    lines.push('## Augment list (loud)');
    lines.push('');
    lines.push('| Bank | Reasons | Now | Prev |');
    lines.push('|---|---|---:|---:|');
    for (const a of augment) {
      lines.push(`| ${a.slug} | ${a.reasons.join(', ')} | ${a.total} | ${a.prev != null ? a.prev : '—'} |`);
    }
    // safe-write-exempt: operator-driven markdown tally report (not a per-bank artifact). ADR-012 §"NOT in scope".
    fs.writeFileSync(opts.report, lines.join('\n') + '\n', 'utf-8');
    console.error(`Wrote report to ${path.relative(process.cwd(), opts.report)}`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main() || 0);
}

module.exports = { categoriseBank, loadPreviousPackCounts };

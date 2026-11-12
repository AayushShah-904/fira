#!/usr/bin/env node
'use strict';
// Build the PM deliverable set from a rates pack — per NRI variant
// (nre / nro / fcnr / gift), mirroring the output/pm-2026-06-11 shape
// (PM brief written separately):
//   output/pm-<date>/<variant>-rates-<date>.csv    one row per (bank, currency, tenure), ISO currencies
//   output/pm-<date>/<variant>-banks-<date>.json   variant subset of the pack (source_url + scraped_at per bank)
//   stdout: stats block for the brief (per-variant coverage + freshness windows)
//
// Usage: node scripts/pack/build-pm-deliverable.js --date 2026-07-07 [--pack <path>] [--variants fcnr,nre,...]
//   --pack:     source pack JSON (default pack/dist/rates-pack.json). Use for
//               packs downloaded from the cloud rates-pack container.
//   --variants: comma list (default nre,nro,fcnr,gift)
// Sprint 011 A7 (D1 approved 2026-07-07); generalized from FCNR-only to all
// NRI variants on 2026-07-08 (PM clarified full-NRI scope).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const dIdx = argv.indexOf('--date');
if (dIdx < 0 || !argv[dIdx + 1]) {
  console.error('Usage: node scripts/pack/build-pm-deliverable.js --date YYYY-MM-DD [--pack <path>] [--variants nre,nro,fcnr,gift]');
  process.exit(1);
}
const DATE = argv[dIdx + 1];
const pIdx = argv.indexOf('--pack');
const PACK_PATH = pIdx >= 0 && argv[pIdx + 1]
  ? path.resolve(argv[pIdx + 1])
  : path.join(ROOT, 'pack', 'dist', 'rates-pack.json');
const vIdx = argv.indexOf('--variants');
const VARIANTS = (vIdx >= 0 && argv[vIdx + 1] ? argv[vIdx + 1].split(',') : ['nre', 'nro', 'fcnr', 'gift'])
  .map((s) => s.trim().toLowerCase()).filter(Boolean);
const OUT_DIR = path.join(ROOT, 'output', `pm-${DATE}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));

const normCurrency = (c) => {
  if (!c) return c;
  const u = String(c).toUpperCase().trim();
  if (u === 'EURO') return 'EUR';
  if (u === 'YEN') return 'JPY';
  return u;
};

const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_HEADER = ['bank_code', 'bank_name', 'category', 'currency', 'tenure_text', 'tenure_min_days', 'tenure_max_days', 'rate_pct', 'deposit_range', 'effective_date', 'scraped_at', 'stale', 'source_url'];
const now = new Date(`${DATE}T23:59:59Z`).getTime();

const stats = { pack_generated_at: pack.generated_at, total_slabs: pack.counts.total_slabs, banks_total: pack.counts.banks_total, variants: {} };

for (const variant of VARIANTS) {
  const banksOut = [];
  const csvRows = [CSV_HEADER];
  const currencies = new Set();
  const freshness = { '<=7d': 0, '8-30d': 0, '31-60d': 0, '61-90d': 0, 'older': 0 };
  let slabTotal = 0;
  let dated = 0;

  for (const bank of pack.banks) {
    const fd = bank.products && bank.products.fd;
    const f = fd && fd[variant];
    if (!f || !Array.isArray(f.slabs) || f.slabs.length === 0) continue;

    banksOut.push({
      bank_code: bank.bank_code,
      bank_name: bank.bank_name,
      category: bank.category,
      effective_date: f.effective_date || null,
      scraped_at: f.scraped_at || null,
      extraction_confidence: f.extraction_confidence || null,
      stale: !!f.stale,
      source_url: f.source_url || null,
      slab_count: f.slabs.length,
      slabs: f.slabs.map((s) => ({ ...s, currency: normCurrency(s.currency) })),
    });
    slabTotal += f.slabs.length;
    if (f.effective_date) dated++;

    const ageMs = now - new Date(f.scraped_at || 0).getTime();
    const d = ageMs / 86400000;
    if (d <= 7) freshness['<=7d']++;
    else if (d <= 30) freshness['8-30d']++;
    else if (d <= 60) freshness['31-60d']++;
    else if (d <= 90) freshness['61-90d']++;
    else freshness.older++;

    for (const s of f.slabs) {
      const ccy = normCurrency(s.currency);
      if (ccy) currencies.add(ccy);
      csvRows.push([
        bank.bank_code, bank.bank_name, bank.category, ccy || '',
        s.tenure_text || '', s.tenure_min_days ?? '', s.tenure_max_days ?? '',
        s.rate_general_pct ?? '', s.deposit_range || '',
        f.effective_date || '', f.scraped_at || '', f.stale ? 'stale' : '',
        f.source_url || '',
      ].map(csvEscape).join(','));
    }
  }

  const csvPath = path.join(OUT_DIR, `${variant}-rates-${DATE}.csv`);
  fs.writeFileSync(csvPath, csvRows.map((r) => (Array.isArray(r) ? r.map(csvEscape).join(',') : r)).join('\n') + '\n');
  const jsonPath = path.join(OUT_DIR, `${variant}-banks-${DATE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ generated_at: `${DATE}`, variant, source_pack: pack.generated_at, banks: banksOut }, null, 2));

  console.log(`Wrote ${csvPath} (${csvRows.length - 1} rows)`);
  console.log(`Wrote ${jsonPath} (${banksOut.length} banks)`);

  stats.variants[variant] = {
    banks: banksOut.length,
    slabs: slabTotal,
    currencies: [...currencies].sort(),
    with_effective_date: dated,
    freshness_by_scraped_at: freshness,
  };
}

console.log('--- stats for brief ---');
console.log(JSON.stringify(stats, null, 1));

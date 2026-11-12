#!/usr/bin/env node
'use strict';

// Build an FCNR-only pack for PM delivery — reads all _fcnr_rates.json files
// in output/latest/ that were scraped today and emits:
//   1) output/pm-2026-06-15/fcnr-only-pack-2026-06-15.json   (denormalised pack)
//   2) output/pm-2026-06-15/fcnr-rates-2026-06-15.csv         (flat rate rows)
//   3) output/pm-2026-06-15/fcnr-coverage-2026-06-15.json     (per-bank summary)
//
// Excluded by operator (no refresh attempted / not publicly published):
//   - jammu-kashmir-bank-limited
//   - bombay-mercantile-co-operative-bank-limited
//   - ujjivan-small-finance-bank-limited
// These keep their previous-pack snapshots (handled by the chooser).

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LATEST = path.join(PROJECT_ROOT, 'output', 'latest');
const COHORT = require(path.join(PROJECT_ROOT, 'data', 'cohorts', 'fcnr-refresh-2026-06-11.json'));
const OUT_DIR = path.join(PROJECT_ROOT, 'output', 'pm-2026-06-15');
const RUN_START = '2026-06-15T00:00:00Z';
const TODAY = '2026-06-15';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Currency normalisation per Sprint 010 convention
function normCurrency(c) {
  if (!c) return c;
  const u = String(c).toUpperCase().trim();
  if (u === 'EURO') return 'EUR';
  if (u === 'YEN') return 'JPY';
  return u;
}

const cohortByCode = new Map(COHORT.map(e => [e.bank_code, e]));
const banks = [];
let totalSlabs = 0;
const allCurrencies = new Set();
const freshnessBucket = { '<=7d': 0, '8-14d': 0, '15-30d': 0, '31-60d': 0, '61-90d': 0, 'older': 0, 'no_date': 0 };
const verifiedCount = { yes: 0, no: 0 };
const today = new Date(TODAY).getTime();

for (const entry of COHORT) {
  const bc = entry.bank_code;
  const fcnrPath = path.join(LATEST, `${bc}_fcnr_rates.json`);
  const j = readJsonSafe(fcnrPath);
  if (!j || !Array.isArray(j.rate_slabs) || j.rate_slabs.length === 0) continue;
  if (!j.scraped_at || j.scraped_at < RUN_START) continue;          // only banks refreshed today

  // Bucket freshness by effective_date if present, else by scraped_at
  const dateStr = j.effective_date || j.scraped_at;
  let bucket = 'no_date';
  if (dateStr) {
    const d = new Date(dateStr).getTime();
    if (Number.isFinite(d)) {
      const days = Math.round((today - d) / (24 * 3600 * 1000));
      bucket = days <= 7 ? '<=7d'
        : days <= 14 ? '8-14d'
        : days <= 30 ? '15-30d'
        : days <= 60 ? '31-60d'
        : days <= 90 ? '61-90d'
        : 'older';
    }
  }
  freshnessBucket[bucket]++;
  (j.verified_against_source ? verifiedCount.yes++ : verifiedCount.no++);

  const slabs = j.rate_slabs.map(s => ({
    ...s,
    currency: normCurrency(s.currency),
  }));
  totalSlabs += slabs.length;
  slabs.forEach(s => s.currency && allCurrencies.add(s.currency));

  banks.push({
    bank_code: bc,
    category: entry.category,
    state: entry.state,
    source_url: j.source_url || null,
    scraped_at: j.scraped_at,
    effective_date: j.effective_date || null,
    effective_end_date: j.effective_end_date || null,
    extraction_method: j.extraction_method || null,
    extraction_confidence: j.extraction_confidence || null,
    verified_against_source: j.verified_against_source === true,
    currencies: [...new Set(slabs.map(s => s.currency).filter(Boolean))].sort(),
    deposit_ranges_present: [...new Set(slabs.map(s => s.deposit_range).filter(Boolean))].sort(),
    slab_count: slabs.length,
    rate_slabs: slabs,
    warnings: Array.isArray(j.warnings) ? j.warnings : [],
  });
}

banks.sort((a, b) => a.bank_code.localeCompare(b.bank_code));

// Excluded list — banks in the cohort that we couldn't refresh today
const excluded = COHORT
  .map(e => e.bank_code)
  .filter(bc => !banks.find(b => b.bank_code === bc))
  .map(bc => {
    const fcnrPath = path.join(LATEST, `${bc}_fcnr_rates.json`);
    const j = readJsonSafe(fcnrPath);
    return {
      bank_code: bc,
      category: cohortByCode.get(bc)?.category || null,
      had_existing_pack: !!j,
      existing_scraped_at: j?.scraped_at || null,
      existing_slab_count: j?.rate_slabs?.length || 0,
      reason: 'not_refreshable_2026-06-15',
    };
  });

const pack = {
  pack_type: 'fcnr_only',
  generated_at: new Date().toISOString().slice(0, 19) + 'Z',
  refresh_cycle: 'FCNR industry update 2026-06-11 (RBI FCNR(B) swap facility window 2026-06-08 to 2026-09-30)',
  counts: {
    banks_fresh_today: banks.length,
    banks_excluded: excluded.length,
    total_slabs: totalSlabs,
    distinct_currencies: allCurrencies.size,
    verified_against_source: verifiedCount.yes,
    paste_only_unverifiable: verifiedCount.no,
  },
  currencies: [...allCurrencies].sort(),
  freshness_distribution: freshnessBucket,
  banks,
  excluded,
};

const packPath = path.join(OUT_DIR, 'fcnr-only-pack-2026-06-15.json');
fs.writeFileSync(packPath, JSON.stringify(pack, null, 2) + '\n');

// CSV — one row per (bank, currency, deposit_range, tenure)
const csvRows = [];
csvRows.push(['bank_code', 'category', 'effective_date', 'scraped_at', 'verified', 'tenure_text', 'tenure_min_days', 'tenure_max_days', 'currency', 'deposit_range', 'rate_general_pct', 'lock_in_flag', 'source_url'].join(','));
function csvEsc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
for (const b of banks) {
  for (const s of b.rate_slabs) {
    const lockFlag = s.lock_in_1_year || s.lock_in_jun15_sep30_2026 || s.lock_in_2026_jun_sep || s.lock_in_starred || s.lock_in_rbi_swap_facility ? 'true' : '';
    csvRows.push([
      b.bank_code, b.category || '', b.effective_date || '', b.scraped_at,
      b.verified_against_source ? 'true' : 'false',
      s.tenure_text || '', s.tenure_min_days ?? '', s.tenure_max_days ?? '',
      s.currency || '', s.deposit_range || '',
      s.rate_general_pct ?? '',
      lockFlag,
      b.source_url || '',
    ].map(csvEsc).join(','));
  }
}
const csvPath = path.join(OUT_DIR, 'fcnr-rates-2026-06-15.csv');
fs.writeFileSync(csvPath, csvRows.join('\n') + '\n');

// Coverage report
const coverage = {
  generated_at: pack.generated_at,
  refresh_cycle: pack.refresh_cycle,
  counts: pack.counts,
  per_bank: banks.map(b => ({
    bank_code: b.bank_code,
    category: b.category,
    slab_count: b.slab_count,
    currencies: b.currencies,
    effective_date: b.effective_date,
    scraped_at: b.scraped_at,
    verified: b.verified_against_source,
  })),
  excluded,
};
const coveragePath = path.join(OUT_DIR, 'fcnr-coverage-2026-06-15.json');
fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2) + '\n');

console.log(JSON.stringify({
  pack_written: packPath,
  csv_written: csvPath,
  coverage_written: coveragePath,
  banks_fresh: banks.length,
  total_slabs: totalSlabs,
  distinct_currencies: allCurrencies.size,
  verified: verifiedCount.yes,
  excluded: excluded.length,
}, null, 2));

'use strict';
// Coverage map for the 500-cohort (data/cohorts/pm-refresh-2026-q2.json, 513 banks).
// Per bank (keyed by bank_code = registry slug), classify into exactly one of:
//   auto   — has a template || template_fcnr || template_gift (deterministic auto-refresh)
//   static — NOT auto, but an output/latest rate file (any variant) has rate_slabs > 0
//   gap    — neither
// Rate-data coverage = auto + static. Grouped by the Tier-1/2/3 category sets (handoff §1/§6).
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.resolve(__dirname, '..', '..');
const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'bank-domains.json'), 'utf-8'));
const cohort = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'cohorts', 'pm-refresh-2026-q2.json'), 'utf-8'));
const list = cohort.cohort || cohort.banks || cohort;
const LATEST = path.join(REPO, 'output', 'latest');

const TIER = {
  'Public Sector Bank': 1, 'Private Sector Bank (Indian)': 1, 'Small Finance Bank': 1,
  'IFSC Banking Unit (IFSCA)': 1, 'Scheduled Urban Co-operative Bank': 1, 'Scheduled State Co-operative Bank': 1,
  'Foreign Bank': 2, 'Regional Rural Bank': 2, 'Non-Scheduled State Co-operative Bank': 2,
  'Payments Bank': 2, 'Local Area Bank': 2, 'Financial Institution': 2,
  'Non-Scheduled Urban Co-operative Bank': 3, 'District Central Co-operative Bank': 3,
};
const VARIANTS = ['', '_gift', '_fcnr', '_nre', '_nro'];

function hasTemplate(e) {
  return !!(e && (e.template || e.template_fcnr || e.template_gift));
}
function hasData(slug) {
  for (const v of VARIANTS) {
    const p = path.join(LATEST, `${slug}${v}_rates.json`);
    if (!fs.existsSync(p)) continue;
    try { if ((JSON.parse(fs.readFileSync(p, 'utf-8')).rate_slabs || []).length > 0) return true; } catch {}
  }
  return false;
}

const tiers = { 1: blank(), 2: blank(), 3: blank() };
function blank() { return { total: 0, auto: 0, static: 0, gap: 0 }; }
for (const b of list) {
  const t = TIER[b.category];
  if (!t) { console.error('UNMAPPED category:', b.category); continue; }
  const e = reg[b.bank_code];
  const bucket = tiers[t];
  bucket.total++;
  if (hasTemplate(e)) bucket.auto++;
  else if (hasData(b.bank_code)) bucket.static++;
  else bucket.gap++;
}

const names = { 1: 'Tier-1 (PSB/PVB/Sched/SFB/IBU)', 2: 'Tier-2 named (FB/RRB/NSSCB/PB/LAB/FI)', 3: 'Tier-3 co-op (DCCB/NSUCB)' };
const tot = blank();
console.log('Tier'.padEnd(38), 'Total', 'Auto', 'Static', 'Gap', 'Coverage');
for (const t of [1, 2, 3]) {
  const x = tiers[t];
  for (const k of ['total', 'auto', 'static', 'gap']) tot[k] += x[k];
  const cov = x.auto + x.static;
  console.log(names[t].padEnd(38), String(x.total).padStart(5), String(x.auto).padStart(4), String(x.static).padStart(6), String(x.gap).padStart(3), `${cov} (${Math.round(cov / x.total * 100)}%)`);
}
const cov = tot.auto + tot.static;
console.log(''.padEnd(38, '-'));
console.log('TOTAL'.padEnd(38), String(tot.total).padStart(5), String(tot.auto).padStart(4), String(tot.static).padStart(6), String(tot.gap).padStart(3), `${cov} (${Math.round(cov / tot.total * 100)}%)`);
console.log(`\nAuto-refresh: ${tot.auto} (${Math.round(tot.auto / tot.total * 100)}%) | Rate-data coverage: ${cov} (${Math.round(cov / tot.total * 100)}%) | Gap: ${tot.gap}`);

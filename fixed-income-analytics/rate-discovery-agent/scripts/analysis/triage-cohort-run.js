#!/usr/bin/env node
'use strict';
// Triage a cohort/batch refresh run at the ARTIFACT level (output/latest),
// complementing scripts/analysis/nri-target-list.js which measures the PACK.
//
// Usage: node scripts/analysis/triage-cohort-run.js [--run <output/runs/<label>>] [--since 2026-07-07]
//
// Reports, per variant: banks with slabs, scraped-on-or-after --since, effective_date
// coverage, JPY presence (fcnr), lock-in signals (fcnr), plus every .pending.json
// sidecar with the rejection reason recorded in the retained file's
// _safe_write_history (rule the write tripped, attempted vs retained slab counts).
// Sprint 011 A6 (2026-07-07). Re-runnable after any refresh run.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const LATEST = path.join(ROOT, 'output', 'latest');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const SINCE = arg('--since', new Date().toISOString().slice(0, 10));
const RUN_DIR = arg('--run', null);

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

const VARIANTS = [
  { key: 'regular', suffix: '_rates.json' },
  { key: 'nre', suffix: '_nre_rates.json' },
  { key: 'nro', suffix: '_nro_rates.json' },
  { key: 'fcnr', suffix: '_fcnr_rates.json' },
  { key: 'gift', suffix: '_gift_rates.json' },
];

const files = fs.readdirSync(LATEST);

console.log(`Artifact triage — output/latest as of ${new Date().toISOString()}  (fresh = scraped_at >= ${SINCE})`);
console.log('');
console.log('variant  withSlabs  fresh  hasEffDate  freshWithEffDate  jpy  lockin');
for (const v of VARIANTS) {
  let withSlabs = 0, fresh = 0, dated = 0, freshDated = 0, jpy = 0, lockin = 0;
  for (const f of files) {
    if (!f.endsWith(v.suffix) || f.endsWith('.pending.json')) continue;
    // the bare _rates.json suffix also matches variant files — exclude them
    if (v.key === 'regular' && /_(nre|nro|fcnr|gift)_rates\.json$/.test(f)) continue;
    const j = readJson(path.join(LATEST, f));
    const slabs = (j && j.rate_slabs) || [];
    if (!slabs.length) continue;
    withSlabs++;
    const isFresh = (j.scraped_at || '').slice(0, 10) >= SINCE;
    if (isFresh) fresh++;
    if (j.effective_date) dated++;
    if (isFresh && j.effective_date) freshDated++;
    if (slabs.some((s) => s.currency === 'JPY')) jpy++;
    if ((j.regulatory_constraints || []).length
      || slabs.some((s) => (s.regulatory_flag_keys || []).length)) lockin++;
  }
  console.log(
    v.key.padEnd(9) + String(withSlabs).padEnd(11) + String(fresh).padEnd(7)
    + String(dated).padEnd(12) + String(freshDated).padEnd(18)
    + String(jpy).padEnd(5) + String(lockin),
  );
}

console.log('');
console.log('Pending sidecars (blocked writes):');
const pendings = files.filter((f) => f.endsWith('.pending.json')).sort();
if (!pendings.length) console.log('  (none)');
for (const p of pendings) {
  const retainedName = p.replace(/\.pending\.json$/, '');
  const retained = readJson(path.join(LATEST, retainedName));
  const pending = readJson(path.join(LATEST, p));
  const hist = (retained && retained._safe_write_history) || [];
  const last = hist[hist.length - 1] || {};
  console.log(
    `  ${retainedName.padEnd(58)} reason=${(last.rejected_reason || '?').padEnd(26)}`
    + ` retained=${(retained && retained.rate_slabs || []).length}`
    + ` attempted=${(pending && pending.rate_slabs || []).length}`
    + ` at=${(last.attempted_at || '').slice(0, 16)}`,
  );
}

if (RUN_DIR) {
  const batch = readJson(path.join(ROOT, RUN_DIR, '_batch_results.json'));
  if (batch && Array.isArray(batch.results)) {
    const failed = batch.results.filter((r) => r.status !== 'success');
    console.log('');
    console.log(`Run ${RUN_DIR}: ${batch.results.length} banks — succeeded=${batch.succeeded} failed=${batch.failed} rate_limited=${batch.rate_limited} skipped=${batch.skipped}`);
    for (const r of failed) console.log(`  ${r.name}: ${r.status} (${r.elapsed_sec}s)`);
  }
}

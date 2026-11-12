#!/usr/bin/env node
// One-shot: build an FCNR-refresh cohort from current pack publishers.
// PM signal: FCNR rates updated industry-wide as of 2026-06-11.
// Scope: every bank that currently publishes FCNR in pack/dist/rates-pack.json.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = path.join(ROOT, 'pack', 'dist', 'rates-pack.json');
const LATEST = path.join(ROOT, 'output', 'latest');
const SOURCE_COHORT = path.join(ROOT, 'data', 'cohorts', 'pm-refresh-2026-q2.json');
const OUT = path.join(ROOT, 'data', 'cohorts', 'fcnr-refresh-2026-06-11.json');

const pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
const sourceCohort = JSON.parse(fs.readFileSync(SOURCE_COHORT, 'utf8'));
const sourceByCode = new Map(sourceCohort.map(e => [e.bank_code, e]));

const fcnrBanks = pack.banks
  .filter(b => b.products && b.products.fd && b.products.fd.fcnr
           && Array.isArray(b.products.fd.fcnr.slabs)
           && b.products.fd.fcnr.slabs.length > 0);

const rows = [];
const missing = [];
for (const b of fcnrBanks) {
  const sumPath = path.join(LATEST, `${b.bank_code}.summary.json`);
  let category = null;
  let state = null;
  if (fs.existsSync(sumPath)) {
    const s = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
    category = s.category || null;
    state = s.state || null;
  } else {
    missing.push(b.bank_code);
  }
  // Backfill state from canonical pm-refresh cohort if summary lacked it.
  if (!state && sourceByCode.has(b.bank_code)) {
    state = sourceByCode.get(b.bank_code).state || null;
  }
  if (!category && sourceByCode.has(b.bank_code)) {
    category = sourceByCode.get(b.bank_code).category || null;
  }
  rows.push({ bank_code: b.bank_code, category, state });
}

rows.sort((a, b) => a.bank_code.localeCompare(b.bank_code));

fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + '\n');

console.log(`Wrote ${OUT}`);
console.log(`  banks: ${rows.length}`);
console.log(`  missing summary: ${missing.length}`, missing);
const byCat = {};
for (const r of rows) byCat[r.category || '?'] = (byCat[r.category || '?'] || 0) + 1;
console.log(`  by category:`, byCat);
const noState = rows.filter(r => !r.state);
console.log(`  no state: ${noState.length}`, noState.map(r => r.bank_code));

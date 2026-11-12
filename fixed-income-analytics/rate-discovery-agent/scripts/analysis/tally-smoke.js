#!/usr/bin/env node
// Tally slab counts per variant across a smoke output dir.
// Usage: node scripts/analysis/tally-smoke.js <dir> [<dir2> ...]
// Prints a markdown table per dir and a comparison if 2 dirs given.

const fs = require('fs');
const path = require('path');

const SLUGS = [
  'state-bank-of-india',
  'bank-of-baroda',
  'punjab-national-bank',
  'hdfc-bank-limited',
  'icici-bank-limited',
  'axis-bank-limited',
  'kotak-mahindra-bank-limited',
  'au-small-finance-bank-limited',
  'equitas-small-finance-bank-limited',
  'citibank-na',
  'bank-of-india-ibu',
  'abhyudaya-co-operative-bank-ltd-mumbai',
];

const VARIANTS = [
  { suffix: '_rates.json', label: 'regular' },
  { suffix: '_nre_rates.json', label: 'nre' },
  { suffix: '_nro_rates.json', label: 'nro' },
  { suffix: '_fcnr_rates.json', label: 'fcnr' },
  { suffix: '_gift_rates.json', label: 'gift' },
];

const BASELINE = {
  'state-bank-of-india':                       { regular: 10, nre: 5, nro: 10, fcnr: 36, gift: null },
  'hdfc-bank-limited':                          { regular: 19, nre: null, nro: null, fcnr: null, gift: null },
  'au-small-finance-bank-limited':              { regular: 23, nre: null, nro: null, fcnr: null, gift: null },
  'abhyudaya-co-operative-bank-ltd-mumbai':     { regular: 8,  nre: null, nro: null, fcnr: null, gift: null },
  'bank-of-india-ibu':                          { regular: null, nre: null, nro: null, fcnr: null, gift: 64 },
};

function tally(dir) {
  const result = {};
  for (const slug of SLUGS) {
    const row = { regular: '—', nre: '—', nro: '—', fcnr: '—', gift: '—', errors: 0, warnings: 0 };
    for (const v of VARIANTS) {
      const p = path.join(dir, `${slug}${v.suffix}`);
      if (!fs.existsSync(p)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        row[v.label] = Array.isArray(j.rate_slabs) ? j.rate_slabs.length : '?';
        if (Array.isArray(j.errors)) row.errors += j.errors.length;
        if (Array.isArray(j.warnings)) row.warnings += j.warnings.length;
      } catch (e) {
        row[v.label] = `ERR(${e.message.slice(0,30)})`;
      }
    }
    const sumPath = path.join(dir, `${slug}.summary.json`);
    if (fs.existsSync(sumPath)) {
      try {
        const s = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
        row.exit_status = s.status || s.outcome || '?';
      } catch (_) {}
    }
    result[slug] = row;
  }
  return result;
}

function print(dir, rows) {
  console.log(`\n## ${dir}\n`);
  console.log('| Bank | regular | nre | nro | fcnr | gift | err | warn | status | vs baseline |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for (const slug of SLUGS) {
    const r = rows[slug];
    let cmp = '';
    if (BASELINE[slug]) {
      const issues = [];
      for (const v of ['regular', 'nre', 'nro', 'fcnr', 'gift']) {
        const exp = BASELINE[slug][v];
        if (exp == null) continue;
        const got = r[v];
        if (typeof got !== 'number') { issues.push(`${v}: missing (exp ${exp})`); continue; }
        if (got < exp) issues.push(`${v}: ${got} < ${exp} REGRESS`);
        else if (got > exp) issues.push(`${v}: ${got} > ${exp} (gain)`);
      }
      cmp = issues.length === 0 ? 'OK' : issues.join('; ');
    }
    console.log(`| ${slug} | ${r.regular} | ${r.nre} | ${r.nro} | ${r.fcnr} | ${r.gift} | ${r.errors} | ${r.warnings} | ${r.exit_status||'?'} | ${cmp} |`);
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: tally-smoke.js <dir> [dir2 ...]');
  process.exit(1);
}
for (const d of dirs) print(d, tally(d));

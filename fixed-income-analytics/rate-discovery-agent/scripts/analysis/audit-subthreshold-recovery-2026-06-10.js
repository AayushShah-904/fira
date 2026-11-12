#!/usr/bin/env node
// For each of the 29 sub-threshold regressed banks, check whether the
// rate files at git HEAD contain enough slabs to match the 8,990 prev-pack
// state. Classify into:
//   - 'head_full': HEAD total slabs >= prev-pack total → restore from HEAD recovers fully
//   - 'head_partial': HEAD total > current but < prev-pack → partial restore from HEAD
//   - 'head_none': HEAD total <= current → must reconstruct from prev pack
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LATEST = path.join(ROOT, 'output', 'latest');
const PREV_PACK = path.join(ROOT, 'pack', 'dist', 'rates-pack.json');

const REGRESSED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'logs', 'sprint-010', 'prev-vs-staged-regressions-2026-06-10.json'),
  'utf8'
));
const R3_DONE = new Set([
  'kotak-mahindra-bank-ibu',
  'punjab-national-bank-ibu',
  'idfc-first-bank-ibu',
  'indian-bank-ibu',
  'slice-small-finance-bank-limited',
  'the-bihar-state-co-operative-bank-ltd',
  'sberbank',
]);
const SUBTHRESHOLD = REGRESSED.rows.filter(r => !R3_DONE.has(r.bank_code));

const VARIANTS = ['rates', 'nre_rates', 'nro_rates', 'fcnr_rates', 'gift_rates'];

function slabCount(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    return Array.isArray(d?.rate_slabs) ? d.rate_slabs.length : 0;
  } catch { return 0; }
}

function readLocal(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

function readHead(rel) {
  try {
    const buf = execSync(`git show HEAD:"./${rel}"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    return buf.toString('utf8');
  } catch { return null; }
}

function listFiles(bankCode) {
  const out = [];
  for (const v of VARIANTS) {
    const fname = `${bankCode}_${v}.json`.replace('_rates_rates.json', '_rates.json').replace('_rates_rates_', '_').replace(/__/g, '_');
    // simpler: just construct
  }
  // Use a cleaner construction:
  return [
    `${bankCode}_rates.json`,
    `${bankCode}_nre_rates.json`,
    `${bankCode}_nro_rates.json`,
    `${bankCode}_fcnr_rates.json`,
    `${bankCode}_gift_rates.json`,
  ].filter(f => fs.existsSync(path.join(LATEST, f)) || readHead(`output/latest/${f}`) != null);
}

const classifications = [];
for (const row of SUBTHRESHOLD) {
  const bc = row.bank_code;
  const files = listFiles(bc);
  let headTotal = 0, currTotal = 0;
  const fileDetail = [];
  for (const f of files) {
    const rel = `output/latest/${f}`;
    const headJson = readHead(rel);
    const currJson = readLocal(rel);
    const hN = headJson != null ? slabCount(headJson) : 0;
    const cN = currJson != null ? slabCount(currJson) : 0;
    headTotal += hN;
    currTotal += cN;
    fileDetail.push({ file: f, head: hN, curr: cN });
  }
  let klass;
  if (headTotal >= row.prev) klass = 'head_full';
  else if (headTotal > currTotal) klass = 'head_partial';
  else klass = 'head_none';

  classifications.push({
    bank_code: bc,
    prev_pack: row.prev,
    current: row.staged,
    current_files_sum: currTotal,
    head_files_sum: headTotal,
    delta_from_prev: row.delta,
    classification: klass,
    files: fileDetail,
  });
}

console.log(`Sub-threshold regressed banks: ${SUBTHRESHOLD.length}`);
console.log('');
console.log('class       count   recoverable-via-HEAD-slabs');
const byClass = {};
let recoverableFromHead = 0, gapAfterHead = 0;
for (const c of classifications) {
  byClass[c.classification] = (byClass[c.classification] || 0) + 1;
  if (c.classification === 'head_full') {
    recoverableFromHead += c.prev_pack - c.current;
  } else if (c.classification === 'head_partial') {
    recoverableFromHead += c.head_files_sum - c.current_files_sum;
    gapAfterHead += c.prev_pack - c.head_files_sum;
  } else {
    gapAfterHead += c.prev_pack - c.current;
  }
}
for (const k of Object.keys(byClass)) console.log(`  ${k.padEnd(12)} ${byClass[k]}`);
console.log('');
console.log(`Slabs recoverable from HEAD checkout: ${recoverableFromHead}`);
console.log(`Slabs needing pack reconstruction   : ${gapAfterHead}`);
console.log('');
console.log('detail (sorted by impact):');
classifications.sort((a, b) => b.delta_from_prev - a.delta_from_prev);
for (const c of classifications) {
  console.log(`  [${c.classification.padEnd(12)}] ${c.bank_code.padEnd(60)} prev=${String(c.prev_pack).padStart(4)} curr=${String(c.current).padStart(4)} HEAD-sum=${String(c.head_files_sum).padStart(4)} delta=${String(c.delta_from_prev).padStart(3)}`);
}

const outPath = path.join(ROOT, 'logs', 'sprint-010', 'subthreshold-audit-2026-06-10.json');
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  total_sub_threshold_banks: classifications.length,
  by_class: byClass,
  recoverable_from_head_slabs: recoverableFromHead,
  gap_after_head_slabs: gapAfterHead,
  classifications,
}, null, 2));
console.log(`\nwrote ${outPath}`);

#!/usr/bin/env node
// Compare the 8,990 pre-cohort pack (pack/dist/rates-pack.json) vs the
// staged 8,641 post-cohort pack to find EVERY bank that regressed.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PREV = path.join(ROOT, 'pack', 'dist', 'rates-pack.json');
const STAGED = path.join(ROOT, 'pack', 'dist-staging-550ptm4', 'rates-pack.json');

function slabsByBank(pack) {
  const out = new Map();
  for (const b of pack.banks || []) {
    let total = 0;
    const fd = b.products?.fd || {};
    for (const k of Object.keys(fd)) {
      const v = fd[k];
      if (Array.isArray(v?.slabs)) total += v.slabs.length;
    }
    out.set(b.bank_code, total);
  }
  return out;
}

const prev = JSON.parse(fs.readFileSync(PREV, 'utf8'));
const staged = JSON.parse(fs.readFileSync(STAGED, 'utf8'));

const prevByBank = slabsByBank(prev);
const stagedByBank = slabsByBank(staged);

const rows = [];
for (const [bc, prevN] of prevByBank) {
  const stagedN = stagedByBank.get(bc) ?? 0;
  if (stagedN < prevN) rows.push({ bank_code: bc, prev: prevN, staged: stagedN, delta: prevN - stagedN });
}
rows.sort((a, b) => b.delta - a.delta);

const total = rows.reduce((s, r) => s + r.delta, 0);
const dropped = [];
for (const [bc] of prevByBank) if (!stagedByBank.has(bc)) dropped.push(bc);

console.log(`Banks with REGRESSION: ${rows.length}`);
console.log(`Banks DROPPED entirely from pack (excluded): ${dropped.length}`);
console.log(`Total slab loss across regressed banks: ${total}`);
console.log('');
console.log('rank  delta  prev -> staged  bank_code');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  console.log(`${String(i + 1).padStart(4)}  ${String(r.delta).padStart(5)}  ${String(r.prev).padStart(4)} -> ${String(r.staged).padStart(4)}  ${r.bank_code}`);
}
if (dropped.length) {
  console.log('');
  console.log('Banks dropped from staged pack entirely:');
  for (const bc of dropped) console.log(`  ${bc} (prev: ${prevByBank.get(bc)} slabs)`);
}

const outPath = path.join(ROOT, 'logs', 'sprint-010', 'prev-vs-staged-regressions-2026-06-10.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  prev_pack_slabs: prev.counts?.total_slabs,
  staged_pack_slabs: staged.counts?.total_slabs,
  total_loss: total,
  regressed_count: rows.length,
  dropped_from_pack: dropped,
  rows
}, null, 2));
console.log(`\nwrote ${outPath}`);

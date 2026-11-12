#!/usr/bin/env node
// Compare HEAD vs current slab counts across all output/latest/*_rates.json
// to identify the full set of banks where HEAD has MORE slabs (i.e. the
// 550ptm4 cohort regressed below pre-cohort state).
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const LATEST = path.join(ROOT, 'output', 'latest');

function slabCount(json) {
  try {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    return Array.isArray(d?.rate_slabs) ? d.rate_slabs.length : 0;
  } catch {
    return null;
  }
}

function headFor(relPath) {
  try {
    const buf = execSync(`git show HEAD:"${relPath}"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

const files = fs.readdirSync(LATEST).filter(f => f.endsWith('_rates.json') && !f.endsWith('.pending.json'));
const rows = [];
for (const f of files) {
  const abs = path.join(LATEST, f);
  let curr;
  try { curr = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
  const currN = slabCount(curr);
  const headRaw = headFor(`output/latest/${f}`);
  if (headRaw == null) continue;  // not in HEAD
  const headN = slabCount(headRaw);
  if (headN == null) continue;
  if (headN > currN) {
    rows.push({ file: f, head: headN, curr: currN, delta: headN - currN });
  }
}
rows.sort((a, b) => b.delta - a.delta);

const total = rows.reduce((s, r) => s + r.delta, 0);
console.log(`Files where HEAD > current: ${rows.length}`);
console.log(`Total recoverable slabs   : ${total}`);
console.log('');
console.log('rank  delta  head -> curr  file');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  console.log(`${String(i + 1).padStart(4)}  ${String(r.delta).padStart(5)}  ${String(r.head).padStart(4)} -> ${String(r.curr).padStart(4)}  ${r.file}`);
}

const out = path.join(ROOT, 'logs', 'sprint-010', 'head-vs-current-2026-06-10.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), total_recoverable_slabs: total, count: rows.length, rows }, null, 2));
console.log(`\nwrote ${out}`);

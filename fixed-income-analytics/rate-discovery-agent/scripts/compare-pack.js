#!/usr/bin/env node
'use strict';

/**
 * Diff two rates-pack.json files per bank. Emits a summary report:
 *   - net bank delta (new banks added, banks dropped)
 *   - per-variant slab gains / losses
 *   - top movers
 *
 * Usage:
 *   node scripts/compare-pack.js <new-pack.json> <previous-pack.json>
 *
 * To diff against a git-committed previous pack:
 *   node scripts/compare-pack.js pack/dist/rates-pack.json <(git show HEAD:pack/dist/rates-pack.json)
 *
 * Sprint 4 Track A 2026-05-20 — ships alongside PM rate-pack refresh delivery
 * (see sdlc/sprints/sprint-004/plan/pm-rate-pack-refresh-2026-q2.md).
 */

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function totalsByBank(pack) {
  // Pack shape (per pack/dist/rates-pack.schema.json):
  //   { banks: [ { bank_code, products: { fd: { regular: { slabs: [...] }, nre: {...}, ... } } } ] }
  // Older internal shape used { rates: { regular: { rate_slabs: [...] } } } — accept both
  // for forwards-compat with any preserved snapshots.
  const totals = new Map();
  const perVariant = new Map();
  for (const b of (pack.banks || [])) {
    const slug = b.bank_code || b.code || b.slug;
    if (!slug) continue;
    let t = 0;
    const v = {};
    const variantMap = (b.products && b.products.fd) || b.rates || {};
    for (const [variant, payload] of Object.entries(variantMap)) {
      const slabs = payload && (Array.isArray(payload.slabs) ? payload.slabs : payload.rate_slabs);
      const n = Array.isArray(slabs) ? slabs.length : 0;
      t += n;
      v[variant] = n;
    }
    totals.set(slug, t);
    perVariant.set(slug, v);
  }
  return { totals, perVariant };
}

function main() {
  const [newPath, prevPath] = process.argv.slice(2);
  if (!newPath || !prevPath) {
    console.error('Usage: node scripts/compare-pack.js <new-pack.json> <previous-pack.json>');
    process.exit(1);
  }

  const newPack = readJson(newPath);
  const prevPack = readJson(prevPath);

  const newT = totalsByBank(newPack);
  const prevT = totalsByBank(prevPack);

  const allSlugs = new Set([...newT.totals.keys(), ...prevT.totals.keys()]);
  const added = [];
  const dropped = [];
  const gainers = [];
  const losers = [];
  let newTotalSlabs = 0;
  let prevTotalSlabs = 0;

  for (const slug of allSlugs) {
    const n = newT.totals.get(slug) || 0;
    const p = prevT.totals.get(slug) || 0;
    newTotalSlabs += n;
    prevTotalSlabs += p;
    if (!prevT.totals.has(slug)) added.push({ slug, n });
    else if (!newT.totals.has(slug)) dropped.push({ slug, p });
    else if (n !== p) {
      const delta = n - p;
      (delta > 0 ? gainers : losers).push({ slug, p, n, delta });
    }
  }

  gainers.sort((a, b) => b.delta - a.delta);
  losers.sort((a, b) => a.delta - b.delta);
  added.sort((a, b) => b.n - a.n);
  dropped.sort((a, b) => b.p - a.p);

  console.log(`# Pack diff`);
  console.log('');
  console.log(`- New pack:      ${path.basename(newPath)} — ${newT.totals.size} banks, ${newTotalSlabs} slabs`);
  console.log(`- Previous pack: ${path.basename(prevPath)} — ${prevT.totals.size} banks, ${prevTotalSlabs} slabs`);
  console.log(`- Net bank delta: ${newT.totals.size - prevT.totals.size > 0 ? '+' : ''}${newT.totals.size - prevT.totals.size}`);
  console.log(`- Net slab delta: ${newTotalSlabs - prevTotalSlabs > 0 ? '+' : ''}${newTotalSlabs - prevTotalSlabs}`);
  console.log('');
  console.log(`## Banks added (${added.length})`);
  console.log('');
  for (const a of added.slice(0, 30)) console.log(`  + ${a.slug.padEnd(50)} ${a.n} slabs`);
  if (added.length > 30) console.log(`  ... (${added.length - 30} more)`);
  console.log('');
  console.log(`## Banks dropped (${dropped.length})`);
  console.log('');
  for (const d of dropped.slice(0, 30)) console.log(`  - ${d.slug.padEnd(50)} (was ${d.p} slabs)`);
  if (dropped.length > 30) console.log(`  ... (${dropped.length - 30} more)`);
  console.log('');
  console.log(`## Top 20 slab GAINERS`);
  console.log('');
  for (const g of gainers.slice(0, 20)) console.log(`  ${g.slug.padEnd(50)} ${g.p} → ${g.n}  (Δ +${g.delta})`);
  console.log('');
  console.log(`## Top 20 slab LOSERS`);
  console.log('');
  for (const l of losers.slice(0, 20)) console.log(`  ${l.slug.padEnd(50)} ${l.p} → ${l.n}  (Δ ${l.delta})`);
}

if (require.main === module) main();

module.exports = { totalsByBank };

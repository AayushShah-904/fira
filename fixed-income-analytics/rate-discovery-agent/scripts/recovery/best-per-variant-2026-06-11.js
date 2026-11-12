#!/usr/bin/env node
// Quality-and-freshness chooser per (bank, variant). Slab count is NOT a
// quality signal — correctness is. We only act in two safe cases:
//
//   A. FILL EMPTY: disk slot is empty/missing AND a confidence='high'
//      snapshot exists in another source. Pick the freshest such snapshot.
//
//   B. SAFE REPLACE: disk slot has data, but another source has the SAME
//      OR HIGHER confidence, AT LEAST as many slabs, AND a strictly fresher
//      scraped_at. Pick it.
//
// We do NOT trade slab count for freshness. We do NOT pull from low-conf
// sources to fill an empty. We do NOT replace verified disk data with an
// older or lower-confidence alternative.
//
// Sources scanned:
//   - output/latest/  (current disk)
//   - git HEAD
//   - pack/dist-staging-550ptm4/                (cohort raw — freshest of 2026-06-09)
//   - pack/dist-staging-550ptm4-fullrecovered/  (post-recovery, same as cur)
//   - pack/dist/rates-pack.json                 (current published)
//   - pack/history/rates-pack-2026-05-14.json
//   - pack/history/rates-pack-2026-04-16.json
//
// Provenance: each written file gets `_best_per_variant_picked` with the
// source and rule (fill_empty | safe_replace).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { safeWriteArtifact } = require('../../lib/safe-write');

const ROOT = path.resolve(__dirname, '..', '..');
const LATEST = path.join(ROOT, 'output', 'latest');
const NOW = new Date('2026-06-11T13:30:00Z').getTime();
const DRY_RUN = process.argv.includes('--dry-run');

const VARIANT_FILE_SUFFIX = {
  regular: '_rates.json',
  nre: '_nre_rates.json',
  nro: '_nro_rates.json',
  fcnr: '_fcnr_rates.json',
  gift: '_gift_rates.json',
};
const VARIANTS = Object.keys(VARIANT_FILE_SUFFIX);

const CONF_RANK = { high: 4, medium: 3, low: 2, none: 0, unknown: 0 };

// Source-preference order for ties when picking a fill candidate.
// Lower index = more trustworthy. HEAD is committed verified state;
// cur/fullrec mirror disk; stg-cohort is the freshest scrape; history
// packs are last because they are oldest.
const SOURCE_PRIORITY = [
  'HEAD',
  'pack:cur',
  'pack:stg-fullrec',
  'pack:stg-cohort',
  'pack:2026-05-14',
  'pack:2026-04-16',
];

function tryJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readHead(rel) {
  try {
    return JSON.parse(execSync(`git show HEAD:"./${rel}"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch { return null; }
}

const PACK_SOURCES = [
  { label: 'pack:cur',         path: path.join(ROOT, 'pack', 'dist', 'rates-pack.json') },
  { label: 'pack:stg-cohort',  path: path.join(ROOT, 'pack', 'dist-staging-550ptm4', 'rates-pack.json') },
  { label: 'pack:stg-fullrec', path: path.join(ROOT, 'pack', 'dist-staging-550ptm4-fullrecovered', 'rates-pack.json') },
  { label: 'pack:2026-05-14',  path: path.join(ROOT, 'pack', 'history', 'rates-pack-2026-05-14.json') },
  { label: 'pack:2026-04-16',  path: path.join(ROOT, 'pack', 'history', 'rates-pack-2026-04-16.json') },
];

console.log('Loading pack sources…');
const PACKS = PACK_SOURCES.map(s => ({ label: s.label, pack: tryJson(s.path) })).filter(x => x.pack);
for (const p of PACKS) console.log(`  ${p.label.padEnd(20)} banks=${p.pack.banks?.length || 0} slabs=${p.pack.counts?.total_slabs || '?'}`);

const packByBank = PACKS.map(({ label, pack }) => {
  const map = new Map();
  for (const b of pack.banks || []) map.set(b.bank_code, b);
  return { label, map };
});

function snapshotFromPack(packEntry, bankCode, variant) {
  const b = packEntry.map.get(bankCode);
  if (!b) return null;
  const v = b.products?.fd?.[variant];
  if (!v?.slabs?.length) return null;
  return {
    label: packEntry.label,
    is_pack: true,
    rate_slabs: v.slabs,
    scraped_at: v.scraped_at || null,
    source_url: v.source_url || null,
    effective_date: v.effective_date || null,
    extraction_method: v.extraction_method || null,
    extraction_confidence: (v.extraction_confidence || '').toLowerCase() || null,
    run_method: v.run_method || null,
    stale: !!v.stale,
    special_schemes: v.special_schemes || [],
    warnings: v.warnings || [],
  };
}

function snapshotFromRateFile(label, rateJson, isPack = false) {
  if (!rateJson || !Array.isArray(rateJson.rate_slabs) || rateJson.rate_slabs.length === 0) return null;
  return {
    label,
    is_pack: isPack,
    rate_slabs: rateJson.rate_slabs,
    scraped_at: rateJson.scraped_at || null,
    source_url: rateJson.source_url || null,
    effective_date: rateJson.effective_date || null,
    extraction_method: rateJson.extraction_method || null,
    extraction_confidence: (rateJson.extraction_confidence || '').toLowerCase() || null,
    run_method: rateJson.run_method || null,
    stale: !!rateJson.stale,
    special_schemes: rateJson.special_schemes || [],
    warnings: rateJson.warnings || [],
  };
}

function confRank(s) { return CONF_RANK[(s.extraction_confidence || 'none').toLowerCase()] ?? 0; }

function ts(s) { return s.scraped_at ? new Date(s.scraped_at).getTime() : 0; }

function ageDays(s) {
  if (!s.scraped_at) return null;
  return (NOW - new Date(s.scraped_at).getTime()) / 86400000;
}

// FILL-EMPTY rule: disk has 0 slabs or file is missing.
// Acceptable candidates: extraction_confidence='high', scraped_at present,
// scraped_at within 90 days (so we never publish months-old data as current).
// Pick the freshest; ties broken by SOURCE_PRIORITY.
function pickForEmpty(candidates) {
  const eligible = candidates.filter(c => {
    if (c.extraction_confidence !== 'high') return false;
    if (!c.scraped_at) return false;
    const a = ageDays(c);
    if (a == null || a > 90) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const tA = ts(a), tB = ts(b);
    if (tB !== tA) return tB - tA;
    return SOURCE_PRIORITY.indexOf(a.label) - SOURCE_PRIORITY.indexOf(b.label);
  });
  return eligible[0];
}

// SAFE-REPLACE rule: disk has data. Only replace if alternative is
// unambiguously better — same-or-higher conf, >= slab count, fresher ts.
function pickForReplace(diskSnap, candidates) {
  const diskConf = confRank(diskSnap);
  const diskTs = ts(diskSnap);
  const diskSlabs = diskSnap.rate_slabs.length;
  const eligible = candidates.filter(c => {
    if (c === diskSnap) return false;
    if (confRank(c) < diskConf) return false;
    if (c.rate_slabs.length < diskSlabs) return false;
    if (ts(c) <= diskTs) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  // Prefer higher conf, then more slabs, then fresher, then SOURCE_PRIORITY
  eligible.sort((a, b) => {
    const cdiff = confRank(b) - confRank(a);
    if (cdiff !== 0) return cdiff;
    const sdiff = b.rate_slabs.length - a.rate_slabs.length;
    if (sdiff !== 0) return sdiff;
    const tdiff = ts(b) - ts(a);
    if (tdiff !== 0) return tdiff;
    return SOURCE_PRIORITY.indexOf(a.label) - SOURCE_PRIORITY.indexOf(b.label);
  });
  return eligible[0];
}

const allBanks = new Set();
for (const p of packByBank) for (const bc of p.map.keys()) allBanks.add(bc);
for (const f of fs.readdirSync(LATEST)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const m = f.match(/^(.+?)(?:_nre|_nro|_fcnr|_gift)?_rates\.json$/);
  if (m) allBanks.add(m[1]);
}
console.log(`\nEnumerated ${allBanks.size} candidate banks across all sources`);

// Respect _pack_excludes.json — never fill or replace a quarantined (bank, variant) pair.
const excludesJson = tryJson(path.join(LATEST, '_pack_excludes.json')) || { excludes: [] };
const excludedPairs = new Set((excludesJson.excludes || []).map(e => `${e.bank_code}|${e.variant}`));
console.log(`Quarantined (bank, variant) pairs from _pack_excludes.json: ${excludedPairs.size}\n`);

const fillDecisions = [];
const replaceDecisions = [];
const noActionWithCandidates = [];

for (const bc of allBanks) {
  for (const variant of VARIANTS) {
    if (excludedPairs.has(`${bc}|${variant}`)) continue;
    const suffix = VARIANT_FILE_SUFFIX[variant];
    const fileName = `${bc}${suffix}`;
    const filePath = path.join(LATEST, fileName);
    const rel = `output/latest/${fileName}`;

    const candidates = [];
    const diskJson = tryJson(filePath);
    const diskSnap = snapshotFromRateFile('disk', diskJson, false);
    if (diskSnap) candidates.push(diskSnap);

    const headSnap = snapshotFromRateFile('HEAD', readHead(rel), false);
    if (headSnap) candidates.push(headSnap);

    for (const p of packByBank) {
      const s = snapshotFromPack(p, bc, variant);
      if (s) candidates.push(s);
    }

    if (candidates.length === 0) continue;

    if (!diskSnap) {
      const picked = pickForEmpty(candidates);
      if (picked) {
        fillDecisions.push({ bank_code: bc, variant, picked });
      }
    } else {
      const picked = pickForReplace(diskSnap, candidates);
      if (picked) {
        replaceDecisions.push({ bank_code: bc, variant, disk: diskSnap, picked });
      } else if (candidates.length > 1) {
        noActionWithCandidates.push({ bank_code: bc, variant, disk: diskSnap });
      }
    }
  }
}

console.log('=== summary ===');
console.log(`FILL_EMPTY picks  : ${fillDecisions.length}  (disk had 0 slabs; filled from high-conf source ≤90d)`);
console.log(`SAFE_REPLACE picks: ${replaceDecisions.length}  (disk replaced by same/higher conf + ≥ slabs + fresher)`);

let fillSlabGain = 0;
for (const d of fillDecisions) fillSlabGain += d.picked.rate_slabs.length;
let replaceSlabGain = 0;
for (const d of replaceDecisions) replaceSlabGain += d.picked.rate_slabs.length - d.disk.rate_slabs.length;
console.log(`Total slab gain from fills  : +${fillSlabGain}`);
console.log(`Total slab gain from replaces: +${replaceSlabGain}`);
console.log(`Net slab delta              : +${fillSlabGain + replaceSlabGain}`);

const fillSources = {};
for (const d of fillDecisions) fillSources[d.picked.label] = (fillSources[d.picked.label] || 0) + 1;
const replaceSources = {};
for (const d of replaceDecisions) replaceSources[d.picked.label] = (replaceSources[d.picked.label] || 0) + 1;

console.log('\nFill sources:');
for (const k of Object.keys(fillSources).sort()) console.log(`  ${k.padEnd(20)} ${fillSources[k]}`);
console.log('\nReplace sources:');
for (const k of Object.keys(replaceSources).sort()) console.log(`  ${k.padEnd(20)} ${replaceSources[k]}`);

console.log('\n=== FILL EMPTY picks (top 30 by slab gain) ===');
fillDecisions.sort((a, b) => b.picked.rate_slabs.length - a.picked.rate_slabs.length);
for (const d of fillDecisions.slice(0, 30)) {
  const ag = ageDays(d.picked);
  console.log(`  [${d.picked.label.padEnd(18)}] +${String(d.picked.rate_slabs.length).padStart(3)}  age=${ag ? Math.round(ag)+'d' : '?'}  ${d.bank_code}/${d.variant}`);
}

console.log('\n=== SAFE REPLACE picks ===');
replaceDecisions.sort((a, b) => (b.picked.rate_slabs.length - b.disk.rate_slabs.length) - (a.picked.rate_slabs.length - a.disk.rate_slabs.length));
for (const d of replaceDecisions) {
  const dskAge = ageDays(d.disk);
  const pickAge = ageDays(d.picked);
  console.log(`  [${d.picked.label.padEnd(18)}] disk=${d.disk.rate_slabs.length}/${d.disk.extraction_confidence}/${dskAge?Math.round(dskAge)+'d':'?'} → picked=${d.picked.rate_slabs.length}/${d.picked.extraction_confidence}/${pickAge?Math.round(pickAge)+'d':'?'}  ${d.bank_code}/${d.variant}`);
}

// Apply
if (!DRY_RUN) {
  console.log('\n=== applying writes ===');
  const writePicks = (decisions, rule) => {
    let written = 0, blocked = 0;
    for (const d of decisions) {
      const fileName = `${d.bank_code}${VARIANT_FILE_SUFFIX[d.variant]}`;
      const filePath = path.join(LATEST, fileName);
      const p = d.picked;
      // Pack denormalization drops extraction_method. When restoring from a
      // pack source, fall back to 'stale_needs_refresh' — semantically honest
      // ("rate values came from a prior pack snapshot; needs a fresh scrape
      // to recover the true extraction method") and accepted by safe-write.
      const extractionMethod = p.extraction_method
        || (p.is_pack ? 'stale_needs_refresh' : null);
      const payload = {
        bank_code: d.bank_code,
        scraped_at: p.scraped_at,
        source_url: p.source_url,
        effective_date: p.effective_date,
        extraction_method: extractionMethod,
        extraction_confidence: p.extraction_confidence,
        run_method: p.run_method,
        stale: !!p.stale,
        rate_slabs: p.rate_slabs,
        special_schemes: p.special_schemes,
        warnings: p.warnings,
        _best_per_variant_picked: {
          picked_at: new Date(NOW).toISOString(),
          picked_from: p.label,
          rule,
          reason: 'best_per_variant_chooser_2026-06-11_v2',
        },
      };
      try {
        safeWriteArtifact({ path: filePath, incoming: payload, kind: 'rates', source: 'operator' });
        written++;
      } catch (e) {
        console.log(`  ! write blocked for ${d.bank_code}/${d.variant}: ${e.message}`);
        blocked++;
      }
    }
    return { written, blocked };
  };
  const r1 = writePicks(fillDecisions, 'fill_empty');
  const r2 = writePicks(replaceDecisions, 'safe_replace');
  console.log(`fills    : written=${r1.written} blocked=${r1.blocked}`);
  console.log(`replaces : written=${r2.written} blocked=${r2.blocked}`);
}

const outPath = path.join(ROOT, 'logs', 'sprint-010', 'best-per-variant-v2-2026-06-11.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date(NOW).toISOString(),
  dry_run: DRY_RUN,
  scoring_rules: {
    fill_empty: "extraction_confidence='high' AND scraped_at ≤ 90 days. Tiebreak: fresher, then SOURCE_PRIORITY.",
    safe_replace: "alt.conf >= disk.conf AND alt.slabs >= disk.slabs AND alt.scraped_at > disk.scraped_at. Tiebreak: higher conf, more slabs, fresher.",
  },
  source_priority: SOURCE_PRIORITY,
  fill_count: fillDecisions.length,
  replace_count: replaceDecisions.length,
  fill_slab_gain: fillSlabGain,
  replace_slab_gain: replaceSlabGain,
  fill_sources: fillSources,
  replace_sources: replaceSources,
  fills: fillDecisions.map(d => ({
    bank_code: d.bank_code, variant: d.variant,
    picked_from: d.picked.label, picked_slabs: d.picked.rate_slabs.length,
    picked_conf: d.picked.extraction_confidence, picked_scraped: d.picked.scraped_at,
  })),
  replaces: replaceDecisions.map(d => ({
    bank_code: d.bank_code, variant: d.variant,
    disk_slabs: d.disk.rate_slabs.length, disk_conf: d.disk.extraction_confidence, disk_scraped: d.disk.scraped_at,
    picked_from: d.picked.label, picked_slabs: d.picked.rate_slabs.length,
    picked_conf: d.picked.extraction_confidence, picked_scraped: d.picked.scraped_at,
  })),
}, null, 2));
console.log(`\nwrote ${outPath}`);
if (DRY_RUN) console.log('\n[dry run — no files written]');

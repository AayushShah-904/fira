#!/usr/bin/env node
'use strict';
// Sprint 010 ad-hoc recount: per-bank cloud outcome based on agent-reported
// slabs from .log, now WITH GIFT variant counted (initial script missed it).
const fs = require('fs');
const path = require('path');

const cohort = JSON.parse(fs.readFileSync('data/cohorts/pm-refresh-2026-q2.json', 'utf-8'));
const cohortBanks = cohort.banks || cohort;
const baseline = JSON.parse(fs.readFileSync('pack/baseline/baseline-pack-2026-05-28.json', 'utf-8'));
const baselineMap = new Map(baseline.banks.map(b => [b.bank_code, b]));

function slabsInBank(bank) {
  let n = 0;
  for (const p of Object.values(bank.products || {})) {
    for (const v of Object.values(p || {})) n += (v && v.slabs ? v.slabs.length : 0);
  }
  return n;
}

function parseAgentSlabs(slug) {
  const p = `output/latest/${slug}.log`;
  if (!fs.existsSync(p)) return null;
  let log;
  try { log = fs.readFileSync(p, 'utf-8'); } catch { return null; }

  // Case 1: LLM-path agent output (legacy) — human-readable "Slabs: N domestic..."
  const m = log.match(/Slabs:\s*(\d+)\s*domestic(?:[^\n]*?(\d+)\s*NRE)?(?:[^\n]*?(\d+)\s*NRO)?(?:[^\n]*?(\d+)\s*FCNR)?(?:[^\n]*?(\d+)\s*GIFT)?/i);
  if (m) {
    const dom = parseInt(m[1]) || 0;
    const nre = parseInt(m[2] || 0);
    const nro = parseInt(m[3] || 0);
    const fcnr = parseInt(m[4] || 0);
    const gift = parseInt(m[5] || 0);
    return { dom, nre, nro, fcnr, gift, total: dom + nre + nro + fcnr + gift, source: 'llm_log' };
  }

  // Case 2: Orchestrator-path agent output — JSON `variantSummary` with
  // per-variant slabs counts. Sprint 010 A1 made orchestrator universal,
  // so this is the new expected format.
  const orchMatch = log.match(/"variantSummary":\s*({[\s\S]*?})\s*}/);
  if (orchMatch) {
    try {
      const vs = JSON.parse(orchMatch[1]);
      const dom = (vs.regular && vs.regular.slabs) || 0;
      const nre = (vs.nre && vs.nre.slabs) || 0;
      const nro = (vs.nro && vs.nro.slabs) || 0;
      const fcnr = (vs.fcnr && vs.fcnr.slabs) || 0;
      const gift = (vs.gift && vs.gift.slabs) || 0;
      return { dom, nre, nro, fcnr, gift, total: dom + nre + nro + fcnr + gift, source: 'orchestrator_log' };
    } catch (_) { /* fall through */ }
  }
  // Case 3: also look for orchestrator's `slabs_extracted_count` signal as
  // a coarse-grained backup if variantSummary JSON parsing fails.
  const sigMatch = log.match(/"slabs_extracted_count":\s*(\d+)/);
  if (sigMatch) {
    const total = parseInt(sigMatch[1], 10);
    return { total, source: 'orchestrator_signal' };
  }
  return null;
}

function readCloudOutcome(slug) {
  const a = parseAgentSlabs(slug);
  if (a) return { source: 'agent_log', ...a };
  for (const t of [`output/latest/${slug}_attempt3.summary.json`, `output/latest/${slug}_attempt2.summary.json`]) {
    if (fs.existsSync(t)) {
      try {
        const j = JSON.parse(fs.readFileSync(t, 'utf-8'));
        if (j.failure_signals?.slab_count != null) return { source: 'attempt_summary', total: j.failure_signals.slab_count };
      } catch {}
    }
  }
  return null;
}

let succ = 0, partial = 0, zeroR = 0, skip = 0, nodata = 0;
const buckets = { cloud_zero: [], partial: [], succ_ge: [], nodata: [] };

for (const entry of cohortBanks) {
  const c = readCloudOutcome(entry.bank_code);
  const base = baselineMap.get(entry.bank_code);
  const baseSlabs = base ? slabsInBank(base) : 0;
  if (!c) {
    try {
      const s = JSON.parse(fs.readFileSync(`output/latest/${entry.bank_code}.summary.json`, 'utf-8'));
      if (s.discovery_method === 'registry_skip') { skip++; continue; }
    } catch {}
    nodata++;
    buckets.nodata.push({ slug: entry.bank_code, baseSlabs, category: entry.category });
    continue;
  }
  if (c.total === 0 && baseSlabs > 0) {
    zeroR++;
    buckets.cloud_zero.push({ slug: entry.bank_code, baseSlabs, cloud: 0, category: entry.category });
  } else if (c.total > 0 && baseSlabs > 0 && c.total < baseSlabs * 0.8) {
    partial++;
    buckets.partial.push({ slug: entry.bank_code, baseSlabs, cloud: c.total, category: entry.category });
  } else {
    succ++;
    buckets.succ_ge.push({ slug: entry.bank_code, baseSlabs, cloud: c.total });
  }
}

console.log('=== Cloud-extraction outcomes (now with GIFT variant) ===');
console.log('Cohort:', cohortBanks.length);
console.log('Cloud >= baseline:    ', succ);
console.log('Cloud partial (<80%): ', partial);
console.log('Cloud zero (real):    ', zeroR);
console.log('Registry-skip:        ', skip);
console.log('No data parseable:    ', nodata);
console.log('SUM:                  ', succ + partial + zeroR + skip + nodata);

const ibuZero = buckets.cloud_zero.filter(b => b.category && b.category.includes('IFSC'));
const ibuSucc = buckets.succ_ge.filter(b => b.slug.endsWith('-ibu') || (b.slug && b.slug.includes('ibu')));
const ibuPart = buckets.partial.filter(b => b.category && b.category.includes('IFSC'));
console.log('\nIBU breakdown:');
console.log('  zero:    ', ibuZero.length);
console.log('  succ_ge: ', ibuSucc.length);
console.log('  partial: ', ibuPart.length);
console.log('\nIBU cloud-zero (still failing):');
for (const b of ibuZero) console.log(`  ${b.slug.padEnd(35)} baseline=${b.baseSlabs}`);
console.log('\nIBU >= baseline (cloud succeeded):');
for (const b of ibuSucc) console.log(`  ${b.slug.padEnd(35)} cloud=${b.cloud} base=${b.baseSlabs}`);
console.log('\nIBU partial:');
for (const b of ibuPart) console.log(`  ${b.slug.padEnd(35)} cloud=${b.cloud} base=${b.baseSlabs}`);

fs.writeFileSync('logs/sprint-010/cloud-outcome-buckets-v2.json', JSON.stringify(buckets, null, 2)); // safe-write-exempt: ad-hoc analysis artifact under logs/, not a per-bank rates/config/summary file.
console.log('\nSaved logs/sprint-010/cloud-outcome-buckets-v2.json');

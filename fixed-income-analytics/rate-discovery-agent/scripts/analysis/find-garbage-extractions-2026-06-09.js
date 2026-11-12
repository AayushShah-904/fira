#!/usr/bin/env node

/**
 * Audit every output/latest/*_rates.json for garbage-extraction signatures
 * (the class that pulled chittoor-DCCB / sbpp / kerala-state-co-op into the
 * Phase K blocked set). Cross-checks HEAD git — if HEAD has plausible data
 * for the same file, flags as recovery candidate.
 *
 * Garbage signatures applied per-slab:
 *   G1: rate_general_pct > 25 (impossibly high for FD; bank rate cards top
 *       out around 9 % retail + ~10 % senior)
 *   G2: tenure_text matches `^\d+\.?\d*$` (pure number) — e.g. "12.45",
 *       "10.", "1." — row indices or rate values landed in tenure_text
 *   G3: tenure_text matches loan-product keywords (LOAN, JLG, MSME, MICRO
 *       FINANCE, OD, OVERDRAFT, ADVANCE, BORROWING) — non-FD product rows
 *   G4: tenure_min_days AND tenure_max_days both null AND the tenure_text
 *       isn't an obviously legitimate special-scheme name (very loose; only
 *       used as a tiebreaker)
 *
 * Per-bank classification:
 *   - "garbage": >= 50 % of slabs hit G1/G2/G3 (strict majority of nonsense)
 *   - "suspect": 20-50 % hit, manual review
 *   - "clean": < 20 % hit
 *
 * Cross-check HEAD content with the same rules; if current is garbage and
 * HEAD is clean, emit a restoration candidate with rationale.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { classifyRatesFile } = require('../../lib/rate-quality/garbage-detector');

const LATEST_DIR = path.join(__dirname, '..', '..', 'output', 'latest');
const GIT_PREFIX = 'rate-discovery-agent/output/latest';

// Thin wrapper that adds a samples[] for human-readable diagnostics.
function classifyFile(j) {
  const r = classifyRatesFile(j);
  const samples = [];
  const slabs = Array.isArray(j?.rate_slabs) ? j.rate_slabs : [];
  if (r.garbage_count > 0) {
    for (const s of slabs) {
      const { classifySlab } = require('../../lib/rate-quality/garbage-detector');
      const f = classifySlab(s);
      if (f.length > 0 && samples.length < 3) samples.push({ tenure: s.tenure_text, rate: s.rate_general_pct, flags: f });
    }
  }
  return { verdict: r.verdict, garbage: r.garbage_count, total: r.slab_count, pct: Math.round(r.garbage_pct * 100), flags: r.flag_counts, samples };
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function gitShow(rel) {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

function main() {
  const files = fs.readdirSync(LATEST_DIR).filter(f => f.endsWith('_rates.json') && !f.endsWith('.pending.json'));
  const candidates = [];
  const stats = { examined: 0, garbage: 0, suspect: 0, clean: 0, empty: 0, head_clean: 0, head_also_bad: 0 };

  for (const fname of files) {
    stats.examined++;
    const local = path.join(LATEST_DIR, fname);
    const cur = readJsonSafe(local);
    if (!cur) continue;
    const curC = classifyFile(cur);
    stats[curC.verdict]++;
    if (curC.verdict !== 'garbage' && curC.verdict !== 'suspect') continue;

    const headText = gitShow(`${GIT_PREFIX}/${fname}`);
    if (!headText) continue;
    const head = JSON.parse(headText);
    const headC = classifyFile(head);

    if (headC.verdict === 'clean' && (head.rate_slabs || []).length > 0) {
      stats.head_clean++;
      candidates.push({
        file: fname,
        current_verdict: curC.verdict,
        current_slabs: curC.total,
        current_garbage_pct: curC.pct,
        current_flags: curC.flags,
        current_sample_garbage: curC.samples,
        current_method: cur.extraction_method,
        head_verdict: headC.verdict,
        head_slabs: headC.total,
        head_method: head.extraction_method,
        head_first_3: (head.rate_slabs || []).slice(0, 3).map(s => ({ t: s.tenure_text, min: s.tenure_min_days, max: s.tenure_max_days, gen: s.rate_general_pct })),
      });
    } else {
      stats.head_also_bad++;
    }
  }

  console.log('=== Garbage-extraction audit ===');
  console.log(`files examined: ${stats.examined}`);
  console.log(`  clean   : ${stats.clean}`);
  console.log(`  empty   : ${stats.empty}`);
  console.log(`  suspect : ${stats.suspect}`);
  console.log(`  garbage : ${stats.garbage}`);
  console.log('');
  console.log(`current=bad + HEAD=clean (RECOVERY CANDIDATES): ${candidates.length}`);
  console.log(`current=bad + HEAD=also bad (Sprint 011 fix)  : ${stats.head_also_bad}`);
  console.log('');

  if (candidates.length > 0) {
    console.log('--- RECOVERY CANDIDATES ---');
    for (const c of candidates) {
      console.log(`\n${c.file}`);
      console.log(`  current: ${c.current_slabs} slabs (${c.current_garbage_pct}% garbage, flags ${JSON.stringify(c.current_flags)}), method=${c.current_method}`);
      console.log(`    sample garbage: ${JSON.stringify(c.current_sample_garbage)}`);
      console.log(`  HEAD   : ${c.head_slabs} slabs (verdict=${c.head_verdict}), method=${c.head_method}`);
      console.log(`    HEAD first 3: ${JSON.stringify(c.head_first_3)}`);
    }
  }

  const outPath = path.join(__dirname, '..', '..', 'logs', 'sprint-010', 'garbage-extraction-audit.json');
  // safe-write-exempt: one-shot audit log under logs/, not a per-bank artifact.
  fs.writeFileSync(outPath, JSON.stringify({ stats, candidates }, null, 2));
  console.log(`\ndetail log: ${outPath}`);
}

main();

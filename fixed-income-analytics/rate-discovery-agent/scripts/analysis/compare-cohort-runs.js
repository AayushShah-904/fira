#!/usr/bin/env node
'use strict';

/**
 * Sprint 002 #13 — compare two cohort runs and emit a delta report.
 *
 * Inputs: two run-output directories (each containing `<slug>.summary.json`
 * + `<slug>_attempt2.summary.json` files with `failure_class` and
 * `phase_outcomes` populated per the v2 taxonomy).
 *
 * Output: a Markdown report comparing the per-bank classification deltas
 * across the two runs. Designed to compare the Sprint 002 cloud DCCB rerun
 * (#12) against the Sprint 001 forensic snapshot — the headline lift number
 * Sprint 002 closes on.
 *
 * Usage:
 *   node scripts/analysis/compare-cohort-runs.js <baseline-dir> <new-dir>
 *
 * Optional flags:
 *   --label-baseline "Sprint 001 cloud"
 *   --label-new      "Sprint 002 cloud rerun"
 *   --output         path/to/report.md     (defaults to stdout)
 *
 * The two runs need not have identical bank sets — banks present in only
 * one run are listed under "Coverage delta". Banks present in both get a
 * transition row.
 */

const fs = require('fs');
const path = require('path');

const FAILURE_CLASS_ORDER = [
  'success',
  'partial_success',
  'extraction_failed',
  'discovery_failed',
  'no_rates_expected',
  'agent_error',
  'unclassified',
];

const WEBSITE_OUTCOME_ORDER = ['found_committed', 'reachable_uncommitted', 'candidates_all_failed', 'no_candidates'];

/**
 * Read a directory's per-bank summary files. Returns Map<slug, summary>
 * with attempt2 preferred over base when both exist.
 */
function collectFinalSummaries(runDir) {
  const out = new Map();
  if (!fs.existsSync(runDir)) return out;

  const entries = fs.readdirSync(runDir);
  const re = /^(.+?)(_attempt2)?\.summary\.json$/;

  for (const f of entries) {
    if (f.startsWith('_')) continue;
    const m = f.match(re);
    if (!m) continue;
    const slug = m[1];
    const isAttempt2 = !!m[2];
    const cur = out.get(slug);
    if (!cur || (isAttempt2 && !cur.fromAttempt2)) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf-8'));
        out.set(slug, { data, fromAttempt2: isAttempt2 });
      } catch {
        // skip unparsable
      }
    }
  }

  return out;
}

function classifyOf(summary) {
  return summary && summary.data && summary.data.failure_class
    ? summary.data.failure_class
    : 'unclassified';
}

function phaseOutcomeOf(summary) {
  return summary && summary.data && summary.data.phase_outcomes
    ? summary.data.phase_outcomes
    : { website: 'no_candidates', rate_page: 'not_attempted', extraction: 'not_attempted' };
}

function slabCountOf(summary) {
  return summary && summary.data && summary.data.failure_signals
    ? (summary.data.failure_signals.slab_count || 0)
    : 0;
}

function compareRuns({ baselineDir, newDir, baselineLabel = 'baseline', newLabel = 'new' }) {
  const baseline = collectFinalSummaries(baselineDir);
  const newRun = collectFinalSummaries(newDir);

  const allSlugs = new Set([...baseline.keys(), ...newRun.keys()]);
  const transitions = [];
  const onlyInBaseline = [];
  const onlyInNew = [];

  for (const slug of [...allSlugs].sort()) {
    const b = baseline.get(slug);
    const n = newRun.get(slug);
    if (!n) { onlyInBaseline.push({ slug, classify: classifyOf(b), slabs: slabCountOf(b) }); continue; }
    if (!b) { onlyInNew.push({ slug, classify: classifyOf(n), slabs: slabCountOf(n) }); continue; }
    transitions.push({
      slug,
      from: classifyOf(b),
      to:   classifyOf(n),
      fromPhase: phaseOutcomeOf(b),
      toPhase:   phaseOutcomeOf(n),
      fromSlabs: slabCountOf(b),
      toSlabs:   slabCountOf(n),
    });
  }

  // Tier-2 distribution per run
  const dist = (map) => {
    const c = Object.fromEntries(FAILURE_CLASS_ORDER.map((k) => [k, 0]));
    for (const summary of map.values()) {
      const cls = classifyOf(summary);
      if (c[cls] === undefined) c[cls] = 0;
      c[cls]++;
    }
    return c;
  };
  const baselineDist = dist(baseline);
  const newDist = dist(newRun);

  // Transition matrix (only banks present in both runs)
  const matrix = {};
  for (const t of transitions) {
    matrix[t.from] = matrix[t.from] || {};
    matrix[t.from][t.to] = (matrix[t.from][t.to] || 0) + 1;
  }

  return {
    baselineLabel,
    newLabel,
    baselineCount: baseline.size,
    newCount: newRun.size,
    sharedCount: transitions.length,
    baselineDist,
    newDist,
    transitions,
    matrix,
    onlyInBaseline,
    onlyInNew,
  };
}

function pct(n, total) {
  if (!total) return '—';
  return ((n / total) * 100).toFixed(1) + '%';
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Cohort comparison — ${report.baselineLabel} → ${report.newLabel}`);
  lines.push('');
  lines.push(`- **${report.baselineLabel}:** ${report.baselineCount} banks`);
  lines.push(`- **${report.newLabel}:** ${report.newCount} banks`);
  lines.push(`- **Shared (in both runs):** ${report.sharedCount}`);
  lines.push(`- **Only in ${report.baselineLabel}:** ${report.onlyInBaseline.length}`);
  lines.push(`- **Only in ${report.newLabel}:** ${report.onlyInNew.length}`);
  lines.push('');

  lines.push('## Tier-2 distribution side-by-side');
  lines.push('');
  lines.push(`| failure_class | ${report.baselineLabel} | % | ${report.newLabel} | % | Δ (pp) |`);
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const cls of FAILURE_CLASS_ORDER) {
    const a = report.baselineDist[cls] || 0;
    const b = report.newDist[cls] || 0;
    if (a === 0 && b === 0) continue;
    const aPct = report.baselineCount > 0 ? (a / report.baselineCount) * 100 : 0;
    const bPct = report.newCount > 0 ? (b / report.newCount) * 100 : 0;
    const delta = (bPct - aPct).toFixed(1);
    const sign = delta > 0 ? '+' : '';
    lines.push(`| \`${cls}\` | ${a} | ${aPct.toFixed(1)}% | ${b} | ${bPct.toFixed(1)}% | ${sign}${delta} |`);
  }
  lines.push('');

  if (report.sharedCount > 0) {
    lines.push('## Transition matrix (banks in both runs)');
    lines.push('');
    lines.push('Rows = ' + report.baselineLabel + '; columns = ' + report.newLabel + '. Diagonal = unchanged classification.');
    lines.push('');
    const cols = FAILURE_CLASS_ORDER.filter((c) =>
      Object.values(report.matrix).some((row) => row[c]) || c === 'success' || c === 'partial_success',
    );
    lines.push(`| from \\ to | ${cols.map((c) => `\`${c}\``).join(' | ')} | total |`);
    lines.push('|---|' + cols.map(() => '---:').join('|') + '|---:|');
    for (const from of FAILURE_CLASS_ORDER) {
      const row = report.matrix[from];
      if (!row) continue;
      const cells = cols.map((to) => (row[to] || ''));
      const total = Object.values(row).reduce((s, n) => s + n, 0);
      lines.push(`| \`${from}\` | ${cells.join(' | ')} | **${total}** |`);
    }
    lines.push('');

    // Diagonal/off-diagonal summary
    let unchanged = 0, improved = 0, regressed = 0;
    const improvementOrder = ['success', 'partial_success', 'no_rates_expected', 'extraction_failed', 'discovery_failed', 'agent_error', 'unclassified'];
    const rank = (c) => improvementOrder.indexOf(c);
    for (const t of report.transitions) {
      if (t.from === t.to) unchanged++;
      else if (rank(t.to) < rank(t.from)) improved++;
      else regressed++;
    }
    lines.push(`**Movement summary:** unchanged=${unchanged}, improved=${improved}, regressed=${regressed}.`);
    lines.push('');
  }

  if (report.onlyInBaseline.length > 0) {
    lines.push(`## Banks only in ${report.baselineLabel} (${report.onlyInBaseline.length})`);
    lines.push('');
    lines.push('| Bank | classification |');
    lines.push('|---|---|');
    for (const b of report.onlyInBaseline.slice(0, 50)) {
      lines.push(`| \`${b.slug}\` | ${b.classify} |`);
    }
    if (report.onlyInBaseline.length > 50) lines.push(`| ... +${report.onlyInBaseline.length - 50} more | |`);
    lines.push('');
  }

  if (report.onlyInNew.length > 0) {
    lines.push(`## Banks only in ${report.newLabel} (${report.onlyInNew.length})`);
    lines.push('');
    lines.push('| Bank | classification |');
    lines.push('|---|---|');
    for (const b of report.onlyInNew.slice(0, 50)) {
      lines.push(`| \`${b.slug}\` | ${b.classify} |`);
    }
    if (report.onlyInNew.length > 50) lines.push(`| ... +${report.onlyInNew.length - 50} more | |`);
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const baselineDir = args[0];
  const newDir = args[1];
  if (!baselineDir || !newDir) {
    console.error('Usage: node scripts/analysis/compare-cohort-runs.js <baseline-dir> <new-dir> [--label-baseline X] [--label-new Y] [--output path]');
    process.exit(1);
  }

  let baselineLabel = 'baseline';
  let newLabel = 'new';
  let outputPath = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--label-baseline') baselineLabel = args[++i];
    else if (args[i] === '--label-new') newLabel = args[++i];
    else if (args[i] === '--output') outputPath = args[++i];
  }

  const report = compareRuns({ baselineDir, newDir, baselineLabel, newLabel });
  const md = renderMarkdown(report);

  if (outputPath) {
    // safe-write-exempt: comparison report (markdown), operational analysis output not a per-bank artifact.
    fs.writeFileSync(outputPath, md);
    console.log('Wrote', outputPath);
  } else {
    console.log(md);
  }
}

if (require.main === module) {
  main();
}

module.exports = { compareRuns, renderMarkdown, collectFinalSummaries };

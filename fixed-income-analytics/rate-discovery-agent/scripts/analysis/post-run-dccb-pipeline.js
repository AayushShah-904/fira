#!/usr/bin/env node
'use strict';

/**
 * Sprint 002 #12 + #13 post-run pipeline.
 *
 * After the full DCCB cloud rerun (execution hdh2hlz) completes:
 *   1. Pull artifacts from blob into an isolated dir.
 *   2. Filter to the 350-slug Sprint 001 cohort.
 *   3. Generate the lift-comparison report against the Sprint 001 forensic
 *      snapshot.
 *
 * Usage:
 *   node scripts/analysis/post-run-dccb-pipeline.js \
 *     --execution caj-bofia-rate-discovery-prod-hdh2hlz \
 *     --slugs .tmp-dccb-slugs-full.json \
 *     --baseline C:/sw/BharatOmni/UFA/agent-data-backup/fixed-income-yield-advisor/output/latest \
 *     --out-dir output/dccb-rerun-2026-05-13 \
 *     --report sdlc/sprints/sprint-002/implementation/cloud-rerun-comparison.md
 *
 * Each step is idempotent; safe to re-run if a network blip interrupts pull.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

const execution = flag('--execution');
const slugsPath = flag('--slugs');
const baselineDir = flag('--baseline');
const outDir = flag('--out-dir');
const reportPath = flag('--report');

if (!execution || !slugsPath || !baselineDir || !outDir || !reportPath) {
  console.error('Usage: --execution <id> --slugs <json> --baseline <dir> --out-dir <dir> --report <md>');
  process.exit(1);
}

const slugs = JSON.parse(fs.readFileSync(slugsPath, 'utf-8'));
const slugSet = new Set(slugs);
const fullPullDir = path.resolve(`${outDir}-fullpull`);
const filteredDir = path.resolve(outDir);

console.log('=== Step 1: pull from blob ===');
fs.mkdirSync(fullPullDir, { recursive: true });
const pullRes = spawnSync('node', ['-e', `
const sync = require('./cloud/sync.js');
(async () => {
  await sync.pull({
    isCloud: true,
    latestDir: ${JSON.stringify(fullPullDir)},
    domainsPath: ${JSON.stringify(path.join(fullPullDir, '_bank-domains.json'))},
  });
})().catch(e => { console.error('PULL ERR:', e.message); process.exit(1); });
`], { stdio: 'inherit' });
if (pullRes.status !== 0) { console.error('pull failed'); process.exit(1); }

console.log('\n=== Step 2: filter to the 350 DCCB cohort ===');
fs.mkdirSync(filteredDir, { recursive: true });
let copied = 0;
const VARIANT_RE = /^([a-z0-9-]+)(_(nre|nro|fcnr|gift)_rates)?(\.summary|\.trace|\.log|_attempt2\.summary|_attempt2\.trace|_config|_rates)?(\.json|\.jsonl|\.log)?$/;
for (const f of fs.readdirSync(fullPullDir)) {
  if (f.startsWith('_')) continue;
  // strip suffix back to slug
  const slug = f.replace(/(_attempt2)?\.summary\.json$/, '')
                .replace(/(_attempt2)?\.trace\.jsonl$/, '')
                .replace(/\.log$/, '')
                .replace(/_config\.json$/, '')
                .replace(/_(nre|nro|fcnr|gift)?_?rates\.json$/, '');
  if (slugSet.has(slug)) {
    // safe-write-exempt: operator post-run pipeline copies blob-sourced artifacts into analysis dir
    fs.copyFileSync(path.join(fullPullDir, f), path.join(filteredDir, f));
    copied++;
  }
}
console.log(`copied ${copied} files for the 350-bank cohort to ${filteredDir}`);

console.log('\n=== Step 3: generate comparison report ===');
const cmpRes = spawnSync('node', [
  'scripts/analysis/compare-cohort-runs.js',
  baselineDir,
  filteredDir,
  '--label-baseline', 'Sprint 001 cloud (2026-05-08)',
  '--label-new',      `Sprint 002 cloud rerun (2026-05-13, exec ${execution})`,
  '--output', reportPath,
], { stdio: 'inherit' });
if (cmpRes.status !== 0) { console.error('compare failed'); process.exit(1); }

console.log('\n=== Step 4: tier-2 distribution summary ===');
const FAILURE_CLASS_ORDER = ['success','partial_success','extraction_failed','discovery_failed','no_rates_expected','agent_error','unclassified'];
const buckets = Object.fromEntries(FAILURE_CLASS_ORDER.map(k => [k, []]));
for (const slug of slugs) {
  const a2 = path.join(filteredDir, slug + '_attempt2.summary.json');
  const a1 = path.join(filteredDir, slug + '.summary.json');
  const fp = fs.existsSync(a2) ? a2 : (fs.existsSync(a1) ? a1 : null);
  let cls = 'unclassified';
  if (fp) {
    try { cls = (JSON.parse(fs.readFileSync(fp, 'utf-8')).failure_class) || 'unclassified'; } catch { /* skip */ }
  }
  if (!buckets[cls]) buckets[cls] = [];
  buckets[cls].push(slug);
}
const total = slugs.length;
console.log(`\nCohort: ${total} banks`);
for (const k of FAILURE_CLASS_ORDER) {
  const n = buckets[k].length;
  if (n > 0) console.log(`  ${k.padEnd(22)} ${n.toString().padStart(3)} (${((n/total)*100).toFixed(1)}%)`);
}
console.log(`\nReport: ${reportPath}`);
console.log('Done.');

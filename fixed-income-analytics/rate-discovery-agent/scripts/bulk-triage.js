#!/usr/bin/env node
'use strict';

/**
 * Companion to bulk-author.js — analyze the report and bucket failures by pattern.
 *
 * For the REVIEW + FAIL buckets, classifies banks by failure mode so Claude /
 * operator can fix in batches:
 *   - waf_cloudflare / waf_akamai / etc.    → need stealth or manual route
 *   - js_under_extraction (<5 slabs from page with many tables) → need fetch tuning
 *     (expand_accordions, click_to_reveal, etc.)
 *   - propose_failed (LLM said null)        → page genuinely not a rate card
 *   - missing_long_tenure                   → bank only publishes short tenures
 *   - rate_out_of_range                     → mis-mapped column (probably amount-text-as-rate)
 *   - baseline_drop                         → coalescing-aware compare; usually OK
 *
 * Also produces a per-cluster summary (template_hash → verdict counts) to
 * spot patterns where ONE bank in a cluster fails but the rest pass — those
 * are usually one-off page quirks.
 *
 * Usage:
 *   node scripts/bulk-triage.js [--report tmp/bulk-author-report.json]
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT = path.join(REPO_ROOT, 'tmp', 'bulk-author-report.json');
const { classifyFailure, classifyReview } = require('./utils/classify-verdict');

function parseArgs(argv) {
  const out = { report: DEFAULT_REPORT };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report') out.report = args[++i];
    else if (args[i] === '--help') { console.log('node scripts/bulk-triage.js [--report path]'); process.exit(0); }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  const report = JSON.parse(fs.readFileSync(opts.report, 'utf-8'));
  const results = report.results || [];

  const totals = { PASS: 0, REVIEW: 0, FAIL: 0 };
  for (const r of results) totals[r.verdict] = (totals[r.verdict] || 0) + 1;

  console.log(`=== Bulk-author triage (${path.basename(opts.report)}) ===`);
  console.log(`Cohort: ${report.cohort_size} | LLM calls: ${report.llm_calls} | Clusters: ${report.clusters} | Total: ${(report.total_ms / 1000).toFixed(0)}s`);
  console.log(`Verdicts: PASS=${totals.PASS}  REVIEW=${totals.REVIEW}  FAIL=${totals.FAIL}\n`);

  // FAIL bucket by classification
  const failByCat = {};
  for (const r of results.filter(x => x.verdict === 'FAIL')) {
    const c = classifyFailure(r);
    failByCat[c] = failByCat[c] || [];
    failByCat[c].push(r);
  }
  console.log('=== FAIL bucket by classification ===');
  for (const [cat, banks] of Object.entries(failByCat).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${cat.padEnd(28)} ${String(banks.length).padStart(3)}  e.g. ${banks.slice(0, 3).map(b => b.slug).join(', ')}`);
  }

  // REVIEW bucket by classification
  console.log('\n=== REVIEW bucket by classification ===');
  const revByCat = {};
  for (const r of results.filter(x => x.verdict === 'REVIEW')) {
    const c = classifyReview(r);
    revByCat[c] = revByCat[c] || [];
    revByCat[c].push(r);
  }
  for (const [cat, banks] of Object.entries(revByCat).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${cat.padEnd(28)} ${String(banks.length).padStart(3)}  e.g. ${banks.slice(0, 3).map(b => `${b.slug}(${b.slab_count})`).join(', ')}`);
  }

  // Cluster analysis: template_hash → verdict counts. Spot where ONE bank in
  // a cluster fails but the rest pass (usually one-off page quirk; fix once,
  // cluster-reuse for the rest).
  console.log('\n=== Cluster verdict distribution (template_hash → {PASS, REVIEW, FAIL}) ===');
  const byCluster = {};
  for (const r of results) {
    const h = r.template_hash || '(no fingerprint)';
    byCluster[h] = byCluster[h] || { PASS: 0, REVIEW: 0, FAIL: 0, banks: [] };
    byCluster[h][r.verdict]++;
    byCluster[h].banks.push(r.slug);
  }
  const mixedClusters = Object.entries(byCluster)
    .filter(([h, c]) => c.banks.length > 1 && (c.PASS > 0 && (c.REVIEW > 0 || c.FAIL > 0) || c.REVIEW > 0 && c.FAIL > 0))
    .sort((a, b) => b[1].banks.length - a[1].banks.length)
    .slice(0, 10);
  if (mixedClusters.length === 0) {
    console.log('  (no mixed clusters — every cluster\'s banks share the same verdict)');
  } else {
    for (const [h, c] of mixedClusters) {
      console.log(`  ${h.slice(0, 24)}  P=${c.PASS} R=${c.REVIEW} F=${c.FAIL}  e.g. ${c.banks.slice(0, 3).join(', ')}`);
    }
  }

  // PASS bucket by category
  console.log('\n=== PASS bucket by bank category ===');
  const passByCat = {};
  for (const r of results.filter(x => x.verdict === 'PASS')) {
    const c = r.category || '(unknown)';
    passByCat[c] = (passByCat[c] || 0) + 1;
  }
  for (const [c, n] of Object.entries(passByCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(42)} ${n}`);
  }

  // Specific actionable lists
  console.log('\n=== Actionable next steps ===');
  if (failByCat['waf_or_unreachable']) {
    console.log(`\nWAF-blocked banks (${failByCat['waf_or_unreachable'].length}) — consider manual transcription via bin/approve-accept.js:`);
    for (const b of failByCat['waf_or_unreachable'].slice(0, 15)) console.log(`  ${b.slug}  [${b.category || '?'}]`);
    if (failByCat['waf_or_unreachable'].length > 15) console.log(`  ... +${failByCat['waf_or_unreachable'].length - 15} more`);
  }
  if (revByCat['slab_count_low']) {
    console.log(`\nLow-slab REVIEW banks (${revByCat['slab_count_low'].length}) — likely need fetch tuning (expand_accordions / click_to_reveal):`);
    for (const b of revByCat['slab_count_low'].slice(0, 15)) console.log(`  ${b.slug}  slabs=${b.slab_count}  fingerprint=${(b.template_hash || '').slice(0, 16)}`);
  }
  if (failByCat['extract_zero_slabs']) {
    console.log(`\nZero-slab FAIL banks (${failByCat['extract_zero_slabs'].length}) — LLM picked wrong table or extractor mis-mapped:`);
    for (const b of failByCat['extract_zero_slabs'].slice(0, 15)) console.log(`  ${b.slug}  template_id=${b.template_id}`);
  }
}

main();

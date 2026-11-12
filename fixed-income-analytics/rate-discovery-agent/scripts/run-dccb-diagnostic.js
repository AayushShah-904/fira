#!/usr/bin/env node
'use strict';

/**
 * Sprint 002 #3 — Local DCCB diagnostic run.
 *
 * Pulls the stratified 34-bank sample via the selector, runs
 * `node run-discovery.js` against each into a dedicated run directory,
 * captures per-bank logs, and produces _run_analysis.json + _run_report.md
 * at the end.
 *
 * Uses run-discovery.js directly (not run-pipeline.js) so we don't have
 * to fight pipeline's status classifier — every sampled bank is forced
 * through discovery regardless of its state in output/latest/.
 *
 * Usage:
 *   node scripts/run-dccb-diagnostic.js              — run all 34 banks
 *   node scripts/run-dccb-diagnostic.js --limit 3    — first N banks (smoke)
 *   node scripts/run-dccb-diagnostic.js --resume     — skip banks already done
 *
 * Cost guard rail: this can spend $20-30 of AOAI. Acknowledge before running.
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { selectSample } = require('./analysis/select-dccb-diagnostic-sample');
const { buildRunAnalysis } = require('../lib/run-aggregator');
const { renderRunReport } = require('../lib/run-report-renderer');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DISCOVERY = path.join(PROJECT_ROOT, 'run-discovery.js');

const args = process.argv.slice(2);
const limit = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : 0;
})();
const resume = args.includes('--resume');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
}

function fmt(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function alreadyDone(runDir, slug) {
  return fs.existsSync(path.join(runDir, `${slug}.summary.json`))
    || fs.existsSync(path.join(runDir, `${slug}_attempt2.summary.json`));
}

async function main() {
  const sample = selectSample();
  const banks = limit > 0 ? sample.slice(0, limit) : sample;

  const runLabel = `${timestamp()}_sprint002-diagnostic`;
  const runDir = path.join(PROJECT_ROOT, 'output', 'runs', runLabel);
  fs.mkdirSync(runDir, { recursive: true });

  const sampleFile = path.join(runDir, '_sample.json');
  // safe-write-exempt: diagnostic batch input sample (_sample.json), operational not per-bank.
  fs.writeFileSync(sampleFile, JSON.stringify(banks, null, 2));

  console.log(`Run label:  ${runLabel}`);
  console.log(`Run dir:    ${runDir}`);
  console.log(`Banks:      ${banks.length}${limit > 0 ? ` (limited from ${sample.length})` : ''}`);
  console.log(`Resume:     ${resume}`);
  console.log();

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const processedBankCodes = [];

  for (let i = 0; i < banks.length; i++) {
    const b = banks[i];
    const prefix = `[${i + 1}/${banks.length}] ${b.slug}`;

    if (resume && alreadyDone(runDir, b.slug)) {
      console.log(`${prefix} — skip (already done)`);
      processedBankCodes.push(b.slug);
      continue;
    }

    console.log(`${prefix} — ${b.name} | ${b.state || '?'} | cohort=${b.cohort}`);
    const bankStart = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        DISCOVERY,
        b.name,
        'District Central Co-operative Bank',
        b.state || '',
        '--log-level', 'debug',
        '--output-dir', runDir,
      ],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'inherit' },
    );
    const bankMs = Date.now() - bankStart;
    processedBankCodes.push(b.slug);
    console.log(`${prefix} — done in ${fmt(bankMs)} (exit ${result.status})`);
    console.log();
  }

  const endedAt = new Date().toISOString();
  const totalMs = Date.now() - startMs;
  console.log('='.repeat(60));
  console.log(`Total elapsed: ${fmt(totalMs)}`);
  console.log('Aggregating run analysis...');

  const pendingChangesFile = path.join(PROJECT_ROOT, 'data', 'bank-domains-pending.json');
  const analysis = buildRunAnalysis({
    runDir,
    runLabel,
    category: 'District Central Co-operative Bank',
    startedAt,
    endedAt,
    bankCodes: processedBankCodes,
    pendingChangesFile: fs.existsSync(pendingChangesFile) ? pendingChangesFile : null,
  });
  // safe-write-exempt: aggregator output (_run_analysis.json), not a per-bank artifact.
  fs.writeFileSync(path.join(runDir, '_run_analysis.json'), JSON.stringify(analysis, null, 2) + '\n');
  // safe-write-exempt: aggregator output (_run_report.md markdown), not a per-bank artifact.
  fs.writeFileSync(path.join(runDir, '_run_report.md'), renderRunReport(analysis));

  console.log();
  console.log(`Run analysis: ${path.join(runDir, '_run_analysis.json')}`);
  console.log(`Report:       ${path.join(runDir, '_run_report.md')}`);
  console.log();
  console.log('Headline:');
  console.log(`  ${analysis.totals.succeeded || 0} succeeded / ${analysis.totals.partial_success || 0} partial / ${analysis.totals.failed || 0} failed / ${analysis.totals.dispatched} dispatched`);
  console.log(`  cost: $${(analysis.cost_usd_total || 0).toFixed(2)}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

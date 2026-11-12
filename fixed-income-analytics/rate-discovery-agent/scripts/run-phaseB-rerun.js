#!/usr/bin/env node
'use strict';

/**
 * Sprint 002 #7 (Phase B): re-run the 12 banks the operator triaged in the
 * Sprint 002 #5 session, after Phase A codifications landed. Compares
 * classification before/after to measure the lift.
 *
 * Different from scripts/run-dccb-diagnostic.js — that runs a stratified
 * 34-bank sample; this one is the focused 12 from the operator queue.
 *
 * Usage:
 *   node scripts/run-phaseB-rerun.js
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildRunAnalysis } = require('../lib/run-aggregator');
const { renderRunReport } = require('../lib/run-report-renderer');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DISCOVERY = path.join(PROJECT_ROOT, 'run-discovery.js');
const MASTER_CSV = path.join(PROJECT_ROOT, 'data', 'Indian_Banks_Comprehensive_List_RBI.csv');

const SLUGS = [
  'agra-zilla-sahakari-bank-ltd',
  'azamgarh-district-central-co-operative-bank-ltd',
  'bhatinda-central-co-operative-bank-ltd',
  'dhanbad-district-central-co-operative-bank-ltd',
  'gondia-district-central-co-operative-bank-ltd',
  'indore-premier-co-operative-bank-ltd',
  'angul-united-central-co-operative-bank-ltd',
  'banswara-central-co-operative-bank-ltd',
  'barmer-central-co-operative-bank-ltd',
  'nizamabad-district-co-operative-central-bank-ltd',
  'bankura-district-central-co-operative-bank-ltd',
  'ajmer-central-co-operative-bank-ltd',
];

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function readMaster() {
  const lines = fs.readFileSync(MASTER_CSV, 'utf-8').split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    rows.push({ name: cols[1].trim(), category: cols[2].trim(), state: cols[3].trim(), city: cols[4].trim() });
  }
  return rows;
}

function fmt(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
}

async function main() {
  const master = readMaster();
  const bySlug = new Map();
  for (const r of master) bySlug.set(slugify(r.name), r);

  const banks = SLUGS.map((slug) => {
    const m = bySlug.get(slug);
    if (!m) {
      console.warn(`! ${slug} not found in master CSV`);
      return null;
    }
    return { slug, name: m.name, state: m.state };
  }).filter(Boolean);

  const runLabel = `${timestamp()}_sprint002-phaseB-rerun`;
  const runDir = path.join(PROJECT_ROOT, 'output', 'runs', runLabel);
  fs.mkdirSync(runDir, { recursive: true });
  // safe-write-exempt: diagnostic batch input sample (_sample.json), operational not per-bank.
  fs.writeFileSync(path.join(runDir, '_sample.json'), JSON.stringify(banks, null, 2));

  console.log(`Run label: ${runLabel}`);
  console.log(`Banks: ${banks.length}`);
  console.log();

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const processedBankCodes = [];

  for (let i = 0; i < banks.length; i++) {
    const b = banks[i];
    const prefix = `[${i + 1}/${banks.length}] ${b.slug}`;
    console.log(`${prefix} — ${b.name} | ${b.state || '?'}`);
    const bankStart = Date.now();
    const result = spawnSync(
      process.execPath,
      [DISCOVERY, b.name, 'District Central Co-operative Bank', b.state || '', '--log-level', 'debug', '--output-dir', runDir],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'inherit' },
    );
    const ms = Date.now() - bankStart;
    processedBankCodes.push(b.slug);
    console.log(`${prefix} — done in ${fmt(ms)} (exit ${result.status})`);
    console.log();
  }

  const endedAt = new Date().toISOString();
  console.log('='.repeat(60));
  console.log(`Total elapsed: ${fmt(Date.now() - startMs)}`);

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
  console.log('Headline:');
  console.log(`  ${analysis.totals.succeeded || 0} succeeded / ${analysis.totals.partial_success || 0} partial / ${analysis.totals.failed || 0} failed / ${analysis.totals.dispatched} dispatched`);
  console.log(`  cost: $${(analysis.cost_usd_total || 0).toFixed(2)}`);
  console.log(`  report: ${path.join(runDir, '_run_report.md')}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

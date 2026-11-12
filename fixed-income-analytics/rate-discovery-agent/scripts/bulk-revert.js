#!/usr/bin/env node
'use strict';

/**
 * Companion to bulk-author.js — undo template blocks persisted by the agent.
 *
 * Safety net for the loosened trust boundary: every `--write` from bulk-author
 * tags entries with `<key>.audit.persisted_by = "bulk-author"`, where <key> is
 * `template` (domestic) or `template_gift` / `template_fcnr` (foreign-currency
 * products persisted alongside a domestic template). This script walks the
 * registry and deletes those tagged blocks, leaving operator-curated entries
 * untouched.
 *
 * Modes:
 *   --all                          Remove every audit.persisted_by="bulk-author"
 *   --since <ISO-date>             Only entries persisted at/after this date
 *   --banks slug1,slug2            Only these specific banks
 *   --from-report <path>           Only banks listed as PASS in this report
 *   --dry-run (default)            Print what WOULD be deleted, don't write
 *   --execute                      Actually delete (still atomic-write via safe-write)
 *
 * Exit codes:
 *   0  success
 *   2  usage error
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'data', 'bank-domains.json');
const { safeWriteArtifact } = require('../lib/safe-write');

function parseArgs(argv) {
  const out = { all: false, since: null, banks: [], fromReport: null, execute: false, help: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--all') out.all = true;
    else if (a === '--since') out.since = args[++i];
    else if (a === '--banks') out.banks = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--from-report') out.fromReport = args[++i];
    else if (a === '--execute') out.execute = true;
    else if (a === '--dry-run') out.execute = false;
    else if (a.startsWith('-')) { process.stderr.write(`unknown flag: ${a}\n`); process.exit(2); }
  }
  return out;
}

function printUsage() {
  process.stdout.write(`bulk-revert — undo bulk-author template persistences

Usage:
  node scripts/bulk-revert.js --all [--dry-run|--execute]
  node scripts/bulk-revert.js --since 2026-05-25 [--execute]
  node scripts/bulk-revert.js --banks slug1,slug2 [--execute]
  node scripts/bulk-revert.js --from-report tmp/bulk-author-report.json [--execute]

Selects template blocks whose audit.persisted_by="bulk-author" and removes them.
Operator-curated templates (no audit tag) are NEVER touched.

Default mode is --dry-run.
`);
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || (!opts.all && !opts.since && opts.banks.length === 0 && !opts.fromReport)) {
    printUsage();
    process.exit(opts.help ? 0 : 2);
  }

  const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));

  // Determine candidate slugs
  let candidateSlugs;
  if (opts.banks.length > 0) {
    candidateSlugs = opts.banks;
  } else if (opts.fromReport) {
    const report = JSON.parse(fs.readFileSync(path.isAbsolute(opts.fromReport) ? opts.fromReport : path.join(REPO_ROOT, opts.fromReport), 'utf-8'));
    candidateSlugs = (report.results || []).filter(r => r.verdict === 'PASS').map(r => r.slug);
  } else {
    candidateSlugs = Object.keys(reg);
  }

  const sinceTime = opts.since ? new Date(opts.since).getTime() : null;
  if (opts.since && Number.isNaN(sinceTime)) {
    process.stderr.write(`error: --since "${opts.since}" is not a valid ISO date\n`);
    process.exit(2);
  }

  // Filter to bulk-author tagged entries. Check all three template keys —
  // `template` (domestic) plus the foreign-currency `template_gift` /
  // `template_fcnr` blocks that bulk-author persists alongside a domestic
  // template. Each is reverted independently so reverting an fcnr block does
  // not touch the operator-or-agent-curated domestic template (and vice versa).
  const TEMPLATE_KEYS = ['template', 'template_gift', 'template_fcnr'];
  const toRevert = [];
  for (const slug of candidateSlugs) {
    const entry = reg[slug];
    if (!entry) continue;
    for (const key of TEMPLATE_KEYS) {
      const block = entry[key];
      if (!block) continue;
      const audit = block.audit;
      if (!audit || audit.persisted_by !== 'bulk-author') continue;
      if (sinceTime != null && audit.verdict_at) {
        const t = new Date(audit.verdict_at).getTime();
        if (Number.isFinite(t) && t < sinceTime) continue;
      }
      toRevert.push({ slug, key, template_id: block.template_id, verdict_at: audit.verdict_at });
    }
  }

  if (toRevert.length === 0) {
    process.stdout.write('Nothing to revert (no bulk-author-tagged templates match the filter).\n');
    process.exit(0);
  }

  process.stdout.write(`${toRevert.length} template block(s) match the filter:\n`);
  for (const r of toRevert.slice(0, 25)) {
    process.stdout.write(`  ${r.slug.padEnd(58)} ${r.key.padEnd(14)} template_id=${r.template_id}  at=${r.verdict_at}\n`);
  }
  if (toRevert.length > 25) process.stdout.write(`  ... +${toRevert.length - 25} more\n`);

  if (!opts.execute) {
    process.stdout.write(`\n(dry-run — re-run with --execute to delete these template blocks)\n`);
    process.exit(0);
  }

  for (const r of toRevert) delete reg[r.slug][r.key];
  safeWriteArtifact({
    path: REGISTRY_PATH,
    incoming: reg,
    kind: 'registry-file',
    source: 'agent',
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  });
  process.stdout.write(`\nReverted ${toRevert.length} template block(s). Registry written atomically.\n`);
}

main();

#!/usr/bin/env node
'use strict';

/**
 * Generate a cohort JSON from `data/Indian_Banks_Comprehensive_List_RBI.csv`,
 * filtered to the categories provided on the command line.
 *
 * Usage:
 *   node scripts/build-cohort-from-csv.js \
 *     --categories "Public Sector Bank,Private Sector Bank (Indian),Small Finance Bank,Payments Bank,Foreign Bank,Regional Rural Bank,Scheduled Urban Co-operative Bank,Non-Scheduled State Co-operative Bank,Scheduled State Co-operative Bank,Local Area Bank,Financial Institution,IFSC Banking Unit (IFSCA),Housing Finance Company" \
 *     --out data/cohorts/_small-categories.json
 *
 * Output shape (one entry per bank, per scripts/utils/load-cohort.js):
 *   [ { "bank_code": "<slug>", "category": "<category>", "state": "<state>" }, ... ]
 *
 * Slug is canonical (scripts/utils/slugify.js); same code path the runtime
 * uses, so cohort entries always match bank-domains.json + agent expectations.
 *
 * Sprint 4 Track A 2026-05-20: ships alongside the PM rate-pack refresh
 * cohort assembly (see sdlc/sprints/sprint-004/plan/pm-rate-pack-refresh-2026-q2.md).
 */

const fs = require('node:fs');
const path = require('node:path');
const { slugify } = require('./utils/slugify');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CSV = path.join(PROJECT_ROOT, 'data', 'Indian_Banks_Comprehensive_List_RBI.csv');

// Known canonical categories — same list as run-batch.js#KNOWN_CATEGORIES,
// kept in sync. Adding here too so we can defend against unknown categories
// on the command line.
const KNOWN_CATEGORIES = new Set([
  'Public Sector Bank',
  'Private Sector Bank (Indian)',
  'Private Sector Bank',
  'Small Finance Bank',
  'Payments Bank',
  'Foreign Bank',
  'Regional Rural Bank',
  'Scheduled Urban Co-operative Bank',
  'Non-Scheduled Urban Co-operative Bank',
  'Scheduled State Co-operative Bank',
  'Non-Scheduled State Co-operative Bank',
  'District Central Co-operative Bank',
  'Local Area Bank',
  'Financial Institution',
  'IFSC Banking Unit (IFSCA)',
  'IFSC Banking Unit',
  'Housing Finance Company',
]);

function parseArgs(argv) {
  const opts = { csv: DEFAULT_CSV, categories: [], out: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--csv' && argv[i + 1]) opts.csv = argv[++i];
    else if (a === '--categories' && argv[i + 1]) opts.categories = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
    else { console.error('Unknown arg:', a); opts.help = true; }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/build-cohort-from-csv.js --categories "<comma,separated>" [--csv <path>] [--out <path>]

Generate a cohort JSON from the RBI master list, filtered by category.

Options:
  --csv <path>           Master CSV (default: data/Indian_Banks_Comprehensive_List_RBI.csv)
  --categories "<list>"  Comma-separated category names. Names must match
                         the CSV verbatim. See KNOWN_CATEGORIES in source.
  --out <path>           Output JSON path. If omitted, prints to stdout.

Examples:
  # All banks in the small categories (each <= 42 master count):
  node scripts/build-cohort-from-csv.js \\
    --categories "Public Sector Bank,Private Sector Bank (Indian),Small Finance Bank,Payments Bank,Foreign Bank,Regional Rural Bank,Scheduled Urban Co-operative Bank,Non-Scheduled State Co-operative Bank,Scheduled State Co-operative Bank,Local Area Bank,Financial Institution,IFSC Banking Unit (IFSCA),Housing Finance Company" \\
    --out data/cohorts/_small-categories.json
`);
}

function parseCSVLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { fields.push(field.trim()); field = ''; }
    else field += c;
  }
  fields.push(field.trim());
  return fields;
}

function findCategoryInRow(fields) {
  for (let i = 2; i < fields.length; i++) {
    const val = fields[i]?.trim();
    if (KNOWN_CATEGORIES.has(val)) {
      const nameParts = fields.slice(1, i).map((f) => f.trim());
      const name = nameParts.join(', ').replace(/,\s*$/, '').trim();
      const state = fields[i + 1]?.trim() || '';
      return { name, category: val, state };
    }
  }
  return null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); return 0; }
  if (opts.categories.length === 0) { console.error('--categories is required'); printUsage(); return 1; }
  for (const c of opts.categories) {
    if (!KNOWN_CATEGORIES.has(c)) {
      console.error(`Warning: category "${c}" not in KNOWN_CATEGORIES — rows will still match by string equality but typos won't be caught.`);
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(opts.csv, 'utf-8');
  } catch (err) {
    console.error(`Failed to read CSV: ${err.message}`);
    return 1;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);  // strip BOM
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  const wanted = new Set(opts.categories);
  const byCat = new Map();  // category → count
  const entries = [];
  const seen = new Set();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    let name = fields[1]?.trim();
    let category = fields[2]?.trim();
    let state = fields[3]?.trim() || '';

    if (!KNOWN_CATEGORIES.has(category)) {
      const found = findCategoryInRow(fields);
      if (found) { name = found.name; category = found.category; state = found.state; }
      else continue;
    }

    if (!name || !category) continue;
    if (!wanted.has(category)) continue;

    const bank_code = slugify(name);
    if (seen.has(bank_code)) continue;
    seen.add(bank_code);
    entries.push({ bank_code, category, state });
    byCat.set(category, (byCat.get(category) || 0) + 1);
  }

  const json = JSON.stringify(entries, null, 2) + '\n';
  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    // safe-write-exempt: operator-driven cohort JSON output (not a per-bank artifact). ADR-012 §"NOT in scope".
    fs.writeFileSync(opts.out, json, 'utf-8');
    console.error(`Wrote ${entries.length} entries to ${path.relative(process.cwd(), opts.out)}`);
  } else {
    process.stdout.write(json);
  }
  console.error('Per-category counts:');
  for (const c of opts.categories) {
    console.error(`  ${c.padEnd(40)} ${byCat.get(c) || 0}`);
  }
  console.error(`Total: ${entries.length}`);
  return 0;
}

if (require.main === module) {
  process.exit(main() || 0);
}

module.exports = { _parseCSVLine: parseCSVLine, _findCategoryInRow: findCategoryInRow };

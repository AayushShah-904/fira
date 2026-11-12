#!/usr/bin/env node
'use strict';

/**
 * One-shot migration: data/bank-domains.json#<bank>.extraction.hints →
 * data/bank-domains.json#<bank>.template.extract.column_map.
 *
 * Sprint 006 Step 5 (Phase F begin retiring). After Sprint 7's Step 4 pilot
 * migration completes, the M2.3 per-bank extraction.hints become redundant
 * because the new template.extract.column_map is the canonical declaration.
 * This script downgrades existing hints into template column_maps then
 * deletes the extraction.hints field.
 *
 * Dry-run by default. --write requires TTY + non-agent + non-CI per the
 * Sprint 5 Phase D2 refusal cascade pattern.
 *
 * After this script runs successfully + commits, lib/extraction-hint.js
 * can be deleted (Sprint 7) since no entries in data/bank-domains.json
 * still reference the legacy hints shape.
 */

const fs = require('node:fs');
const path = require('node:path');
const { safeWriteArtifact } = require('../lib/safe-write');
const { detectAgentEnvironment, detectCiEnvironment } = require('../lib/quality-gate/signed-accepts');

const REPO_ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'data', 'bank-domains.json');

function fail(code, message) {
  process.stderr.write(`migrate-hints-to-column-maps: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { write: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else fail(2, `unknown argument: ${a}`);
  }
  return out;
}

function printUsage() {
  process.stdout.write(`migrate-hints-to-column-maps — downgrade data/bank-domains.json extraction.hints to template.extract.column_map

Usage:
  node scripts/migrate-hints-to-column-maps.js [--write]

By default this is a dry-run: walks the registry, reports what would change,
exits without writing. --write requires a TTY + non-agent + non-CI shell.

Exit codes:
  0  success / dry-run complete
  2  usage error
  10 refused (CI)
  11 refused (agent session)
  12 refused (no TTY for --write)
  20 nothing to migrate
`);
}

/**
 * Migrate one entry: extract any extraction.<key>.column_map / .columns
 * into template.extract.column_map and remove extraction.hints.
 *
 * Returns { changed: bool, plan: { added_template, removed_keys, ... }, entry }
 */
function migrateEntry(slug, entry) {
  if (!entry || typeof entry !== 'object') return { changed: false, plan: { reason: 'entry not an object' }, entry };
  if (!entry.extraction || typeof entry.extraction !== 'object') {
    return { changed: false, plan: { reason: 'no extraction.* hints to migrate' }, entry };
  }
  // Look for any extraction.<key> block that carries column_map-shaped info.
  // The M2.3 hint shape is typically { type, fulfills_product, pages: [{ columns: [...] }] }.
  // For migration: if no template block exists AND there's a recognizable column_map signal,
  // create a basic template.extract.column_map. Otherwise just delete the hints.
  const removedKeys = Object.keys(entry.extraction);
  const hadHints = removedKeys.length > 0;
  if (!hadHints) return { changed: false, plan: { reason: 'extraction object empty' }, entry };

  // Preserve any template.extract.column_map already present (operator-authored wins).
  let addedTemplate = false;
  const newEntry = JSON.parse(JSON.stringify(entry));
  if (!newEntry.template || !newEntry.template.extract || !newEntry.template.extract.column_map) {
    // Try to derive a column_map from the FIRST extraction key's first-page columns
    const firstKey = removedKeys[0];
    const firstBlock = entry.extraction[firstKey];
    if (firstBlock && Array.isArray(firstBlock.pages) && firstBlock.pages.length > 0) {
      const firstPage = firstBlock.pages[0];
      if (Array.isArray(firstPage.columns) && firstPage.columns.length > 0) {
        const columnMap = {};
        for (let i = 0; i < firstPage.columns.length; i++) {
          // Map common column-name patterns to slab fields
          const colName = String(firstPage.columns[i] || '').toLowerCase();
          if (/tenure|period/.test(colName)) columnMap[String(i)] = 'tenure_text';
          else if (/super.*senior/.test(colName)) columnMap[String(i)] = 'rate_super_senior_pct';
          else if (/senior/.test(colName)) columnMap[String(i)] = 'rate_senior_pct';
          else if (/general|rate|interest/.test(colName)) columnMap[String(i)] = 'rate_general_pct';
        }
        if (Object.keys(columnMap).length >= 2) {
          newEntry.template = newEntry.template || {};
          newEntry.template.extract = newEntry.template.extract || {};
          newEntry.template.extract.column_map = columnMap;
          addedTemplate = true;
        }
      }
    }
  }

  // Always remove the extraction.hints field after migration
  delete newEntry.extraction;
  return {
    changed: true,
    plan: {
      removed_keys: removedKeys,
      added_template_column_map: addedTemplate,
      column_map: addedTemplate ? newEntry.template.extract.column_map : null,
    },
    entry: newEntry,
  };
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }

  if (opts.write) {
    const ci = detectCiEnvironment();
    if (ci.isCI) fail(10, `--write refused under CI (${ci.reason})`);
    const ag = detectAgentEnvironment();
    if (ag.isAgent) fail(11, `--write refused inside AI-agent session (${ag.reason})`);
    if (!process.stdin.isTTY) fail(12, `--write requires a TTY for operator confirmation`);
  }

  if (!fs.existsSync(REGISTRY_PATH)) fail(2, `registry missing at ${REGISTRY_PATH}`);
  let registry;
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')); }
  catch (e) { fail(2, `registry parse failed: ${e.message}`); }

  const newRegistry = JSON.parse(JSON.stringify(registry));
  let changedCount = 0;
  const summary = [];
  for (const [slug, entry] of Object.entries(registry)) {
    const result = migrateEntry(slug, entry);
    if (result.changed) {
      changedCount++;
      summary.push({ bank: slug, ...result.plan });
      newRegistry[slug] = result.entry;
    }
  }

  process.stdout.write(`Scanned ${Object.keys(registry).length} banks; ${changedCount} have extraction.hints to migrate\n`);
  if (changedCount === 0) {
    process.stdout.write('Nothing to migrate. lib/extraction-hint.js can be deleted in Sprint 7 once this is the steady state.\n');
    process.exit(20);
  }

  if (!opts.write) {
    process.stdout.write('\n=== Dry-run summary (first 20 banks) ===\n');
    for (const s of summary.slice(0, 20)) {
      process.stdout.write(`  ${s.bank}: removed=${(s.removed_keys || []).join(',')}, added_template_column_map=${s.added_template_column_map}\n`);
    }
    if (summary.length > 20) process.stdout.write(`  ... +${summary.length - 20} more\n`);
    process.stdout.write(`\nRe-run with --write (from a clean shell, non-agent, non-CI, TTY) to persist.\n`);
    process.exit(0);
  }

  // Execute path
  safeWriteArtifact({
    path: REGISTRY_PATH,
    incoming: newRegistry,
    kind: 'registry-file',
    source: 'operator',
  });
  process.stdout.write(`\nMigrated ${changedCount} bank(s). lib/extraction-hint.js is now safe to delete (no remaining callers).\n`);
  process.stdout.write(`[METRIC] hints_migrated count=${changedCount} runtime_path=column_map\n`);
}

main();

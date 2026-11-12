#!/usr/bin/env node
'use strict';

/**
 * One-off normaliser for `currency` field on existing FCNR / GIFT slab
 * files. Walks `output/latest/*_fcnr_rates.json` (and `*_gift_rates.json`),
 * applies `normaliseCurrency` to each slab's `currency`, and writes the
 * file back if any value changed.
 *
 * Why: pre-FCNR-4a runs of the LLM-fallback path landed slabs with
 * non-canonical currency codes (EURO, YEN, "USD (Above 5L)"). Those
 * files don't get re-extracted on every cohort run, so the normaliser
 * embedded in extract_html_table.js only fixes future writes. This
 * script catches up the historical data already on disk.
 *
 * Dry-run by default; pass `--write` to persist changes.
 *
 * Usage:
 *   node scripts/analysis/normalise-fcnr-currencies.js [--write]
 */

const fs = require('node:fs');
const path = require('node:path');
const { normaliseCurrency } = require('../utils/normalise-currency');

const WRITE = process.argv.includes('--write');
const ROOT = path.resolve(__dirname, '..', '..', 'output', 'latest');

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`Output dir not found: ${ROOT}`);
    process.exit(1);
  }
  const files = fs.readdirSync(ROOT).filter(
    (f) => f.endsWith('_fcnr_rates.json') || f.endsWith('_gift_rates.json'),
  );
  console.log(`Scanning ${files.length} FCNR/GIFT rate files in ${ROOT}`);
  let changedFiles = 0;
  let changedSlabs = 0;
  let unrecognised = new Set();

  for (const f of files) {
    const p = path.join(ROOT, f);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.warn(`  skipping ${f}: parse error ${e.message}`);
      continue;
    }
    if (!Array.isArray(doc.rate_slabs)) continue;
    let fileChanged = false;
    for (const s of doc.rate_slabs) {
      if (!s.currency) continue;
      const canon = normaliseCurrency(s.currency);
      if (canon && canon !== s.currency) {
        s.currency = canon;
        changedSlabs++;
        fileChanged = true;
      } else if (!canon && /[A-Za-z]/.test(s.currency)) {
        unrecognised.add(s.currency);
      }
    }
    if (fileChanged) {
      changedFiles++;
      const bank = f.replace(/_(?:fcnr|gift)_rates\.json$/, '');
      const cur = [...new Set(doc.rate_slabs.map((s) => s.currency).filter(Boolean))];
      console.log(`  ${WRITE ? 'WROTE' : 'WOULD WRITE'} ${f.padEnd(60)} → currencies now: ${JSON.stringify(cur)}`);
      if (WRITE) {
        // TODO(sprint-006): migrate to safeWriteArtifact with operator --force; bypasses ADR-012 because pre-dates safe-write framework, runs rarely. Tracked in code-inventory.md.
        // safe-write-exempt: one-off historical-data normaliser, explicit --write gate (see TODO above for sprint-006 migration).
        fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      }
    }
  }

  console.log(`\nSummary: ${changedFiles} file(s) changed, ${changedSlabs} slab(s) normalised`);
  if (unrecognised.size > 0) {
    console.log(`Unrecognised currency strings (left as-is):`);
    for (const u of unrecognised) console.log(`  ${JSON.stringify(u)}`);
  }
  if (!WRITE) {
    console.log(`\n(dry-run; pass --write to persist changes)`);
  }
}

main();

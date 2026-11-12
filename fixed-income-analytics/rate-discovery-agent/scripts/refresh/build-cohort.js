#!/usr/bin/env node
'use strict';

/**
 * Phase 1 — cohort builder.
 *
 * Walks output/latest/, groups *_rates.json files per bank, and emits a cohort
 * manifest listing every (bank, variant) pair we already have rates for —
 * along with the prior effective_date, source_url, scraped_at, and
 * scraper_type so downstream phases can fetch and compare cheaply.
 *
 * Output: output/refresh/<run-ts>/cohort.json
 *
 * Run:   node scripts/refresh/build-cohort.js
 *        node scripts/refresh/build-cohort.js --run-ts 2026-05-13T17-00-00
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LATEST_DIR = path.join(REPO_ROOT, 'output', 'latest');
const REFRESH_ROOT = path.join(REPO_ROOT, 'output', 'refresh');

// Order matters: more-specific suffixes must match before the bare `_rates.json`
// so `<slug>_nre_rates.json` isn't misread as a `regular` variant of `<slug>_nre`.
const VARIANT_SUFFIXES = [
  { suffix: '_nre_rates.json', variant: 'nre', urlKey: 'fd_nre' },
  { suffix: '_nro_rates.json', variant: 'nro', urlKey: 'fd_nro' },
  { suffix: '_fcnr_rates.json', variant: 'fcnr', urlKey: 'fd_fcnr' },
  { suffix: '_gift_rates.json', variant: 'gift', urlKey: 'fd_gift' },
  { suffix: '_rates.json', variant: 'regular', urlKey: 'fd' },
];

function parseRatesFilename(name) {
  if (!name.endsWith('.json')) return null;
  if (name.includes('_attempt')) return null;
  for (const { suffix, variant, urlKey } of VARIANT_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const slug = name.slice(0, -suffix.length);
      if (!slug) return null;
      return { slug, variant, urlKey };
    }
  }
  return null;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function runTimestamp(argv) {
  const flagIdx = argv.indexOf('--run-ts');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function main() {
  const runTs = runTimestamp(process.argv);
  const runDir = path.join(REFRESH_ROOT, runTs);
  fs.mkdirSync(runDir, { recursive: true });

  const entries = fs.readdirSync(LATEST_DIR, { withFileTypes: true });
  const ratesEntries = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const parsed = parseRatesFilename(ent.name);
    if (parsed) ratesEntries.push({ ...parsed, file: ent.name });
  }

  const banksBySlug = new Map();

  for (const { slug, variant, urlKey, file } of ratesEntries) {
    const ratesPath = path.join(LATEST_DIR, file);
    const ratesDoc = readJsonSafe(ratesPath);
    if (!ratesDoc) continue;

    let bank = banksBySlug.get(slug);
    if (!bank) {
      const configPath = path.join(LATEST_DIR, `${slug}_config.json`);
      const config = readJsonSafe(configPath);
      bank = {
        bank_code: slug,
        bank_name: ratesDoc.bank_name || (config && config.bank_name) || slug,
        bank_type: (config && config.bank_type) || ratesDoc.bank_type || null,
        category: (config && config.category) || null,
        website: (config && config.website) || null,
        scraper_type: (config && config.scraper_type) || null,
        rate_page_urls: (config && config.rate_page_urls) || {},
        config_present: Boolean(config),
        variants: [],
      };
      banksBySlug.set(slug, bank);
    }

    const sourceUrl =
      ratesDoc.source_url ||
      (bank.rate_page_urls && bank.rate_page_urls[urlKey]) ||
      null;

    bank.variants.push({
      variant,
      rates_file: file,
      source_url: sourceUrl,
      stored_effective_date: ratesDoc.effective_date || null,
      stored_scraped_at: ratesDoc.scraped_at || null,
      stored_extraction_method: ratesDoc.extraction_method || null,
      stored_extraction_confidence: ratesDoc.extraction_confidence || null,
      slab_count: Array.isArray(ratesDoc.rate_slabs) ? ratesDoc.rate_slabs.length : 0,
    });
  }

  const banks = [...banksBySlug.values()].sort((a, b) =>
    a.bank_code.localeCompare(b.bank_code),
  );

  for (const bank of banks) {
    bank.variants.sort((a, b) => a.variant.localeCompare(b.variant));
  }

  const summary = summarize(banks);

  const cohort = {
    generated_at: new Date().toISOString(),
    run_ts: runTs,
    source_dir: path.relative(REPO_ROOT, LATEST_DIR),
    summary,
    banks,
  };

  const cohortPath = path.join(runDir, 'cohort.json');
  // safe-write-exempt: refresh-run cohort plan; aggregator artifact under runs/<ts>/, not a per-bank canonical write.
  fs.writeFileSync(cohortPath, JSON.stringify(cohort, null, 2) + '\n');

  // Update output/refresh/latest pointer (copy, not symlink — works on Windows).
  const latestPointer = path.join(REFRESH_ROOT, 'latest');
  fs.mkdirSync(latestPointer, { recursive: true });
  // safe-write-exempt: refresh-pipeline pointer file under output/refresh/latest/; not a per-bank canonical write.
  fs.writeFileSync(
    path.join(latestPointer, '_run_ts.txt'),
    runTs + '\n',
  );

  console.log(`cohort: wrote ${cohortPath}`);
  console.log(`  banks: ${summary.bank_count}`);
  console.log(`  variants: ${JSON.stringify(summary.variant_counts)}`);
  console.log(`  bank_types: ${JSON.stringify(summary.bank_type_counts)}`);
  console.log(`  banks_without_config: ${summary.banks_without_config}`);
  console.log(`  variants_without_source_url: ${summary.variants_without_source_url}`);
}

function summarize(banks) {
  const variantCounts = {};
  const bankTypeCounts = {};
  let banksWithoutConfig = 0;
  let variantsWithoutSourceUrl = 0;
  let totalVariants = 0;

  for (const b of banks) {
    if (!b.config_present) banksWithoutConfig++;
    const bt = b.bank_type || 'UNKNOWN';
    bankTypeCounts[bt] = (bankTypeCounts[bt] || 0) + 1;
    for (const v of b.variants) {
      variantCounts[v.variant] = (variantCounts[v.variant] || 0) + 1;
      totalVariants++;
      if (!v.source_url) variantsWithoutSourceUrl++;
    }
  }

  return {
    bank_count: banks.length,
    variant_count: totalVariants,
    variant_counts: variantCounts,
    bank_type_counts: bankTypeCounts,
    banks_without_config: banksWithoutConfig,
    variants_without_source_url: variantsWithoutSourceUrl,
  };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('cohort: FAILED', err);
    process.exit(1);
  }
}

module.exports = { parseRatesFilename, summarize };

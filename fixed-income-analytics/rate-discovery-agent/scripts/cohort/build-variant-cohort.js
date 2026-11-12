#!/usr/bin/env node
'use strict';

/**
 * Sprint 011 Track A / Item 20 — variant-cohort builder with UNION rule.
 *
 * Problem (2026-06-16, Yes Bank gap): the one-shot FCNR builder
 * (scripts/cohort/build-fcnr-2026-06-11.js) selected banks where the PACK
 * already has variant slabs — i.e. "pack HAS data", not "bank PUBLISHES the
 * variant". Any bank whose variant page is registered in
 * data/bank-domains.json but never successfully extracted was silently
 * dropped (13 banks, incl. yes-bank-limited).
 *
 * Fix: cohort = UNION of
 *   (a) pack.banks where products.fd[<variant>].slabs is non-empty, and
 *   (b) bank-domains entries that DECLARE a source for the variant:
 *       - rate_pages[<fd key>] is a non-null URL, or
 *       - any extraction-hint block whose `fulfills_product` includes the
 *         fd key (this is how Axis declares its FCNR PDF — the hint can
 *         exist without a matching rate_pages entry, so we honour it too).
 *
 * Plus an operator-visible [cohort-audit] warning listing banks that
 * publish the variant per bank-domains but have no pack data — the exact
 * class of miss that dropped Yes Bank.
 *
 * Usage:
 *   node scripts/cohort/build-variant-cohort.js --variant fcnr [--out <file>]
 *
 * Default out: data/cohorts/<variant>-refresh-<YYYY-MM-DD>.json
 * (refuses to overwrite an existing cohort file — pick a new --out instead).
 *
 * Output file shape matches existing cohorts (see
 * data/cohorts/fcnr-refresh-2026-06-11.json): an array of
 * { bank_code, category, state } consumable by scripts/utils/load-cohort.js,
 * run-batch and the splitter.
 *
 * Exit codes:
 *   0  cohort written
 *   1  invalid args
 *   2  out file already exists (won't overwrite)
 *   3  pack or bank-domains missing/invalid
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PACK_FILE = path.join(ROOT, 'pack', 'dist', 'rates-pack.json');
const DOMAINS_FILE = path.join(ROOT, 'data', 'bank-domains.json');
const LATEST_DIR = path.join(ROOT, 'output', 'latest');
const SOURCE_COHORT_FILE = path.join(ROOT, 'data', 'cohorts', 'pm-refresh-2026-q2.json');
const COHORTS_DIR = path.join(ROOT, 'data', 'cohorts');

/** FD variants the pack knows about (pack/dist products.fd.<key>). */
const VARIANTS = ['regular', 'nre', 'nro', 'fcnr', 'gift'];

/**
 * bank-domains.json key for a variant. rate_pages uses `fd` for the
 * domestic/regular product and `fd_<variant>` for the rest
 * (fd_nre / fd_nro / fd_fcnr / fd_gift). The same key namespace is used by
 * extraction-hint `fulfills_product` declarations.
 */
function domainsKeyFor(variant) {
  return variant === 'regular' ? 'fd' : `fd_${variant}`;
}

/**
 * Does this bank-domains entry declare a source for the variant?
 * True when rate_pages has a non-null URL for the fd key, OR any
 * extraction-hint block's fulfills_product (string or array) names the
 * fd key (Axis-style: hint present, rate_pages entry optional).
 */
function entryPublishesVariant(entry, fdKey) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.rate_pages && entry.rate_pages[fdKey]) return true;
  if (entry.extraction && typeof entry.extraction === 'object') {
    for (const hint of Object.values(entry.extraction)) {
      if (!hint || typeof hint !== 'object') continue;
      const fp = hint.fulfills_product;
      if (!fp) continue;
      const products = Array.isArray(fp) ? fp : [fp];
      if (products.includes(fdKey)) return true;
    }
  }
  return false;
}

/**
 * Build a variant cohort with the UNION rule (Item 20).
 *
 * @param {object} opts
 * @param {string} opts.variant  one of regular|nre|nro|fcnr|gift
 * @param {object} opts.pack     parsed rates-pack.json ({ banks: [...] })
 * @param {object} opts.domains  parsed bank-domains.json ({ <bank_code>: entry })
 * @param {function} [opts.warn] sink for the [cohort-audit] warning lines
 *                               (default console.warn)
 * @returns {{ cohort: string[], inPack: string[], inDomains: string[], gap: string[] }}
 *          all arrays sorted; cohort = inPack ∪ inDomains;
 *          gap = inDomains − inPack (publish-but-no-pack-data banks)
 */
function buildVariantCohort({ variant, pack, domains, warn = console.warn }) {
  if (!VARIANTS.includes(variant)) {
    throw new Error(`unknown variant "${variant}" (expected one of: ${VARIANTS.join(', ')})`);
  }
  if (!pack || !Array.isArray(pack.banks)) {
    throw new Error('pack must be a parsed rates-pack.json with a banks array');
  }
  if (!domains || typeof domains !== 'object' || Array.isArray(domains)) {
    throw new Error('domains must be a parsed bank-domains.json object keyed by bank_code');
  }

  const fdKey = domainsKeyFor(variant);

  const inPack = new Set(
    pack.banks
      .filter((b) => b && b.products && b.products.fd
        && b.products.fd[variant]
        && Array.isArray(b.products.fd[variant].slabs)
        && b.products.fd[variant].slabs.length > 0)
      .map((b) => b.bank_code),
  );

  const inDomains = new Set(
    Object.entries(domains)
      .filter(([, entry]) => entryPublishesVariant(entry, fdKey))
      .map(([bankCode]) => bankCode),
  );

  const cohort = [...new Set([...inPack, ...inDomains])].sort();
  const gap = [...inDomains].filter((bc) => !inPack.has(bc)).sort();

  // Operator-visible audit — the signal that catches the Yes-Bank class of miss.
  if (gap.length > 0) {
    warn(`[cohort-audit] ${gap.length} banks publish ${variant} per bank-domains but have no pack data:`);
    gap.forEach((bc) => warn(`  - ${bc}`));
  }

  return {
    cohort,
    inPack: [...inPack].sort(),
    inDomains: [...inDomains].sort(),
    gap,
  };
}

/**
 * Enrich bank codes into cohort-file entries ({ bank_code, category, state }),
 * pulling category/state from output/latest summaries and backfilling from
 * the canonical pm-refresh cohort — same approach as build-fcnr-2026-06-11.js.
 */
function enrichCohortEntries(bankCodes, { latestDir = LATEST_DIR, sourceCohort = null } = {}) {
  const sourceByCode = new Map((sourceCohort || []).map((e) => [e.bank_code, e]));
  const rows = [];
  const missingSummary = [];
  for (const bankCode of bankCodes) {
    let category = null;
    let state = null;
    const sumPath = path.join(latestDir, `${bankCode}.summary.json`);
    if (fs.existsSync(sumPath)) {
      try {
        const s = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
        category = s.category || null;
        state = s.state || null;
      } catch { /* treat malformed summary as missing */ }
    } else {
      missingSummary.push(bankCode);
    }
    const src = sourceByCode.get(bankCode);
    if (src) {
      if (!category) category = src.category || null;
      if (!state) state = src.state || null;
    }
    rows.push({ bank_code: bankCode, category, state });
  }
  return { rows, missingSummary };
}

function parseArgs(argv) {
  const opts = { variant: null, out: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--variant') opts.variant = argv[++i];
    else if (a.startsWith('--variant=')) opts.variant = a.slice('--variant='.length);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/cohort/build-variant-cohort.js --variant <${VARIANTS.join('|')}> [--out <file>]

Builds a refresh cohort for an FD variant as the UNION of
(pack has variant slabs) ∪ (bank-domains declares a URL or extraction
hint for that variant), and prints a [cohort-audit] warning listing
publish-but-no-pack-data banks (Item 20 gap rule).

Default out: data/cohorts/<variant>-refresh-<today>.json.
Refuses to overwrite an existing file.`);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    printUsage();
    process.exit(1);
  }
  if (opts.help) { printUsage(); process.exit(0); }
  if (!opts.variant || !VARIANTS.includes(opts.variant)) {
    console.error(`error: --variant is required and must be one of: ${VARIANTS.join(', ')}\n`);
    printUsage();
    process.exit(1);
  }

  let pack;
  let domains;
  try {
    pack = JSON.parse(fs.readFileSync(PACK_FILE, 'utf8'));
    domains = JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf8'));
  } catch (err) {
    console.error(`error: failed to read pack or bank-domains: ${err.message}`);
    process.exit(3);
  }

  const outFile = opts.out
    ? path.resolve(opts.out)
    : path.join(COHORTS_DIR, `${opts.variant}-refresh-${todayIso()}.json`);
  if (fs.existsSync(outFile)) {
    console.error(`error: ${outFile} already exists — refusing to overwrite a cohort file. Pass --out <new file>.`);
    process.exit(2);
  }

  const { cohort, inPack, inDomains, gap } = buildVariantCohort({ variant: opts.variant, pack, domains });

  let sourceCohort = null;
  if (fs.existsSync(SOURCE_COHORT_FILE)) {
    try { sourceCohort = JSON.parse(fs.readFileSync(SOURCE_COHORT_FILE, 'utf8')); } catch { /* optional backfill only */ }
  }
  const { rows, missingSummary } = enrichCohortEntries(cohort, { sourceCohort });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // safe-write-exempt: derived cohort artifact (never overwrites an existing file — guarded above).
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2) + '\n');

  console.log(`Wrote ${outFile}`);
  console.log(`  variant: ${opts.variant}`);
  console.log(`  cohort: ${rows.length}  (in pack: ${inPack.length}, in bank-domains: ${inDomains.length}, gap: ${gap.length})`);
  if (missingSummary.length > 0) {
    console.log(`  missing summary: ${missingSummary.length}`, missingSummary);
  }
  const byCat = {};
  for (const r of rows) byCat[r.category || '?'] = (byCat[r.category || '?'] || 0) + 1;
  console.log('  by category:', byCat);
}

if (require.main === module) main();

module.exports = {
  buildVariantCohort,
  domainsKeyFor,
  entryPublishesVariant,
  enrichCohortEntries,
  parseArgs,
  VARIANTS,
};

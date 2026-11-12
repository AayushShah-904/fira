#!/usr/bin/env node
// Sprint-011 Track A item A5 — NRI target list.
// Builds a per-bank missing-variant matrix (NRE / NRO / FCNR, GIFT for IBUs) for the
// NRI cohort run ahead of the RBI FCNR concession-window close (2026-09-30).
//
// Inputs (read-only):
//   pack/dist/rates-pack.json                       — what we actually have (slabs + dates)
//   data/bank-domains.json                          — registry: URLs, extraction hints, status flags
//   data/Indian_Banks_Comprehensive_List_RBI.csv    — universe + category
//
// Output:
//   data/cohorts/nri-target-list-<as-of>.json       — the matrix (banks sorted by bank_type, bank_code)
//   stdout                                          — human-readable summary
//
// Re-runnable: node scripts/analysis/nri-target-list.js [--as-of 2026-07-06]
//
// Verdict per variant:
//   OK                  — pack has slabs AND effective_date parses AND >= FRESH_CUTOFF
//   STALE_OR_UNDATED    — pack has slabs but no parseable date, or date < FRESH_CUTOFF
//   MISSING_EXTRACTION  — no pack slabs but the registry knows a URL / extraction hint for the variant
//   UNKNOWN_PUBLISHES   — no slabs, no URL; bank type suggests it plausibly publishes. UNKNOWN is a
//                         valid verdict — we never invent whether a bank offers a product.
//   EXCLUDED            — registry status says the product cannot apply (wholesale_only,
//                         no_retail_deposits, no_fd_product; foreign_currency_not_inr excludes
//                         the INR variants NRE/NRO only).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { slugify } = require('../utils/slugify.js');
const { aliasToCanonical } = require('../../lib/slug-aliases.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = require(path.join(ROOT, 'pack', 'dist', 'rates-pack.json'));
const DOMAINS = require(path.join(ROOT, 'data', 'bank-domains.json'));
const CSV_PATH = path.join(ROOT, 'data', 'Indian_Banks_Comprehensive_List_RBI.csv');

const argv = process.argv.slice(2);
const asOfIdx = argv.indexOf('--as-of');
const AS_OF = asOfIdx >= 0 ? argv[asOfIdx + 1] : '2026-07-06';
const FRESH_CUTOFF = '2026-06-01'; // effective_date older than this (or unparseable) => STALE_OR_UNDATED
const OUT_PATH = path.join(ROOT, 'data', 'cohorts', `nri-target-list-${AS_OF}.json`);

// ---------------------------------------------------------------------------
// Universe rules
// ---------------------------------------------------------------------------
const CAT_TO_TYPE = {
  'Public Sector Bank': 'PSB',
  'Private Sector Bank (Indian)': 'PVB',
  'Foreign Bank': 'FB',
  'Small Finance Bank': 'SFB',
  'IFSC Banking Unit (IFSCA)': 'IBU',
};

// docs/agent/discovery-workflow.md §Efficiency Rules names AU, Equitas, Ujjivan as the
// NRI-relevant ("large") SFBs. We additionally admit any SFB with a measured NRI signal
// (pack slabs or a registry NRI URL) so the universe is data-driven, not guessed.
const DOC_LARGE_SFBS = new Set([
  'au-small-finance-bank-limited',
  'equitas-small-finance-bank-limited',
  'ujjivan-small-finance-bank-limited',
]);

// T1 per sdlc/sprints/sprint-011/design/qa-data-quality-draft.md §7.1:
// all 12 PSBs + major PVBs (HDFC, ICICI, Axis, Kotak, IndusInd, Yes, Bandhan, IDFC First, Federal, RBL).
const T1_PVB_PREFIXES = [
  'hdfc-bank', 'icici-bank', 'axis-bank', 'kotak-mahindra-bank', 'indusind-bank',
  'yes-bank', 'bandhan-bank', 'idfc-first-bank', 'federal-bank', 'rbl-bank',
];

// Registry rate_pages / rate_pdfs keys that count as "URL known" per variant.
// fd_nri_combined covers NRE+NRO on most banks but is NOT assumed to cover FCNR
// (only an explicit extraction hint fulfills_product: ["fd_fcnr"] does that).
const URL_KEYS = {
  nre: ['fd_nre', 'fd_nri_combined'],
  nro: ['fd_nro', 'fd_nri_combined'],
  fcnr: ['fd_fcnr'],
  gift: ['fd_gift', 'fd_gift_pdf', 'fd_gift_pdf_stable', 'gift'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Tolerant parser for the effective_date zoo observed in the pack:
// ISO, dd.mm.yyyy, dd-mm-yyyy, dd/mm/yyyy, dd-Mon-yy(yy), "18th April 2026",
// "2nd-July-2025", "20th June, 2025", "1st July 1995". Returns "YYYY-MM-DD" or null.
function parseEffectiveDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/))) {
    return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  // dd-Mon-yy / dd-Mon-yyyy / "1st July 1995" / "2nd-July-2025" / "20th June, 2025"
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s.,-]+([A-Za-z]{3,9})[\s.,-]+(\d{2}|\d{4})$/))) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    let y = Number(m[3]);
    if (m[3].length === 2) y += 2000;
    return `${y}-${String(mon).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

function fulfillsProducts(reg) {
  const out = new Set();
  for (const hint of Object.values(reg.extraction || {})) {
    for (const p of (hint && hint.fulfills_product) || []) out.add(p);
  }
  return out;
}

function registryUrlFor(reg, variant, fulfills) {
  const sources = [];
  for (const bag of [reg.rate_pages || {}, reg.rate_pdfs || {}]) {
    for (const key of URL_KEYS[variant]) {
      if (bag[key]) sources.push(key);
    }
  }
  if (fulfills.has(`fd_${variant}`)) sources.push(`extraction:fd_${variant}`);
  return sources;
}

// ---------------------------------------------------------------------------
// Build universe from the RBI CSV
// ---------------------------------------------------------------------------
const csvRows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8')).slice(1);
const packByCode = new Map(PACK.banks.map((b) => [b.bank_code, b]));

const unmatched = [];
const excludedSfbs = [];
const universe = [];

for (const r of csvRows) {
  const [, name, category] = r;
  const bankType = CAT_TO_TYPE[category];
  if (!bankType) continue;
  const bankCode = aliasToCanonical(slugify(name));
  const pack = packByCode.get(bankCode) || null;
  const reg = DOMAINS[bankCode] || null;
  if (!pack && !reg) unmatched.push({ bank_code: bankCode, bank_name: name, category });

  if (bankType === 'SFB') {
    const fd = (pack && pack.products && pack.products.fd) || {};
    const rp = (reg && reg.rate_pages) || {};
    const fulfills = reg ? fulfillsProducts(reg) : new Set();
    const hasSignal =
      ['nre', 'nro', 'fcnr'].some((v) => fd[v] && (fd[v].slabs || []).length > 0) ||
      ['fd_nre', 'fd_nro', 'fd_fcnr', 'fd_nri_combined'].some((k) => rp[k]) ||
      ['fd_nre', 'fd_nro', 'fd_fcnr'].some((p) => fulfills.has(p));
    const docLarge = DOC_LARGE_SFBS.has(bankCode);
    if (!docLarge && !hasSignal) {
      excludedSfbs.push(bankCode);
      continue; // small SFB with no measured NRI signal — not in cohort
    }
    universe.push({ name, bankType, bankCode, pack, reg, sfb_inclusion_reason: docLarge ? 'docs_large_sfb' : 'measured_nri_signal' });
  } else {
    universe.push({ name, bankType, bankCode, pack, reg });
  }
}

// ---------------------------------------------------------------------------
// Per-bank rows
// ---------------------------------------------------------------------------
function isT1(bankType, bankCode) {
  if (bankType === 'PSB') return true;
  if (bankType !== 'PVB') return false;
  return T1_PVB_PREFIXES.some((p) => bankCode.startsWith(p));
}

const rows = universe.map(({ name, bankType, bankCode, pack, reg, sfb_inclusion_reason }) => {
  const r = reg || {};
  const fd = (pack && pack.products && pack.products.fd) || {};
  const fulfills = fulfillsProducts(r);

  const status = r.status || null;                       // wholesale_only / no_retail_deposits / ...
  const discoveryStatus = r.discovery_status || null;    // foreign_currency_not_inr / unreachable / ...
  const flags = {
    wholesale_only: status === 'wholesale_only',
    no_retail_deposits: status === 'no_retail_deposits',
    foreign_currency_not_inr: discoveryStatus === 'foreign_currency_not_inr',
    no_fd_product: discoveryStatus === 'no_fd_product',
    cloud_blocked: !!(r.cloud_block_status && r.cloud_block_status.blocked),
    site_unreachable: status === 'site_unreachable' || discoveryStatus === 'unreachable',
    rates_not_published: status === 'rates_not_published',
    in_pack: !!pack,
    in_registry: !!reg,
  };

  const variantsToCheck = bankType === 'IBU' ? ['gift'] : ['nre', 'nro', 'fcnr'];
  const variants = {};
  for (const v of variantsToCheck) {
    const entry = fd[v] || null;
    const slabCount = entry ? (entry.slabs || []).length : 0;
    const rawDate = entry ? entry.effective_date : null;
    const parsedDate = parseEffectiveDate(rawDate);
    const urlSources = registryUrlFor(r, v, fulfills);

    let verdict;
    const fullyExcluded = flags.wholesale_only || flags.no_retail_deposits || flags.no_fd_product;
    const inrExcluded = flags.foreign_currency_not_inr && (v === 'nre' || v === 'nro');
    if (fullyExcluded || inrExcluded) verdict = 'EXCLUDED';
    else if (slabCount > 0 && parsedDate && parsedDate >= FRESH_CUTOFF) verdict = 'OK';
    else if (slabCount > 0) verdict = 'STALE_OR_UNDATED';
    else if (urlSources.length > 0) verdict = 'MISSING_EXTRACTION';
    else verdict = 'UNKNOWN_PUBLISHES';

    variants[v] = {
      pack_has_slabs: slabCount,
      pack_effective_date: rawDate || null,
      pack_effective_date_parsed: parsedDate,
      registry_has_url: urlSources.length > 0,
      registry_url_sources: urlSources,
      verdict,
    };
  }

  const nreSlabs = variants.nre ? variants.nre.pack_has_slabs : 0;
  const fcnrSlabs = variants.fcnr ? variants.fcnr.pack_has_slabs : 0;

  const row = {
    bank_code: bankCode,
    bank_name: name,
    bank_type: bankType,
    tier1: isT1(bankType, bankCode),
    status,
    discovery_status: discoveryStatus,
    flags,
    variants,
    nre_without_fcnr: bankType !== 'IBU' && nreSlabs > 0 && fcnrSlabs === 0 && variants.fcnr.verdict !== 'EXCLUDED',
  };
  if (sfb_inclusion_reason) row.sfb_inclusion_reason = sfb_inclusion_reason;
  return row;
});

const TYPE_ORDER = ['PSB', 'PVB', 'FB', 'SFB', 'IBU'];
rows.sort((a, b) =>
  TYPE_ORDER.indexOf(a.bank_type) - TYPE_ORDER.indexOf(b.bank_type) ||
  a.bank_code.localeCompare(b.bank_code));

// ---------------------------------------------------------------------------
// Summaries + sanity checks
// ---------------------------------------------------------------------------
const VERDICTS = ['OK', 'STALE_OR_UNDATED', 'MISSING_EXTRACTION', 'UNKNOWN_PUBLISHES', 'EXCLUDED'];

function tally(rowsSubset, variant) {
  const t = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const row of rowsSubset) if (row.variants[variant]) t[row.variants[variant].verdict]++;
  return t;
}

const nonIbu = rows.filter((r) => r.bank_type !== 'IBU');
const ibus = rows.filter((r) => r.bank_type === 'IBU');
const perVariant = {
  nre: tally(nonIbu, 'nre'),
  nro: tally(nonIbu, 'nro'),
  fcnr: tally(nonIbu, 'fcnr'),
  gift: tally(ibus, 'gift'),
};

const perType = {};
for (const t of TYPE_ORDER) {
  const sub = rows.filter((r) => r.bank_type === t);
  perType[t] = { banks: sub.length };
  for (const v of t === 'IBU' ? ['gift'] : ['nre', 'nro', 'fcnr']) perType[t][v] = tally(sub, v);
}

// Measured AD-Category-I FCNR universe: non-IBU cohort banks whose FCNR verdict is not EXCLUDED.
const fcnrUniverse = nonIbu.filter((r) => r.variants.fcnr.verdict !== 'EXCLUDED');
const fcnrWithData = fcnrUniverse.filter((r) => r.variants.fcnr.pack_has_slabs > 0);

// Priority list: T1 banks with any non-OK, non-EXCLUDED variant + all FB likewise.
function nonOkVariants(row) {
  return Object.entries(row.variants)
    .filter(([, v]) => v.verdict !== 'OK' && v.verdict !== 'EXCLUDED')
    .map(([k, v]) => `${k}:${v.verdict}`);
}
const priority = rows
  .filter((r) => (r.tier1 || r.bank_type === 'FB') && nonOkVariants(r).length > 0)
  .map((r) => ({
    bank_code: r.bank_code,
    bank_type: r.bank_type,
    tier1: r.tier1,
    non_ok_variants: nonOkVariants(r),
  }))
  .sort((a, b) =>
    (b.tier1 - a.tier1) ||
    (TYPE_ORDER.indexOf(a.bank_type) - TYPE_ORDER.indexOf(b.bank_type)) ||
    (b.non_ok_variants.length - a.non_ok_variants.length) ||
    a.bank_code.localeCompare(b.bank_code));

const sanity = {
  psb_count: rows.filter((r) => r.bank_type === 'PSB').length,
  psb_count_expected: 12,
  ibu_count: ibus.length,
  ibu_count_expected: 37,
  csv_rows_unmatched_in_pack_and_registry: unmatched,
  nre_without_fcnr_banks: rows.filter((r) => r.nre_without_fcnr).map((r) => r.bank_code),
  sfbs_excluded_no_nri_signal: excludedSfbs,
};

if (sanity.psb_count !== 12) {
  console.error(`SANITY FAIL: PSB count ${sanity.psb_count} != 12`);
  process.exitCode = 1;
}
if (sanity.ibu_count !== 37) {
  console.error(`SANITY WARN: IBU count ${sanity.ibu_count} != 37 (registry IBU category entries)`);
}

// ---------------------------------------------------------------------------
// Write artifact
// ---------------------------------------------------------------------------
const artifact = {
  generated_at: new Date().toISOString(),
  as_of: AS_OF,
  script: 'scripts/analysis/nri-target-list.js',
  inputs: {
    pack: 'pack/dist/rates-pack.json',
    pack_generated_at: PACK.generated_at,
    registry: 'data/bank-domains.json',
    universe_csv: 'data/Indian_Banks_Comprehensive_List_RBI.csv',
  },
  rules: {
    fresh_cutoff: FRESH_CUTOFF,
    universe: 'CSV categories PSB/PVB/FB/IBU in full; SFBs only if docs-large (AU, Equitas, Ujjivan) or measured NRI signal',
    fcnr_universe: 'non-IBU cohort banks whose FCNR verdict is not EXCLUDED',
    t1: 'all PSBs + major PVBs per sdlc/sprints/sprint-011/design/qa-data-quality-draft.md §7.1',
    combined_page: 'fd_nri_combined counts as URL-known for NRE and NRO, not FCNR',
  },
  summary: {
    banks_total: rows.length,
    per_variant: perVariant,
    per_bank_type: perType,
    fcnr_universe_measured: fcnrUniverse.length,
    fcnr_universe_with_data: fcnrWithData.length,
    priority_refresh_count: priority.length,
  },
  sanity_checks: sanity,
  priority_refresh: priority,
  banks: rows,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(`NRI target list — as of ${AS_OF} (pack generated ${PACK.generated_at})`);
console.log(`Cohort: ${rows.length} banks (${TYPE_ORDER.map((t) => `${t}=${perType[t].banks}`).join(', ')})`);
console.log(`SFBs excluded (no NRI signal): ${excludedSfbs.join(', ') || '(none)'}\n`);

console.log(pad('variant', 8) + VERDICTS.map((v) => pad(v, 20)).join(''));
for (const [v, t] of Object.entries(perVariant)) {
  console.log(pad(v, 8) + VERDICTS.map((k) => pad(t[k], 20)).join(''));
}

console.log(`\nMeasured AD-I FCNR universe (non-excluded): ${fcnrUniverse.length} banks; with FCNR slabs today: ${fcnrWithData.length}`);
console.log(`NRE-without-FCNR banks: ${sanity.nre_without_fcnr_banks.length}`);
console.log(`Priority refresh list (T1 + FB with any non-OK variant): ${priority.length} banks`);
for (const p of priority.slice(0, 15)) {
  console.log(`  ${pad(p.bank_code, 50)} ${pad(p.bank_type, 5)} ${p.tier1 ? 'T1 ' : '   '} ${p.non_ok_variants.join(', ')}`);
}
console.log(`\nSanity: PSB=${sanity.psb_count}/12  IBU=${sanity.ibu_count}/37  unmatched CSV rows=${unmatched.length}`);
console.log(`Artifact written: ${path.relative(ROOT, OUT_PATH)}`);

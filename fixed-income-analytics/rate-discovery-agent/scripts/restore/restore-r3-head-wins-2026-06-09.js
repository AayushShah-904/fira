#!/usr/bin/env node

/**
 * Sprint 010 Phase K E4 recovery (2026-06-09).
 *
 * Restore HEAD for 48 specific (bank_code, variant) pairs in the R3
 * partial-degradation bucket where HEAD has strictly more slabs than the
 * current n55y5dr-cohort extraction. Each was investigated and confirmed:
 *
 *   - IBU GIFT (6 banks): orchestrator fell back to _llm-fallback because
 *     `ibu-gift-currency-amount-3x3` / `ibu-gift-currency-2col` /
 *     `indusind-ibu-gift-currency-3col` / `extract_rates_pdf.mjs` are
 *     declared in bank-domains.json but NOT registered in
 *     lib/extractors/dispatch.js#REGISTRY. _llm-fallback only emits USD.
 *
 *   - FCNR multi-currency (5 banks): `hsbc-fcnr-per-currency-2col` /
 *     `union-fcnr-multi-currency-amount-bucket` declared but unregistered;
 *     idfc / indian-bank / barclays have NO template_fcnr. Same fallback,
 *     same USD-only result.
 *
 *   - Regular partial (37 banks): mixture of LLM under-extraction
 *     (bandhan, slice, citi, dbs), tenure-zero from non-FD tables
 *     (cosmos, mahamantralaya), and table-mapping drift.
 *
 * In every case the HEAD content was authored or extracted under a richer
 * regime and is provably better than the cohort output. Sprint 011 will
 * author the missing extractor modules; until then, HEAD is authoritative.
 *
 * Recovery acts ONLY on the explicit list below — narrow scope, operator-
 * authorized via Phase K E4. Idempotent.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TARGETS = [
  // IBU GIFT (E1)
  { bank: 'hdfc-bank-ibu', variant: 'gift' },
  { bank: 'kotak-mahindra-bank-ibu', variant: 'gift' },
  { bank: 'idfc-first-bank-ibu', variant: 'gift' },
  { bank: 'indian-bank-ibu', variant: 'gift' },
  { bank: 'punjab-national-bank-ibu', variant: 'gift' },
  { bank: 'indusind-bank-ibu', variant: 'gift' },
  // FCNR multi-currency (E2)
  { bank: 'idfc-first-bank-limited', variant: 'fcnr' },
  { bank: 'union-bank-of-india', variant: 'fcnr' },
  { bank: 'hong-kong-and-shanghai-banking-corporation-limited-hsbc', variant: 'fcnr' },
  { bank: 'indian-bank', variant: 'fcnr' },
  { bank: 'barclays-bank-plc', variant: 'fcnr' },
  // Bandhan / Citi / Barclays / DBS — LLM under-extraction (E4)
  { bank: 'bandhan-bank-limited', variant: 'regular' },
  { bank: 'bandhan-bank-limited', variant: 'nro' },
  { bank: 'bandhan-bank-limited', variant: 'nre' },
  { bank: 'citibank-na', variant: 'nro' },
  { bank: 'barclays-bank-plc', variant: 'regular' },
  { bank: 'dbs-bank-india-limited', variant: 'regular' },
  { bank: 'slice-small-finance-bank-limited', variant: 'regular' },
  { bank: 'mizuho-bank-ltd', variant: 'nre' },
  { bank: 'the-bihar-state-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'emirates-nbd-bank-pjsc', variant: 'nre' },
  { bank: 'bank-of-india', variant: 'regular' },
  { bank: 'mahamantralaya-allied-offices-coop-bank-ltd', variant: 'regular' },
  { bank: 'ghaziabad-district-central-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'saraswat-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'raigad-district-central-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'telangana-grameena-bank', variant: 'regular' },
  { bank: 'bank-of-bahrain-and-kuwait-bsc', variant: 'nre' },
  { bank: 'bank-of-bahrain-and-kuwait-bsc', variant: 'regular' },
  { bank: 'bank-of-bahrain-and-kuwait-bsc', variant: 'nro' },
  { bank: 'jana-small-finance-bank-limited', variant: 'regular' },
  { bank: 'kallappanna-awade-ichalkaranji-janata-sahakari-bank-ltd', variant: 'regular' },
  { bank: 'bank-of-nova-scotia', variant: 'regular' },
  { bank: 'idfc-first-bank-limited', variant: 'nre' },
  { bank: 'sberbank', variant: 'regular' },
  { bank: 'the-nagaland-state-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'balageria-central-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'mizoram-rural-bank', variant: 'regular' },
  { bank: 'the-andhra-pradesh-state-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'cosmos-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'maharashtra-gramin-bank', variant: 'regular' },
  { bank: 'the-goa-state-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'the-visakhapatnam-co-operative-bank-ltd', variant: 'regular' },
  { bank: 'the-washim-urban-co-operative-bank-limited', variant: 'regular' },
  { bank: 'eluru-district-co-operative-central-bank-ltd', variant: 'regular' },
  { bank: 'icici-bank-limited', variant: 'nre' },
  { bank: 'the-assam-co-operative-apex-bank-ltd', variant: 'regular' },
  { bank: 'jodhpur-central-co-operative-bank-ltd', variant: 'regular' },
];

const GIT_PREFIX = 'rate-discovery-agent/output/latest';
const LATEST_DIR = path.join(__dirname, '..', '..', 'output', 'latest');

function filename(bank, variant) {
  return variant === 'regular' ? `${bank}_rates.json` : `${bank}_${variant}_rates.json`;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function gitShow(rel) {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

const stats = { restored: 0, skipped_already: 0, skipped_no_head: 0, slabs_recovered: 0 };
const detail = [];

for (const { bank, variant } of TARGETS) {
  const fn = filename(bank, variant);
  const local = path.join(LATEST_DIR, fn);
  const rel = `${GIT_PREFIX}/${fn}`;
  const cur = readJsonSafe(local);
  const curN = Array.isArray(cur?.rate_slabs) ? cur.rate_slabs.length : 0;
  const headText = gitShow(rel);
  if (!headText) { stats.skipped_no_head++; continue; }
  const head = JSON.parse(headText);
  const headN = Array.isArray(head.rate_slabs) ? head.rate_slabs.length : 0;
  if (headN <= curN) { stats.skipped_already++; continue; }
  execFileSync('git', ['checkout', 'HEAD', '--', rel], { stdio: ['ignore', 'pipe', 'pipe'] });
  stats.restored++;
  stats.slabs_recovered += (headN - curN);
  detail.push({ file: fn, current_slabs: curN, head_slabs: headN, delta: headN - curN, method: head.extraction_method });
}

console.log('=== Phase K E4 targeted recovery (R3 HEAD-wins) ===');
console.log('targets        :', TARGETS.length);
console.log('restored       :', stats.restored);
console.log('skipped no-head:', stats.skipped_no_head);
console.log('skipped already:', stats.skipped_already);
console.log('slabs recovered:', stats.slabs_recovered);

// safe-write-exempt: one-shot per-run audit log under logs/, not a per-bank artifact.
fs.writeFileSync(
  path.join(__dirname, '..', '..', 'logs', 'sprint-010', 'phase-k-r3-recovery-detail.json'),
  JSON.stringify({ stats, restored: detail }, null, 2),
);

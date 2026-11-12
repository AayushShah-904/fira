'use strict';

/**
 * Split each bank's discovery+extraction run into three phases —
 * Website discovery, Rate-page discovery, Extraction — and tally outcomes
 * across the cohort. Surfaces partial-success cells the single-axis
 * `failure_class` enum collapses (e.g., website found but rate page not).
 *
 * Originally written 2026-05-10 to inform the Sprint 002 taxonomy revision.
 * Re-runnable after fixes ship to measure the partial-success cohort growth
 * (especially after the agent-side change that emits partial configs at
 * phase boundaries).
 *
 * Usage:
 *   node scripts/analysis/phase-outcome-distribution.js [<output-dir>]
 *
 * Defaults to the Sprint 001 DCCB forensic snapshot at
 * `C:/sw/BharatOmni/UFA/agent-data-backup/fixed-income-yield-advisor/output/latest`.
 *
 * Phase outcome derivation:
 *   website:
 *     found_committed         — config exists with non-null website + non-manual scraper_type
 *     found_committed_manual  — config exists, scraper_type=manual (agent picked but flagged)
 *     reachable_uncommitted   — at least one fetch_url succeeded but no config produced
 *     candidates_all_failed   — fetch_url attempts present, all errored
 *     no_candidates           — zero fetch_url attempts
 *   rate_page:
 *     found / not_found       — derived from config.rate_page_urls.fd
 *     not_attempted           — no config exists
 *   extraction:
 *     succeeded / succeeded_low_confidence / failed / not_attempted
 *
 * Reads only summary/config/rates JSON; no writes.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = 'C:/sw/BharatOmni/UFA/agent-data-backup/fixed-income-yield-advisor/output/latest';
const DIR = path.resolve(process.argv[2] || DEFAULT_DIR);

if (!fs.existsSync(DIR)) {
  console.error(`Directory not found: ${DIR}`);
  process.exit(1);
}

const final = new Map();
for (const f of fs.readdirSync(DIR)) {
  const m = f.match(/^([a-z0-9-]+?)(_attempt2)?\.summary\.json$/);
  if (!m || f.startsWith('_')) continue;
  const s = m[1];
  const cur = final.get(s);
  if (!cur || (m[2] && !cur.includes('attempt2'))) final.set(s, f);
}

function readJsonSafe(p) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch { return null; }
}

const distribution = {};
const partialBuckets = {
  website_no_rate_page: [],
  rate_page_no_extraction: [],
  reachable_uncommitted: [],
};

for (const [slug, f] of final) {
  const j = readJsonSafe(path.join(DIR, f)) || {};
  const tc = j.tool_calls || [];
  const fetchAttempts = tc.filter((t) => /fetch_url|webfetch/i.test(t.name || ''));
  const fetchOk = fetchAttempts.filter((t) => !t.is_error).length;
  const fetchErr = fetchAttempts.filter((t) => t.is_error).length;

  const cfg = readJsonSafe(path.join(DIR, slug + '_config.json'));
  const rates = readJsonSafe(path.join(DIR, slug + '_rates.json'));

  // Phase 1
  let website;
  if (cfg && cfg.website && cfg.website !== '?' && cfg.scraper_type && cfg.scraper_type !== 'manual') {
    website = 'found_committed';
  } else if (cfg && cfg.website && cfg.scraper_type === 'manual') {
    website = 'found_committed_manual';
  } else if (fetchOk > 0) {
    website = 'reachable_uncommitted';
  } else if (fetchErr > 0) {
    website = 'candidates_all_failed';
  } else {
    website = 'no_candidates';
  }

  // Phase 2
  let ratePage = 'not_attempted';
  if (cfg) {
    const fdUrl = cfg.rate_page_urls && cfg.rate_page_urls.fd;
    ratePage = fdUrl ? 'found' : 'not_found';
  }

  // Phase 3
  let extraction = 'not_attempted';
  if (rates) {
    const slabs = (rates.rate_slabs || []).length;
    const conf = (rates.extraction_confidence || '').toLowerCase();
    if (slabs > 0 && conf !== 'low' && conf !== 'none') extraction = 'succeeded';
    else if (slabs > 0) extraction = 'succeeded_low_confidence';
    else extraction = 'failed';
  }

  const key = `${website} | ${ratePage} | ${extraction}`;
  distribution[key] = (distribution[key] || 0) + 1;

  // Partial-success cohorts (operator-actionable)
  if (website === 'found_committed' && ratePage === 'not_found') {
    partialBuckets.website_no_rate_page.push({ slug, websiteUrl: cfg.website });
  }
  if (website === 'found_committed' && ratePage === 'found' && extraction !== 'succeeded' && extraction !== 'succeeded_low_confidence') {
    partialBuckets.rate_page_no_extraction.push({ slug, websiteUrl: cfg.website, rateUrl: cfg.rate_page_urls && cfg.rate_page_urls.fd });
  }
  if (website === 'reachable_uncommitted') {
    partialBuckets.reachable_uncommitted.push({ slug });
  }
}

console.log(`Source: ${DIR}`);
console.log();
console.log('--- (website / rate_page / extraction) outcome distribution ---');
const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
let total = 0;
for (const [k, v] of sorted) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
  total += v;
}
console.log(`  ----  TOTAL: ${total}`);

console.log();
console.log(`--- Partial successes: website found+committed, rate page NOT found (n=${partialBuckets.website_no_rate_page.length}) ---`);
for (const e of partialBuckets.website_no_rate_page.slice(0, 10)) {
  console.log(`  ${e.slug.padEnd(60)} ${e.websiteUrl}`);
}
if (partialBuckets.website_no_rate_page.length > 10) console.log(`  ... +${partialBuckets.website_no_rate_page.length - 10} more`);

console.log();
console.log(`--- Partial successes: rate page found, extraction failed (n=${partialBuckets.rate_page_no_extraction.length}) ---`);
for (const e of partialBuckets.rate_page_no_extraction.slice(0, 10)) {
  console.log(`  ${e.slug.padEnd(60)} ${(e.rateUrl || '?').slice(0, 60)}`);
}

console.log();
console.log(`--- "Reachable but uncommitted": agent fetched OK but didn't commit a website (n=${partialBuckets.reachable_uncommitted.length}) ---`);
for (const e of partialBuckets.reachable_uncommitted.slice(0, 10)) {
  console.log(`  ${e.slug}`);
}
if (partialBuckets.reachable_uncommitted.length > 10) console.log(`  ... +${partialBuckets.reachable_uncommitted.length - 10} more`);

'use strict';

/**
 * Aggregate tool-call patterns across a category run's per-bank summaries
 * to quantify search/fetch behavior, URL-guessing, and dead-domain hotspots.
 *
 * Originally written 2026-05-10 to drill into the Sprint 001 DCCB cloud
 * run's 89% website_unreachable rate. Designed to be re-runnable after
 * Sprint 002 fixes ship — same script, same output shape, easy lift comparison.
 *
 * Usage:
 *   node scripts/analysis/dccb-tool-call-stats.js [<summaries-dir>]
 *
 * Defaults to the Sprint 001 DCCB forensic snapshot at
 * `C:/sw/BharatOmni/UFA/agent-data-backup/fixed-income-yield-advisor/output/latest`.
 *
 * Reads `<slug>.summary.json` and `<slug>_attempt2.summary.json` files in
 * the target directory. For each bank picks the final attempt and walks
 * `tool_calls[]`, then prints:
 *   - per-bank counts (tool histogram, error histogram)
 *   - search-query empty-rate + top query 2-grams
 *   - fetch hit-rate + URL-guessing rate (URL contains slug tokens / acronym)
 *   - top 15 failing domains (the dead-end portals)
 *
 * Inputs are read-only; no temp files; safe to run against any output dir.
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

function constructedFromSlug(url, slug) {
  const u = (url || '').toLowerCase();
  if (!u) return false;
  if (u.includes(slug.replace(/-/g, ''))) return true;
  const parts = slug.split('-');
  const long = parts.filter((p) => p.length >= 4);
  if (long.length >= 2 && long.every((p) => u.includes(p))) return true;
  const acro = parts.filter((p) => p.length >= 3).map((p) => p[0]).join('');
  if (acro.length >= 3 && u.includes(acro)) return true;
  return false;
}

function extractDomain(u) {
  try { return new URL(u).hostname; } catch { return null; }
}

let bankCount = 0;
let totalCalls = 0;
let totalErrs = 0;
const toolHist = {};
const errToolHist = {};
let totalQueries = 0;
let emptyQueries = 0;
const queryHeadHist = {};
let totalFetches = 0;
let totalFetchErrs = 0;
let constructedFetches = 0;
let constructedFetchErrs = 0;
const failingDomains = {};

for (const [slug, f] of final) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const tc = j.tool_calls || [];
  bankCount++;
  totalCalls += tc.length;

  for (const t of tc) {
    const n = (t.name || '').toLowerCase();
    const ip = t.input_preview || '';
    toolHist[n] = (toolHist[n] || 0) + 1;
    if (t.is_error) {
      totalErrs++;
      errToolHist[n] = (errToolHist[n] || 0) + 1;
    }

    if (n === 'web_search' || n === 'websearch') {
      totalQueries++;
      const qm = ip.match(/"query"\s*:\s*"([^"]*)"/);
      const q = qm ? qm[1] : '';
      if (!q || q.length < 3) emptyQueries++;
      const head = q.replace(/^"+|"+$/g, '').toLowerCase().split(/\s+/).slice(0, 2).join(' ');
      if (head) queryHeadHist[head] = (queryHeadHist[head] || 0) + 1;
    }

    if (n === 'fetch_url' || n === 'webfetch' || n === 'web_fetch') {
      totalFetches++;
      const um = ip.match(/"url"\s*:\s*"([^"]*)"/);
      const url = um ? um[1] : '';
      const isCon = constructedFromSlug(url, slug);
      if (isCon) constructedFetches++;
      if (t.is_error) {
        totalFetchErrs++;
        if (isCon) constructedFetchErrs++;
        const dom = extractDomain(url);
        if (dom) failingDomains[dom] = (failingDomains[dom] || 0) + 1;
      }
    }
  }
}

console.log(`Source: ${DIR}`);
console.log(`Banks (final summary): ${bankCount}`);
console.log(`Total tool calls: ${totalCalls}, errors: ${totalErrs} (${(totalErrs / totalCalls * 100).toFixed(1)}%)`);

console.log();
console.log('--- Tool histogram ---');
for (const [k, v] of Object.entries(toolHist).sort((a, b) => b[1] - a[1])) {
  const errs = errToolHist[k] || 0;
  console.log(`  ${k.padEnd(15)} ${String(v).padStart(5)} (${errs} errs)`);
}

console.log();
console.log('--- Search queries ---');
console.log(`total: ${totalQueries}, empty/<3 chars: ${emptyQueries} (${(emptyQueries / totalQueries * 100).toFixed(0)}%)`);
console.log('top query-head 2-grams:');
for (const [k, v] of Object.entries(queryHeadHist).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(v).padStart(4)}  "${k}"`);
}

console.log();
console.log('--- Fetches ---');
console.log(`total: ${totalFetches}, failed: ${totalFetchErrs} (${(totalFetchErrs / totalFetches * 100).toFixed(0)}%)`);
console.log(`constructed-from-slug fetches: ${constructedFetches} (${(constructedFetches / totalFetches * 100).toFixed(0)}%)`);
console.log(`  of which failed: ${constructedFetchErrs}`);

console.log();
console.log('--- Top 15 failing domains ---');
for (const [k, v] of Object.entries(failingDomains).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

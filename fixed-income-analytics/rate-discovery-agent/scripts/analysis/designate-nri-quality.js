#!/usr/bin/env node
'use strict';
/**
 * designate-nri-quality.js — Sprint 011 (2026-07-08)
 *
 * For a cohort, classify each bank×variant by WHERE it breaks and record the
 * designation durably in bank-domains.json under `nri_quality_status`, so
 * future runs can skip auto-attempts on broken banks and the manual worklist
 * is auditable. Also emits manual-fetch / manual-parse worklists.
 *
 * Signals combined:
 *   - FETCH: live URL probe (fetch the stored rate-page URL; live / dead / suspect)
 *   - PARSE: fresh extractor slab counts from recent run logs (EXTRACTED events)
 *            vs stored slabs in the pack.
 *
 * Designation per variant (parent owns nre/nro/fcnr, IBU owns gift):
 *   action = "auto"               fetch live AND parse produced usable slabs
 *          = "manual_fetch"       URL dead/suspect/missing → a human must obtain the page/PDF
 *          = "manual_parse_help"  URL live but extractor yields ~0 → needs extractor work
 *
 * Usage:
 *   node scripts/analysis/designate-nri-quality.js --cohort gold-11-nri-banks \
 *        --runs <taskfile1>[,<taskfile2>]        # run logs to read EXTRACTED events from
 *        [--apply]                                # write nri_quality_status into bank-domains.json
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const REG_PATH = path.join(ROOT, 'data', 'bank-domains.json');
const reg = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'pack', 'dist-staging-final-2026-07-08', 'dist', 'rates-pack.json'), 'utf8'));
const packByCode = new Map(pack.banks.map((b) => [b.bank_code, b]));

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const cohort = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cohorts', val('--cohort') + '.json'), 'utf8'));
const apply = argv.includes('--apply');
const AS_OF = val('--as-of') || '2026-07-08';

// Parse EXTRACTED events (fresh extractor output) from run logs → { bank_code: { variant: slabs } }
const fresh = {};
for (const rf of (val('--runs') || '').split(',').filter(Boolean)) {
  const txt = fs.readFileSync(rf, 'utf8');
  for (const m of txt.matchAll(/"EXTRACTED"[^\n]*?"bank_code":"([^"]+)"[^\n]*?"slab_count":(\d+)[^\n]*?"variants":\{([^}]*)\}/g)) {
    const code = m[1]; fresh[code] = fresh[code] || {};
    // variants like  "gift":7,"fcnr":30
    for (const vm of m[3].matchAll(/"(\w+)":(\d+)/g)) fresh[code][vm[1]] = +vm[2];
    if (!m[3].trim()) fresh[code]._total = +m[2];
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36';
const RATE = /(fcnr|nre|nro|interest rate|per annum|% p\.a|deposit|tenure|maturity|senior citizen)/i;
async function probe(url) {
  if (!url) return 'MISSING';
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: c.signal });
    if (!r.ok) return 'DEAD';
    if (/pdf/i.test(r.headers.get('content-type') || '')) return 'LIVE';
    return RATE.test((await r.text()).slice(0, 200000)) ? 'LIVE' : 'SUSPECT';
  } catch { return 'DEAD'; } finally { clearTimeout(t); }
}
const resolve = (d, v) => (!v ? null : /^https?:/i.test(v) ? v : 'https://' + d.replace(/\/$/, '') + '/' + v.replace(/^\//, ''));
function stored(code, vkey) { const b = packByCode.get(code); const x = b && b.products && b.products.fd && b.products.fd[vkey]; return x && x.slabs ? x.slabs.length : 0; }

const BANKS = [
  ['yes-bank-limited', 'yes-bank-ibu'], ['axis-bank-limited', 'axis-bank-ibu'],
  ['au-small-finance-bank-limited', null], ['icici-bank-limited', 'icici-bank-ibu'],
  ['rbl-bank-limited', 'rbl-bank-ibu'], ['idfc-first-bank-limited', 'idfc-first-bank-ibu'],
  ['canara-bank', 'canara-bank-ibu'], ['indian-overseas-bank', null],
  ['bank-of-maharashtra', 'bank-of-maharashtra-ibu'],
  ['saraswat-co-operative-bank-ltd', null], ['cosmos-co-operative-bank-ltd', null],
];
const VARIANTS = [['nre', 'fd_nre'], ['nro', 'fd_nro'], ['fcnr', 'fd_fcnr'], ['gift', 'fd_gift']];

(async () => {
  const worklist = { manual_fetch: [], manual_parse_help: [], auto: [], na: [] };
  const designations = {}; // code -> { variant: {fetch,parse,action,...} }

  for (const [parent, ibu] of BANKS) {
    for (const [vkey, urlkey] of VARIANTS) {
      const isGift = vkey === 'gift';
      const code = isGift ? ibu : parent;
      if (isGift && !ibu) { worklist.na.push(`${parent} GIFT (no IBU)`); continue; }
      const e = reg[code] || {}; const rp = e.rate_pages || {};
      let url = resolve(e.domain, rp[urlkey]);
      if (!url && rp.fd) url = resolve(e.domain, rp.fd);
      const fetchStatus = await probe(url);
      // A bank with an EXTRACTED event was PROCESSED this run; an absent variant
      // there means the extractor produced 0 for it (not "untested"). Only a bank
      // with no event at all is truly untested (freshN = null).
      const processed = fresh[code] !== undefined;
      const freshN = processed ? (fresh[code][vkey] ?? 0) : null;
      const storedN = stored(code, vkey);

      let action, parse, fetch, note;
      const degraded = freshN != null && freshN > 0 && storedN >= 8 && freshN < Math.ceil(storedN * 0.5);
      if (fetchStatus === 'LIVE') {
        fetch = 'auto';
        if (degraded) { parse = 'manual'; action = 'manual_parse_help'; note = `partial: fresh ${freshN} << stored ${storedN}`; }
        else if (freshN != null && freshN > 0) { parse = 'auto'; action = 'auto'; }
        else if (freshN === 0) { parse = 'manual'; action = 'manual_parse_help'; } // ran, produced nothing on a live URL
        else if (storedN > 0) { parse = 'auto'; action = 'auto'; } // untested but stored data present
        else { parse = 'manual'; action = 'manual_parse_help'; }
      } else {
        fetch = 'manual'; parse = 'unknown'; action = 'manual_fetch';
      }
      const rec = { fetch, parse, action, fetch_status: fetchStatus, fresh_slabs: freshN, stored_slabs: storedN, as_of: AS_OF };
      if (note) rec.note = note;
      designations[code] = designations[code] || {};
      designations[code][vkey] = rec;
      const tag = `${code} ${vkey.toUpperCase()} (url=${fetchStatus}, fresh=${freshN ?? '-'}, stored=${storedN})${note ? ' — ' + note : ''}`;
      worklist[action].push(tag);
    }
  }

  console.log('=== MANUAL FETCH (URL dead/suspect — human must obtain page/PDF) ===');
  worklist.manual_fetch.forEach((t) => console.log('  ' + t));
  console.log('\n=== MANUAL PARSE HELP (URL live, extractor yields ~0 — needs extractor work) ===');
  worklist.manual_parse_help.forEach((t) => console.log('  ' + t));
  console.log('\n=== AUTO (fetch+parse working) ===');
  worklist.auto.forEach((t) => console.log('  ' + t));
  console.log('\n=== N/A ===');
  worklist.na.forEach((t) => console.log('  ' + t));

  if (apply) {
    for (const [code, vmap] of Object.entries(designations)) {
      if (!reg[code]) continue;
      reg[code].nri_quality_status = { as_of: AS_OF, assessed_by: 'gold-11 local QA', variants: vmap };
    }
    const sorted = {}; for (const k of Object.keys(reg).sort()) sorted[k] = reg[k];
    fs.writeFileSync(REG_PATH, JSON.stringify(sorted, null, 2) + '\n');
    console.log(`\napplied nri_quality_status to ${Object.keys(designations).length} bank(s) in bank-domains.json`);
  } else {
    console.log('\ndry-run: not written. Re-run with --apply to persist nri_quality_status into bank-domains.json');
  }
})();

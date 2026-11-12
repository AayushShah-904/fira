#!/usr/bin/env node
'use strict';
/**
 * url-health-probe.js — Sprint 011 (2026-07-08)
 *
 * Read-only health check of the stored rate-page URLs for a set of banks,
 * so we can decide per bank: refresh-in-place (--rates-only, URL still good)
 * vs re-discover (URL changed/dead). Answers "what if the URL changed?"
 * before we trust --rates-only on a quality-critical cohort.
 *
 * For each bank's rate_pages entries (NRI-relevant keys), resolves the URL,
 * fetches it (browser UA, timeout), and classifies:
 *   LIVE-OK      200 + looks like a rate page (HTML has rate tokens, or PDF)
 *   LIVE-SUSPECT 200 but no rate tokens (page may have been restructured)
 *   DEAD         404 / 5xx / timeout / network error
 *
 * Usage: node scripts/analysis/url-health-probe.js --cohort gold-11-nri-banks
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'bank-domains.json'), 'utf8'));
const argv = process.argv.slice(2);
const ci = argv.indexOf('--cohort');
if (ci < 0) { console.error('--cohort <name> required'); process.exit(1); }
const cohort = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cohorts', argv[ci + 1] + '.json'), 'utf8'));

// rate_pages keys that carry NRI-relevant rate content
const KEYS = ['fd', 'fd_nre', 'fd_nro', 'fd_fcnr', 'fd_gift', 'fd_nri_combined',
  'fd_pdf_nri', 'fd_pdf_fcnr', 'fd_pdf_nri_plus', 'fd_image_ocr_fcnr'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const RATE_TOKENS = /(fcnr|nre|nro|interest rate|per annum|% p\.a|deposit|tenure|maturity|1 year|senior citizen)/i;

function resolveUrl(domain, val) {
  if (!val) return null;
  if (/^https?:\/\//i.test(val)) return val;
  return 'https://' + domain.replace(/\/$/, '') + '/' + val.replace(/^\//, '');
}

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) return { status: r.status, verdict: 'DEAD', ct };
    if (/pdf/i.test(ct)) return { status: r.status, verdict: 'LIVE-OK', ct: 'pdf' };
    const body = (await r.text()).slice(0, 200000);
    return { status: r.status, verdict: RATE_TOKENS.test(body) ? 'LIVE-OK' : 'LIVE-SUSPECT', ct: ct.split(';')[0] };
  } catch (e) {
    return { status: '-', verdict: 'DEAD', ct: (e.name === 'AbortError' ? 'timeout' : e.code || e.message.slice(0, 30)) };
  } finally { clearTimeout(t); }
}

(async () => {
  for (const entry of cohort) {
    const code = entry.bank_code;
    const e = reg[code] || {};
    const rp = e.rate_pages || {};
    const seen = new Map();
    for (const k of KEYS) {
      const u = resolveUrl(e.domain, rp[k]);
      if (u && !seen.has(u)) seen.set(u, k);
    }
    if (!seen.size) { console.log(`\n#### ${code}\n  (no NRI rate URLs in registry)`); continue; }
    console.log(`\n#### ${code}  [${e.domain}]`);
    const results = await Promise.all([...seen.entries()].map(async ([u, k]) => ({ k, u, ...(await probe(u)) })));
    for (const r of results) {
      const flag = r.verdict === 'LIVE-OK' ? '✓' : r.verdict === 'LIVE-SUSPECT' ? '?' : '✗';
      console.log(`  ${flag} ${r.k.padEnd(18)} ${String(r.status).padStart(3)} ${r.verdict.padEnd(12)} ${r.ct}`);
      if (r.verdict !== 'LIVE-OK') console.log(`      ${r.u}`);
    }
  }
})();

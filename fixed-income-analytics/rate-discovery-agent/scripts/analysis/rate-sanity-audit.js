'use strict';
// Rate-sanity audit over output/latest/*_rates.json (all variants).
// Flags data-quality issues the pack quality-gate would BLOCK on, with
// provenance (template-auto vs tier-2 vs static) so triage is fast.
//
//   senior_below_general    senior < general by > 30bps (Indian FD invariant)
//   super_below_senior      super_senior < senior by > 30bps
//   out_of_bounds           rate outside loose variant band (would be dropped)
//   insane_tenure           tenure_max > 3700d or min>max (would be dropped)
//   suspicious_senior       senior in {0.1,1,2} while general >= senior+2  (col-map / min-deposit leak)
//   dup_tenure              two slabs same (tenure_min,tenure_max,deposit_range)
//   stale                   effective_date older than STALE_MONTHS (default 18)
//
// Usage:
//   node scripts/analysis/rate-sanity-audit.js [--stale-months N] [--only <slug,slug>] [--json]
const fs = require('node:fs');
const path = require('node:path');
const { isSlabRateInBounds, isSlabTenureSane } = require('../../lib/rate-bounds.js');
const { classifyTableType, ladderPlausibility, fcnrCurrencySanity } = require('../../lib/checks/structural-checks.js');
const REPO = path.resolve(__dirname, '..', '..');
const LATEST = path.join(REPO, 'output', 'latest');
const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'bank-domains.json'), 'utf-8'));

// bank_type lives in the per-bank config file (not the rate file or registry);
// cache it so the ladder floor is accurate. Sprint 008 Phase 3.
const _btCache = new Map();
function bankTypeOf(slug) {
  if (_btCache.has(slug)) return _btCache.get(slug);
  let bt = null;
  try { bt = (JSON.parse(fs.readFileSync(path.join(LATEST, `${slug}_config.json`), 'utf-8')).bank_type) || null; } catch { /* no config */ }
  _btCache.set(slug, bt);
  return bt;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const staleMonths = (() => { const i = args.indexOf('--stale-months'); return i >= 0 ? Number(args[i + 1]) : 18; })();
const onlyArg = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1].split(',')) : null; })();
const SENIOR_BPS = 0.30, SUPER_BPS = 0.30;
const now = new Date('2026-05-26');
const staleBefore = new Date(now); staleBefore.setMonth(staleBefore.getMonth() - staleMonths);

const VARIANT_SUFFIX = { '': 'regular', '_nre': 'nre', '_nro': 'nro', '_fcnr': 'fcnr', '_gift': 'gift' };
function slugFromFile(f) {
  const base = f.replace(/_rates\.json$/, '');
  for (const [suf, v] of Object.entries(VARIANT_SUFFIX)) {
    if (suf && base.endsWith(suf)) return { slug: base.slice(0, -suf.length), variant: v };
  }
  return { slug: base, variant: 'regular' };
}
function provenance(slug) {
  const e = reg[slug] || {};
  const auto = !!(e.template || e.template_fcnr || e.template_gift);
  return { auto, extraction_method: e.extraction_method || null, tier2: !!e.tier2, discovery_status: e.discovery_status || null };
}

const files = fs.readdirSync(LATEST).filter(f => f.endsWith('_rates.json'));
const flagged = {};
let scanned = 0;
for (const f of files) {
  const { slug, variant } = slugFromFile(f);
  if (onlyArg && !onlyArg.has(slug)) continue;
  let d; try { d = JSON.parse(fs.readFileSync(path.join(LATEST, f), 'utf-8')); } catch { continue; }
  const slabs = d.rate_slabs || [];
  if (slabs.length === 0) continue;
  scanned++;
  const issues = [];
  const seen = new Map();
  for (const s of slabs) {
    const g = s.rate_general_pct, sr = s.rate_senior_pct, ss = s.rate_super_senior_pct;
    if (typeof g === 'number' && typeof sr === 'number' && sr < g - SENIOR_BPS)
      issues.push({ k: 'senior_below_general', t: s.tenure_text, g, sr });
    if (typeof sr === 'number' && typeof ss === 'number' && ss < sr - SUPER_BPS)
      issues.push({ k: 'super_below_senior', t: s.tenure_text, sr, ss });
    if (!isSlabRateInBounds(s, variant)) issues.push({ k: 'out_of_bounds', t: s.tenure_text, g, sr, ss });
    if (!isSlabTenureSane(s)) issues.push({ k: 'insane_tenure', t: s.tenure_text, min: s.tenure_min_days, max: s.tenure_max_days });
    if (typeof sr === 'number' && [0.1, 1, 2].includes(sr) && typeof g === 'number' && g >= sr + 2)
      issues.push({ k: 'suspicious_senior', t: s.tenure_text, g, sr });
    const key = `${s.tenure_min_days}|${s.tenure_max_days}|${s.deposit_range || ''}|${s.currency || ''}`;
    if (seen.has(key)) issues.push({ k: 'dup_tenure', t: s.tenure_text, also: seen.get(key) });
    else seen.set(key, s.tenure_text);
  }
  // Sprint 008 Phase 3: variant-level structural checks. Peer senior-premium
  // (check #2) is gate-only (needs the full-pack peer distribution); the audit
  // runs the three that work on a single bank in isolation.
  const ctx = { variant, bankType: bankTypeOf(slug) };
  for (const it of [classifyTableType(slabs, ctx), ladderPlausibility(slabs, ctx), ...fcnrCurrencySanity(slabs, ctx)]) {
    if (it) issues.push({ k: it.check, t: variant, sev: it.severity, detail: it.detail, value: it.value });
  }
  let stale = false;
  if (d.effective_date && /^\d{4}-\d{2}-\d{2}$/.test(d.effective_date)) {
    if (new Date(d.effective_date) < staleBefore) stale = true;
  }
  if (issues.length || stale) {
    const p = provenance(slug);
    (flagged[slug] ||= { slug, prov: p, variants: {} });
    flagged[slug].variants[variant] = {
      n: slabs.length, effective_date: d.effective_date || null, stale,
      run_method: (d.discovery_metadata || {}).run_method || null,
      source_url: d.source_url || null, issues,
    };
  }
}

if (asJson) { console.log(JSON.stringify(flagged, null, 2)); process.exit(0); }

// Summary by issue kind
const kindCount = {};
const banksByKind = {};
let staleBanks = 0;
for (const b of Object.values(flagged)) {
  let anyStale = false;
  for (const [v, x] of Object.entries(b.variants)) {
    if (x.stale) anyStale = true;
    for (const i of x.issues) { kindCount[i.k] = (kindCount[i.k] || 0) + 1; (banksByKind[i.k] ||= new Set()).add(b.slug); }
  }
  if (anyStale) staleBanks++;
}
console.log(`Scanned ${scanned} non-empty rate files; ${Object.keys(flagged).length} bank(s) flagged.\n`);
console.log('Issue kind             slabs  banks');
for (const k of Object.keys(kindCount).sort((a, b) => kindCount[b] - kindCount[a]))
  console.log(k.padEnd(22), String(kindCount[k]).padStart(5), String(banksByKind[k].size).padStart(6));
console.log(`stale (>${staleMonths}mo)`.padEnd(22), ' '.repeat(5), String(staleBanks).padStart(6));

// Detail, auto (template) banks first since those affect refresh quality
const order = Object.values(flagged).sort((a, b) => (b.prov.auto - a.prov.auto));
console.log('\n=== Flagged banks (AUTO=template first) ===');
for (const b of order) {
  const tag = b.prov.auto ? 'AUTO' : (b.prov.tier2 ? 'tier2' : 'static');
  const em = b.prov.extraction_method ? ` em=${b.prov.extraction_method}` : '';
  console.log(`\n${b.slug}  [${tag}${em}]`);
  for (const [v, x] of Object.entries(b.variants)) {
    const flags = {};
    for (const i of x.issues) flags[i.k] = (flags[i.k] || 0) + 1;
    const fstr = Object.entries(flags).map(([k, n]) => `${k}×${n}`).join(', ') || (x.stale ? '(stale only)' : '');
    console.log(`  ${v}: n=${x.n} eff=${x.effective_date}${x.stale ? ' STALE' : ''} rm=${x.run_method || '-'}  ${fstr}`);
    for (const i of x.issues.slice(0, 4)) console.log(`     - ${i.k}: ${JSON.stringify(i)}`);
    if (x.issues.length > 4) console.log(`     ... +${x.issues.length - 4} more`);
  }
}

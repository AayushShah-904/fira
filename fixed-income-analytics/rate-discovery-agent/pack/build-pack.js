#!/usr/bin/env node
/**
 * Build the BIRD rates-pack: a single denormalized JSON bundle for external consumers.
 *
 * Reads from   ../output/latest/   (and its legacy/ subfolder for slugs not in latest)
 * Writes       ./dist/rates-pack.json
 *              ./dist/rates-pack.schema.json
 *              ./dist/README.md
 */

const fs = require('fs');
const path = require('path');
const { aliasToCanonical } = require('../lib/slug-aliases');
const { isSlabRateInBounds, isSlabTenureSane } = require('../lib/rate-bounds');

const PACK_VERSION = '1.0.0';

// Sprint-004 cohort #3 Phase B (2026-05-23): per-bank counter of slabs the
// pack-builder dropped because their rate values were outside the loose
// sanity band in lib/rate-bounds.js. Mutated by `buildVariant`, surfaced in
// the final console log so operators can audit which banks lost slabs to
// extraction-error filtering. Reset at the start of each `buildPack()` call.
const filterDropCounts = new Map(); // bank_code → { variant: count }
// Dedup + freshness telemetry (sprint-007 solidify, 2026-05-26).
const dedupCounts = new Map();      // bank_code → { variant: count of identical slabs removed }
let staleVariantCount = 0;          // variants flagged stale this build
// A variant is badged `stale` when its effective_date is older than this many
// months — purely a presentation freshness hint for the PM, not a filter.
const STALE_MONTHS = 18;
const STALE_CUTOFF = (() => { const d = new Date(); d.setMonth(d.getMonth() - STALE_MONTHS); return d; })();

// Identity key for an in-pack slab. Two slabs with the same key carry no extra
// information (same tenure text + parsed days + amount tier + currency + every
// rate), so the second is a pure duplicate and is dropped. tenure_text is part
// of the key so distinct bands whose tenure failed to parse to days (common in
// FCNR cards) are NOT merged.
function slabIdentityKey(s) {
  return [
    (s.tenure_text || '').trim().toLowerCase().replace(/\s+/g, ' '),
    s.tenure_min_days, s.tenure_max_days, s.deposit_range || '', s.currency || '',
    s.rate_general_pct, s.rate_senior_pct, s.rate_super_senior_pct,
  ].join('|');
}
const ROOT = path.resolve(__dirname);

// Path overrides via env vars (per Sprint 002 #11) — operators / tests can
// build a pack from any output/latest/ snapshot without copying the dir.
//   BIRD_LATEST_DIR  — source dir of per-bank artifacts (defaults to ../output/latest)
//   BIRD_DIST_DIR    — target dir for rates-pack.json + schema + README (defaults to ./dist)
const LATEST_DIR = process.env.BIRD_LATEST_DIR
  ? path.resolve(process.env.BIRD_LATEST_DIR)
  : path.resolve(ROOT, '..', 'output', 'latest');
const LEGACY_DIR = path.join(LATEST_DIR, 'legacy');
const DIST_DIR = process.env.BIRD_DIST_DIR
  ? path.resolve(process.env.BIRD_DIST_DIR)
  : path.join(ROOT, 'dist');

// Order matters: variant suffixes must be tested BEFORE the bare `_rates.json`.
const LATEST_VARIANTS = [
  { suf: '_nre_rates.json',  key: 'nre' },
  { suf: '_nro_rates.json',  key: 'nro' },
  { suf: '_fcnr_rates.json', key: 'fcnr' },
  { suf: '_gift_rates.json', key: 'gift' },
  { suf: '_rates.json',      key: 'regular' },
];

function tryParse(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function slugFromRateFile(name) {
  for (const v of LATEST_VARIANTS) {
    if (name.endsWith(v.suf)) {
      const raw = name.slice(0, -v.suf.length);
      const slug = aliasToCanonical(raw);
      return { slug, key: v.key, fromAlias: slug !== raw };
    }
  }
  return null;
}

function loadExcludes() {
  // Triage-driven manifest of (bank_code, variant) pairs to drop from the pack.
  // Why: rate files in output/latest/ may have known structural issues (corrupt
  // values, wrong-table extractions) that we want preserved for refresh-baseline
  // comparison but excluded from the published pack.
  const m = tryParse(path.join(LATEST_DIR, '_pack_excludes.json'));
  const set = new Set();
  for (const e of m?.excludes || []) set.add(e.bank_code + '|' + e.variant);
  return set;
}

// Sprint 008 Phase 5: per-variant confidence sidecars produced by
// scripts/confidence/build-confidence.js. Only consulted when BIRD_EMIT_CONFIDENCE
// is set, so the default published pack is byte-compatible with prior builds
// until the operator opts in. build-pack stays LLM-free — it only reads the
// precomputed score/tier/signals.
let _confLoaded = false;
let _confMap = null;
function confidenceFor(slug, variant) {
  if (!process.env.BIRD_EMIT_CONFIDENCE) return null;
  if (!_confLoaded) {
    _confMap = new Map();
    const dir = path.join(LATEST_DIR, '_confidence');
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const c = tryParse(path.join(dir, f));
        if (c && c.bank_code && c.variant) _confMap.set(`${c.bank_code}|${c.variant}`, c);
      }
    } catch { /* no _confidence dir — leave map empty */ }
    _confLoaded = true;
  }
  return _confMap.get(`${slug}|${variant}`) || null;
}

/**
 * Sprint 4 Track A 2026-05-20: discover banks flagged partial_silent by
 * run-discovery.js. Each marker file is <bank_code>.partial_silent.json in
 * output/latest/. The marker is suspected-incomplete-extraction; healthy
 * data should not ride along with the suspect variant into the pack.
 *
 * M2.1 (sprint-004 2026-05-21): markers are now variant-scoped. Returns
 *   Map<bank_code, Set<variant>>
 * where the set entries are variant keys ('regular', 'nre', 'nro', 'fcnr',
 * 'gift') OR the wildcard '*'. Wildcard semantics:
 *   - explicit by absence of `drifted_variants` in the marker (legacy
 *     marker_schema_version < 2 from previous sprints; treated as
 *     whole-bank exclusion for backward compatibility)
 *   - empty drifted_variants array (defensive: shouldn't happen but
 *     gives the most-conservative behaviour if it does)
 *
 * Operator can re-run with the floor lowered or accept the lower count
 * by removing the marker file before the next pack build.
 */
function loadPartialSilent() {
  const map = new Map();
  if (!fs.existsSync(LATEST_DIR)) return map;
  for (const f of fs.readdirSync(LATEST_DIR)) {
    if (!f.endsWith('.partial_silent.json')) continue;
    const slug = aliasToCanonical(f.slice(0, -'.partial_silent.json'.length));
    const marker = tryParse(path.join(LATEST_DIR, f));
    if (marker && Array.isArray(marker.drifted_variants) && marker.drifted_variants.length > 0) {
      map.set(slug, new Set(marker.drifted_variants));
    } else {
      // Legacy whole-bank exclusion (back-compat).
      map.set(slug, new Set(['*']));
    }
  }
  return map;
}

function loadLatest() {
  const index = tryParse(path.join(LATEST_DIR, '_bank_index.json'))?.banks || {};
  const excludes = loadExcludes();
  const partialSilent = loadPartialSilent(); // Map<slug, Set<variant|'*'>>
  const banks = {};
  const files = fs.readdirSync(LATEST_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  let excluded = 0;
  let silentSkipped = 0;
  // M2.1: track per-bank which variants were skipped so the log clearly
  // distinguishes "whole bank held" from "fcnr held, regular+NRE+NRO ship".
  const silentByBank = new Map(); // slug → Set<variant skipped>
  // Fix #9 (2026-05-23): when two filenames alias to the same canonical slug
  // (e.g., legacy nkgsb-co-operative-bank-ltd-mumbai_rates.json + new
  // nkgsb-co-operative-bank-ltd_rates.json after the registry was
  // de-duplicated), prefer the file whose filename already matches the
  // canonical slug. Without this tiebreaker, alphabetical readdir order
  // would let the alias filename overwrite the canonical one.
  const rateSourceIsAlias = new Map(); // 'slug|variant' → boolean

  for (const f of files) {
    const r = slugFromRateFile(f);
    if (r) {
      if (excludes.has(r.slug + '|' + r.key)) { excluded++; continue; }
      const drifted = partialSilent.get(r.slug);
      if (drifted && (drifted.has('*') || drifted.has(r.key))) {
        silentSkipped++;
        if (!silentByBank.has(r.slug)) silentByBank.set(r.slug, new Set());
        silentByBank.get(r.slug).add(drifted.has('*') ? '*' : r.key);
        continue;
      }
      const d = tryParse(path.join(LATEST_DIR, f));
      if (!d) continue;
      banks[r.slug] = banks[r.slug] || { rates: {}, config: null };
      const variantKey = r.slug + '|' + r.key;
      const prev = rateSourceIsAlias.has(variantKey) ? rateSourceIsAlias.get(variantKey) : null;
      if (prev === false && r.fromAlias) continue; // canonical already loaded; alias loses tiebreaker
      banks[r.slug].rates[r.key] = d;
      rateSourceIsAlias.set(variantKey, r.fromAlias);
      continue;
    }
    if (f.endsWith('_config.json')) {
      const raw = f.slice(0, -'_config.json'.length);
      const slug = aliasToCanonical(raw);
      const fromAlias = slug !== raw;
      const drifted = partialSilent.get(slug);
      // Config files are kept unless the whole-bank legacy marker is set.
      // For variant-scoped markers the config still ships (the bank exists,
      // some variants are just being held back).
      if (drifted && drifted.has('*')) {
        silentSkipped++;
        if (!silentByBank.has(slug)) silentByBank.set(slug, new Set());
        silentByBank.get(slug).add('*');
        continue;
      }
      banks[slug] = banks[slug] || { rates: {}, config: null };
      const prev = rateSourceIsAlias.has(slug + '|_config') ? rateSourceIsAlias.get(slug + '|_config') : null;
      if (prev === false && fromAlias) continue;
      banks[slug].config = tryParse(path.join(LATEST_DIR, f));
      rateSourceIsAlias.set(slug + '|_config', fromAlias);
    }
  }
  if (excluded) console.log('Excluded', excluded, '(bank,variant) pairs via _pack_excludes.json');
  if (silentSkipped) {
    const summary = [...silentByBank.entries()]
      .map(([slug, vs]) => `${slug}(${vs.has('*') ? 'all' : [...vs].join(',')})`)
      .join(', ');
    console.log('Skipped', silentSkipped, 'file(s) for', silentByBank.size, 'partial_silent bank(s):', summary);
  }

  for (const slug of Object.keys(banks)) banks[slug].index = index[slug] || null;
  for (const slug of Object.keys(index)) {
    if (!banks[slug]) banks[slug] = { rates: {}, config: null, index: index[slug] };
  }
  return banks;
}

function loadLegacy(existingSlugs) {
  if (!fs.existsSync(LEGACY_DIR)) return {};
  const banks = {};
  for (const f of fs.readdirSync(LEGACY_DIR).filter(x => x.endsWith('.json'))) {
    let slug, kind;
    if (f.endsWith('-config.json'))      { slug = aliasToCanonical(f.slice(0, -'-config.json'.length)); kind = 'config'; }
    else if (f.endsWith('-rates.json'))  { slug = aliasToCanonical(f.slice(0, -'-rates.json'.length)); kind = 'rates_regular'; }
    else continue;
    if (existingSlugs.has(slug)) continue;
    banks[slug] = banks[slug] || { rates: {}, config: null };
    const d = tryParse(path.join(LEGACY_DIR, f));
    if (!d) continue;
    if (kind === 'config') banks[slug].config = d;
    else banks[slug].rates.regular = d;
  }
  return banks;
}

function buildVariant(d, slug, variant) {
  if (!d || !Array.isArray(d.rate_slabs) || d.rate_slabs.length === 0) return null;
  // Sprint 008 IBU sweep: a bare <slug>_rates.json is slotted as the 'regular'
  // (domestic) variant by filename. If its own `variant` field is a foreign-
  // currency variant (gift/fcnr) AND its slabs carry a currency, it's a
  // mislabel — refuse to ship GIFT/FCNR rates as domestic FD. (IBUs have no
  // domestic FD; their data belongs in the _gift variant.) A no-currency odd
  // label like 'corporate' is left alone (it's still domestic FD).
  if (variant === 'regular' && d.variant && d.variant !== 'regular'
      && d.rate_slabs.some((s) => s.currency)) {
    return null;
  }
  // Phase B: drop slabs whose rate values are outside the loose sanity band
  // in lib/rate-bounds.js. Counts the drops so the run log can surface them.
  const v = variant || d.variant || 'regular';
  const filtered = [];
  let dropped = 0;
  for (const slab of d.rate_slabs) {
    if (!isSlabRateInBounds(slab, v)) { dropped++; continue; }
    if (!isSlabTenureSane(slab)) { dropped++; continue; }
    // Normalize tenure_text whitespace (collapse tabs / runs of spaces) — PDF
    // text extraction leaves tab artifacts ("8\t-\t14 days"). Cosmetic only;
    // done before dedup so tab/space variants of the same band coalesce.
    if (typeof slab.tenure_text === 'string' && /\s{2,}|\t/.test(slab.tenure_text)) {
      filtered.push({ ...slab, tenure_text: slab.tenure_text.replace(/\s+/g, ' ').trim() });
    } else {
      filtered.push(slab);
    }
  }
  if (dropped > 0 && slug) {
    const bucket = filterDropCounts.get(slug) || {};
    bucket[v] = (bucket[v] || 0) + dropped;
    filterDropCounts.set(slug, bucket);
  }
  if (filtered.length === 0) return null;
  // Dedup pure-identical slabs (no information lost). Preserves first-seen order.
  const seen = new Set();
  const deduped = [];
  let dedupRemoved = 0;
  for (const slab of filtered) {
    const k = slabIdentityKey(slab);
    if (seen.has(k)) { dedupRemoved++; continue; }
    seen.add(k);
    deduped.push(slab);
  }
  if (dedupRemoved > 0 && slug) {
    const bucket = dedupCounts.get(slug) || {};
    bucket[v] = (bucket[v] || 0) + dedupRemoved;
    dedupCounts.set(slug, bucket);
  }
  // Freshness badge: stale when the effective_date is older than STALE_MONTHS.
  // Unknown/unparseable dates are left unbadged (stale: false) — absence of a
  // date is surfaced separately by effective_date: null.
  let stale = false;
  const ed = d.effective_date;
  if (typeof ed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ed) && new Date(ed) < STALE_CUTOFF) {
    stale = true;
    staleVariantCount++;
  }
  const built = {
    effective_date: d.effective_date || null,
    source_url: d.source_url || null,
    scraped_at: d.scraped_at || null,
    extraction_confidence: d.extraction_confidence || 'unknown',
    // Provenance so the PM can badge auto-refreshed vs transcribed/manual data.
    extraction_method: d.extraction_method || null,
    run_method: (d.discovery_metadata && d.discovery_metadata.run_method) || null,
    stale,
    slabs: deduped,
    special_schemes: Array.isArray(d.special_schemes) ? d.special_schemes : [],
    warnings: Array.isArray(d.warnings) ? d.warnings : [],
  };
  // Sprint 008 Phase 5: composite confidence (opt-in via BIRD_EMIT_CONFIDENCE).
  const conf = confidenceFor(slug, v);
  if (conf) {
    built.confidence_score = conf.score;
    built.confidence_tier = conf.tier;
    built.confidence_signals = conf.signals;
  }
  return built;
}

function bestEffectiveDate(entry) {
  const dates = [];
  for (const v of Object.values(entry.products.fd || {})) if (v?.effective_date) dates.push(v.effective_date);
  if (!dates.length) return null;
  dates.sort();
  return dates[dates.length - 1];
}

function toEntry(slug, raw, source) {
  const cfg = raw.config || {};
  const idx = raw.index || {};
  const products = { fd: {} };
  for (const key of ['regular','nre','nro','fcnr','gift']) {
    const v = buildVariant(raw.rates[key], slug, key);
    if (v) products.fd[key] = v;
  }
  const entry = {
    bank_code: aliasToCanonical(cfg.bank_code || slug),
    bank_name: cfg.bank_name || idx.bank_name || slug,
    bank_type: cfg.bank_type || null,
    category: cfg.category || idx.category || null,
    website: cfg.website || idx.website || null,
    status: idx.status || (cfg.scraper_type === 'manual' ? 'manual' : 'unknown'),
    confidence: idx.confidence || cfg.discovery_metadata?.confidence || null,
    source,
    effective_date: null,
    rate_pages: cfg.rate_page_urls || null,
    products,
  };
  entry.effective_date = bestEffectiveDate(entry);
  return entry;
}

function variantKeys(fd) { return Object.keys(fd || {}); }
function hasNRI(keys)   { return keys.some(k => k === 'nre' || k === 'nro' || k === 'fcnr'); }

function buildCountsByCategory(entries) {
  const cats = {};
  for (const e of entries) {
    const cat = e.category || '(unknown)';
    cats[cat] = cats[cat] || { banks: 0, with_regular_fd: 0, with_any_variant: 0, with_nri: 0, with_gift: 0 };
    cats[cat].banks++;
    const keys = variantKeys(e.products.fd);
    if (keys.includes('regular')) cats[cat].with_regular_fd++;
    if (keys.length > 0)          cats[cat].with_any_variant++;
    if (hasNRI(keys))             cats[cat].with_nri++;
    if (keys.includes('gift'))    cats[cat].with_gift++;
  }
  return cats;
}

function buildCounts(entries) {
  let total_slabs = 0, with_regular_fd = 0, with_any_variant = 0, with_nri = 0, with_gift = 0;
  for (const e of entries) {
    const fd = e.products.fd || {};
    for (const v of Object.values(fd)) total_slabs += v.slabs.length;
    const keys = variantKeys(fd);
    if (keys.includes('regular')) with_regular_fd++;
    if (keys.length > 0)          with_any_variant++;
    if (hasNRI(keys))             with_nri++;
    if (keys.includes('gift'))    with_gift++;
  }
  return {
    banks_total: entries.length,
    banks_with_regular_fd: with_regular_fd,
    banks_with_any_variant: with_any_variant,
    banks_with_nri: with_nri,
    banks_with_gift: with_gift,
    total_slabs,
    by_category: buildCountsByCategory(entries),
  };
}

function buildPack() {
  filterDropCounts.clear();
  dedupCounts.clear();
  staleVariantCount = 0;
  const latest = loadLatest();
  const legacy = loadLegacy(new Set(Object.keys(latest)));

  const entries = [];
  for (const [slug, raw] of Object.entries(latest)) entries.push(toEntry(slug, raw, 'latest'));
  for (const [slug, raw] of Object.entries(legacy)) entries.push(toEntry(slug, raw, 'legacy'));
  entries.sort((a, b) => a.bank_code.localeCompare(b.bank_code));

  // Phase B: surface filter-drop telemetry.
  if (filterDropCounts.size > 0) {
    let total = 0;
    const lines = [];
    for (const [slug, perVariant] of filterDropCounts.entries()) {
      const vCounts = Object.entries(perVariant).map(([v, n]) => `${v}=${n}`).join(',');
      const bankTotal = Object.values(perVariant).reduce((a, b) => a + b, 0);
      total += bankTotal;
      lines.push(`  ${slug}: ${vCounts}`);
    }
    console.log(`Rate-bound filter dropped ${total} slab(s) across ${filterDropCounts.size} bank(s):`);
    for (const l of lines) console.log(l);
  }

  // Dedup + freshness telemetry.
  if (dedupCounts.size > 0) {
    let total = 0;
    for (const perVariant of dedupCounts.values()) total += Object.values(perVariant).reduce((a, b) => a + b, 0);
    console.log(`Deduped ${total} identical slab(s) across ${dedupCounts.size} bank(s).`);
  }
  console.log(`Freshness: ${staleVariantCount} variant(s) badged stale (effective_date older than ${STALE_MONTHS} months).`);

  const counts = buildCounts(entries);
  const pack = {
    pack_version: PACK_VERSION,
    generated_at: new Date().toISOString(),
    source: 'BIRD Rate Discovery Agent',
    enums: {
      bank_types:        ['PSB','PVB','SFB','PB','FB','RRB','SUCB','NSUCB','SSCB','NSSCB','DCCB','LAB','FI','IBU','HFC'],
      variants:          ['regular','nre','nro','fcnr','gift'],
      statuses:          ['current','stale','parse_fail','manual','blocked','no_website','unknown'],
      confidence_levels: ['high','medium','low','none','unknown'],
      // M2.3 (sprint-004 2026-05-21): extended with fine-grained bulk
      // buckets that Axis (and likely HDFC / ICICI / SBI) publish on their
      // multi-column rate-card PDFs. Older coarse value `25cr_to_100cr`
      // kept for back-compat with banks that publish at that coarseness.
      // Coordination with BIRD-side ingestion before pack publish: the
      // ingestion side must accept (or at least tolerate) these new values
      // — see sdlc/sprints/sprint-004/design/per-bank-extraction-hints.md
      // §5e for the deployment dependency.
      deposit_ranges:    ['below_3cr','3cr_to_5cr','5cr_to_25cr','25cr_to_50cr','50cr_to_100cr','25cr_to_100cr','100cr_to_200cr','200cr_to_500cr','500cr_to_1000cr','above_100cr','above_1000cr',
                          'below_15l','15l_to_1cr','1cr_to_10cr','above_10cr','below_1m_usd'],
    },
    counts,
    banks: entries,
  };

  fs.mkdirSync(DIST_DIR, { recursive: true });
  // safe-write-exempt: pack output (rates-pack.json), derived aggregate of output/latest/ — not a per-bank artifact (ADR-012 §"NOT in scope").
  fs.writeFileSync(path.join(DIST_DIR, 'rates-pack.json'),        JSON.stringify(pack, null, 2));
  // safe-write-exempt: pack schema (rates-pack.schema.json), derived.
  fs.writeFileSync(path.join(DIST_DIR, 'rates-pack.schema.json'), JSON.stringify(buildSchema(), null, 2));
  // safe-write-exempt: pack README (markdown), derived.
  fs.writeFileSync(path.join(DIST_DIR, 'README.md'),              buildReadme(pack));

  const sz = fs.statSync(path.join(DIST_DIR, 'rates-pack.json')).size;
  console.log('Wrote', path.join(DIST_DIR, 'rates-pack.json'), `(${(sz/1024).toFixed(1)} KB)`);
  console.log('Wrote', path.join(DIST_DIR, 'rates-pack.schema.json'));
  console.log('Wrote', path.join(DIST_DIR, 'README.md'));
  console.log('Banks:', counts.banks_total,
              '| regular FD:', counts.banks_with_regular_fd,
              '| any variant:', counts.banks_with_any_variant,
              '| slabs:', counts.total_slabs);
}

function buildSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://bird.local/rates-pack.schema.json',
    title: 'BIRD Rates Pack',
    type: 'object',
    required: ['pack_version','generated_at','enums','counts','banks'],
    properties: {
      pack_version: { type: 'string' },
      generated_at: { type: 'string', format: 'date-time' },
      source:       { type: 'string' },
      enums: {
        type: 'object',
        properties: {
          bank_types:        { type: 'array', items: { type: 'string' } },
          variants:          { type: 'array', items: { type: 'string' } },
          statuses:          { type: 'array', items: { type: 'string' } },
          confidence_levels: { type: 'array', items: { type: 'string' } },
          deposit_ranges:    { type: 'array', items: { type: 'string' } },
        },
      },
      counts: {
        type: 'object',
        properties: {
          banks_total:           { type: 'integer' },
          banks_with_regular_fd: { type: 'integer' },
          banks_with_any_variant:{ type: 'integer' },
          banks_with_nri:        { type: 'integer' },
          banks_with_gift:       { type: 'integer' },
          total_slabs:           { type: 'integer' },
          by_category: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                banks:            { type: 'integer' },
                with_regular_fd:  { type: 'integer' },
                with_any_variant: { type: 'integer' },
                with_nri:         { type: 'integer' },
                with_gift:        { type: 'integer' },
              },
            },
          },
        },
      },
      banks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['bank_code','bank_name','status','products'],
          properties: {
            bank_code:     { type: 'string' },
            bank_name:     { type: 'string' },
            bank_type:     { type: ['string','null'] },
            category:      { type: ['string','null'] },
            website:       { type: ['string','null'] },
            status:        { type: 'string' },
            confidence:    { type: ['string','null'] },
            source:        { type: 'string', enum: ['latest','legacy'] },
            effective_date:{ type: ['string','null'] },
            rate_pages:    { type: ['object','null'] },
            products: {
              type: 'object',
              properties: {
                fd: {
                  type: 'object',
                  description: 'Keys are variant names (regular|nre|nro|fcnr|gift). A key is present only when slabs is non-empty.',
                  additionalProperties: {
                    type: 'object',
                    required: ['slabs'],
                    properties: {
                      effective_date:       { type: ['string','null'] },
                      source_url:           { type: ['string','null'] },
                      scraped_at:           { type: ['string','null'] },
                      extraction_confidence:{ type: 'string' },
                      confidence_score:     { type: 'integer', description: 'Sprint 008: 0-100 composite confidence (present only when BIRD_EMIT_CONFIDENCE built the pack).' },
                      confidence_tier:      { type: 'string', enum: ['verified','needs_review'], description: 'Sprint 008: verified (independent checks clean) vs needs_review.' },
                      confidence_signals:   { type: 'object', description: 'Sprint 008: the inputs behind confidence_score (structural, cross-check, freshness, measured error).' },
                      slabs: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['tenure_text','rate_general_pct'],
                          properties: {
                            tenure_text:           { type: 'string' },
                            tenure_min_days:       { type: ['integer','null'] },
                            tenure_max_days:       { type: ['integer','null'] },
                            rate_general_pct:      { type: ['number','null'] },
                            rate_senior_pct:       { type: ['number','null'] },
                            rate_super_senior_pct: { type: ['number','null'] },
                            deposit_range:         { type: ['string','null'] },
                            currency: {
                              type: ['string','null'],
                              description: 'Present on fcnr and gift slabs (USD, GBP, EUR, etc.)',
                            },
                          },
                        },
                      },
                      special_schemes: { type: 'array' },
                      warnings:        { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildReadme(pack) {
  const c = pack.counts;
  const catRows = Object.entries(c.by_category)
    .sort((a, b) => b[1].with_regular_fd - a[1].with_regular_fd)
    .map(([cat, v]) =>
      `| ${cat} | ${v.banks} | ${v.with_regular_fd} | ${v.with_any_variant} | ${v.with_nri} | ${v.with_gift} |`)
    .join('\n');

  return `# BIRD Rates Pack

Single-file bundle of Indian bank deposit interest rates, produced by the **BIRD Rate Discovery Agent**.

- **Pack version:** ${pack.pack_version}
- **Generated at:** ${pack.generated_at}
- **Total banks in pack:** ${c.banks_total}
- **Banks with ≥ 1 extracted rate slab:** ${c.banks_with_any_variant}
- **Total rate slabs:** ${c.total_slabs}

## Coverage summary

> Full coverage of commercial banks (PSB + PVB + SFB + PB + FB + LAB: ~69 banks), partial coverage of RRBs (~21) and GIFT-City IBUs (~13), plus a starter set of co-operative banks (~85). Total with at least one extracted rate: **${c.banks_with_any_variant} banks**.

Co-operative coverage is deliberately a small slice — the RBI universe includes ~1,500 UCBs and ~370 DCCBs, and this pack ships whichever co-op banks we have managed to scrape so far. What's here is accurate; what's here is not representative of the category as a whole.

## Coverage by category

| Category | Banks in pack | With regular FD | With any variant | With NRI | With GIFT |
|---|---:|---:|---:|---:|---:|
${catRows}

## Files in this bundle

- \`rates-pack.json\` — the data
- \`rates-pack.schema.json\` — JSON Schema for \`rates-pack.json\`
- \`README.md\` — this file

## Top-level shape

\`\`\`jsonc
{
  "pack_version": "1.0.0",
  "generated_at": "...",
  "enums": { "bank_types": [...], "variants": [...], "statuses": [...], ... },
  "counts": { "banks_total": N, "banks_with_regular_fd": N, ... },
  "banks": [ /* per-bank entry, see below */ ]
}
\`\`\`

## Per-bank entry

\`\`\`jsonc
{
  "bank_code": "hdfc-bank-limited",            // slug, stable primary key
  "bank_name": "HDFC Bank Limited",
  "bank_type": "PVB",                          // see enums.bank_types
  "category":  "Private Sector Bank (Indian)",
  "website":   "https://www.hdfcbank.com",
  "status":    "current",                      // see enums.statuses
  "confidence":"high",
  "source":    "latest",                       // "latest" | "legacy"
  "effective_date": "2026-03-01",              // max effective_date across variants, or null
  "rate_pages": {                              // original bank URLs where data came from
    "fd":"...", "fd_nre":"...", "fd_nro":null,
    "fd_fcnr":"...", "fd_nri_combined":null,
    "savings":null, "rd":null
  },
  "products": {
    "fd": {
      "regular": {
        "effective_date":"2026-03-01",
        "source_url":"...",
        "scraped_at":"...",
        "extraction_confidence":"high",        // high|medium|low|none|unknown
        "slabs": [
          {
            "tenure_text":"7 days to 45 days",
            "tenure_min_days":7,
            "tenure_max_days":45,
            "rate_general_pct":3.50,           // percent, number (NOT "3.50%")
            "rate_senior_pct":4.00,
            "rate_super_senior_pct":null,
            "deposit_range":"below_3cr"        // see enums.deposit_ranges
          }
        ],
        "special_schemes": [],
        "warnings": []
      },
      "nre":  { /* same shape, INR */ },
      "nro":  { /* same shape, INR */ },
      "fcnr": { /* foreign currency; each slab has "currency" (USD, GBP, EUR...).
                  FCNR has no senior premium — rate_senior_pct is always null. */ },
      "gift": { /* IFSC Banking Units only. Same shape as fcnr, with "currency". */ }
    }
  }
}
\`\`\`

### Rules you can rely on

- A variant key (\`regular\` / \`nre\` / \`nro\` / \`fcnr\` / \`gift\`) is **present only when we extracted ≥ 1 slab for it**. An absent key means "no data", not "zero rate".
- Banks with \`status\` in \`{manual, blocked, no_website, parse_fail}\` will typically have \`products: { fd: {} }\`. Their name/website/type are still provided so the UI can list them as "coming soon" rows.
- \`bank_code\` is the stable primary key across the whole project — same slug is used in filenames, database rows, and this pack.
- Rates are **percent numbers** (e.g. \`6.50\`), not strings. Divide by 100 to get the decimal rate.
- \`tenure_min_days\` / \`tenure_max_days\` are integers in days. Either may be \`null\` for open-ended slabs (e.g. "5 years and above" → \`min=1826, max=null\`).

## Node.js recipes

Drop \`rates-pack.json\` alongside your server code.

\`\`\`js
const pack = require('./rates-pack.json');
\`\`\`

### 1. List banks (with filters)

\`\`\`js
function listBanks({ type, status, hasRates = true } = {}) {
  return pack.banks.filter(b =>
    (!type   || b.bank_type === type) &&
    (!status || b.status === status) &&
    (!hasRates || Object.keys(b.products.fd || {}).length > 0)
  );
}

// All public-sector banks with any rate data
listBanks({ type: 'PSB' });
\`\`\`

### 2. Get FD rates for one bank

\`\`\`js
function getBank(bankCode) {
  return pack.banks.find(b => b.bank_code === bankCode) || null;
}

const hdfc = getBank('hdfc-bank-limited');
hdfc?.products.fd.regular?.slabs;    // domestic FD
hdfc?.products.fd.nre?.slabs;        // NRE
hdfc?.products.fd.fcnr?.slabs;       // FCNR (each slab has .currency)
\`\`\`

### 3. Best rate at N days across all banks

\`\`\`js
function bestRateAtDays(days, { variant = 'regular', tier = 'rate_general_pct' } = {}) {
  const out = [];
  for (const b of pack.banks) {
    const v = b.products.fd?.[variant];
    if (!v) continue;
    for (const s of v.slabs) {
      const minOk = s.tenure_min_days == null || s.tenure_min_days <= days;
      const maxOk = s.tenure_max_days == null || s.tenure_max_days >= days;
      if (minOk && maxOk && s[tier] != null) {
        out.push({ bank: b.bank_name, code: b.bank_code, rate: s[tier], tenure: s.tenure_text });
      }
    }
  }
  return out.sort((a, b) => b.rate - a.rate);
}

// Top 10 senior-citizen FD rates at 400 days
bestRateAtDays(400, { tier: 'rate_senior_pct' }).slice(0, 10);
\`\`\`

## Enums (copy into your code if useful)

\`\`\`
bank_types:        PSB, PVB, SFB, PB, FB, RRB, SUCB, NSUCB, SSCB, NSSCB, DCCB, LAB, FI, IBU, HFC
variants:          regular, nre, nro, fcnr, gift
statuses:          current, stale, parse_fail, manual, blocked, no_website, unknown
confidence_levels: high, medium, low, none, unknown
deposit_ranges:    below_3cr, 3cr_to_5cr, 5cr_to_25cr, 25cr_to_100cr, above_100cr,
                   below_15l, 15l_to_1cr, 1cr_to_10cr, above_10cr, below_1m_usd
\`\`\`

## Caveats

- **No live refresh.** This is a snapshot; regenerate the pack from source whenever you want the latest numbers.
- **Status semantics.** \`current\` = fresh scrape. \`stale\` = data from an older run (still useful but older \`effective_date\`). \`parse_fail\` = page fetched but rate table couldn't be parsed. \`manual\` / \`blocked\` / \`no_website\` = no rates extractable for reasons stated.
- **FCNR and GIFT rates are in foreign currency.** Use the \`currency\` field on each slab; don't assume INR.
- **Not every bank is here.** If a bank is missing, it hasn't been discovered yet — not "rates are zero".
`;
}

if (require.main === module) {
  buildPack();
}

module.exports = { buildPack, loadLatest, loadLegacy, toEntry };

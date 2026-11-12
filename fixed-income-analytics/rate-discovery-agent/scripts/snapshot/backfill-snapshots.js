#!/usr/bin/env node
'use strict';
//
// Backfill the source-snapshot store from output/latest (Sprint 008, Phase 1).
//
// Re-fetches each rate file's source_url and stores a content-addressed
// snapshot keyed to the rate file's scraped_at. Captures are tagged
// post_hoc:true because a backfill fetch happens AFTER extraction — the bytes
// may differ from the original scrape if the page changed since. This is an
// explicit, recorded limitation; the Phase 2 audit labels post_hoc verdicts
// distinctly and the Phase 4 cross-check treats mismatches as page-drift, not
// extraction error.
//
// Uses a lightweight built-in fetch (fast, static-friendly). JS-rendered pages
// will snapshot as scaffolding — marked post_hoc; the live detect-changes hook
// captures the real rendered body on the next refresh.
//
// Usage:
//   node scripts/snapshot/backfill-snapshots.js [--limit N] [--only slug,slug]
//       [--concurrency 6] [--force] [--dry-run]
//   --force        re-fetch even if a snapshot already exists for the variant
//   --dry-run      list what would be fetched, fetch nothing

const fs = require('node:fs');
const path = require('node:path');
const store = require('../../lib/snapshot/snapshot-store.js');

const REPO = path.resolve(__dirname, '..', '..');
const LATEST = path.join(REPO, 'output', 'latest');

const VARIANT_SUFFIX = { '': 'regular', '_nre': 'nre', '_nro': 'nro', '_fcnr': 'fcnr', '_gift': 'gift' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 RateDiscoveryAgent/snapshot-backfill';
const FETCH_TIMEOUT_MS = 25000;
const MAX_BYTES = 12 * 1024 * 1024;

function parseArgs(argv) {
  const a = { limit: Infinity, only: null, concurrency: 6, force: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--limit') a.limit = Number(argv[++i]) || Infinity;
    else if (x === '--only') a.only = new Set(argv[++i].split(','));
    else if (x === '--concurrency') a.concurrency = Number(argv[++i]) || 6;
    else if (x === '--force') a.force = true;
    else if (x === '--dry-run') a.dryRun = true;
  }
  return a;
}

function slugAndVariant(file) {
  const base = file.replace(/_rates\.json$/, '');
  for (const [suf, v] of Object.entries(VARIANT_SUFFIX)) {
    if (suf && base.endsWith(suf)) return { slug: base.slice(0, -suf.length), variant: v };
  }
  return { slug: base, variant: 'regular' };
}

function kindFor(url, contentType) {
  const u = String(url || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('pdf') || /\.pdf(?:\?|#|$)/.test(u)) return 'pdf';
  if (ct.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|tiff?)(?:\?|#|$)/.test(u)) return 'image';
  return 'html';
}

async function fetchOnce(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': UA } });
    const ct = res.headers.get('content-type') || '';
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length === 0) return { ok: false, error: 'empty_body' };
    if (buf.length > MAX_BYTES) return { ok: false, error: 'body_too_large' };
    return {
      ok: res.ok,
      status: res.status,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      contentType: ct,
      finalUrl: res.url,
      buf,
      error: res.ok ? null : `http_${res.status}`,
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : `fetch_error:${err.code || err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(LATEST)) { console.error(`no ${LATEST}`); process.exit(2); }

  const files = fs.readdirSync(LATEST).filter((f) => f.endsWith('_rates.json'));
  const jobs = [];
  for (const f of files) {
    const { slug, variant } = slugAndVariant(f);
    if (args.only && !args.only.has(slug)) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(LATEST, f), 'utf-8')); } catch { continue; }
    if (!d.source_url || !Array.isArray(d.rate_slabs) || d.rate_slabs.length === 0) continue;
    if (!args.force && store.getLatestSnapshot(slug, variant)) continue; // skip already-snapshotted
    jobs.push({ slug, variant, sourceUrl: d.source_url, scrapedAt: d.scraped_at || null, extractionMethod: d.extraction_method || null });
    if (jobs.length >= args.limit) break;
  }

  console.log(`backfill-snapshots: ${jobs.length} (bank,variant) to fetch (concurrency ${args.concurrency}${args.force ? ', force' : ''}${args.dryRun ? ', dry-run' : ''})`);
  if (args.dryRun) { for (const j of jobs.slice(0, 40)) console.log(`  ${j.slug}/${j.variant}  ${j.sourceUrl}`); if (jobs.length > 40) console.log(`  …+${jobs.length - 40}`); return; }

  const tally = { ok: 0, deduped: 0, failed: 0 };
  const failures = [];
  await runWithConcurrency(jobs, args.concurrency, async (j) => {
    const r = await fetchOnce(j.sourceUrl);
    if (!r.ok || !r.buf) { tally.failed++; failures.push(`${j.slug}/${j.variant}: ${r.error}`); return; }
    try {
      const put = store.putSnapshot({
        bankCode: j.slug, variant: j.variant, sourceUrl: r.finalUrl || j.sourceUrl,
        contentKind: kindFor(r.finalUrl || j.sourceUrl, r.contentType),
        bytes: r.buf, headers: { status: r.status, etag: r.etag, last_modified: r.lastModified },
        scrapedAt: j.scrapedAt, extractionMethod: j.extractionMethod, capturedBy: 'backfill', postHoc: true,
      });
      tally.ok++; if (put.deduped) tally.deduped++;
    } catch (err) { tally.failed++; failures.push(`${j.slug}/${j.variant}: put_error:${err.message}`); }
  });

  const idx = store.rebuildIndex();
  console.log(`\nDone. captured=${tally.ok} (blob-dedup ${tally.deduped})  failed=${tally.failed}`);
  console.log(`store: ${idx.variants} variants, ${idx.blobs} unique blobs, ${idx.orphans.length} orphan(s)`);
  if (failures.length) {
    console.log(`\nFailures (${failures.length}):`);
    for (const m of failures.slice(0, 30)) console.log(`  ${m}`);
    if (failures.length > 30) console.log(`  …+${failures.length - 30}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { slugAndVariant, kindFor };

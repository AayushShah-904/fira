#!/usr/bin/env node
'use strict';

/**
 * Phase 2 — change detection (+ body cache for Phase 3).
 *
 * For each (bank, variant) in the cohort: HTTP GET the source URL once,
 * compute cheap signals (Last-Modified, ETag, content hash, effective_date
 * scan, PDF byte hash), classify, and persist the body for any pair that
 * Phase 3 will need to extract from. One fetch per URL across the pipeline.
 *
 * Bodies for `likely_changed`, `signals_missing`, and `needs_playwright` are
 * saved to `output/refresh/<run-ts>/fetched/<slug>__<variant>.{html,pdf}`.
 * Bodies for `unchanged` and `unreachable` are discarded — they served their
 * purpose (hash + effective-date check) and Phase 3 won't read them.
 *
 * No AOAI calls. No Playwright in this phase — `html_js` pages that come back
 * as scaffolding get classified `needs_playwright` for Phase 3 to handle.
 *
 * Run:   node scripts/refresh/detect-changes.js
 *        node scripts/refresh/detect-changes.js --run-ts 2026-05-13T17-29-11
 *        node scripts/refresh/detect-changes.js --concurrency 6
 *        node scripts/refresh/detect-changes.js --slug state-bank-of-india  # single bank smoke
 *        node scripts/refresh/detect-changes.js --dry-run                    # use cached signals, no fetches
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const snapshotStore = require('../../lib/snapshot/snapshot-store.js'); // Sprint 008 Phase 1

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REFRESH_ROOT = path.join(REPO_ROOT, 'output', 'refresh');
const SIGNALS_CACHE_PATH = path.join(REPO_ROOT, 'data', 'refresh-signals.json');

const DEFAULT_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36 RateDiscoveryAgent/refresh';

// Effective-date regexes covering the formats Indian banks use on rate pages.
// We scan globally and pick the *latest* date — many pages list both old
// ("existing rates w.e.f. 15/07/2025") and new ("revised rates w.e.f. 15/12/2025")
// in the same table, and the latest is the right answer.
//
// The date payload accepts: `1st March 2026`, `01 March 2026`, `01-Mar-2026`,
// `01.03.2026`, `01/03/2026`, `2026-03-01`. Anchor keyword is `w.e.f.` (with
// flexible punctuation/spacing), `wef`, `with effect from`, `effective`,
// `effective date`, `revised`, `updated`, or `last updated`.
const ANCHOR_RE = /(?:w\.?\s*e\.?\s*f\.?|wef|with\s+effect\s+from|effective(?:\s+date)?|revised|(?:last\s+)?updated(?:\s+on)?)\s*:?\s*[\.,]?\s*/i;
const DATE_RE = /([0-9]{1,2}(?:st|nd|rd|th)?\s*[\s\.\-\/]\s*[A-Za-z0-9]{1,9}\s*[\s\.\-\/]\s*[0-9]{2,4}|20[2-3][0-9]-[0-1][0-9]-[0-3][0-9])/;
const COMBINED_RE = new RegExp(ANCHOR_RE.source + DATE_RE.source, 'gi');

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function parseArgs(argv) {
  const args = { runTs: null, concurrency: DEFAULT_CONCURRENCY, slug: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-ts') args.runTs = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || DEFAULT_CONCURRENCY;
    else if (a === '--slug') args.slug = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  // safe-write-exempt: refresh-pipeline run-meta artifact (_change_signals.json etc.) under runs/<ts>/; not a per-bank canonical write.
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

function resolveRunTs(explicit) {
  if (explicit) return explicit;
  const pointer = path.join(REFRESH_ROOT, 'latest', '_run_ts.txt');
  if (fs.existsSync(pointer)) {
    return fs.readFileSync(pointer, 'utf-8').trim();
  }
  const entries = fs.readdirSync(REFRESH_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'latest')
    .map((e) => e.name)
    .sort();
  if (entries.length === 0) throw new Error('No refresh run directory found. Run build-cohort.js first.');
  return entries[entries.length - 1];
}

function normalizeHtmlForHash(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Strip leading/trailing whitespace inside tags + collapse runs of whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function looksLikePdf(url, contentType) {
  if (contentType && contentType.toLowerCase().includes('application/pdf')) return true;
  if (url && /\.pdf(?:[?#]|$)/i.test(url)) return true;
  return false;
}

function extractEffectiveDate(text) {
  if (!text) return null;
  // Strip tags + decode common entities so anchors like `w.e.f.&nbsp;15/12/2025`
  // become matchable.
  const stripped = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
  // Cap at 400KB — rate pages are small; anything larger is regex-cost wasteful.
  const sample = stripped.length > 400000 ? stripped.slice(0, 400000) : stripped;
  let best = null;
  const re = new RegExp(COMBINED_RE.source, 'gi');
  let m;
  while ((m = re.exec(sample)) !== null) {
    const raw = m[1].replace(/\s+/g, ' ').trim();
    const iso = normalizeDateString(raw);
    if (iso && (!best || iso > best.iso)) best = { raw, iso };
  }
  return best;
}

function normalizeDateString(raw) {
  // ISO
  let m = raw.match(/^(20[2-3][0-9])-([0-1][0-9])-([0-3][0-9])$/);
  if (m) return raw;
  // dd-MMM-yyyy / dd MMM yyyy / dd.MMM.yyyy (with potential whitespace around separators)
  m = raw.match(/^([0-9]{1,2})(?:st|nd|rd|th)?\s*[\s\.\-\/]\s*([A-Za-z]{3,9})\s*[\s\.\-\/]\s*([0-9]{2,4})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = MONTH_NAMES[m[2].toLowerCase()];
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (mon && day >= 1 && day <= 31 && year >= 2020 && year <= 2099) {
      return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  // dd-mm-yyyy / dd/mm/yyyy / dd.mm.yyyy
  m = raw.match(/^([0-9]{1,2})(?:st|nd|rd|th)?\s*[\s\.\-\/]\s*([0-9]{1,2})\s*[\s\.\-\/]\s*([0-9]{2,4})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31 && year >= 2020 && year <= 2099) {
      return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

function looksLikeScaffolding(html, normalizedLength) {
  // Heuristic: small normalized body + no rate-like number pattern → likely
  // JS-rendered scaffolding (React/Angular root, AEM shell).
  if (normalizedLength > 5000) return false;
  if (!html) return true;
  const hasPercent = /\b[0-9]{1,2}\.[0-9]{1,2}\s*%/.test(html);
  if (hasPercent) return false;
  const hasReactRoot = /<div\s+[^>]*id\s*=\s*["']?(root|app|__next|app-root)["']?/i.test(html);
  if (hasReactRoot) return true;
  return normalizedLength < 1500;
}

async function fetchUrl(url, signal) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
  });
  const headers = {
    status: res.status,
    contentType: res.headers.get('content-type'),
    lastModified: res.headers.get('last-modified'),
    etag: res.headers.get('etag'),
    contentLength: res.headers.get('content-length'),
    finalUrl: res.url,
  };
  if (!res.ok) {
    return { ok: false, headers, error: `http_${res.status}` };
  }
  if (looksLikePdf(url, headers.contentType)) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, headers, bodyBuffer: buf, isPdf: true };
  }
  // Cap text body at 4MB — bank rate pages are tiny; anything larger is a red flag.
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) {
    return { ok: false, headers, error: 'body_too_large' };
  }
  const body = buf.toString('utf-8');
  return { ok: true, headers, body, isPdf: false };
}

async function probe(item) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetchUrl(item.source_url, ac.signal);
    if (!r.ok) return { error: r.error, headers: r.headers };
    if (r.isPdf) {
      const pdfHash = sha256(r.bodyBuffer);
      const urlBasename = item.source_url.split('?')[0].split('#')[0].split('/').pop() || '';
      const filenameDate = extractDateFromFilename(urlBasename);
      return {
        kind: 'pdf',
        headers: r.headers,
        pdf_hash: pdfHash,
        pdf_byte_length: r.bodyBuffer.length,
        body_buffer: r.bodyBuffer,
        filename_date_iso: filenameDate,
        effective_date: filenameDate ? { raw: urlBasename, iso: filenameDate } : null,
      };
    }
    const normalized = normalizeHtmlForHash(r.body);
    const contentHash = sha256(normalized);
    const effectiveDate = extractEffectiveDate(r.body);
    return {
      kind: 'html',
      headers: r.headers,
      normalized_length: normalized.length,
      raw_length: r.body.length,
      content_hash: contentHash,
      effective_date: effectiveDate,
      scaffolding: looksLikeScaffolding(r.body, normalized.length),
      body_text: r.body,
    };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout' : `fetch_error:${err.code || err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const PERSIST_STATUSES = new Set(['likely_changed', 'signals_missing', 'needs_playwright']);

function persistBody(runDir, bankCode, variant, probeResult, sourceUrl) {
  if (!probeResult || probeResult.error) return null;
  const dir = path.join(runDir, 'fetched');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${bankCode}__${variant}`;
  const isPdf = probeResult.kind === 'pdf';
  const target = path.join(dir, `${base}.${isPdf ? 'pdf' : 'html'}`);
  // safe-write-exempt: HTTP body cache under runs/<ts>/fetched/; raw upstream bytes, not a canonical per-bank artifact.
  fs.writeFileSync(target, isPdf ? probeResult.body_buffer : probeResult.body_text);
  captureSnapshot(bankCode, variant, probeResult, sourceUrl, isPdf);
  return path.relative(REPO_ROOT, target);
}

// Durable, content-addressed snapshot of the fetched source (Sprint 008 Phase 1).
// Wrapped so a snapshot-store failure can never break the refresh pipeline.
function captureSnapshot(bankCode, variant, probeResult, sourceUrl, isPdf) {
  try {
    const h = probeResult.headers || {};
    snapshotStore.putSnapshot({
      bankCode,
      variant,
      sourceUrl: sourceUrl || h.finalUrl || null,
      contentKind: isPdf ? 'pdf' : 'html',
      bytes: isPdf ? probeResult.body_buffer : probeResult.body_text,
      headers: { status: h.status, etag: h.etag, last_modified: h.lastModified },
      scrapedAt: new Date().toISOString(),
      capturedBy: 'detect-changes',
    });
  } catch (err) {
    if (process.env.DEBUG_SNAPSHOT) console.error(`snapshot capture failed for ${bankCode}/${variant}: ${err.message}`);
  }
}

function extractDateFromFilename(name) {
  // Try yyyy-mm-dd or yyyy_mm_dd
  let m = name.match(/(20[2-3][0-9])[\-_\.]?([0-1][0-9])[\-_\.]?([0-3][0-9])/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  // Try dd-mm-yyyy
  m = name.match(/([0-3][0-9])[\-_\.]([0-1][0-9])[\-_\.](20[2-3][0-9])/);
  if (m) {
    return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return null;
}

function classify(probeResult, prior, scraperType) {
  if (!probeResult) return { status: 'unreachable', reason: 'no_probe' };
  if (probeResult.error) return { status: 'unreachable', reason: probeResult.error };

  const isFirstSighting = !prior;

  if (probeResult.kind === 'pdf') {
    if (isFirstSighting) return { status: 'signals_missing', reason: 'no_prior_signal' };
    if (prior.pdf_hash && prior.pdf_hash === probeResult.pdf_hash) {
      return { status: 'unchanged', reason: 'pdf_hash_match' };
    }
    return { status: 'likely_changed', reason: 'pdf_hash_differs' };
  }

  // HTML
  if (probeResult.scaffolding && (scraperType === 'html_js' || scraperType === 'mixed')) {
    return { status: 'needs_playwright', reason: 'static_body_scaffolding_only' };
  }

  if (isFirstSighting) {
    return { status: 'signals_missing', reason: 'no_prior_signal' };
  }

  // Effective-date wins if both sides have one.
  const storedED = prior.stored_effective_date || null;
  const fetchedED = probeResult.effective_date ? probeResult.effective_date.iso : null;
  if (storedED && fetchedED) {
    if (storedED === fetchedED) {
      // Even if hash differs (CMS noise), trust the effective date.
      return { status: 'unchanged', reason: 'effective_date_match' };
    }
    if (fetchedED > storedED) {
      return { status: 'likely_changed', reason: 'effective_date_newer' };
    }
    // Fetched date is older than stored — probably we have a newer scrape and
    // the page hasn't refreshed yet; treat as unchanged.
    return { status: 'unchanged', reason: 'fetched_effective_date_older' };
  }

  // Fall back to content hash.
  if (prior.content_hash && prior.content_hash === probeResult.content_hash) {
    return { status: 'unchanged', reason: 'content_hash_match' };
  }
  if (prior.content_hash) {
    return { status: 'likely_changed', reason: 'content_hash_differs' };
  }
  return { status: 'signals_missing', reason: 'no_prior_signal' };
}

async function runWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function pump() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, pump);
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const runTs = resolveRunTs(args.runTs);
  const runDir = path.join(REFRESH_ROOT, runTs);
  const cohortPath = path.join(runDir, 'cohort.json');
  const cohort = readJsonSafe(cohortPath);
  if (!cohort) throw new Error(`Missing cohort at ${cohortPath}`);

  const priorSignals = readJsonSafe(SIGNALS_CACHE_PATH) || {};

  // Flatten (bank, variant) pairs.
  const pairs = [];
  for (const b of cohort.banks) {
    if (args.slug && b.bank_code !== args.slug) continue;
    for (const v of b.variants) {
      pairs.push({
        bank_code: b.bank_code,
        bank_name: b.bank_name,
        bank_type: b.bank_type,
        scraper_type: b.scraper_type,
        variant: v.variant,
        source_url: v.source_url,
        stored_effective_date: v.stored_effective_date,
        stored_scraped_at: v.stored_scraped_at,
      });
    }
  }

  const fetchable = pairs.filter((p) => p.source_url);
  const noUrl = pairs.filter((p) => !p.source_url);

  console.log(`detect-changes: run_ts=${runTs}`);
  console.log(`  pairs=${pairs.length}  fetchable=${fetchable.length}  no_source_url=${noUrl.length}`);
  console.log(`  concurrency=${args.concurrency}  dry_run=${args.dryRun}`);

  const startedAt = new Date().toISOString();
  let probed = 0;

  const probeResults = await runWithConcurrency(
    fetchable,
    args.concurrency,
    async (pair) => {
      if (args.dryRun) return { skipped: true, reason: 'dry_run' };
      return probe(pair);
    },
    (done, total) => {
      probed = done;
      if (done % 25 === 0 || done === total) {
        process.stdout.write(`  progress: ${done}/${total}\n`);
      }
    },
  );

  const records = [];
  const newSignalsCache = { ...priorSignals };

  for (let i = 0; i < fetchable.length; i++) {
    const pair = fetchable[i];
    const probeResult = probeResults[i];
    const signalKey = `${pair.bank_code}::${pair.variant}`;
    const prior = priorSignals[signalKey] || null;

    // Merge stored_effective_date from cohort into the "prior" view so first-run
    // classification can still leverage it (signals cache may be empty on first run).
    const priorForClassify = prior
      ? { ...prior }
      : pair.stored_effective_date
        ? { stored_effective_date: pair.stored_effective_date }
        : null;

    const klass = classify(probeResult, priorForClassify, pair.scraper_type);

    const record = {
      bank_code: pair.bank_code,
      bank_name: pair.bank_name,
      bank_type: pair.bank_type,
      variant: pair.variant,
      source_url: pair.source_url,
      scraper_type: pair.scraper_type,
      stored_effective_date: pair.stored_effective_date,
      status: klass.status,
      reason: klass.reason,
    };
    if (probeResult && !probeResult.error) {
      record.kind = probeResult.kind;
      record.fetched_effective_date = probeResult.effective_date ? probeResult.effective_date.iso : null;
      record.fetched_effective_date_raw = probeResult.effective_date ? probeResult.effective_date.raw : null;
      if (probeResult.kind === 'html') {
        record.content_hash = probeResult.content_hash;
        record.normalized_length = probeResult.normalized_length;
        record.scaffolding = probeResult.scaffolding;
      } else {
        record.pdf_hash = probeResult.pdf_hash;
        record.pdf_byte_length = probeResult.pdf_byte_length;
      }
      record.headers = probeResult.headers;

      // Persist body only for statuses Phase 3 will act on — `unchanged` and
      // any error case discard the body since no extraction will follow.
      if (PERSIST_STATUSES.has(klass.status)) {
        record.body_cache_path = persistBody(runDir, pair.bank_code, pair.variant, probeResult, pair.source_url);
      }

      // Update cache.
      newSignalsCache[signalKey] = {
        bank_code: pair.bank_code,
        variant: pair.variant,
        source_url: pair.source_url,
        last_checked_at: startedAt,
        kind: probeResult.kind,
        content_hash: probeResult.content_hash || null,
        pdf_hash: probeResult.pdf_hash || null,
        last_modified: probeResult.headers && probeResult.headers.lastModified,
        etag: probeResult.headers && probeResult.headers.etag,
        stored_effective_date: pair.stored_effective_date,
        fetched_effective_date:
          probeResult.effective_date ? probeResult.effective_date.iso : null,
      };
    }
    records.push(record);
  }

  // Synthesize records for pairs without a source URL.
  for (const pair of noUrl) {
    records.push({
      bank_code: pair.bank_code,
      bank_name: pair.bank_name,
      bank_type: pair.bank_type,
      variant: pair.variant,
      source_url: null,
      scraper_type: pair.scraper_type,
      stored_effective_date: pair.stored_effective_date,
      status: 'unreachable',
      reason: 'no_source_url',
    });
  }

  records.sort((a, b) =>
    a.bank_code.localeCompare(b.bank_code) || a.variant.localeCompare(b.variant),
  );

  const summary = summarizeStatuses(records);

  const out = {
    generated_at: new Date().toISOString(),
    run_ts: runTs,
    cohort_path: path.relative(REPO_ROOT, cohortPath),
    counts: {
      total: records.length,
      ...summary,
    },
    records,
  };

  const outPath = path.join(runDir, '_change_signals.json');
  writeJsonAtomic(outPath, out);
  if (!args.dryRun) {
    writeJsonAtomic(SIGNALS_CACHE_PATH, newSignalsCache);
  }

  console.log(`detect-changes: wrote ${outPath}`);
  console.log(`  status counts: ${JSON.stringify(summary)}`);
  if (!args.dryRun) console.log(`  signals cache: ${SIGNALS_CACHE_PATH}`);
}

function summarizeStatuses(records) {
  const counts = {};
  for (const r of records) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  return counts;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('detect-changes: FAILED', err);
    process.exit(1);
  });
}

module.exports = {
  normalizeHtmlForHash,
  extractEffectiveDate,
  normalizeDateString,
  classify,
  looksLikeScaffolding,
  extractDateFromFilename,
};

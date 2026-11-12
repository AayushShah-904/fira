'use strict';
//
// Source-snapshot substrate (Sprint 008, Phase 1 — keystone).
//
// A durable, content-addressed store of the raw bytes each rate extraction
// came from, so any slab in output/latest is re-verifiable offline (no live
// re-fetch). Consumed by the Phase 2 sampling audit, the Phase 4 cross-check,
// and the Phase 6 golden backfill. See design/snapshot-substrate.md + ADR-015.
//
//   output/snapshots/
//     blobs/<aa>/<sha256>.<ext>      raw bytes, content-addressed (gitignored)
//     index/<bank>__<variant>.json   append-only manifest, newest last (tracked)
//     _index.json                    derived roll-up for enumeration (tracked)
//
// safe-write-exempt rationale: this is raw upstream bytes + a derived ledger,
// NOT a per-bank canonical artifact (same reasoning as detect-changes.js#persistBody).
// It uses its own atomic temp-rename writer.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Overridable for tests (never write the real store from a test run).
function rootDir() {
  return process.env.SNAPSHOT_ROOT || path.join(REPO_ROOT, 'output', 'snapshots');
}
function blobsDir() { return path.join(rootDir(), 'blobs'); }
function indexDir() { return path.join(rootDir(), 'index'); }
function rollupPath() { return path.join(rootDir(), '_index.json'); }

const CONTENT_KINDS = new Set(['html', 'pdf', 'image']);
const EXT_BY_KIND = { html: 'html', pdf: 'pdf', image: 'bin' };

function variantKey(bankCode, variant) { return `${bankCode}__${variant || 'regular'}`; }
function manifestPathFor(bankCode, variant) { return path.join(indexDir(), `${variantKey(bankCode, variant)}.json`); }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function writeAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  // safe-write-exempt: snapshot store under output/snapshots/ — raw upstream bytes + derived ledger, not a per-bank canonical artifact (ADR-015).
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function deriveExt(contentKind, sourceUrl, explicitExt) {
  if (explicitExt) return String(explicitExt).replace(/^\./, '');
  if (contentKind === 'image' && sourceUrl) {
    const m = String(sourceUrl).toLowerCase().match(/\.(jpe?g|png|webp|gif|bmp|tiff?)(?:\?|#|$)/);
    if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  }
  return EXT_BY_KIND[contentKind] || 'bin';
}

function blobRelPath(sha, ext) { return path.join('blobs', sha.slice(0, 2), `${sha}.${ext}`); }

/**
 * Persist one source snapshot. Idempotent: a re-capture with the same bytes
 * AND the same scraped_at as the newest manifest entry is a no-op append.
 */
function putSnapshot(opts = {}) {
  const {
    bankCode, variant, sourceUrl, contentKind, bytes, headers = {},
    scrapedAt = null, extractionMethod = null, capturedBy = 'unknown',
    postHoc = false, ext,
  } = opts;
  if (!bankCode) throw new Error('putSnapshot: bankCode required');
  if (!CONTENT_KINDS.has(contentKind)) throw new Error(`putSnapshot: contentKind must be one of ${[...CONTENT_KINDS].join('/')}`);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes == null ? '' : String(bytes), 'utf-8');
  if (buf.length === 0) throw new Error('putSnapshot: empty bytes');

  const sha = sha256(buf);
  const realExt = deriveExt(contentKind, sourceUrl, ext);
  const blobRel = blobRelPath(sha, realExt);
  const blobAbs = path.join(rootDir(), blobRel);

  // Content-addressed write (dedup): only write if the blob is not already there.
  let blobWrote = false;
  if (!fs.existsSync(blobAbs)) { writeAtomic(blobAbs, buf); blobWrote = true; }

  const entry = {
    scraped_at: scrapedAt,
    source_url: sourceUrl || null,
    content_kind: contentKind,
    blob_sha256: sha,
    blob_path: blobRel.split(path.sep).join('/'),
    byte_length: buf.length,
    http: {
      status: headers.status != null ? headers.status : null,
      etag: headers.etag || null,
      last_modified: headers.last_modified || headers['last-modified'] || null,
    },
    extraction_method: extractionMethod,
    captured_by: capturedBy,
    post_hoc: !!postHoc,
    captured_at: new Date().toISOString(),
  };

  const mPath = manifestPathFor(bankCode, variant);
  const manifest = readJsonSafe(mPath) || [];
  const last = manifest[manifest.length - 1];
  let appended = false;
  if (last && last.blob_sha256 === sha && last.scraped_at === entry.scraped_at) {
    // identical capture already recorded — idempotent no-op
  } else {
    manifest.push(entry);
    writeAtomic(mPath, JSON.stringify(manifest, null, 2));
    appended = true;
  }

  return { sha256: sha, blobPath: blobRel, blobAbsPath: blobAbs, manifestPath: mPath, wrote: blobWrote, appended, deduped: !blobWrote };
}

function withAbs(entry) {
  if (!entry) return null;
  return { ...entry, blobAbsPath: path.join(rootDir(), entry.blob_path.split('/').join(path.sep)) };
}

function getLatestSnapshot(bankCode, variant) {
  const manifest = readJsonSafe(manifestPathFor(bankCode, variant));
  if (!Array.isArray(manifest) || manifest.length === 0) return null;
  return withAbs(manifest[manifest.length - 1]);
}

function getSnapshotAtScrapedAt(bankCode, variant, scrapedAt) {
  const manifest = readJsonSafe(manifestPathFor(bankCode, variant));
  if (!Array.isArray(manifest) || manifest.length === 0) return null;
  const exact = manifest.filter((e) => e.scraped_at === scrapedAt);
  if (exact.length) return withAbs(exact[exact.length - 1]);
  if (!scrapedAt) return withAbs(manifest[manifest.length - 1]);
  // closest with scraped_at <= target
  const target = Date.parse(scrapedAt);
  let best = null;
  for (const e of manifest) {
    const t = Date.parse(e.scraped_at);
    if (!Number.isNaN(t) && t <= target && (!best || t > Date.parse(best.scraped_at))) best = e;
  }
  return withAbs(best);
}

function readBlob(entry) {
  if (!entry) return null;
  const abs = entry.blobAbsPath || path.join(rootDir(), entry.blob_path.split('/').join(path.sep));
  return fs.readFileSync(abs);
}

// Returns LLM-ready text for html (stripped) or best-effort utf-8 for others.
function readTextForLlm(entry) {
  if (!entry) return null;
  const buf = readBlob(entry);
  if (entry.content_kind === 'html') {
    // lazy require — verify-with-llm has a require.main guard, safe to import
    const { stripHtmlForLlm } = require('../../scripts/refresh/verify-with-llm.js');
    return stripHtmlForLlm(buf.toString('utf-8'));
  }
  return buf.toString('utf-8');
}

function listManifestFiles() {
  if (!fs.existsSync(indexDir())) return [];
  return fs.readdirSync(indexDir()).filter((f) => f.endsWith('.json'));
}

function listVariants() {
  return listManifestFiles().map((f) => {
    const key = f.slice(0, -'.json'.length);
    const manifest = readJsonSafe(path.join(indexDir(), f)) || [];
    const latest = manifest[manifest.length - 1] || null;
    return { key, count: manifest.length, latest };
  });
}

function rebuildIndex() {
  const variants = listVariants();
  const rollup = { generated_at: new Date().toISOString(), variants: {} };
  const referenced = new Set();
  for (const v of variants) {
    rollup.variants[v.key] = { count: v.count, latest_sha: v.latest && v.latest.blob_sha256, latest_scraped_at: v.latest && v.latest.scraped_at };
    const manifest = readJsonSafe(path.join(indexDir(), `${v.key}.json`)) || [];
    for (const e of manifest) referenced.add(e.blob_sha256);
  }
  writeAtomic(rollupPath(), JSON.stringify(rollup, null, 2));
  // report orphan blobs (present on disk but unreferenced)
  const orphans = [];
  if (fs.existsSync(blobsDir())) {
    for (const sub of fs.readdirSync(blobsDir())) {
      const subDir = path.join(blobsDir(), sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const f of fs.readdirSync(subDir)) {
        const sha = f.split('.')[0];
        if (!referenced.has(sha)) orphans.push(path.join('blobs', sub, f));
      }
    }
  }
  return { variants: variants.length, blobs: referenced.size, orphans };
}

// Keep newest keepN manifest entries per variant (+ pinned shas), GC blobs no
// longer referenced by any manifest.
function trim(keepN = 3, { pinned = new Set() } = {}) {
  const pinnedSet = pinned instanceof Set ? pinned : new Set(pinned);
  const referenced = new Set(pinnedSet);
  let trimmedEntries = 0;
  for (const f of listManifestFiles()) {
    const mPath = path.join(indexDir(), f);
    const manifest = readJsonSafe(mPath) || [];
    let kept = manifest;
    if (manifest.length > keepN) {
      const pinnedEntries = manifest.filter((e) => pinnedSet.has(e.blob_sha256));
      const tail = manifest.slice(-keepN);
      const merged = [...pinnedEntries.filter((e) => !tail.includes(e)), ...tail];
      kept = merged;
      trimmedEntries += manifest.length - kept.length;
      writeAtomic(mPath, JSON.stringify(kept, null, 2));
    }
    for (const e of kept) referenced.add(e.blob_sha256);
  }
  // GC unreferenced blobs
  let gcBlobs = 0;
  if (fs.existsSync(blobsDir())) {
    for (const sub of fs.readdirSync(blobsDir())) {
      const subDir = path.join(blobsDir(), sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      for (const file of fs.readdirSync(subDir)) {
        const sha = file.split('.')[0];
        if (!referenced.has(sha)) { fs.unlinkSync(path.join(subDir, file)); gcBlobs++; }
      }
    }
  }
  rebuildIndex();
  return { trimmedEntries, gcBlobs };
}

module.exports = {
  CONTENT_KINDS,
  putSnapshot,
  getLatestSnapshot,
  getSnapshotAtScrapedAt,
  readBlob,
  readTextForLlm,
  listVariants,
  rebuildIndex,
  trim,
  // exposed for tests / tooling
  _paths: { rootDir, blobsDir, indexDir, rollupPath, manifestPathFor, blobRelPath },
};

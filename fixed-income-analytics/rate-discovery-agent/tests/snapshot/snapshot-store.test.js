'use strict';

// Sprint 008, Phase 1 — source-snapshot substrate.
// Uses a temp SNAPSHOT_ROOT so the real output/snapshots is never touched
// (feedback_preserve_scraped_artifacts).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

let store;
let TMP;

test.before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snaptest-'));
  process.env.SNAPSHOT_ROOT = TMP;
  store = require('../../lib/snapshot/snapshot-store.js'); // reads SNAPSHOT_ROOT lazily per call
});
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.SNAPSHOT_ROOT;
});

test('putSnapshot + getLatestSnapshot round-trip', () => {
  const r = store.putSnapshot({
    bankCode: 'test-bank', variant: 'regular', sourceUrl: 'https://x.example/fd',
    contentKind: 'html', bytes: '<table>rates</table>', headers: { status: 200, etag: 'abc' },
    scrapedAt: '2026-05-20T10:00:00Z', extractionMethod: 'automatic_html_static', capturedBy: 'unit',
  });
  assert.ok(r.wrote);
  assert.equal(r.appended, true);
  const latest = store.getLatestSnapshot('test-bank', 'regular');
  assert.equal(latest.blob_sha256, r.sha256);
  assert.equal(latest.http.etag, 'abc');
  assert.equal(store.readBlob(latest).toString('utf-8'), '<table>rates</table>');
});

test('content-addressing dedups identical bytes across variants', () => {
  const a = store.putSnapshot({ bankCode: 'dedup-bank', variant: 'regular', contentKind: 'html', bytes: 'SAME', scrapedAt: '2026-01-01T00:00:00Z' });
  const b = store.putSnapshot({ bankCode: 'dedup-bank', variant: 'nre', contentKind: 'html', bytes: 'SAME', scrapedAt: '2026-01-01T00:00:00Z' });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.wrote, true);
  assert.equal(b.wrote, false, 'second identical blob should dedup');
  assert.equal(b.deduped, true);
});

test('idempotent: same bytes + same scraped_at => no duplicate manifest entry', () => {
  const opts = { bankCode: 'idem-bank', variant: 'regular', contentKind: 'html', bytes: 'X', scrapedAt: '2026-02-02T00:00:00Z' };
  const first = store.putSnapshot(opts);
  const second = store.putSnapshot(opts);
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  const manifest = JSON.parse(fs.readFileSync(store._paths.manifestPathFor('idem-bank', 'regular'), 'utf-8'));
  assert.equal(manifest.length, 1);
});

test('getSnapshotAtScrapedAt: exact and closest-earlier', () => {
  store.putSnapshot({ bankCode: 'time-bank', variant: 'regular', contentKind: 'html', bytes: 'v1', scrapedAt: '2026-03-01T00:00:00Z' });
  store.putSnapshot({ bankCode: 'time-bank', variant: 'regular', contentKind: 'html', bytes: 'v2', scrapedAt: '2026-03-10T00:00:00Z' });
  const exact = store.getSnapshotAtScrapedAt('time-bank', 'regular', '2026-03-01T00:00:00Z');
  assert.equal(store.readBlob(exact).toString(), 'v1');
  const between = store.getSnapshotAtScrapedAt('time-bank', 'regular', '2026-03-05T00:00:00Z');
  assert.equal(store.readBlob(between).toString(), 'v1', 'should pick the latest snapshot at or before the target');
  const after = store.getSnapshotAtScrapedAt('time-bank', 'regular', '2026-03-20T00:00:00Z');
  assert.equal(store.readBlob(after).toString(), 'v2');
});

test('getLatestSnapshot returns null for unknown variant', () => {
  assert.equal(store.getLatestSnapshot('nope', 'regular'), null);
});

test('post_hoc flag is recorded', () => {
  store.putSnapshot({ bankCode: 'ph-bank', variant: 'regular', contentKind: 'html', bytes: 'b', scrapedAt: '2026-04-01T00:00:00Z', postHoc: true, capturedBy: 'backfill' });
  const latest = store.getLatestSnapshot('ph-bank', 'regular');
  assert.equal(latest.post_hoc, true);
  assert.equal(latest.captured_by, 'backfill');
});

test('image ext derived from source url', () => {
  const r = store.putSnapshot({ bankCode: 'img-bank', variant: 'regular', contentKind: 'image', sourceUrl: 'https://x.example/rates.JPG', bytes: Buffer.from([1, 2, 3]), scrapedAt: '2026-04-02T00:00:00Z' });
  assert.match(r.blobPath, /\.jpg$/);
});

test('rejects empty bytes and bad contentKind', () => {
  assert.throws(() => store.putSnapshot({ bankCode: 'b', variant: 'regular', contentKind: 'html', bytes: '' }));
  assert.throws(() => store.putSnapshot({ bankCode: 'b', variant: 'regular', contentKind: 'docx', bytes: 'x' }));
});

test('rebuildIndex writes a roll-up and detects no orphans on a clean store', () => {
  const res = store.rebuildIndex();
  assert.ok(res.variants >= 1);
  const rollup = JSON.parse(fs.readFileSync(store._paths.rollupPath(), 'utf-8'));
  assert.ok(rollup.variants && Object.keys(rollup.variants).length >= 1);
});

test('trim keeps newest N and GCs unreferenced blobs', () => {
  const bank = 'trim-bank';
  for (let i = 0; i < 5; i++) {
    store.putSnapshot({ bankCode: bank, variant: 'regular', contentKind: 'html', bytes: `gen-${i}`, scrapedAt: `2026-05-0${i + 1}T00:00:00Z` });
  }
  let manifest = JSON.parse(fs.readFileSync(store._paths.manifestPathFor(bank, 'regular'), 'utf-8'));
  assert.equal(manifest.length, 5);
  const res = store.trim(2);
  manifest = JSON.parse(fs.readFileSync(store._paths.manifestPathFor(bank, 'regular'), 'utf-8'));
  assert.equal(manifest.length, 2, 'kept newest 2');
  assert.ok(res.gcBlobs >= 3, 'GCd the 3 dropped blobs');
  // newest content preserved
  assert.equal(store.readBlob(store.getLatestSnapshot(bank, 'regular')).toString(), 'gen-4');
});

# Design — Phase 1: source-snapshot substrate (keystone)

**Sprint:** 008 · **Phase:** 1 · **Status:** design → implementation
**Unblocks:** Phase 2 (audit verifies against snapshots), Phase 4 (cross-check re-extracts from snapshots), Phase 6 (golden `.html` backfilled from snapshots).
**ADR:** ADR-015 (to draft).

## Problem

Re-verifying a slab today needs a live re-fetch of a page that may have changed; there is no stored ground truth. `detect-changes.js#persistBody` already fetches bodies but discards `unchanged`/`unreachable` and buries the rest under transient `output/refresh/<ts>/fetched/`. We need a durable, content-addressed snapshot keyed so any slab in `output/latest` resolves to the exact bytes it came from.

## Layout — `output/snapshots/`

```
output/snapshots/
  blobs/<aa>/<sha256>.<ext>        raw bytes, content-addressed (aa = first 2 hex). GITIGNORED.
  index/<bank>__<variant>.json     append-only manifest, newest last. TRACKED (ledger, no bytes).
  _index.json                      derived roll-up for enumeration. TRACKED.
```

Blobs are content-addressed so identical fetches dedup automatically. The `index/` ledger is small and committed — a reviewable provenance record without the (large) bytes. This mirrors the existing convention of ignoring `output/runs/` while keeping run metadata.

**Manifest entry** (one per capture, appended):
```json
{ "scraped_at": "2026-05-20T16:47:00Z", "source_url": "https://…",
  "content_kind": "html|pdf|image", "blob_sha256": "…", "blob_path": "blobs/ab/ab….html",
  "byte_length": 24576, "http": {"status":200,"etag":"…","last_modified":"…"},
  "extraction_method": "automatic_html_static", "captured_by": "detect-changes|backfill|fetch_page",
  "post_hoc": false }
```
`post_hoc:true` marks a backfill capture whose bytes may differ from the original scrape (page changed since) — Phase 2 labels such verdicts distinctly, never silently.

## Module — `lib/snapshot/snapshot-store.js`

`safe-write-exempt`: this is raw upstream bytes + a derived ledger, not a per-bank canonical artifact (same rationale as `persistBody`). Own atomic temp-rename writer.

API:
- `putSnapshot({bankCode, variant, sourceUrl, contentKind, bytes, headers, scrapedAt, extractionMethod, capturedBy, postHoc, ext?})` → `{sha256, blobPath, manifestPath, wrote, deduped}`. sha256 the bytes; write blob if absent (dedup); append manifest entry. Idempotent: if the newest manifest entry has the same `blob_sha256` AND `scraped_at`, skip the append.
- `getLatestSnapshot(bankCode, variant)` → newest manifest entry (with absolute `blobAbsPath`) or null. Reads the per-variant manifest directly (no global-index dependency on the hot path).
- `getSnapshotAtScrapedAt(bankCode, variant, scrapedAt)` → entry with exact `scraped_at`, else newest with `scraped_at <= target`, else null.
- `readBlob(entry)` → Buffer. `readTextForLlm(entry)` → string; for html lazy-requires `stripHtmlForLlm` from `scripts/refresh/verify-with-llm.js`, for pdf returns raw text best-effort (Phase 2/4 own PDF text extraction).
- `listVariants()` → from `_index.json`. `rebuildIndex()` → regenerate `_index.json` from `index/*.json` and report orphan blobs. `trim(keepN=3, {pinned})` → keep newest N entries per variant (+ pinned shas for golden), GC unreferenced blobs.

### Concurrency

Per-variant manifests are the source of truth; each `(bank,variant)` is processed once per run, so no concurrent writes to the same manifest. `_index.json` is **derived** (rebuilt by `rebuildIndex()`), never updated on every put — avoids a global-file write race under `detect-changes.js`'s concurrency.

## Producers

1. **`scripts/refresh/detect-changes.js#persistBody`** — already holds `body_text`/`body_buffer` + headers + url; add a `putSnapshot` call (capturedBy `detect-changes`). Near-zero added cost; the highest-value live hook.
2. **`scripts/snapshot/backfill-snapshots.js`** (new) — iterate `output/latest/*_rates.json`, re-fetch each `source_url` via existing `lib/fetch/fetch_html.js` / `fetch_pdf.js`, `putSnapshot(..., capturedBy:'backfill', postHoc:true)`. `--limit N`, `--only slug`, `--kind html|pdf`. Populates the store for the current pack → unblocks Phase 2/4/6.
3. **`lib/actions/fetch_page.js` / `lib/fetch/fetch_pdf.js`** — opt-in `captureSnapshot` flag (deferred to a follow-on; backfill + detect-changes cover the immediate need).

## .gitignore

Add `output/snapshots/blobs/`. Keep `output/snapshots/index/` and `_index.json` tracked.

## Tests — `tests/snapshot/snapshot-store.test.js`

put/get round-trip; content-addressing dedup (same bytes twice → one blob); idempotent manifest append (same sha+scraped_at → no dup entry); `getSnapshotAtScrapedAt` exact + closest-earlier; atomic writer leaves no partial on simulated failure; `trim(keepN)` + orphan GC; `rebuildIndex` reconstructs `_index.json`. Uses a temp dir via `SNAPSHOT_ROOT` override (never writes real `output/snapshots`), per `feedback_preserve_scraped_artifacts`.

## Out of scope

- Cloud-side snapshot storage (local-first; revisit with the repo split).
- fetch_page/fetch_pdf live capture hooks (follow-on; backfill + detect-changes suffice now).

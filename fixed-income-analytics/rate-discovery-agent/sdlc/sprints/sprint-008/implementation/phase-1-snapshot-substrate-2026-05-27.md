# Implementation — Phase 1: source-snapshot substrate (2026-05-27)

Design: `../design/snapshot-substrate.md`. ADR: ADR-015. Status: **code complete; full backfill run is a separate (background) data step.**

## What shipped

- **`lib/snapshot/snapshot-store.js`** (new) — content-addressed store, `safe-write-exempt` with its own atomic temp-rename writer (raw bytes + derived ledger, not a per-bank canonical artifact). API: `putSnapshot`, `getLatestSnapshot`, `getSnapshotAtScrapedAt`, `readBlob`, `readTextForLlm` (lazy-requires `stripHtmlForLlm` from `verify-with-llm.js`), `listVariants`, `rebuildIndex` (+ orphan report), `trim(keepN, {pinned})` (+ blob GC). Root overridable via `SNAPSHOT_ROOT` for tests.
- **`scripts/refresh/detect-changes.js`** — `persistBody` now also calls `captureSnapshot` (wrapped in try/catch so a store failure can never break the refresh pipeline). Captures on `PERSIST_STATUSES` (likely_changed / signals_missing / needs_playwright) — exactly when content is new/changed. `scraped_at` = capture time; headers carried from the probe.
- **`scripts/snapshot/backfill-snapshots.js`** (new) — re-fetches each `output/latest/*_rates.json` `source_url` (lightweight built-in `fetch`, concurrency-limited) and snapshots it, tagged `post_hoc:true` + `captured_by:'backfill'`, `scraped_at` from the rate file. Flags `--limit/--only/--concurrency/--force/--dry-run`; skips already-snapshotted variants unless `--force`; `rebuildIndex()` at the end.
- **`.gitignore`** — ignore `output/snapshots/blobs/` (large); keep `index/` + `_index.json` tracked as a provenance ledger.

## Layout

```
output/snapshots/
  blobs/<aa>/<sha256>.<ext>     content-addressed bytes (gitignored, dedups identical fetches)
  index/<bank>__<variant>.json  append-only manifest, newest last (tracked)
  _index.json                   derived roll-up (tracked, rebuilt — never raced)
```

`_index.json` is **derived** (rebuilt by `rebuildIndex`), never updated per-put, so `detect-changes`'s concurrency can't race a global file. Per-variant manifests are the source of truth and each `(bank,variant)` is processed once per run.

## Verified

- `node --test tests/snapshot/snapshot-store.test.js` → **10/10** (round-trip, content-addressing dedup, idempotent append, exact + closest-earlier `scraped_at`, post_hoc flag, image ext derivation, empty/bad-kind rejection, rebuildIndex, trim+GC). Uses a temp `SNAPSHOT_ROOT` — never touches real `output/snapshots` (`feedback_preserve_scraped_artifacts`).
- `node scripts/check-write-discipline.js` → clean (151 files).
- `detect-changes.js` + `backfill-snapshots.js` load without side effects.
- Live `backfill --limit 3` → 3 captured, manifest carries `scraped_at` (from the rate file), `source_url`, `blob_sha256`, `byte_length`, `http.status`; ledger written; blobs gitignored, index tracked (`git check-ignore` confirmed).

## post_hoc caveat (recorded, not hidden)

A backfill fetch happens after extraction; if the page changed since, the bytes differ from the original scrape. Such captures carry `post_hoc:true`. Phase 2 labels post_hoc verdicts distinctly (a CONTRADICT on a post_hoc snapshot may be page-drift, not an extraction bug); Phase 4 treats low agreement on post_hoc as drift. The live `detect-changes` hook captures the real body going forward (not post_hoc).

## Follow-on

- **Full backfill run** (586 variants) is a network-heavy background step (some `.bank.in` TLS / WAF / JS-render failures expected — tallied, not fatal). JS-rendered pages snapshot as scaffolding under the lightweight fetch; the live detect-changes hook (Playwright-backed upstream) captures the rendered body on the next refresh. The committed ledger is populated after that run.
- `lib/actions/fetch_page.js` / `lib/fetch/fetch_pdf.js` opt-in `captureSnapshot` hook — deferred; backfill + detect-changes cover the immediate need.
- ADR-015 to be written documenting the store + retention + gitignore policy.

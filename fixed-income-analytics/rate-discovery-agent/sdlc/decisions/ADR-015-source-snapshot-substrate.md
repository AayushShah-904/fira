# ADR-015: Source-snapshot substrate (content-addressed, local-first)

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Persist a durable, content-addressed snapshot of the raw bytes each rate extraction came from, under `output/snapshots/` — local-regenerable, not tracked (amended; see below). It is `safe-write-exempt` (raw upstream bytes + derived ledger, not a per-bank canonical artifact). |
| Decided by | Samir Joshi (auto-mode authorization, 2026-05-27) |
| Date | 2026-05-27 |
| Sprint | 008 (Phase 1) |
| Related | ADR-012 (write-discipline), Sprint 008 plan, design/snapshot-substrate.md |

## Context

The data-correctness program (Sprint 008) needs to re-verify extracted slabs against the source they came from — for the sampling audit (Phase 2), the systematic cross-check (Phase 4), and the dormant golden gate (Phase 6). Today there is no durable source of truth: `scripts/refresh/detect-changes.js#persistBody` fetches bodies but discards `unchanged`/`unreachable` and keeps the rest only transiently under `output/refresh/<ts>/fetched/`. Re-verifying a slab requires a live re-fetch of a page that may have changed.

## Decision

A content-addressed store keyed so any slab in `output/latest` resolves to the bytes it came from.

```
output/snapshots/
  blobs/<aa>/<sha256>.<ext>     raw bytes (gitignored; identical fetches dedup by hash)
  index/<bank>__<variant>.json  append-only manifest, newest last (local; not tracked — amended)
  _index.json                   derived roll-up for enumeration (tracked)
```

- **Content-addressed blobs** dedup identical fetches and make a snapshot immutable by construction.
- **The whole store is local-regenerable, not tracked** (amended 2026-05-27 — superseded the initial "track the index/ ledger" stance). Tracking the per-variant manifests meant 500+ generated files that churn on every capture and reference local-only (gitignored) blobs — repo noise with little cross-machine value. The store is rebuilt on demand via `scripts/snapshot/backfill-snapshots.js`, like `output/runs/`. The durable, committed artifacts are the golden `.html` companions in `tests/golden-html/` (Phase 6).
- **`_index.json` is derived**, rebuilt by `rebuildIndex()`, never updated per-put — so `detect-changes`'s fetch concurrency cannot race a global file. Per-variant manifests are the source of truth; each `(bank,variant)` is processed once per run.

### Why `safe-write-exempt` and not routed through `lib/safe-write.js`

`safe-write.js` (ADR-012) guards *per-bank canonical artifacts* (`config`, `rates`, `summary`, `registry-file`) — it enforces curated-overwrite protection and `extraction_method` validation. A source snapshot is neither: it is raw upstream bytes plus a derived ledger. This is the same reasoning already applied to `persistBody`'s body cache. The store uses its own atomic temp-rename writer carrying an inline `// safe-write-exempt:` comment, satisfying `check-write-discipline.js`.

### Retention

Keep the newest `N=3` snapshots per variant plus golden-pinned shas (Phase 6); `trim(keepN, {pinned})` GCs unreferenced blobs and rebuilds the index. Local-first; cloud-side storage is deferred (revisit with the agent repo split, `project_agent_repo_split`).

### Producers

1. `detect-changes.js#persistBody` — live capture on changed/missing/needs-playwright statuses (wrapped so a store failure cannot break the pipeline).
2. `scripts/snapshot/backfill-snapshots.js` — initial population from `output/latest`, captures tagged `post_hoc:true` (bytes may post-date the original scrape).
3. (deferred) `fetch_page.js` / `fetch_pdf.js` opt-in capture.

## Consequences

**Positive.** Every slab becomes offline-verifiable; Phase 2/4/6 stop depending on live re-fetches. A committed ledger gives provenance review without bloating the repo. Content-addressing makes refresh diffs cheap (same sha ⇒ unchanged).

**Costs.** Blob storage grows with capture history — bounded by `trim` + content-addressed dedup. The lightweight backfill fetch snapshots JS-rendered pages as scaffolding (marked `post_hoc`); the Playwright-backed `detect-changes` hook supersedes those on the next refresh.

**Neutral.** `post_hoc` captures are explicitly flagged so a CONTRADICT on a stale snapshot is read as page-drift, not an extraction error.

## Verification

`tests/snapshot/snapshot-store.test.js` (10 tests, temp `SNAPSHOT_ROOT`): round-trip, dedup, idempotent append, `scraped_at` resolution, retention+GC, rebuildIndex. `check-write-discipline.js` clean. Live `backfill --limit 3` confirmed the fetch→store→ledger path end-to-end.

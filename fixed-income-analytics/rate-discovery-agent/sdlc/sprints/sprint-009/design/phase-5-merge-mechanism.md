# Phase 5 — Merge mechanism (DESIGN)

**Sprint:** 009
**Phase:** 5 (after Phase 4 split)
**Status:** Design — autonomous-run decisions; flagged highest-risk by operator at sprint open.
**Driver:** Sprint 009 scope item 5.

## Goal

After a split-execution flow:
- Cloud has run `<cohort>-cloud` → per-bank artifacts in cloud's output/runs/<cloud_run_label>/ + blob
- Local has run `<cohort>-local` → per-bank artifacts in local's output/runs/<local_run_label>/

The merger reconciles per-bank artifacts into a single canonical view
(written to `output/latest/`), producing one rates / config / summary
file per bank with provenance attached.

## Decisions (autonomous-run, operator delegated 2026-06-04)

### Conflict rules — restated from operator decision #3 at sprint open

> Merge precedence: richer-set-wins for slab arrays; local-wins for
> `extraction_method` / `source_url` / curated fields.

Per-field rules:

| Field                       | Rule                                                                 |
|----------------------------|----------------------------------------------------------------------|
| `rate_slabs` (array)        | Whichever side has more entries wins. Tiebreak: local.              |
| `extraction_method`         | Local wins. (Operator-curated > agent re-extraction.)               |
| `source_url`                | Local wins.                                                          |
| `effective_date`            | Pick the more recent ISO date. (Newer rate set is presumably truer.) |
| `scraped_at`                | Pick the more recent ISO timestamp.                                  |
| `extraction_confidence`     | Pick the higher of {high, medium, low, none}. Tiebreak: local.       |
| `warnings`                  | Union of both arrays, de-duplicated by string equality.              |
| `bank_code` / `product_type` / `variant` | Identity fields; must match between sides (assertion).      |
| Any other present field     | Local wins (curated path is the safer default).                      |

### What gets merged

- Per-variant rate files: `<bank>_rates.json`, `<bank>_nre_rates.json`, `<bank>_nro_rates.json`, `<bank>_fcnr_rates.json`, `<bank>_gift_rates.json`.
- Bank config: `<bank>_config.json`. Same per-field rules.
- Summary file: `<bank>.summary.json`. **Not merged** — summary is per-run telemetry, not canonical data. The merger writes a NEW summary entry under `output/latest/` that records the merge itself (provenance only); the contributing summary files are preserved in their respective per-run dirs untouched.

### Provenance

Every merged artifact carries:

```json
{
  ...existing fields...,
  "source_runs": [
    { "run_id": "<cloud_run_label>", "source": "cloud", "contributed_fields": ["rate_slabs", "scraped_at"] },
    { "run_id": "<local_run_label>", "source": "local", "contributed_fields": ["extraction_method", "source_url", "warnings"] }
  ]
}
```

`contributed_fields` lists which fields' final values came from that
source. Useful for forensic debugging — operator can answer "where did
this rate come from?" by reading the merged file.

### Cloud-only-bank case

A bank in `<cohort>-cloud.json` (route=cloud) has only a cloud artifact.
Merger emits a copy of the cloud artifact with `source_runs: [{cloud}]`.

### Local-only-bank case

A bank in `<cohort>-local.json` (route=local) has only a local artifact.
Merger emits a copy of the local artifact with `source_runs: [{local}]`.

### Operator-edited-in-place case (the curated-data trap from ADR-012)

If `output/latest/<bank>_rates.json` ALREADY has operator-curated data
when the merger runs (extraction_method in the curated set per
ADR-012's `ALLOWED_EXTRACTION_METHODS`), the merger respects ADR-012
and routes the incoming through safeWriteArtifact's pending-sidecar
path. The merger does NOT bypass safe-write.

### Safe-write integration

Merged writes go via `safeWriteArtifact({ kind: 'rates' | 'config', source: 'merger' })`.

**Open: 'merger' is a new source.** Adding it to `lib/safe-write.js`#VALID_SOURCES, matching the Phase 3 pattern.

### Idempotency

Re-running the merger with the same inputs must produce the same output.
Test: run merger twice; assert byte-for-byte equality.

### Bank coverage

Cohort defines the universe. A bank present in the cohort but missing
from BOTH sides (cloud failed + local failed) is reported but skipped
(no merge possible — nothing to merge). Counts in the merge summary.

## Module structure

```
lib/merge/merge-bank.js      pure function: mergeArtifact({cloud, local, cloudRunId, localRunId}) → {merged, source_runs, decisions}
lib/merge/run-merger.js       reads peer-runs/<cohort>.json, drives merge-bank for each bank, writes via safeWriteArtifact
scripts/merge/merge-runs.js   CLI wrapper
```

## Tests

Comprehensive fixture tests:

1. Cloud-richer slab count → cloud's rate_slabs win.
2. Local-richer slab count → local's rate_slabs win.
3. Tie slab count → local wins (tiebreak rule).
4. extraction_method: cloud has `llm_inline_extraction`, local has `manual_image_transcription` → merged has manual_image_transcription, contributed_fields includes extraction_method on local.
5. extraction_confidence: cloud=medium, local=high → merged=high, source=local.
6. effective_date: cloud=2026-06-04, local=2026-06-01 → merged=cloud's.
7. warnings: union with de-dup.
8. Identity field mismatch (different bank_code) → throws.
9. Cloud-only artifact (no local) → straight copy with source_runs=[cloud only].
10. Local-only artifact (no cloud) → straight copy with source_runs=[local only].
11. Idempotency: merge(merge(a,b), b) === merge(a,b).
12. ADR-012 path: safeWriteArtifact routes to pending if existing is curated.

## Out of scope

- **Three-way merge.** If a previous merge already exists in output/latest, the merger reads it as if it were the local side (since output/latest is the "canonical local view") and merges the new cloud into it. No special three-way logic.
- **Conflict notification.** The merger logs each per-bank decision; the operator reads the log. No UI / email / Slack hooks.
- **Rollback.** Operator uses git history (output/latest is tracked) to revert if needed.

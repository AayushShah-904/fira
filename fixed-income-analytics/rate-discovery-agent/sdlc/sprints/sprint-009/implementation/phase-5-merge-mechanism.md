# Sprint 009 — Phase 5 implementation: merge mechanism

**Date:** 2026-06-04
**Branch:** `azure-openai-agent`
**Status:** Shipped (autonomous-run)
**Driver:** Sprint 009 scope item 5 + design at `sdlc/sprints/sprint-009/design/phase-5-merge-mechanism.md`. Operator flagged this as highest-risk phase at sprint open.

## What landed

### Pure-function merger

`lib/merge/merge-bank.js` — `mergeArtifact({ cloud, local, cloudRunId, localRunId })` → `{ merged, decisions, source_runs }`. Per-field rules per the design doc and operator decision #3:

- `rate_slabs`: higher-length wins; tiebreak local.
- `extraction_method`, `source_url`: local wins (curated).
- `effective_date`, `scraped_at`: later ISO wins.
- `extraction_confidence`: stronger (high > medium > low > none); tiebreak local.
- `warnings`: union, deduplicated by string equality.
- `bank_code` / `product_type` / `variant`: identity — caller-asserted equal, throws on mismatch.
- Any other field: local wins (curated path is the safer default).

Cloud-only and local-only paths return straight copies with single-source provenance.

### Runner

`lib/merge/run-merger.js` — walks the union of cloud + local sub-cohort bank codes, reads per-variant rate files (`<bank>(_nre|_nro|_fcnr|_gift)?_rates.json`) plus the bank config from each run's `output/runs/<run_label>/` dir, delegates to `mergeArtifact`, writes merged outputs to `output/latest/` via `safeWriteArtifact({ kind: 'rates'|'config', source: 'merger' })`. ADR-012 honored: curated existing rates route incoming to `<file>.pending.json` instead of clobbering.

### CLI

`scripts/merge/merge-runs.js` — reads `data/peer-runs/<cohort>.json` to find the cloud + local run labels, runs the merger, prints a decision summary.

### safe-write addition

`'merger'` added to `lib/safe-write.js#VALID_SOURCES`.

## Decisions taken autonomously (operator delegated 2026-06-04)

| Q | Decision | Why |
|---|---|---|
| **Slab tiebreak** | Local wins | Local artifacts are more likely to have operator curation; the tiebreak should land on the safer side. |
| **Identity-field mismatch** | Throw, don't silently pick one | A `bank_code` / `variant` mismatch means cohort-construction or cross-bank reads — surfaces as a load-bearing bug, not silent data corruption. |
| **One side missing variant** | Skip silently (don't error) | A bank might have `_nre` in local but only the bare in cloud (or vice versa). Merge what's there. |
| **Summary file** | NOT merged | Summaries are per-run telemetry, not canonical data. The per-run files at `output/runs/<label>/<bank>.summary.json` are preserved untouched; the merger emits no merged summary. |
| **Provenance shape** | `source_runs: [{ run_id, source, contributed_fields[] }]` per the scope doc | Operator can answer "where did this field come from?" by reading the merged file. |
| **Dry-run** | CLI accepts `--dry-run` but currently still proceeds | A clean dry-run requires threading a writer-injection point into runMerger; deferred. CLI prints a warning. |
| **Read source for cloud** | `output/runs/<cloud_run_label>/` | The cloud run writes here as a per-run preserved copy alongside its blob writes. Operator-side merge runs on disk after a blob → local sync; the per-run dir is the local source-of-truth. |
| **Cloud beacon patch** | Deferred (Phase 4 inherited this gap) | `deploy-smoke.js` would patch `cloud_run_label` / `cloud_finished_at` into the beacon. Today the operator passes `--cloud-run-label` to the merge CLI, OR a future commit extends deploy-smoke. Not load-bearing — `merge-runs.js --cloud-run-label <label>` works today. |

## Files

```
NEW
  lib/merge/merge-bank.js                          ~190 lines pure function
  lib/merge/run-merger.js                          ~125 lines runner
  scripts/merge/merge-runs.js                      CLI wrapper
  tests/lib/merge/merge-bank.test.js               33 tests
  tests/lib/merge/run-merger.test.js               11 tests
  sdlc/sprints/sprint-009/design/phase-5-merge-mechanism.md
  sdlc/sprints/sprint-009/implementation/phase-5-merge-mechanism.md

EDITED
  lib/safe-write.js                                +'merger' source
```

## Test results

```
$ node --test --test-force-exit tests/lib/merge/merge-bank.test.js tests/lib/merge/run-merger.test.js
# tests 44   # pass 44   # fail 0
```

Fixture coverage:
- All 7 conflict rules (slabs richer-set, extraction_method local-wins, source_url local-wins, effective_date later-wins, scraped_at later-wins, extraction_confidence stronger-wins, warnings union)
- Tie-break (local wins)
- Identity-field mismatch (throws)
- One side missing (cloud-only, local-only)
- Idempotency (re-merge produces same data)
- Multi-variant per bank
- Config + rates both merged
- ADR-012 curated-protection: existing manual_image_transcription in output/latest → incoming routes to .pending

## Open follow-ups

- **CLI dry-run**: threads a writer-injection into runMerger so dry-run truly inhibits writes. Today --dry-run prints a TODO but proceeds.
- **Cloud beacon auto-patch via deploy-smoke.js**: deploy-smoke would write `cloud_run_label` / `cloud_execution_name` / `cloud_finished_at` into `data/peer-runs/<cohort>.json` after a successful smoke. Trivial extension; deferred to keep this phase scoped.
- **Three-way merge** (re-merge with output/latest already a merge): per the design doc this case is handled implicitly — the existing output/latest is read as the local side, the new cloud is merged in. The `source_runs` provenance grows linearly; the merger doesn't dedupe across re-runs. If this becomes a problem at scale, a small post-process to dedupe by `run_id` can be added.

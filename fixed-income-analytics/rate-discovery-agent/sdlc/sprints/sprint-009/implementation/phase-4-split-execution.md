# Sprint 009 — Phase 4 implementation: split-execution orchestration

**Date:** 2026-06-04
**Branch:** `azure-openai-agent`
**Status:** Shipped (autonomous-run)
**Driver:** Sprint 009 scope item 4 + autonomous decisions documented in `sdlc/sprints/sprint-009/design/phase-4-split-execution.md`.

## What landed

### Splitter (pure function + CLI)

- `lib/cohort/splitter.js` — `splitCohort({ entries, domains, now }) → { cloud, local, decisions }`. Decision rule order: no registry → cloud; `blocked: false` → cloud; stale (>30 days per Phase 3's `isFresh`) → cloud; low-confidence → cloud (probe); medium/high → local.
- `scripts/cohort/split.js` — CLI wrapper. Reads `data/cohorts/<name>.json` + `data/bank-domains.json`, emits `<name>-cloud.json`, `<name>-local.json`, and `data/peer-runs/<name>.json` (peer-run beacon for Phase 5).

### Local-side runner

- `scripts/cohort/run-local-only.js` — spawns `run-batch.js --cohort <name>-local` with `BIRD_STORAGE` unset (local mode). Snapshots `output/runs/` before+after to capture the run label (run-batch.js generates it; we can't pass it in). Patches `local_run_label` / `local_finished_at` / `local_started_at` / `local_exit_code` into the beacon so Phase 5 can find this run.

### Hand-off contract for Phase 5

`data/peer-runs/<cohort>.json` is the single source of truth for "where are the two runs":

```json
{
  "cohort": "smoke-1",
  "split_at": "2026-06-04T13:00:00Z",
  "cloud_cohort": "smoke-1-cloud",
  "local_cohort": "smoke-1-local",
  "cloud_run_label":     null | "<run-batch.js batchLabel>",
  "cloud_execution_name": null | "<Container Apps Job execution name>",
  "cloud_finished_at":   null | ISO,
  "local_run_label":     null | "<run-batch.js batchLabel>",
  "local_started_at":    null | ISO,
  "local_finished_at":   null | ISO,
  "local_exit_code":     null | number
}
```

Splitter writes the structural fields and clears stale run pointers on
re-split. `run-local-only.js` patches the local_* fields. Cloud-side
patches (cloud_run_label / cloud_execution_name / cloud_finished_at)
are deferred to a follow-up — today the cloud receipt at
`output:latest:_execution_<execName>.json` carries that info, so Phase 5
can re-derive without a beacon update. A future commit can extend
`deploy-smoke.js` to patch the beacon, but it's not load-bearing.

## Decisions taken autonomously (operator delegated 2026-06-04)

Captured in the design doc; key ones repeated here for the implementation note:

1. **Splitter outputs co-locate with the input cohort** (`data/cohorts/<cohort>-{cloud,local}.json`) — zero path threading for downstream consumers.
2. **No-block-record → cloud** — default behavior for banks the cloud has never observed. Phase 3's inspector will record any block on first attempt.
3. **Stale block → cloud (probe)** — aligns with Phase 3's 30-day `isFresh` decay rule.
4. **Low-confidence block → cloud (probe)** — currently unreached (Phase 3 only produces medium/high), but reserved for future signal sources (e.g., the deferred sustained-NOT_FOUND fingerprint).
5. **Local-only writes to `output/runs/<batchLabel>/` via run-batch.js's existing per-run preservation** — no env/CLI plumbing required. Local also writes to `output/latest/` which is harmless because Phase 5 merger writes the merged result back to `output/latest/` anyway.
6. **Single peer-run beacon per cohort** at `data/peer-runs/<cohort>.json` — simpler than per-side beacons; one file tells Phase 5 everything.
7. **Empty local cohort → run-local-only.js exits 3 (no-op success)** — no-op short-circuit so operator scripts can branch on this.

## Files

```
NEW
  lib/cohort/splitter.js
  scripts/cohort/split.js
  scripts/cohort/run-local-only.js
  tests/lib/cohort/splitter.test.js                  (17 tests)
  sdlc/sprints/sprint-009/design/phase-4-split-execution.md
  sdlc/sprints/sprint-009/implementation/phase-4-split-execution.md
```

## Test + smoke results

```
$ node --test --test-force-exit tests/lib/cohort/splitter.test.js
# tests 17   # pass 17   # fail 0

$ node scripts/cohort/split.js --cohort smoke-1
Split cohort "smoke-1":
  → ...smoke-1-cloud.json  (1 banks)
  → ...smoke-1-local.json  (0 banks)
  → ...peer-runs/smoke-1.json  (peer-run beacon)

Total: 1 banks
  cloud:no_block_record: 1

All banks route to cloud; no local run needed.

$ npm test
# tests 1377   # pass 1333   # fail 0
```

The smoke-1 cohort routes entirely to cloud because no Phase 3 cloud-block
observations exist yet for HDFC. After the planned 12-bank cloud
validation run (next), if HDFC's cloud egress hits a WAF (the 2026-06-03
incident pattern), Phase 3's inspector will mark it, and a subsequent
split would route HDFC to local.

## What's deferred

- **Cloud-side beacon patches.** The cloud execution receipt already
  carries `execution_name` + `run_label`; Phase 5 can re-derive without
  a beacon write. A later commit can extend `deploy-smoke.js` to patch
  for completeness.
- **Splitter-aware deploy-smoke.** Currently `deploy-smoke.js` fires
  the original cohort name; ideally for split-cohort flows it would
  fire `<cohort>-cloud`. The operator can pass `--cohort <cohort>-cloud`
  explicitly today; a flag like `--split` to automate the call into
  `scripts/cohort/split.js` first is nice-to-have.
- **Cohort splitter unit tests for the CLI wrappers** (only the pure
  function is tested). The CLI wrappers are thin spawn-and-glue; smoke-
  tested manually.

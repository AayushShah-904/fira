# Phase 4 — Split-execution orchestration (DESIGN)

**Sprint:** 009
**Phase:** 4 (after Phase 3 cloud-block registry)
**Status:** Design — autonomous-run decisions documented; implementation in this commit.
**Driver:** Sprint 009 scope item 4.

## Goal

The cloud-block registry from Phase 3 records which banks the cloud
egress can't fetch. Phase 4 uses that signal to split a cohort into
two non-overlapping sub-cohorts — `cohort-cloud.json` and
`cohort-local.json` — so cloud runs don't burn AOAI tokens on banks
that are definitely going to fail, and the operator can run the blocked
subset locally from a desktop that doesn't share the cloud egress IP.

## Decisions taken autonomously (operator delegated 2026-06-04)

| Q | Decision | Why |
|---|---|---|
| **Where to write splitter output** | `data/cohorts/<cohort>-cloud.json` + `data/cohorts/<cohort>-local.json` | Co-located with the input cohort. Operator can run `--cohort <name>-cloud` immediately afterwards with no path threading. |
| **What if cohort references a bank with no registry entry** | Default route → cloud | Banks the cloud has never seen aren't blocked. The current Phase 3 inspector will record any block on first attempt. |
| **What if `cloud_block_status` is stale (>30 days)** | Route → cloud (probe again). | Aligns with Phase 3's `isFresh()` decay rule. Phase 3's inspector will refresh the entry on the new attempt. |
| **What signal counts as "blocked"** | `cloud_block_status.blocked === true` AND `isFresh()` AND `confidence ∈ {medium, high}` | Excludes `low`-confidence entries — those should keep probing cloud to either confirm or fade. Currently the Phase 3 confidence model only produces medium/high, but `low` is reserved for future signal sources (e.g., the deferred sustained-NOT_FOUND fingerprint). |
| **Local-only run output preservation** | Use the existing per-run dir `output/runs/<batchLabel>/`. Don't redirect `output/latest/`. | run-batch.js already preserves per-run snapshots via batchRunDir. The local cohort is small (only blocked banks); overwriting output/latest/ for them is fine because the merger (Phase 5) writes the merged result back into output/latest/ anyway. |
| **Peer beacon location for Phase 5 to join on** | `data/peer-runs/<cohort>.json` — single file per cohort recording cloud_run_label + local_run_label + timestamps. | Simpler than per-side beacons. Phase 5 reads ONE file to find both runs. The operator (or future automation) writes/updates this file when each side finishes. |
| **Skip-local-run when local cohort is empty** | `run-local-only.js` exits 0 with a message. | A cohort with zero blocked banks needs no local run; the merger just consumes the cloud output as-is. |
| **Splitter overwrite policy** | `<cohort>-cloud.json` / `<cohort>-local.json` are OUTPUTS of the splitter; safe to overwrite each run. | They're derived artifacts. The source cohort is untouched. |

## Files added

```
lib/cohort/splitter.js                       (pure function — testable in isolation)
scripts/cohort/split.js                       (CLI wrapper)
scripts/cohort/run-local-only.js              (CLI wrapper around run-batch.js)
tests/lib/cohort/splitter.test.js             (unit tests for the splitter)
```

## Splitter behavior summary

```js
splitCohort({ entries, domains, now }) →
  {
    cloud: [<entry>, ...],
    local: [<entry>, ...],
    decisions: [
      { bank_code, route: 'cloud'|'local', reason: 'no_block_record'|'block_stale'|'blocked_high'|'blocked_medium'|'block_low_confidence_probe_cloud' },
      ...
    ],
  }
```

Rules (in order):
1. No `cloud_block_status` in registry, or no entry → route=`cloud`, reason=`no_block_record`.
2. `blocked === false` → route=`cloud`, reason=`no_block_record`.
3. `!isFresh()` → route=`cloud`, reason=`block_stale`.
4. `confidence === 'low'` → route=`cloud`, reason=`block_low_confidence_probe_cloud`.
5. Otherwise → route=`local`, reason=`blocked_<confidence>`.

## Phase 5 hand-off contract

The peer-runs beacon file is the minimum surface area:

```json
{
  "cohort": "smoke-1",
  "split_at": "2026-06-04T13:00:00Z",
  "cloud_cohort": "smoke-1-cloud",
  "local_cohort": "smoke-1-local",
  "cloud_run_label": "2026-06-04T13:05:00Z-cloud",
  "cloud_execution_name": "caj-bofia-rate-discovery-prod-xyz",
  "cloud_finished_at": "2026-06-04T13:08:00Z",
  "local_run_label": "2026-06-04T13:09:00Z-local",
  "local_finished_at": "2026-06-04T13:12:00Z"
}
```

`run-local-only.js` patches in the local_* fields when it finishes; the
cloud equivalent is the existing execution receipt. Phase 5 reads both
the beacon (for the local run label) and the cloud receipt (for the
cloud run label) and walks both per-run dirs.

## Out of scope for Phase 4

- Automating "fire the cloud run too". This phase only routes; the operator (or `deploy-smoke.js` extended in a later sprint) fires cloud separately.
- Concurrent cloud + local execution. The operator runs them sequentially today; the peer-runs beacon doesn't assume a specific order.
- Re-merging if a third run happens. Phase 5 takes the cohort + the beacon at face value.

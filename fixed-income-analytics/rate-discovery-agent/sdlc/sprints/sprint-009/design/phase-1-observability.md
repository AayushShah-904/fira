# Phase 1 — Observability hardening

## Goal

Make a cloud run unambiguous from the operator's seat. After Phase 1 closes,
"did the last run end-to-end work, and if not where did it stop" must be
answerable from a single command, not by hand-correlating Log Analytics +
blob inventory + ARM status.

## What landed already (this commit series)

The execution-scoped receipt (Phase 1 first chunk, commit `f03a0f2`):

- `run-batch.js` writes `output/latest/_execution_<exec>.json` on startup,
  after each bank (incremental), and at terminal phase.
- `cloud/sync.js#uploadExecutionReceipt` pushes it to blob.
- `finalize()` returns a truthful exit code derived from the outcome
  (success / partial_failure / failure / no_work) — non-zero on anything
  but success, so ARM "Failed" mirrors business failure.
- The composite Function status endpoint (commit `674de46`) reads it.

That alone closes the "ARM Succeeded but nothing landed" trap (problems.md
#8). What's still missing is everything the operator needs at the
**cohort** level, not the execution level.

## Remaining Phase 1 deliverables

| # | Deliverable | Status |
|---|---|---|
| 1.1 | Per-execution receipt (`output/latest/_execution_<exec>.json`) | **Done** (this turn) |
| 1.2 | Run beacon (`runs/<run_label>/_run_start.json`, `_run_end.json`) | Pending |
| 1.3 | Structured per-bank events at WARN+ for KQL | Pending |
| 1.4 | Single KQL query for "did the last run end-to-end work" | Pending |
| 1.5 | Drift check on job spec (image, env, kill-switch) | Pending |
| 1.6 | `npm run cloud:status` — last N executions, task-meaningful progress | Pending |

## 1.2 Run beacon

**Why both receipt and beacon?** The receipt is keyed by *Azure execution
name* and lives in `output/latest/` — useful when the operator knows the
execution ID (e.g., from the Function trigger response). The beacon is
keyed by *logical run_label* and lives under `runs/<run_label>/` — useful
when the operator knows the cohort + date but not the execution ID, and
for grouping per-run artifacts (logs, traces, summary, beacon) in one
blob prefix.

The beacon is a thin doc; it does not duplicate the receipt's contents:

```json
// _run_start.json
{
  "run_label":           "20260603T084215_psb-prod",
  "execution_name":      "caj-bofia-rate-discovery-prod-abc123",
  "job_name":            "caj-bofia-rate-discovery-prod",
  "trigger_request_id":  "...",
  "source":              "cohort:psb-prod",
  "image_tag":           "0088324",
  "started_at":          "2026-06-03T08:42:15Z",
  "planned_bank_count":  217
}
```

```json
// _run_end.json — written by finalize()
{
  "run_label":           "...",
  "execution_name":      "...",
  "outcome":             "success" | "partial_failure" | "failure" | "no_work",
  "exit_code":           0 | 1,
  "started_at":          "...",
  "completed_at":        "...",
  "wall_time_sec":       2731,
  "summary": {
    "total_banks":       217,
    "succeeded":         208,
    "failed":            6,
    "rate_limited":      0,
    "skipped":           3
  }
}
```

Implementation: extend `cloud/sync.js` with `uploadRunBeacon(runLabel,
which, payload)` (which ∈ `start` | `end`). Call once at start
(receipt-write time) and once at end (finalize). Per-bank receipt updates
do NOT touch the beacon — beacon is start/end only.

## 1.3 Structured per-bank events (deferred to a separate change)

The events stream (`ATTEMPT`, `EXTRACTED`, `BLOB_WRITE`, `SKIPPED`,
`FAILED`) requires threading through `run-discovery.js`, `cloud/sync.js`
upload paths, and the existing console logging. Bigger surface; landing
later in the sprint after 1.2/1.5/1.6 are bedded in.

## 1.4 KQL query (deferred — depends on 1.3)

The single-query reconciliation needs the structured events to be in
place first. Until then, queries over `ContainerAppConsoleLogs_CL` are
unstructured grep.

## 1.5 Drift check on job spec

`scripts/azops/drift-check.js`. Reads the live job spec via
`az containerapp job show`; compares against expected values (image tag
== `git rev-parse HEAD`, kill-switch env value, replica timeout, etc.).
Exit 0 if matched, exit non-zero with a per-field diff on drift.

The trigger for this is operator-paranoia: "I deployed, but did the
Bicep re-apply actually take? Did Sprint-002's silent kill-switch flip
recur?" The Phase 0 deploy-script kill-switch preservation closes the
write-side hole; this is the read-side audit.

## 1.6 `npm run cloud:status`

Wraps the existing `scripts/azops/status.js`. Lists the last N executions
of the job with start time, outcome (from the receipt when present),
bank counts, and progress (`208/217 banks, last: hdfc-bank-limited`).
The existing `status.js` already polls a single execution; this adds a
"give me a list" mode.

## Order

Sequential: 1.2 -> 1.5 -> 1.6 -> 1.3 -> 1.4. Beacon first because it's
the natural extension of the receipt and unblocks the drift check (which
wants to read the beacon to know which run it's auditing).

## Out of scope for Phase 1

- Dashboard surfaces (Grafana / Azure Workbook). Pending operator
  decision in retro.
- Alerting / paging hooks. We don't have a paging story yet at all.
- Cost telemetry. The AOAI per-bank cost line item is sprint 010+.

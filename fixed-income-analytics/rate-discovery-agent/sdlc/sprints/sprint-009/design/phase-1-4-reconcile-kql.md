# Phase 1.4 — Single KQL reconciliation query

## Goal

A single query answers the operator's load-bearing question — "did the
last cohort run end-to-end work, and if not where did it stop" — in one
table, without grep over free-form logs or hand-correlating with blob
inventory. The Phase 1.3 events are the substrate; this is the
consumer.

## What "end-to-end work" means, in events

Per bank within a `run_label`, the expected event sequence is one of:

```
ATTEMPT → EXTRACTED → BLOB_WRITE          # success path
SKIPPED                                    # pre-LLM short-circuit
ATTEMPT → FAILED                           # terminal failure during run
ATTEMPT → EXTRACTED                        # extraction landed but blob upload missing — silent skip
ATTEMPT                                    # the worst case: started, never reported terminal — likely crashed
```

The KQL turns each bank's event stream into a single per-bank verdict,
then aggregates per `run_label`.

## Two deliverables

| # | Artifact | Purpose |
|---|---|---|
| A | `scripts/azops/reconcile.kql` | The canonical query. Checked-in source of truth; pasteable into the Log Analytics portal. |
| B | `scripts/azops/reconcile.js` + `npm run cloud:reconcile` | Operator wrapper: reads the .kql, runs it via `az monitor log-analytics query`, pretty-prints the result. |

## Source table

`ContainerAppConsoleLogs_CL` (also used by `cloud-status.js` via the
implicit AppInsights-of-Container-Apps pipeline). Relevant columns:

- `TimeGenerated` — emit timestamp on the cluster side
- `ContainerAppName_s` — for jobs, this is the job name (`caj-bofia-rate-discovery-prod`)
- `Log_s` — the line of stdout/stderr (the `[EVENT] {…}` lines live here)
- `Stream_s` — `stdout` or `stderr` (events go to stderr — easy filter)

## Query shape

1. Filter to the job + last N minutes (defaults to 120m, parameterised).
2. Keep only lines with the `[EVENT] ` prefix.
3. Parse the JSON payload after the prefix into a dynamic column.
4. Project canonical columns: `run_label`, `execution_name`, `bank_code`,
   `event`, `ts`, plus payload fields used by aggregates
   (`slab_count`, `files_uploaded`, `error_count`, `kind`, `reason`).
5. Optionally filter to a specific `run_label` (parameter; empty = all
   recent runs).
6. Per `(run_label, bank_code)` summarise which events were seen — emit
   a `bank_verdict`:

   - `success` if `EXTRACTED && BLOB_WRITE && !FAILED`
   - `failed` if `FAILED && !EXTRACTED`
   - `extracted_no_blob_write` if `EXTRACTED && !BLOB_WRITE && !FAILED`
     (silent blob-write gap — the Sprint-002 trap)
   - `attempted_no_terminal` if `ATTEMPT && !(EXTRACTED|FAILED|SKIPPED)`
     (the worst case — likely crashed mid-bank)
   - `skipped` if `SKIPPED && !ATTEMPT`

7. Per `run_label`, summarise: total banks observed, per-verdict counts,
   first `ATTEMPT`, last terminal event, wall-clock. Emit a `run_status`:

   - `clean` — all observed banks are `success` or `skipped`
   - `failures_only` — some `failed`, none of the silent-failure kinds
   - `silent_gap` — at least one `extracted_no_blob_write` or
     `attempted_no_terminal` (Phase 1's whole reason for existing)

The query output is the per-`run_label` row; the per-bank breakdown is
emitted as a nested `bag_unpack` for drill-down without a second query.

## Parameters

The .kql uses Kusto `declare query_parameters` for:

- `run_label:string` — empty (default) = no run filter
- `lookback_minutes:int` — default 120
- `job_name:string` — default `"caj-bofia-rate-discovery-prod"`

The wrapper passes these via `--analytics-query-parameters`.

## What the KQL **does not** know

- **Planned bank count.** That lives in the run-beacon (`runs/<run>/_run_start.json`),
  not in events. The query reports `attempted` (count of distinct
  bank_codes with an ATTEMPT) — the wrapper compares against the
  beacon's `planned_bank_count` when present and surfaces a discrepancy
  in the printed output (not in the KQL itself, to keep the query
  self-contained and pasteable into the portal).
- **Receipt outcome.** The composite Function status endpoint already
  exposes this; no need to duplicate in the KQL.

## Wrapper behaviour (`reconcile.js`)

```
node scripts/azops/reconcile.js [--env prod|dev] [--run-label <label>]
                                [--lookback 120] [--exec-name <name>]
```

- Resolves the Log Analytics workspace ID from the resource group
  (same lookup pattern as `cloud-status.js`).
- Reads `scripts/azops/reconcile.kql` from disk verbatim.
- Calls `az monitor log-analytics query --workspace <id>
  --analytics-query <kql> --parameters …` and gets back JSON rows.
- For each `run_label`, looks up the run beacon at
  `runs/<run_label>/_run_start.json` (best-effort, via the same
  storage helper used by Phase 1.6) and prints planned-vs-attempted.
- Prints a one-line `OK|GAP|FAIL` summary per run plus a per-verdict
  table.
- Exits 0 even on `GAP|FAIL` — this is a read-only operator tool.
  Non-zero exits would conflate "query failed" with "run failed".

## Test plan

- `tests/scripts/azops/reconcile.test.js` — unit tests over the
  wrapper's argument parsing, beacon lookup, and the per-row
  verdict-rendering logic. The KQL itself is not unit-tested — it's
  exercised end-to-end against a real workspace when Phase 1.4 runs
  against a real cohort. Validation of the KQL syntax happens via a
  `--validate` mode that runs the query with a fixed historical
  window and asserts the response shape (run as an integration check
  during deploy, not in CI).

## Out of scope

- Saved searches / Azure Workbook tiles — operator decision in Phase 6
  retro.
- Alerting / paging rules — Phase 1.x is "I can ask"; alerting is
  "the system tells me unasked" and that's a Sprint 010 conversation.

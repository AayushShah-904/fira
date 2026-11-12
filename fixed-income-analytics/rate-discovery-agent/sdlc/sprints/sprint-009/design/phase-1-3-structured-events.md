# Phase 1.3 — Structured per-bank events

## Goal

A cohort run emits five canonical event types — `ATTEMPT`, `EXTRACTED`,
`BLOB_WRITE`, `SKIPPED`, `FAILED` — as single-line JSON to stderr, so
that a single KQL query over `ContainerAppConsoleLogs_CL` can reconcile
"planned vs attempted vs extracted vs landed in blob" without grep over
free-form text.

This is the substrate that Phase 1.4's single-query reconciliation runs
on top of. Until the events are stable, the KQL is a moving target.

## Why structured (not free text)

Sprint 002 telemetry was free-form WARN lines. Reconciling "did bank X
end up in blob" required hand-correlating the log line, the blob
inventory, and the run summary. The five event types are a contract
saying: every bank passes through some prefix of {ATTEMPT, EXTRACTED |
SKIPPED | FAILED, BLOB_WRITE}, and the KQL doesn't need to know about
log phrasing.

## Wire format

One line per event. Prefix `[EVENT]` for cheap KQL filtering. Payload is
a single JSON object — no nested newlines.

```
[EVENT] {"event":"ATTEMPT","ts":"2026-06-03T08:42:15.123Z","run_label":"20260603T084215_psb-prod","execution_name":"caj-bofia-…-abc123","bank_code":"hdfc-bank-limited","idx":42,"total":217}
```

Every line carries `event`, `ts`, `run_label`, `execution_name` (when
set), `job_name` (when set), `image_tag` (when set) — derived from env
vars (`RUN_LABEL`, `CONTAINER_APP_REPLICA_NAME` / `EXECUTION_NAME`,
`JOB_NAME`, `IMAGE_TAG`) at module init and merged into every emit.

Stderr, not stdout: stderr maps to the `stderr` stream in Container
Apps logs, which is what we filter `severityLevel >= 2` for in KQL.
This matches the convention the existing logger already uses for
`error` (logger.js:57).

## Event schema

### `ATTEMPT`
Per-bank start, immediately before the discovery child process spawns.

```json
{"event":"ATTEMPT","bank_code":"…","idx":42,"total":217,"mode":"sequential|parallel|extract_only|expand_nri|rates_only"}
```

### `EXTRACTED`
After the final attempt's results are collected. Always emitted — even
when zero slabs landed — so the KQL doesn't have to special-case
"silent failure of the extraction step".

```json
{"event":"EXTRACTED","bank_code":"…","slab_count":17,"variants":{"regular":12,"nre":3,"nro":2},"scraper_type":"html","config_exists":true,"retried":false}
```

### `BLOB_WRITE`
Per-bank upload completion in `cloud/sync.js#uploadOneBank`. Counts
files uploaded — not "blob exists", because a no-op (nothing changed
locally) is a valid `BLOB_WRITE` with `files_uploaded:0` and is
distinguishable from a write failure (which never reaches the emit).

```json
{"event":"BLOB_WRITE","bank_code":"…","files_uploaded":4,"bytes_total":83421}
```

### `SKIPPED`
Pre-LLM skip: resume hit, no-config in extract-only mode, registry skip,
or category filter (when classifyResult is short-circuited).

```json
{"event":"SKIPPED","bank_code":"…","reason":"resume_already_succeeded|no_config_for_extract_only|registry_skip|…"}
```

### `FAILED`
Per-bank terminal failure that does NOT reach `EXTRACTED`. Emitted from
the call site that knows the failure kind — `classifyResult` for
exit-code / timeout / rate_limited, plus the catch-blocks in the
parallel path.

```json
{"event":"FAILED","bank_code":"…","kind":"timeout|exit_nonzero|rate_limited|spawn_error","exit_code":1,"signal":"SIGTERM","detail":"…"}
```

## Module: `lib/events.js`

Single export `emit(name, payload)`:

```js
const { emit } = require('./lib/events');
emit('ATTEMPT', { bank_code, idx, total, mode });
```

- Merges in env-derived context (`run_label`, `execution_name`,
  `job_name`, `image_tag`) at first emit, memoized for the process.
- Writes one line to `process.stderr`. Synchronous, swallows write
  errors — observability must never crash the run.
- Provides `_envContext()` (test seam) so the unit test can reset env
  between assertions without monkey-patching the module.

Reading env vars rather than threading run context through every emit
site keeps the change to ~one-liner inserts at five sites. The env vars
are already set by run-batch.js when it boots.

## Emit sites

| Event | Site (file:line approx) |
|---|---|
| `ATTEMPT` | `run-batch.js` — sequential loop right before `runBankSync` (~933), parallel pool just before spawn |
| `EXTRACTED` | `run-discovery.js` — right after `collectResults()` (~827), before the existing log.warn `OK` line |
| `BLOB_WRITE` | `cloud/sync.js` — end of `uploadOneBank` success path |
| `SKIPPED` | `run-batch.js` — `checkResume` return point in the loop (after `skipped++`), plus extract-only no-config branch (~885) |
| `FAILED` | `run-batch.js` — `classifyResult` terminal branches (timeout, exit, rate_limited) |

`runBankSync`'s "succeeded" branch does NOT emit a separate `SUCCEEDED`
event; success is implied by the pair (`EXTRACTED`, `BLOB_WRITE`) for
the same bank_code in the same run_label. Avoids a redundant event.

## What stays unchanged

- The existing free-form `log.warn(…)` lines in `run-discovery.js`
  (the human-readable `OK 17 slabs` summary). Those are for
  operators tailing the log. The structured events are for KQL.
- `summarizeResults()` / `buildExecutionReceipt()` — receipts are the
  authoritative summary; events are the audit trail of how the
  summary was built.
- `console.warn` for ad-hoc "cloud sync failed" etc. — not promoted
  to events because they're not per-bank reconcilable.

## Test plan

- `tests/lib/events.test.js`:
  - emits a single JSON line to stderr with the `[EVENT]` prefix
  - includes `event`, `ts` (ISO8601), and the supplied payload
  - merges env-derived context (`RUN_LABEL`, `EXECUTION_NAME`,
    `JOB_NAME`, `IMAGE_TAG`) when set, omits keys when unset
  - swallows write failure (mock stderr.write to throw) without
    throwing to the caller

No e2e test of the emit sites — the call-site change is one line of
"call emit with the locally-available facts" and is exercised by the
existing run-batch test path. The Phase 1.4 KQL will be the practical
end-to-end validator once it lands against a real cohort run.

## Out of scope (folded into 1.4)

- The KQL query itself. Phase 1.3 is the substrate; 1.4 is the
  consumer.
- A KQL-side schema check (Azure Workbook / saved query). Optional;
  Phase 1.4 will decide.
- Replacing the receipt with events. Receipt stays — it's the
  end-state, events are the audit trail.

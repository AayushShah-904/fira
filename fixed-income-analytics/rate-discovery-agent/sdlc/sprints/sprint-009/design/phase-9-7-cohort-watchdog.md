# Sprint 009 Phase 9.7 — cohort-level no-progress watchdog

**Authored:** 2026-06-05
**Driver:** pm-refresh-2026-q2 cohort hang (execution `5kz1vm8`) — see
`sdlc/sprints/sprint-009/implementation/cloud-validation-pm-refresh-hang-2026-06-05.md`.
**Status:** Designed; awaiting implementation.

## Problem

The Container Apps Consumption-profile runtime developed a silent hang
during a 513-bank cohort run after ~6h57min of work (314 banks
processed). The container went fully silent (no logs, no metrics, no
network) for 4+ hours while ARM continued reporting the execution as
`Running`. Manual stop was required.

`spawnSync.timeout` was supposed to kill any hung per-bank child after
15 min — but it didn't fire either. The exact root cause (likely
kernel-level resource exhaustion in Consumption profile after sustained
load) is unknown and not addressable in Sprint 9 scope.

What IS addressable: make the cohort fail FAST and CLEANLY when this
happens, instead of leaking 4h+ of "Running" status.

## Goal

A top-level watchdog in `run-batch.js` that monitors **cohort-level
progress**, not just per-bank timeout. If the per-bank loop variable
hasn't advanced in N minutes, the cohort exits with a partial-success
receipt, allowing the next deploy-smoke poll to capture the truthful
state instead of waiting for `replicaTimeoutSec` (now 20h).

## Non-goals

- **Not** fixing the underlying spawn / container fault. That's an
  infrastructure investigation for Sprint 010.
- **Not** retrying the stuck bank or attempting recovery within the same
  execution. The cohort exits.
- **Not** replacing `spawnSync.timeout` — the per-bank timeout still
  enforces (when it works); the watchdog is belt-and-suspenders for
  when it doesn't.

## Design

### Trigger condition

Watchdog fires when **the cohort's `i` index has not advanced for more
than `COHORT_NO_PROGRESS_TIMEOUT_MS` (default 25 minutes)**.

Why 25 minutes:
- Per-bank timeout is 15 min. A bank can legitimately take up to 15 min
  before being killed.
- After kill, run-batch.js needs ~5-10s to handle the failed bank
  (uploadOneBank flush, classifyResult, FAILED event emit).
- Then the next bank starts.
- So worst case under healthy conditions, one bank cycle is ~15.5 min.
- 25 min = 15 min × 1.67 leaves comfortable buffer. A true hang
  (cohort idle, no per-bank timeout firing) exceeds this with margin.

Configurable via env var `BIRD_COHORT_NO_PROGRESS_TIMEOUT_MS`.

### Mechanism

1. **`lastProgressMs`** module-level variable. Reset on every per-bank
   completion (regardless of succeeded / failed / rate-limited).
2. **`watchdogInterval`** — a `setInterval` running every 60s that
   checks `Date.now() - lastProgressMs`. If exceeded, fires the
   abort.
3. **Abort handler**:
   - Logs a structured `[EVENT] FAILED` event with
     `kind: "cohort_no_progress"`, `last_bank_index: i`,
     `stalled_at_ms: lastProgressMs`, `current_bank: bank_code`.
   - Emits a clear `!!! COHORT WATCHDOG: no progress for Xs, aborting
     to allow partial-success receipt` console line.
   - Calls `publishFinalExecutionReceiptLoud("aborted_no_progress")` to
     flush the receipt with truthful state.
   - Calls `runCloudSync("push")` to flush any in-flight outputs to blob.
   - Calls `process.exit(7)` (a distinct exit code from 0=success,
     1=any-bank-failed).

The `setInterval` is the simplest mechanism that doesn't require
restructuring run-batch.js's existing per-bank loop. Node's event loop
runs the timer callback at the next quiescence — which means if the main
loop is genuinely hung in a synchronous syscall (the actual failure
mode we observed), **the watchdog won't actually fire either**.

That's a real limitation. But: even with that limitation, the watchdog
catches every case where the Node event loop is still alive — async
hangs in storage SDK / cloud-sync / LLM client (which is probably most
of the failure modes we'll see in future runs). It only misses the
case where the event loop itself is frozen at the kernel level (which
is what happened in `5kz1vm8` — and in that case the cohort is already
unrecoverable; `replicaTimeoutSec` 20h is the only safety net).

### Cohort-level vs per-bank timeout interaction

| Layer | Timeout | Enforcement | Action on fire |
|---|---|---|---|
| Per-bank `spawnSync.timeout` | 15 min | Node sends SIGTERM/SIGKILL to child | classifyResult → bank marked `timeout` → next bank starts |
| **Cohort-level watchdog (NEW)** | **25 min since last progress** | **`setInterval` checks; calls process.exit(7)** | **Receipt flushed, partial-success emitted, container exits** |
| `replicaTimeoutSec` (Bicep) | 20h | Container Apps SIGKILLs entire container | execution ends; receipt may or may not have flushed |

The watchdog sits **between** the per-bank timeout and the
replicaTimeout, giving the cohort a clean exit path for the silent-hang
case.

### Receipt contract for the abort path

When the watchdog fires, the receipt should reflect:
- `phase: "failed"` (the cohort didn't complete)
- `outcome: "aborted_no_progress"` (new outcome value)
- `summary.succeeded` / `.failed` / `.skipped`: same as last receipt
  update before the hang
- `completed_at`: timestamp of the abort
- A new field: `aborted_reason: "no_progress_for_<N>s"`

This lets `scripts/azops/deploy-smoke.js`'s poll loop distinguish
"cohort timed out cleanly" from "cohort succeeded" from
"cohort genuinely failed mid-run".

### Tests

`tests/lib/cohort-watchdog.test.js` — three cases:

1. **Watchdog fires when no progress in window.** Mock a long-running
   bank loop that doesn't update `lastProgressMs`; assert the watchdog
   triggers `process.exit(7)` (use a fake exit fn for testing).
2. **Watchdog stays quiet when banks complete normally.** Run a tight
   loop that updates `lastProgressMs` every 100ms; assert no exit
   over a 3s window.
3. **Receipt is flushed with `aborted_no_progress` outcome on abort.**

Source-level contract tests should also verify:
- `lastProgressMs` is updated on every classifyResult call (sync path
  and async path both).
- The watchdog timeout env var override works.

## Files touched

```
NEW:
  sdlc/sprints/sprint-009/design/phase-9-7-cohort-watchdog.md  (this file)
  tests/lib/cohort-watchdog.test.js

CHANGED:
  run-batch.js
    - Add lastProgressMs module var
    - Add watchdog setInterval after cohort starts processing
    - Update lastProgressMs in classifyResult success path AND async path
    - Add abort handler with receipt flush + push + process.exit(7)
  lib/extraction-inspector.js OR a new lib/cohort-watchdog.js
    - (Optional) extract the watchdog into a separate file if it grows
```

## Out of scope

- **Sub-bank-level granular progress**: e.g., "no LLM tool call in 5
  minutes." Too low-level; the per-bank timeout already covers this.
- **Cohort restart**: the watchdog exits. A separate deploy-smoke re-fire
  with a resume cohort is the recovery path.
- **Health checks at the Container Apps level**: would require Bicep
  changes; not the right layer.

## Acceptance criteria

1. New unit tests pass (3 cohort-watchdog cases).
2. Existing `npm test` continues to pass (no regressions).
3. Watchdog detects a simulated no-progress condition within
   COHORT_NO_PROGRESS_TIMEOUT_MS + ~60s (the setInterval tick).
4. Receipt schema accepts the new `aborted_no_progress` outcome value
   without breaking deploy-smoke.js's poll-loop verdict logic.
5. `BIRD_COHORT_NO_PROGRESS_TIMEOUT_MS=10` env var override works in
   tests (so tests don't need 25min wall time).

## Implementation order

1. Author this design doc — DONE.
2. Implement watchdog in `run-batch.js`. ~30 lines.
3. Update `cloud/sync.js` if needed to accept the new outcome value
   (probably no change — receipt is just JSON).
4. Update `scripts/azops/deploy-smoke.js` poll-loop verdict to
   recognize `aborted_no_progress` as distinct from `partial_failure`
   / `success`.
5. Tests.
6. Commit + push.
7. Build resume cohort (banks #316-513 = 198 banks).
8. Fire deploy-smoke against the new image — should complete cleanly
   either way (succeeds OR watchdog fires).

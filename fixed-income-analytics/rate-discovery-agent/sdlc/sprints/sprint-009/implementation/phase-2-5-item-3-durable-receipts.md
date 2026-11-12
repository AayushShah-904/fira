# Sprint 009 — Phase 2.5: Item 3 — Durable + early receipts

**Date:** 2026-06-03
**Branch:** `azure-openai-agent`
**Status:** Shipped
**Driver:** `container-mgmt/doc/cloud-deploy-smoke-operational-handoff.md` item 3

## What the doc asked for

> The receipt should be written before the first bank starts, updated during
> the run, and finalized before exit. Required behavior:
> - On cloud start, publish an initial receipt with `phase: "running"`.
> - After each bank, publish an updated receipt with current counters.
> - In finalize(), publish the final receipt directly and include the local receipt in the normal cloud/sync.js push.
> - If final receipt upload fails, the run should log that loudly.
> - The deploy-smoke script should fail if no final receipt is found after terminal execution.

## What was already in place (from Sprint 009 Phase 1)

- **Initial "running" receipt at startup:** `run-batch.js:641-642` already calls `writeExecutionReceipt("running")` + `publishExecutionReceiptBestEffort("running")` right after `process.env.RUN_STARTED_AT` is set.
- **Per-bank updates:** sequential path (`run-batch.js:1000`) and parallel path (`run-batch.js:1051`) already call `await publishExecutionReceiptBestEffort("running")` after each bank's `applyBackoff()`.
- **Final receipt write:** `finalize()` already calls `writeExecutionReceipt(phase)` and the file lands in blob via the subsequent `runCloudSync("push")` bulk upload.

## Gaps closed this turn

1. **Direct final-receipt upload in `finalize()`.** Previously the final receipt landed only via the bulk `runCloudSync("push")`. If the bulk push failed (cloud sync, network, etc.), the receipt was local-only and deploy-smoke's poller could never see it. Now `finalize()` calls `publishFinalExecutionReceiptLoud(phase)` *before* the bulk push, so the receipt is written twice by design — direct upload + bulk push fallback.

2. **Loud-log on final-receipt failure.** New `publishFinalExecutionReceiptLoud()` distinguishes itself from the running-phase best-effort helper by:
   - Emitting `console.error` with a `!!! FINAL RECEIPT UPLOAD FAILED` marker (greppable by humans + log routers).
   - Emitting a structured `FAILED` event keyed off synthetic `bank_code: "_execution_receipt"` with `kind: "receipt_upload_failed"` so the Phase 1.4 KQL reconciliation surfaces it. Same event schema; no analytics-side change required.
   - On success, also logs `[cloud] final execution receipt uploaded (phase=<phase>)` so the operator sees the positive signal in the run log.

3. **`finalize()` is now `async`.** Required so `await publishFinalExecutionReceiptLoud(phase)` actually blocks until upload completes (or fails). Three call sites updated:
   - Sequential async-IIFE (`run-batch.js:1015`) — `process.exit(await finalize())`
   - Parallel `runParallel().then` (`run-batch.js:1078`) — `.then(async () => process.exit(await finalize()))`
   - Extract-only block (`run-batch.js:929-986`) — wrapped in an async IIFE matching the sequential pattern. Also added `await publishExecutionReceiptBestEffort("running")` after each bank, so a mid-extract-only crash still leaves the counter snapshot in blob.

4. **`cloud/sync.js#uploadExecutionReceipt` docstring updated.** Previously claimed the blob key was the slash form `output/latest/_execution_<id>.json`; now describes both the logical key and the literal colon-form blob name after the storage adapter translation. References the Phase 2.5 receipt-blob-name pin test.

## Files changed

- `run-batch.js` — new `publishFinalExecutionReceiptLoud()` helper; `finalize()` made async + direct publish; three call sites updated; extract-only block wrapped in async IIFE with per-bank receipt update.
- `cloud/sync.js` — docstring updated to describe the storage-adapter translation.

## What this enables

- **Deploy-smoke (item 4) can poll `/api/job-status/<id>` and reliably get a receipt for any terminal execution.** The two-phase publish (direct + bulk) closes the previous gap where a flaky bulk push hid the terminal state.
- **Receipt-upload failures become visible.** Pre-Phase-2.5 a silent upload failure looked indistinguishable from a healthy run — both produced no receipt blob if the bulk push also failed. Now the loud-log + structured event mean even a double-failure leaves trace.
- **The deploy-smoke poller's "fail if no terminal receipt after terminal execution" check (doc item 4) is now safe** — the only way to reach terminal-execution-without-receipt is for both the direct upload AND the bulk push to fail, which will already be loud in the cloud logs.

## What's deliberately NOT in this turn

- **Extract-only mode's receipt updates** are now wired but extract-only is local-only today (no cloud trigger uses it). Symmetry, not functionality.
- **Unit test for the loud-log helper.** The helper is a closure over module-scope `executionName` + `emitEvent`, so testing it requires either extracting to a module (churn for one function with one caller) or spawn-and-mock infra (heavy). Behavior is verified by code review + the existing observability tests in tests/cloud.
- **Deploy-smoke's polling logic that consumes the receipt** is item 4 — next turn.

## Test results

```
$ node --test --test-force-exit --test-concurrency=1 \
        tests/cloud/*.test.js \
        tests/lib/extraction-inspector.test.js \
        tests/functions/job-status/receipt-blob-name.test.js
# tests 61   # pass 61   # fail 0

$ node run-batch.js --dry-run --category "Payments Bank"
Resolved 6 bank(s) [mode=category]: ...
Dry run — no agent invocations performed.
```

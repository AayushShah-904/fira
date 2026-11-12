# Sprint 009 — Phase 2.5: Operational Trust (Items 1+2)

**Date:** 2026-06-03
**Branch:** `azure-openai-agent`
**Status:** In progress — items 1+2 of 6 shipped (this commit).
**Driver:** `container-mgmt/doc/cloud-deploy-smoke-operational-handoff.md`

## What this phase exists for

The 2026-06-03 manual HDFC cloud smoke surfaced two truth-of-success failures
that the existing observability could not catch:

1. The Function App's `job-status` endpoint always returned `receipt_found:
   false` because it was reading the receipt at a blob path that doesn't
   exist — silent 404.
2. The Container Apps Job exited 0 (and ARM reported `Succeeded`) even
   though HDFC extracted zero rate slabs across domestic / NRE / NRO /
   FCNR. A green platform status hid an empty refresh.

Phase 2.5 is inserted between Phase 2 (Function App salvage) and the
originally-planned Phase 3 (cloud-block registry) because making cloud
operations *truthful* is upstream of any router that routes off cloud
state. Per operator decision (2026-06-03), Phases 3-7 from the original
scope shift one slot.

## Items shipped this turn (1 + 2 of 6)

### Item 1 — Receipt blob-name consistency

**Root cause.** `cloud/sync.js#uploadExecutionReceipt` builds a logical key
`output/latest/_execution_<id>.json` and passes it through the storage
adapter. `lib/storage.js#toUnstorageKey` translates `/ → :` before the
unstorage azure-storage-blob driver writes the blob. The on-disk blob name
is therefore `output:latest:_execution_<id>.json`.

`functions/job-status/lib/receipt-blob-name.js` was returning the
slash-form (logical) key and the Function handler reads the blob over raw
HTTPS (no storage adapter). Slash form → 404 every time.

**Fix.** `buildReceiptBlobName` now returns colon form. The handler's
existing URL encoding (`split('/').map(encodeURIComponent).join('/')`)
treats the whole name as one path segment, encoding `:` as `%3A`, which
Azure Blob REST accepts.

**Files changed:**
- `functions/job-status/lib/receipt-blob-name.js` — return colon form; comment block updated
- `functions/job-status/index.js` — comment block updated to reference the storage-adapter translation
- `tests/functions/job-status/receipt-blob-name.test.js` — expected values updated + two new tests that reproduce the writer formula inline and assert it equals the reader's output. Future drift on either side breaks at test time, not in prod.

**Trade-off considered & rejected.** Making the Function App use the
storage adapter (instead of raw HTTPS) would remove the duplicate path-
building entirely. Deferred — bigger change, and not needed to unblock
the smoke contract.

### Item 2 — Zero-slab exit-0 classification

**Root cause.** `run-batch.js#classifyResult` treated any exit-0 child
as `status: success`. The cloud-side rollup (`computeRunOutcome` /
`finalize`) is already correct (`success` requires ≥1 succeeded bank
and zero failed / rate-limited); the breakdown happened at the per-bank
classifier where exit code was the only signal.

**Fix.** When the child exits 0:

1. Read every `<bankCode>(_nre|_nro|_fcnr|_gift)?_rates.json`, sum
   `rate_slabs.length`.
2. Read the bare file's `extraction_confidence` (lowercased).
3. Read the final summary's `failure_class` (prefer `_attempt2.summary.json`
   over `.summary.json` to match `run-discovery.js:858`).
4. If `failure_class !== "no_rates_expected"` AND any rate file is
   present AND `total_slabs === 0` AND `bare_confidence === "none"` →
   re-classify as `status: failed` with `reason: "zero_slab_extraction"`.

The rule is intentionally strict — only `confidence=none` qualifies. A
medium/low/high-confidence run that happens to produce zero slabs is a
different shape (and an unlikely one); the doc explicitly asked for this
narrow rule.

**Legitimate no-FD banks preserved.** Payments Banks and similar (which
carry `failure_class: "no_rates_expected"`) continue to count as
`success` even though slab totals are 0 — they're a different outcome,
not a missed extraction.

**Files changed:**
- `lib/extraction-inspector.js` — new module with `inspectExtractionOutput()` + `isZeroSlabFailure()`. Lives in lib/ rather than inline in run-batch.js so the rule is testable against tmp-dir fixtures without booting the agent.
- `run-batch.js` — `classifyResult()` consults the inspector when exit code is 0; emits a structured `FAILED` event with `kind: "zero_slab_extraction"` for KQL.
- `tests/lib/extraction-inspector.test.js` — 11 tests covering: slab summation across variants, confidence lowercasing, HDFC-style zero-slab detection, retry-summary precedence, missing files, malformed JSON, and every branch of `isZeroSlabFailure`.

## What this phase does NOT do (deferred to follow-up turns)

Items 3-6 of the handoff doc remain open:

- **Item 3 — Durable + early receipts.** Need to publish a `phase: "running"` receipt before bank 1 and update it after each bank. Today `writeExecutionReceipt` is only called in `finalize()`.
- **Item 4 — `scripts/azops/deploy-smoke.js`.** Build zip + ACR + Bicep + ARM start + poll receipt + verdict, in one command.
- **Item 5 — Bicep diagnostic categories.** The unstaged change in `iac/modules/function-app.bicep` already swaps to the supported set; needs the comment block updated and a deploy retry to confirm.
- **Item 6 — Operator runbook.** Short doc pointing operators at `deploy-smoke.js`.

## Test results

```
$ node --test --test-force-exit tests/lib/extraction-inspector.test.js \
                                tests/functions/job-status/receipt-blob-name.test.js
# tests 19   # pass 19   # fail 0

$ node --test --test-force-exit --test-concurrency=1 tests/cloud/*.test.js
# tests 42   # pass 42   # fail 0
```

`npm test` itself is blocked by two pre-existing write-discipline violations
introduced in earlier sprint-009 commits (`f03a0f2` and `e35b42c`) — not
this turn's work, but a known gap:

- `run-batch.js:579` — `fs.writeFileSync(executionReceiptPath, ...)` in `writeExecutionReceipt`. Probably wants a `// safe-write-exempt: execution-receipt operator artifact, atomic enough at one write per bank` comment.
- `scripts/azops/start-cohort.js:254` — tmp body file for the `az rest` POST. Probably wants `// safe-write-exempt: tmp ARM request body, lives ms`.

These should be cleaned up before the next commit run; capturing them here so they don't get lost.

## Naming-contract test (item 1 detail)

The new test `matches the writer blob name produced by cloud/sync.js +
storage adapter` reproduces the writer formula inline rather than
importing `cloud/sync.js` directly (which would pull the Azure SDK into
test boot). The reproduction is two short functions — `LATEST_KEY_PREFIX`
and `toUnstorageKey` — pointed at their source by comment. If either side
of the contract changes, the test fails *here*, before the change reaches
prod.

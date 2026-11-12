# Sprint 009 — Phase 3 implementation: cloud-block detection + registry

**Date:** 2026-06-04
**Branch:** `azure-openai-agent`
**Status:** Shipped
**Driver:** Sprint 009 scope item 3 + the operator decisions on `sdlc/sprints/sprint-009/design/phase-3-cloud-block-registry.md`.

## Operator decisions taken (all recommended options)

1. **Q1 storage** — extend `data/bank-domains.json` entries with a `cloud_block_status` block (Option A).
2. **Q2 schema** — the proposed shape: `blocked` / `last_observed` / `first_observed` / `evidence_url` / `http_status` / `reason` / `vendor` / `signal` / `confidence` / `observation_count` / `last_run_id` / `last_execution_name`.
3. **Q3 confidence + decay** — vendor-specific × 1 → high; `unknown_waf` × 1 → medium, × ≥ 2 → high; 30-day freshness for Phase 4 consumers.
4. **Q4 trigger** — Option III: read on-disk per-bank evidence sidecars in `finalize()` (revised mid-implementation to a per-bank sidecar after discovering the structured-event stream is stderr-only).
5. **Housekeeping** — fix the sprint-007 Cloudflare regex regression as part of Phase 3 (the test fixture, not the production regex; details below).
6. **Source tag** — new `'cloud-block-detector'` value in `safeWriteArtifact`.

## What landed

### New modules under `lib/cloud-block/`

- **`observer.js`** — `recordObservation` writes per-bank evidence sidecar
  `<bankCode>_cloud_block_evidence.json` to the run's `output/latest/`
  directory. Gated on `BIRD_STORAGE === 'azure'` so local runs are silent.
  Read-side helpers (`readObservations`, `listObservedBanks`) drive the
  finalize-time aggregation.
- **`inspector.js`** — bridge between the orchestrator's `fetchPage` call
  and the observer. Runs `detectChallenge` against the fetch result;
  on positive detection it (a) emits a structured `FAILED` event with
  `kind: 'cloud_block_detected'` for KQL surfacing (always — useful
  telemetry in local mode too) and (b) records the evidence via
  observer (cloud-only via observer's own gate).
- **`registry-updater.js`** — `deriveCloudBlockStatus` applies the Q3
  confidence rules to a sidecar payload + the prior registry entry
  (counter advances; `first_observed` survives across runs). `isFresh`
  exposes the 30-day decay check for Phase 4 cohort splitter consumers.
  `updateRegistryFromEvidence` loads `bank-domains.json`, merges the
  per-bank statuses, and writes the file via `safeWriteArtifact({ kind:
  'registry-file', source: 'cloud-block-detector' })`.

### Production wire-up

- `lib/orchestrator.js` — calls `inspectFetchForCloudBlock` right after
  every `fetchPage`. Pre-existing fetch-cache short-circuit
  (`memoised`) skips inspection on re-uses of the same URL within a
  bank; deliberate (we already inspected the first time).
- `lib/actions/fetch_page.js` — surfaces `status_code` + `body` on the
  non-2xx (`ok: false`) path so inspector can detect 403/406/429 bodies.
  Backwards-compatible (`ok` is still the primary check; new fields
  appear only on failure, which existing readers ignored anyway).
- `run-batch.js#finalize()` — new `updateCloudBlockRegistryBestEffort()`
  helper reads each sidecar in `output/latest/`, builds the per-bank
  statuses, writes the registry via the updater. Cloud-only;
  best-effort (any failure logs loudly but doesn't flip the run's exit
  code — per-bank rates already pushed via `uploadBankBestEffort`).
- `lib/safe-write.js` — new `'cloud-block-detector'` source added to
  `VALID_SOURCES`.

### Housekeeping fix

`tests/lib/fetch/fetch_html.test.js:76` — the test fixture used the
synthetic body `'Just a moment Cloudflare...'`. Sprint 7's tightening
removed the bare `/cloudflare/i` alternative from the Cloudflare regex
(the 72-bank cdnjs false-positive), and the regex now requires the
literal sequence `Just a moment...` (or `cf-chl-bypass` / `cf-mitigated`).
Real Cloudflare challenge bodies DO contain `<title>Just a moment...</title>`
— the production regex is correct; the test fixture was outdated. Fixture
updated to a realistic Cloudflare interstitial body. No production-side
change.

### Tests added

- `tests/lib/cloud-block/observer.test.js` — 11 tests covering shape,
  append, cloud/local gate, env capture, required-fields, malformed-prior recovery.
- `tests/lib/cloud-block/registry-updater.test.js` — 18 tests covering
  every confidence branch, decay, mergeStatusIntoRegistry semantics, and
  cross-run counter accumulation via the end-to-end `updateRegistryFromEvidence`.
- `tests/lib/cloud-block/inspector.test.js` — 6 tests covering the
  bridge logic: Cloudflare body detection on ok=true, 403 on ok=false,
  local-mode (emit-but-don't-record), clean fetches, transport-error
  fall-through, null defensiveness.

35 new tests in total.

## Full chain in one paragraph

In a cloud run, the orchestrator fetches each rate-page URL. The
inspector runs `detectChallenge` against the response; on a positive
detection it emits `FAILED { kind: 'cloud_block_detected', vendor,
signal, http_status, url }` (visible in KQL via Phase 1.4 reconciliation)
and calls `observer.recordObservation`, which appends to
`<bankCode>_cloud_block_evidence.json` under `output/latest/`. Multiple
fetches per bank append to the same sidecar. At end of run,
`finalize()` lists the observed banks, builds a `cloud_block_status`
per bank (applying the confidence rules using the prior registry entry
when present, so counters advance across runs), and writes the merged
registry via `safeWriteArtifact({ kind: 'registry-file', source:
'cloud-block-detector' })` — the same path `lib/domain-cache.js` uses
for agent-side registry updates. Phase 4's cohort splitter (next phase)
will read `cloud_block_status` + `isFresh()` to route banks.

## Mid-implementation revision

The design doc proposed Option III: "read on-disk event log in finalize."
While reading `lib/events.js` during implementation, I discovered events
stream to stderr only — there is no on-disk JSONL event log. Adjusted
to per-bank evidence sidecars written by `observer.recordObservation`
inline (the orchestrator-callsite path the inspector lives at). Same
end-to-end outcome; no design change at the boundary (the writer is
still inside finalize() reading per-bank artifacts), just a different
intermediate format.

## What's deliberately NOT in this phase

- **Phase 4 cohort splitter.** That's the consumer; this phase builds
  the registry. Splitter design is its own next-phase doc.
- **`lib/manifest/per-bank-manifest.js` wire-up.** Sprint 006 Step 4
  leftover; orthogonal per the Option-A decision. Still loose-ends inventory.
- **Sustained NOT_FOUND-after-retry signal.** The scope doc listed this
  as one block fingerprint. It needs cross-run state (have we tried this
  URL in cloud before? did it 404 last time too?) that the current
  inspector doesn't have. Deferred — present infrastructure handles
  403/406/429/WAF-body fingerprints, which is the documented HDFC failure
  mode. Sustained-404 can layer in later as a separate observer call from
  the orchestrator's outer retry loop.
- **Decay enforcement in the writer.** `isFresh` is exported for
  consumers (Phase 4 splitter). The writer never wipes a stale entry —
  it accumulates evidence. Phase 4 reads `isFresh` to decide trust.

## Files

```
NEW
  lib/cloud-block/observer.js
  lib/cloud-block/inspector.js
  lib/cloud-block/registry-updater.js
  tests/lib/cloud-block/observer.test.js
  tests/lib/cloud-block/inspector.test.js
  tests/lib/cloud-block/registry-updater.test.js

EDITED
  lib/safe-write.js                                       # +'cloud-block-detector' source
  lib/orchestrator.js                                     # +inspectFetchForCloudBlock call
  lib/actions/fetch_page.js                               # surface status_code on ok=false
  run-batch.js                                            # +updateCloudBlockRegistryBestEffort
  tests/lib/fetch/fetch_html.test.js                      # fixture alignment (housekeeping)
```

## Test results

```
$ node --test --test-force-exit \
        tests/lib/cloud-block/observer.test.js \
        tests/lib/cloud-block/inspector.test.js \
        tests/lib/cloud-block/registry-updater.test.js \
        tests/lib/fetch/fetch_html.test.js
# tests 60   # pass 60   # fail 0

$ npm test
# tests 1360   # pass 1316   # fail 0   (44 skipped, expected)
```

The pre-existing fetch_html WAF classifier failure from the prior
session is now fixed.

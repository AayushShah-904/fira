# Sprint 010 Phase 2 — cloud_capability registry field

**Date:** 2026-06-07
**Outcome:** ✅ Registry field added; 19 high-confidence multi-signal banks seeded.

---

## Field shape

Parallel to `cloud_block_status` (Sprint 009 Phase 3). Lives on `data/bank-domains.json` entries:

```js
cloud_capability: {
  capable: bool,                 // true = cloud can extract, false = route to local
  confidence: 'high' | 'medium' | 'low',
  reason: 'partial_silent_pattern' | 'zero_slab_extraction_repeated'
        | 'crash_pre_flight' | 'cloud_succeeded' | 'manual_operator:<reason>',
  first_observed: ISO,
  last_observed: ISO,
  observation_count: int,
  last_run_id: string|null,
  last_execution_name: string|null,
  signals: { partial_silent: int, zero_slab: int, crash: int },
}
```

The `signals` per-kind tally lets Phase 4 fuse multi-signal evidence and lets future inspectors disambiguate ("this bank fails in zero-slab but never in partial_silent — pipeline issue, not page issue").

**Why it's separate from `cloud_block_status`:** they're orthogonal evidence streams. `cloud_block_status` = "can't reach the bank" (WAF / 403 / challenge). `cloud_capability` = "can reach but extraction fails" (partial_silent / zero_slab / crash). A bank can have either, both, or neither. Phase 3 splitter is where precedence between them gets resolved.

## Derivation rules

| Signal | Mapping | Confidence rule |
|---|---|---|
| `partial_silent` × 1 | capable = false, reason = partial_silent_pattern | medium |
| `partial_silent` × ≥ 2 (cumulative) | capable = false | high |
| `zero_slab` × 1 | capable = false, reason = zero_slab_extraction_repeated | medium |
| `zero_slab` × ≥ 2 | capable = false | high |
| `crash` × 1 | capable = false, reason = crash_pre_flight | medium |
| `crash` × ≥ 2 | capable = false | high |
| `cloud_succeeded` × 1 | capable = **true**, reason = cloud_succeeded | high (1 dispositive) |
| operator override | capable = whatever operator says | high |

A single `cloud_succeeded` observation **fully resets** prior `capable: false` — one healthy cloud run is dispositive evidence the bank is now workable.

Decay: 60 days since `last_observed` → stale (Phase 3 splitter ignores). Longer than the 30-day WAF window because extraction capability changes more slowly than WAF policy.

## Files

| Path | Role |
|---|---|
| `lib/cloud-capability/registry-updater.js` | Direct structural mirror of `lib/cloud-block/registry-updater.js`. Exports `deriveCloudCapability`, `isFresh`, `mergeCapabilityIntoRegistry`, `updateRegistryFromEvidence`, `reasonFromSignal`. |
| `lib/safe-write.js` (edit) | `VALID_SOURCES` adds `'cloud-capability-detector'`. |
| `scripts/registry/seed-cloud-capability.js` | One-shot migration: reads `data/sprint-009-cloud-incapable-candidates.json`, filters to ≥ N signals (default 2), authors evidence and rolls into the registry. Supports `--dry-run` and `--min-signals N`. |
| `scripts/registry/mark-capability.js` | Operator CLI: `node scripts/registry/mark-capability.js <bank> <capable\|incapable> "<reason>"`. Writes via safe-write source=`operator`, always high confidence. |
| `tests/lib/cloud-capability/registry-updater.test.js` | 18 cases, all pass. Mirrors the cloud-block test fixture pattern; injects `now` everywhere. |
| `tests/scripts/registry/seed-cloud-capability.test.js` | 4 cases, all pass. Verifies signal mapping + dry-run output against the real candidate file. |

## Seed execution

```
[seed] eligible banks (signals >= 2): 19
[seed] evidence sidecars to write:    19
[seed] updated 19 entries in ./data/bank-domains.json
[seed]   capable=false: 19
[seed]   capable=true:  0
[seed]   high-conf:     14
[seed]   medium-conf:   5
```

**14 high-confidence** banks have 2+ observations of the *same* signal (mostly `zero_slab` × 2: one batch_failure + one regressed_to_zero, which both map to the zero_slab observer signal).

**5 medium-confidence** banks have 2 observations of *different* signals (e.g. AU SFB: 1 partial_silent + 1 regressed_to_zero → signals.partial_silent = 1, signals.zero_slab = 1, latest signal's count = 1 → medium). That's correct behaviour — split-signal evidence is real but not as strong as repeated same-signal evidence.

Sample entry (`au-small-finance-bank-limited`):

```json
"cloud_capability": {
  "capable": false,
  "confidence": "medium",
  "reason": "zero_slab_extraction_repeated",
  "first_observed": "2026-06-06T16:55:06.288Z",
  "last_observed":  "2026-06-06T16:55:06.288Z",
  "observation_count": 2,
  "last_run_id": "sprint-009-cohort-9zulerb-and-prior",
  "last_execution_name": "sprint-010-phase-2-seed",
  "signals": { "partial_silent": 1, "zero_slab": 1, "crash": 0 }
}
```

## What this does NOT do

- Does not change `lib/cohort/splitter.js`. Phase 3 wires the splitter to read `cloud_capability` — until then, the field exists but isn't consumed.
- Does not run from cohort runs automatically. Phase 4 wires `run-batch.js`'s post-bank hook.
- Does not validate that the 19 seeded banks should genuinely be cloud-incapable. The Sprint 009 candidate list was *candidates*; a one-shot local probe could disprove any of them, in which case `mark-capability.js <bank> capable "local probe confirmed"` flips them back.

## Exit criteria check

Sprint 010 plan exit criterion #3: "`cloud_capability` populated for ≥ 19 banks (the Sprint-009 multi-signal candidates)." → ✅ Met (exactly 19).

## Files committed

- `lib/cloud-capability/registry-updater.js` (new)
- `lib/safe-write.js` (VALID_SOURCES += cloud-capability-detector)
- `scripts/registry/seed-cloud-capability.js` (new)
- `scripts/registry/mark-capability.js` (new)
- `tests/lib/cloud-capability/registry-updater.test.js` (new, 18 cases)
- `tests/scripts/registry/seed-cloud-capability.test.js` (new, 4 cases)
- `data/bank-domains.json` (19 cloud_capability entries added)
- `sdlc/sprints/sprint-010/implementation/phase-2-cloud-capability-registry-2026-06-07.md` (this doc)

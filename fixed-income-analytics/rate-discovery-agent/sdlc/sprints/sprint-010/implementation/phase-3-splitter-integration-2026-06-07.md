# Sprint 010 Phase 3 — splitter wired to cloud_capability

**Date:** 2026-06-07
**Outcome:** ✅ Splitter routes the 19 Sprint-009 cloud-incapable banks to local on the real 513-bank cohort.

---

## What changed

`lib/cohort/splitter.js#decide` now reads two registry signals instead of one:

| Signal | Source | Means |
|---|---|---|
| `cloud_block_status` | Sprint 009 Phase 3 (`lib/cloud-block/registry-updater.js`) | cloud can't reach the bank (WAF / 403 / challenge) |
| `cloud_capability` | Sprint 010 Phase 2 (`lib/cloud-capability/registry-updater.js`) | cloud can reach but extraction silently fails |

Both contribute to the routing decision. Precedence is **deterministic** — no race between fresh signals:

```
  a) Both null/absent                   → cloud (no_record)
  b) Block fresh + medium/high          → local  (blocked_*)
  c) Capability fresh + capable=false   → local  (incapable_*)
  d) Block fresh + low                  → cloud (block_low_confidence_probe_cloud)
  e) Capability fresh + capable=true    → cloud (capability_succeeded)
  f) Block stale OR capability stale    → cloud (block_stale | capability_stale)
```

**Why block trumps capability (rule b before c):** a WAF block is "cloud can't even reach this." Trying cloud regardless of capability is pointless wall-clock. Capability evidence only matters when the bank is reachable.

**Why low-conf block falls through to capability (rule d after c):** a low-confidence block alone isn't enough to ship to local. But if both a low-conf block AND high-conf incapability are present, the incapability is the stronger signal and routes local.

## New decision reasons

| Reason | Route | Meaning |
|---|---|---|
| `no_record` | cloud | No evidence either way (was: `no_block_record`) |
| `blocked_high`, `blocked_medium` | local | Existing — fresh WAF block at strength |
| `block_low_confidence_probe_cloud` | cloud | Existing — fresh but weak block, probe cloud |
| `block_stale` | cloud | Existing — block older than 30 days |
| `incapable_high` | local | **New** — fresh capable=false at high confidence |
| `incapable_medium` | local | **New** — fresh capable=false at medium confidence |
| `capability_stale` | cloud | **New** — capability older than 60 days |
| `capability_succeeded` | cloud | **New** — fresh capable=true |

The `no_block_record` → `no_record` rename is technically a breaking change to any consumer asserting on that string. Tests updated; docs (the Sprint 009 runbook + Phase 4 impl doc) carry forward the old name as historical context.

## Tests

`tests/lib/cohort/splitter.test.js` — was 14 cases, now 24 cases (+10 for cloud_capability + precedence). Patterns:

| Case | Asserts |
|---|---|
| fresh high-conf incapable → `local/incapable_high` | direct decide() output |
| fresh medium-conf incapable → `local/incapable_medium` | direct decide() output |
| 65-day-stale capability → `cloud/capability_stale` | decay window |
| fresh capable=true → `cloud/capability_succeeded` | healthy reset |
| fresh block(high) + fresh incapable(high) → `local/blocked_high` | block precedence over capability |
| fresh block(low) + fresh incapable(high) → `local/incapable_high` | low block falls through, capability wins |
| stale block + fresh incapable(high) → `local/incapable_high` | stale block doesn't preempt fresh capability |

All 24 pass; no existing test regressed.

## Live verification

Splitter run against `data/cohorts/pm-refresh-2026-q2.json` (513 banks) with the Phase-2-seeded registry:

```
Cohort size: 513
Cloud lane: 494
Local lane: 19

Total: 513 banks
  cloud:no_record:          494
  local:incapable_high:     14
  local:incapable_medium:    5

Local lane (head):
  icici-bank-limited
  au-small-finance-bank-limited
  the-junagadh-jilla-sahakari-bank-ltd
  jilla-sahakari-kendriya-bank-maryadit-ujjain
  krishna-district-co-operative-central-bank-ltd
  …(14 more)
```

The 19 banks the Sprint 009 close-out flagged as multi-signal cloud-incapable are exactly the 19 now routing to the local lane. Sprint 010 plan exit criterion #4 is met.

## What this does NOT do

- Does not actually *run* the cohort. Splitter is pure; the operator dispatches the cloud-lane sub-cohort to the CAJ and the local-lane sub-cohort to `scripts/cohort/run-local-only.js` as separate executions (the runbook at `container-mgmt/doc/runbook-split-cohort-500bank.md` covers the workflow).
- Does not auto-update `cloud_capability`. That's Phase 4 — `run-batch.js` post-bank hook authoring evidence sidecars + a finalize() rollup using `updateRegistryFromEvidence`.

## Files

- `lib/cohort/splitter.js` (edit: rewrote `decide()`, new imports, expanded JSDoc; renamed `no_block_record` → `no_record`)
- `tests/lib/cohort/splitter.test.js` (10 new cases, 1 fixture helper `capability()`, `no_block_record` → `no_record` everywhere)
- `sdlc/sprints/sprint-010/implementation/phase-3-splitter-integration-2026-06-07.md` (this doc)

## Side-by-side reasons map

For operators reading existing diagnostic output:

| Old (pre-Sprint-010) | New | Why |
|---|---|---|
| `no_block_record` | `no_record` | broadened — now means "neither block nor capability evidence" |
| `block_*` | unchanged | block side untouched |
| (n/a) | `incapable_*` | new capability-driven local-lane reason |
| (n/a) | `capability_*` | new capability-driven cloud-lane reason |

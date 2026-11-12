# ADR-014: Validation rules live in a single shared package

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Consolidate rate/tenure/format validation into `packages/shared/src/validation/` (TS-native) with a CJS port at `rate-discovery-agent/scripts/utils/validate-rates.js` for the agent. All three current validation surfaces (`commit_rates` action, `scripts/refresh/sanity-gate.js`, `packages/scraper/src/validators/{range,delta,format}.ts`) consume from the shared package. |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-16 |
| Date decided | 2026-05-16 |
| Sprint | 003 (Week 2 Task #6) |
| Supersedes | — |
| Related | ADR-012 (write-discipline), Sprint 003 #1a action contracts (A8 `commit_rates`), Sprint 003 #2 packages/scraper validation |

## Context

Sprint 003 Week 1 Track 1 exercised `packages/scraper`'s 7-layer validation against current agent output for the first time. The audit (`sdlc/sprints/sprint-003/implementation/scraper-pipeline-audit.md`) and Sprint 003 reconciliation analysis surfaced that rate-bound + tenure-order + delta + completeness rules now live in **three** places with diverging semantics:

| Surface | File | Bounds / thresholds | Where it fires |
|---|---|---|---|
| Agent-side write-gate | `rate-discovery-agent/scripts/utils/validate-rates.js` | general 1.5–9.5%, senior 1.5–10.5%, super 1.5–10.5%; variant overrides NRE/NRO 2.0–9.5, FCNR/GIFT 0.5–8.0; tenure-order error; senior≥general warning | A8 `commit_rates` — blocks canonical write |
| Refresh-pipeline pre-LLM-verify gate | `rate-discovery-agent/scripts/refresh/sanity-gate.js` | rate plausibility 1–9.5%, large-move 75 bps, slab-count drift 50%, senior/general collapse, all-senior-null | Decides which suspicious candidates go to LLM verification |
| DB-import gate | `BIRD/packages/scraper/src/validators/{range,delta,format,completeness,monotonicity}.ts` | Variant-aware ranges (regular ~max+2 critical), delta 50/75 bps default/SFB+NBFC+LAB, format L1, completeness L5, monotonicity L4 | Decides which slabs land in the D1 `rate_slabs` table with what severity |

Different rate ceilings, different delta thresholds, different severity mappings. They cannot agree on what is suspicious for the same input — and they don't share a source of truth for what the rate range even is. `PRODUCT_TYPES.rateRange` is published from `packages/shared/`, but only the scraper consumes it; the agent's validator and the refresh sanity-gate hard-code their own numbers.

This is the duplication operator flagged on 2026-05-16. Reconciling is in scope of Sprint 003 because:

1. Week 1 Track 1 turned packages/scraper from "untested code" into "exercised but disagreement-prone code". Disagreement will produce silent drift between the agent's write-time gate and the scraper's import-time gate, and we won't notice until users see broken rates downstream.
2. Sprint 003 Week 2 will add packages/scraper integration tests as item #2b. Those tests pin the scraper's validators in place; reconciling AFTER that adds churn. Doing it before #2b is cheaper.
3. The action-decomposition direction (Q13 deterministic orchestrator) presumes a clean contract surface; "which validator did this rule come from" undermines that.

## Decision

Validation rules consolidate into one package, consumed from all surfaces.

### Where

`packages/shared/src/validation/` — TS-native, alongside the existing `packages/shared/src/constants/tenure-maps.ts`.

```
packages/shared/src/validation/
  rate-bounds.ts         // single source of truth for rate ranges per (product, variant, payer-class)
  delta-thresholds.ts    // single source for delta-bps thresholds per bank category
  format-rules.ts        // tenure-order, senior≥general, missing-rate-field, currency-required-for-fcnr-gift
  completeness-rules.ts  // expected-count tolerance (±20%), zero-slab handling
  index.ts               // exports validateSlabs(slabs, ctx) — public API
```

`ctx` shape encapsulates the per-call context that drives variant-aware decisions (product_type, variant, bank_category for delta tolerance, expected_slab_count for completeness, previous_slabs for delta comparison). The single function returns the same `{passed, flags, criticalCount, warningCount, infoCount}` shape `packages/scraper` already uses.

### Why `packages/shared` and not a new package

- `packages/shared` is already the canonical home for cross-package primitives (zod schemas, product types, tenure maps, helpers). Validation belongs with the constants it consumes.
- Adding a new workspace (`packages/validation`) adds tsconfig wiring, build, test, and import-path tax with no benefit a subdirectory of `packages/shared` doesn't already give.
- The CJS-port pattern (TS source of truth + JS twin for the agent) is already established by `tenure-maps.ts` ↔ `parse-tenure.js`. We extend that pattern rather than inventing new.

### CJS twin for the agent

`rate-discovery-agent/scripts/utils/validate-rates.js` becomes a CJS port that mirrors `packages/shared/src/validation/index.ts`. Single API surface (`validateSlabs(slabs, ctx)`), same numeric bounds, same flag shape. Maintenance is a manual port (same convention as `parse-tenure.js`) — when one changes the other must change in the same commit; a CI guard can be added if drift becomes a problem.

The agent does not import from `packages/shared/` at runtime because rate-discovery-agent is CJS-only and `packages/shared` is TS-compiled-to-ESM; bridging at runtime would require either bundling or runtime TS resolution. Neither is worth the operational tax for this size of API.

### What migrates

| From | To | Shape change at consumer |
|---|---|---|
| `rate-discovery-agent/scripts/utils/validate-rates.js`'s constants + rule bodies | Sourced from `packages/shared/src/validation/` via the CJS port pattern | None — `validateSlabs` keeps the same signature; consumers (commit_rates A8) unaffected |
| `rate-discovery-agent/scripts/refresh/sanity-gate.js`'s thresholds and rate-bound checks | Import the same constants + a thin wrapper that produces sanity-gate-shaped output | sanity-gate's per-flag emission shape preserved; constants now come from the shared module |
| `packages/scraper/src/validators/range.ts` | Imports rate-bounds + emit_flag from `packages/shared/src/validation/` | Layer file stays; becomes a thin adapter that maps shared validators to `scrape_flags` rows |
| `packages/scraper/src/validators/delta.ts` | Imports delta-thresholds from shared | Same — thin adapter |
| `packages/scraper/src/validators/format.ts` | Imports format-rules from shared | Same — thin adapter |

### What stays separate (deliberately)

- **`packages/scraper/src/validators/staleness.ts` (L7)** — needs DB access (`scrape_runs.started_at`); inherently scraper-side. Not duplicated elsewhere, so nothing to consolidate.
- **`packages/scraper/src/validators/monotonicity.ts` (L4)** — pure rules but only meaningful at import-time with the full slab set; no current duplicate; could move later if a use case appears.
- **`packages/scraper/src/validators/completeness.ts` (L5)** — same as monotonicity. Sprint 003 #1b's A3 completeness check (dispatcher-vs-LLM count comparison from Task #4) is a different rule and doesn't replace L5.

## Consequences

### Positive

- One place to change a rate bound, a delta threshold, or a senior-rate premium. Today changing the regular FD ceiling from 9.5% to 10% requires hunting in three files; tomorrow it's one.
- Drift detection becomes automatic: a CI test compares the TS module's exported constants against the CJS port's constants and fails if they differ. (Sprint 003 #2b deliverable.)
- The action contract A8's "validate-rates as hard gate" gains durability — the gate's behavior is no longer locked to one file's history but to a shared package's versioned API.
- packages/scraper's import-time validators become declarative: they're adapters that map shared rules onto `scrape_flags` schema, not rule definitions themselves.

### Negative / Costs

- One-time migration: ~1.5 days for the move + CJS port + consumer-side updates + tests.
- Maintenance overhead of the CJS port — a JS file must be hand-edited to mirror TS changes. Mitigated by the existing `parse-tenure.js` precedent, which has been low-friction.
- A future ESM-compatible agent or a build step could collapse the port. Today's CJS-only agent doesn't justify that work; revisit if the agent moves to its own ESM-aware repo (per `project_agent_repo_split.md`).

### Neutral

- The duplication of layer files (`packages/scraper/src/validators/range.ts` remains, but as an adapter) is intentional. The scraper's import flow has its own per-flag persistence mechanism (`scrape_flags` rows) that the shared module doesn't need to know about. Adapter layers keep the shared module storage-agnostic.

## Implementation plan

Migration is a single coordinated change, all in one PR-equivalent commit (since we don't open PRs on `azure-openai-agent`).

**Day 1:**
- `packages/shared/src/validation/index.ts` and four sub-modules ported from the current `validate-rates.js` + `range.ts` + `delta.ts` + `format.ts` bodies. Numeric constants reconciled — where the three sources disagree, the **stricter** value wins by default (operator can adjust before this lands).
- Public API: `validateSlabs(slabs, ctx) → { passed, flags, criticalCount, warningCount, infoCount }`.
- TS unit tests for each rule (Vitest, mirrors `packages/shared` convention).

**Day 1.5:**
- `rate-discovery-agent/scripts/utils/validate-rates.js` ported back. Same API signature. Existing 15 tests of `lib/actions/commit_rates.js` continue to pass without test changes (the action consumes `validateSlabs` and doesn't care which file the rules live in).
- `rate-discovery-agent/scripts/refresh/sanity-gate.js` migrated.

**Day 2:**
- `packages/scraper/src/validators/{range,delta,format}.ts` rewired as adapters over the shared module.
- packages/scraper's existing tests pass unchanged (the per-flag shape is unchanged).
- CI guard: a Vitest test in `packages/shared` that asserts the TS module's constants match the agent's CJS port's constants. Run on every `npm test`.

**Day 2.5 — buffer:** reconciling whatever disagreements surface (e.g., delta thresholds: agent's sanity-gate uses 75 bps, scraper uses 50 bps; the shared module will publish 50 bps by default, with a per-category override for SFB/NBFC/LAB that uses 75 bps — both consumers get the same numbers without either of them needing to fork).

Total: ~1.5–2 days single-developer.

## Reconciliation of specific disagreements

Where the three current sources differ, the shared module's chosen value is recorded here. Each is a small operator call; flag back if any are wrong.

| Rule | Agent's validate-rates.js | Refresh sanity-gate.js | Scraper validators/range.ts | Shared (proposed) |
|---|---|---|---|---|
| Regular FD general min | 1.5% | 1.0% | `PRODUCT_TYPES.FD.rateRange.min` (TBD) | **`PRODUCT_TYPES.FD.rateRange.min`** — single canonical |
| Regular FD general max | 9.5% | 9.5% | `PRODUCT_TYPES.FD.rateRange.max` (TBD) | **`PRODUCT_TYPES.FD.rateRange.max`** |
| FCNR/GIFT general max | 8.0% | n/a | 8.0% | **8.0%** |
| Senior premium ceiling | +1.0% | n/a | +1.0% over general max | **+1.0%** |
| Super-senior premium ceiling | +1.0% | n/a | +1.5% (per Layer 2) | **+1.5%** (scraper's broader bound; LLM rates 10.25–10.50% are common at SFBs) |
| Default delta threshold | n/a | 75 bps | 50 bps | **50 bps** — stricter default |
| SFB/NBFC/LAB delta threshold | n/a | 75 bps | 75 bps | **75 bps** |
| Critical-rate cutoff (range L2) | "above ceiling" warning, no critical | "implausible_rate" > 9.5% in sanity-gate (flag, not block) | `rate > max + 2` is critical | **`rate > max + 2` critical, `rate < 0` critical, anything else in [min, max+2] is warning** — matches scraper |

The most operator-load-bearing choice is the **50 bps default delta** (down from the agent's effective 75 bps via sanity-gate). This will produce more "delta warning" flags on rate-change runs. Operator can flip to 75 bps if the noise is too much; the shared module makes that a one-line change.

## Open questions (not blocking the decision)

- Should there be a "warn-only" CI guard that runs the validators against `output/latest/` and reports any new criticals as part of every test run? Adds ~30 sec to CI. Probably overkill for a single-operator workflow; defer.
- The agent's `validate-rates.js` today returns `warnings: string[]` (formatted human-readable strings). The scraper returns `ValidationFlag[]` (structured objects). The shared module will publish the structured shape; the CJS port can render strings on demand for the agent's existing console output. No consumer-visible change to `commit_rates`'s validation.flags array.

## Not in scope of this ADR

- Migrating `packages/scraper/src/validators/staleness.ts`, `monotonicity.ts`, `completeness.ts` to shared. Those are scraper-side and have no current duplicate.
- Re-implementing the L6 cross-reference validator (which references a second source for rate sanity). Out of scope; future ADR if/when L6 lands.
- Folding the action-side completeness check (Sprint 003 #1b A3 follow-up — "dispatcher count > LLM count" warning, per Task #4 measurement) into the shared module. That's an extraction-decision rule, not a rate-bound rule; it lives in the action, not validation.

## Verification

After migration:
- All 277 current rate-discovery-agent tests pass unchanged (validate-rates.js is a black-box port).
- packages/scraper test suite passes unchanged.
- New tests in `packages/shared/src/validation/__tests__/` cover every numeric bound and every flag-shape edge case (~30 tests).
- A drift-detector test compares TS module exports against CJS port exports byte-by-byte (numbers; ignores comments).
- A small end-to-end test in `packages/scraper/__tests__/integration` (the Sprint 003 #2b deliverable that follows this ADR) imports one bank's real output through the consolidated pipeline and asserts identical flag output between the agent's pre-write check and the scraper's import check.

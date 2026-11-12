# Sprint 009 — Phase 6 implementation: synthetic E2E harness

**Date:** 2026-06-04
**Branch:** `azure-openai-agent`
**Status:** Shipped (synthetic); real 500-bank cohort deferred to operator pickup.
**Driver:** Sprint 009 scope item 6 + design at `sdlc/sprints/sprint-009/design/phase-6-e2e-harness.md`.

## Scope decision (autonomous-run)

Per scope, Phase 6 calls for a **500-bank Q2 cohort run, split → cloud + local → merge → compare against pure-local pack**. This cannot be run autonomously:

- ~$100–500 AOAI tokens
- ~6–12 hours wall time, parallelism-dependent
- Any partial_failure mid-run needs operator judgment

**Phase 6 ships in two parts:**

1. **Synthetic E2E harness** (this commit) — exercises the Phase 4 splitter + Phase 5 merger end-to-end against fixture data. Proves the plumbing works without touching cloud. Six explicit assertions cover the regression rules from operator decision #3 at sprint open.

2. **Operator runbook for the real 500-bank run** (`container-mgmt/doc/runbook-split-cohort-500bank.md`) — step-by-step pre-flight, split, cloud-run, local-run, merge, compare, pack-rebuild. The operator fires it when ready.

## Synthetic harness — what it proves

`scripts/e2e/synth-validate.js`:

1. **Stage 1 — Splitter**: 6-bank fixture cohort routes correctly (3 clean → cloud, 3 blocked → local).
2. **Stage 2 — Simulate runs**: Writes per-bank artifacts under `output/runs/<cloud_label>/` and `output/runs/<local_label>/` in a tmp project root.
3. **Stage 3 — Merge**: Drives `lib/merge/run-merger.js` against the fixture beacon.
4. **Stage 4 — Assertions** (6 explicit):
   - **A**: Richer-set-wins (local 30 slabs > cloud 20 slabs → merged has 30).
   - **B**: Provenance `source_runs[]` lists both sides on overlapping bank.
   - **C**: ADR-012 curated-protection (`extraction_method: manual_image_transcription` in `output/latest/` survives; merger's incoming routes to `.pending.json`).
   - **D**: Cloud-only banks have cloud-only provenance.
   - **E**: Local-only banks have local-only provenance.
   - **F**: Total slab count matches expected (102 across 6 merged files — confirms the math of all rules combined).

## Test results

```
$ node scripts/e2e/synth-validate.js
Stage 1: Splitter        ✓ ×2
Stage 2: Simulate runs   ✓ ×3
Stage 3: Merge           ✓ ×3
Stage 4: Anti-regression ✓ ×6
PASS — all assertions passed.
```

## Sprint exit criteria evaluation

Per the scope doc, Phase 6 exit requires:

| Criterion | Status |
|---|---|
| Total slab count ≥ Sprint 008 baseline for the same cohort | **Deferred** — requires real 500-bank cohort + pack rebuild |
| Zero silent overwrites of richer data | **Proven on fixtures** (assertion A above). Real cohort confirms in operator runbook step 6. |
| Per-variant coverage matches or exceeds baseline | **Deferred** — same as above |

The synthetic harness gives high confidence in the merge mechanism's correctness on the failure modes Sprint 008 cared about. The real-cohort verification is operator-driven; see the runbook.

## Files

```
NEW
  scripts/e2e/synth-validate.js                                          ~270 lines
  container-mgmt/doc/runbook-split-cohort-500bank.md                     operator runbook for the real cohort
  sdlc/sprints/sprint-009/design/phase-6-e2e-harness.md
  sdlc/sprints/sprint-009/implementation/phase-6-e2e-harness.md
  sdlc/sprints/sprint-009/implementation/cloud-validation-12-bank-2026-06-04.md  (operator-requested 12-bank check; outcome: stuck on Playwright spawn timeout, see file)
```

## The 12-bank cloud validation interlude

Per operator request mid-autonomous-run, a live 12-bank cloud cohort was
fired against the deployed `dd8e15f` image to verify Phase 2.5 + 3
against real workload before Phase 5–6 layered on top. Outcome:

- Platform layers (deploy, function-load, ARM start, status endpoint) all **green**.
- Bank-extraction layer **stuck on bank 1 at a Playwright spawn ETIMEDOUT**. Pre-existing infrastructure issue; not a regression from this sprint's code (the failing path was the deprecated LLM-agent codepath, not the orchestrator hook Phase 3 wires into).
- Re-fire deferred to operator after Playwright spawn issue is diagnosed.

Full writeup: `cloud-validation-12-bank-2026-06-04.md`. The takeaway:
the sprint code is operationally trusted at the platform layer; the
real-workload validation is gated on an unrelated Playwright infrastructure
issue.

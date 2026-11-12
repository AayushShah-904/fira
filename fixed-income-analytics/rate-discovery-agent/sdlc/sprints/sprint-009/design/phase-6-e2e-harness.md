# Phase 6 — End-to-end split-cohort validation (DESIGN)

**Sprint:** 009
**Phase:** 6 (after Phase 5 merger)
**Status:** Design — autonomous-run; deferred portions documented for operator pickup.
**Driver:** Sprint 009 scope item 6.

## Goal (per scope doc)

> 500-bank Q2 cohort run, split → cloud + local → merge → comparison
> against pure-local pack; metrics: total slab count, per-variant coverage,
> zero silent overwrites of richer data.

## Autonomous-run scope decision

The literal 500-bank cohort against live cloud + live local CANNOT be run
autonomously per the standing "be safe and wise" rule — it costs real
AOAI tokens (~$100-500), takes ~6-12 hours wall time, and requires
operator validation of intermediate gates (any partial_failure mid-run
should pause; any anomalous slab regression should be operator-reviewed).

**What I AM doing autonomously:**

1. Build the harness — `scripts/e2e/synth-validate.js` — that exercises
   the full Phase 4 + Phase 5 chain against fixture data. This proves
   the plumbing works end-to-end without touching cloud.
2. Run the in-flight live 12-bank cohort the operator explicitly
   requested. Results captured separately in
   `sdlc/sprints/sprint-009/implementation/cloud-validation-12-bank-2026-06-04.md`.
3. Document the gating for the real 500-bank run as a runbook
   (`container-mgmt/doc/runbook-split-cohort-500bank.md`) so the
   operator can fire it when ready.

**What's deferred to operator-driven follow-up:**

- The live 500-bank cohort itself.
- Cohort-quality comparison (slab counts vs. baseline) against real
  pack rebuilds — requires the live cohort first.

## Synthetic E2E harness — what it tests

The harness creates a temp project root, populates fixture cohort +
fixture bank-domains.json with `cloud_block_status` blocks, then runs:

1. **Splitter** (`scripts/cohort/split.js`) — input: 6-bank fixture cohort
   with 3 clean + 3 blocked banks. Asserts cloud-cohort=3, local-cohort=3,
   peer-run beacon written.
2. **Simulated cloud run** — writes per-bank rate files into a fake
   `output/runs/<cloud_label>/`. Some banks "extract" more slabs than
   the local equivalent will, others fewer, to exercise the
   richer-set-wins rule.
3. **Simulated local run** — same shape, different slab counts +
   `extraction_method: manual_image_transcription` for one bank.
4. **Merger** (`lib/merge/run-merger.js` directly, OR
   `scripts/merge/merge-runs.js` via spawn) — drives the merge against
   the fixture peer-runs beacon.
5. **Assertions**:
   - Total slab count across merged output equals the union of richer
     sides (each bank contributes its richer slab set).
   - Per-variant coverage: every (bank, variant) that existed on at
     least one side appears in the merged output.
   - Provenance: every merged file has `source_runs` with at least one
     entry; banks-with-both have two entries.
   - Curated-protection: a planted operator-curated `output/latest/`
     file is NOT clobbered (routes to .pending.json).
   - **Zero silent overwrites of richer data** — the explicit
     anti-regression assertion: if local had N slabs and cloud had M < N,
     the merged file must have N slabs (not M).

## CLI shape

```
node scripts/e2e/synth-validate.js
```

No flags. Always runs against an in-process tmp dir; exits 0 on
all-asserts-pass.

Output: one-line-per-stage progress + final PASS / FAIL verdict.

## What this validates vs what it doesn't

Validates:
- The Phase 4 splitter actually partitions correctly when given a
  populated cloud_block_status registry.
- The Phase 5 merger applies all the field-level rules and ADR-012
  curated-protection.
- The two pieces compose: splitter output feeds the merger input cleanly.
- The CLI scripts work end-to-end (not just the underlying pure-function
  libs).

Does NOT validate:
- Real cohort scale (500 banks vs 6 fixtures).
- AOAI prompt regressions (extractor / orchestrator changes that
  surface only with real bank HTML).
- WAF block detection in cloud against live targets (Phase 3 inspector
  fires; the in-flight 12-bank cloud cohort exercises this).
- Slab-count regressions at the pack level (need pack rebuild + compare).

These belong to the operator-driven 500-bank validation.

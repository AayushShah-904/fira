# Rate Discovery Agent — v2 Rewrite Doc Set

> **Status: Proposal / not yet implemented.** These documents re-imagine the Bank Rate Discovery
> Agent from scratch, keeping every lesson from v1 (sprints 001–008) but free of backward-compat
> constraints. No production code has been changed by this doc set.

## The documents

| Doc | What it answers |
|---|---|
| [`functional-spec.md`](./functional-spec.md) | **What** the agent does — per-bank agent contract, fleet pipeline, strict output schemas, hard rules, special cases. |
| [`evaluation-spec.md`](./evaluation-spec.md) | **How we know it's correct** — snapshot substrate, the six evaluation layers, human-in-the-loop adjudication, confidence tiers, release gate, metrics, acceptance criteria. |
| [`design.md`](./design.md) | **How we build** specs 1 & 2 — bespoke Node pipeline (snapshot-first), module layout, two-tier orchestration, evaluation wiring, data contracts, traceability matrix. |
| [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md) | **Where it's going** — deposits as phase 1 of the FIRA platform; envisioned bond/instrument coverage; the hybrid stance (generic contracts now, deposit-only implementation) and the bond roadmap. |
| [`plan.md`](./plan.md) | Working plan for producing this doc set (kept with the set for reference). |

Read the four specs in order (functional → evaluation → design → vision); the design doc references
both specs, and the vision doc explains the `instrument_type` seam they carry.

## Why a rewrite

v1 works (≈8,600 slabs across ≈435 banks shipped) but the design accreted: rules split across
`docs/agent/*.md` + prompt fragments, extraction in `scripts/bulk-author.js` + `lib/orchestrator.js`,
and **correctness was bolted on late** as the Sprint-008 confidence program. The operator's standing
concern is *trust in correctness* — plausible-but-wrong data (column swaps, loan-as-FD, collapsed FCNR
currencies, truncated ladders, bulk-over-retail, foreign-currency-as-INR) that slips past naive gates.

The central design move in v2: **evaluation is first-class, and the agent's output is re-checkable by
construction** — every extraction reads from and references an immutable source snapshot, and a
layered defence (per-slab validity → structural checks → rate-reasonableness → independent cross-check
→ statistically-measured error rate → golden regression) catches the systematic error classes before
ship. A human adjudicates the ambiguous residue, because the LLM-as-judge over-flags ~7×.

## Locked decisions (with operator)

- **Scope** — the per-bank agent *and* the fleet pipeline that runs it across ~1,900 banks.
- **Architecture** — bespoke Node pipeline + direct LLM calls (no agent framework); preserve the v1
  orchestrator/stage approach unless a strong argument emerges in design.
- **Location** — this folder, `docs/agent/rewrite/`.
- **Depth** — detailed and opinionated; concrete schemas, named components, carried-over thresholds.
- **Multi-instrument future** — deposits are phase 1 of the FIRA platform; the system must accommodate
  bonds later. Stance: **hybrid** — generic, instrument-aware contracts now (`instrument_type`
  discriminator, instrument-keyed dispatch/registry/checks, schema versioning) but **only the deposit
  instrument implemented** (no speculative bond logic). See `vision-coverage-extensibility.md`.

## Rewrite plan / roadmap

This doc set is step 1 (the specs). Suggested sequence once the specs are approved:

1. **Specs (this folder)** — functional, evaluation, design. ← *current step*
2. **Snapshot substrate first** — `snapshot/capture.js` wired into all fetch paths; seed corpus from
   existing `output/latest/` + `output/snapshots/`. Nothing else proceeds until capture is the hard
   dependency of extraction.
3. **Per-bank agent core** — prompt assembly (fragments/modes), action set, `lib/llm/provider.js`,
   fetch escalation + www-self-heal, extractor dispatch (generic-3col + currency cross-product + OCR).
4. **Layer 1 + 2 + 3 inline** — `slab-validate.js`, `structural-checks.js`, `rate-reasonableness.js`
   wired into write path and gate; unit tests per check.
5. **Fleet orchestration** — `bulk-author.js` (fingerprint→cluster→propose→extract→gate→persist),
   `registry.js` single-writer + clobber invariants, two-tier model, `--from-report`.
6. **Pack + gate** — `build-pack.js`, `quality-gate.js`, signed accepts, macro governance.
7. **Evaluation layers 4–6** — cross-check, sampling audit (adjudicated error rate + CI), golden
   suite + backfill, confidence score + sidecars.
8. **First measured baseline** — run the audit, report the cycle metrics, tune thresholds, then ship.

## Open questions for the operator

Listed in [`design.md` §10](./design.md): cost of universal cross-check, provider mix, confidence
emission default, audit cadence/sample size, and whether v2 lands in its own repo
(per the agent-repo-split intent).

## Provenance

Specs derived from the v1 source of truth — `docs/agent/{core,discovery-workflow,nri-gift-ibu,schemas,field-learnings}.md`
and the live check/score code (`lib/checks/structural-checks.js`, `lib/checks/rate-reasonableness.js`,
`lib/confidence/score.js`, `scripts/quality-gate.js`, `lib/snapshot/snapshot-store.js`). Schema field
names and numeric thresholds are quoted from those files; verify against current code before
implementing, as point-in-time values may drift.

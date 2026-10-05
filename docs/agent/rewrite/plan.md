# Rewrite Specs: Rate Discovery Agent (clean-slate) — working plan

> This is the working plan that produced the v2 rewrite doc set, kept alongside the docs for
> reference. The deliverables it describes are: [`functional-spec.md`](./functional-spec.md),
> [`evaluation-spec.md`](./evaluation-spec.md), [`design.md`](./design.md),
> [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md), [`README.md`](./README.md).

## Context

We've built the Bank Rate Discovery Agent over ~8 sprints. It works (8,591 slabs across
~435 banks shipped), but the design accreted: rules live in `docs/agent/*.md` + prompt
fragments, extraction in a bulk-author pipeline (`scripts/bulk-author.js` + `lib/orchestrator.js`),
and correctness was bolted on late as the Sprint-008 "confidence program" (snapshots, sampling
audit, cross-check, structural checks, golden gate, confidence score, signed accepts).

The operator's recurring pain has been **trust in correctness**: numbers that look plausible but are
wrong (column swaps, loan-table-as-FD, collapsed FCNR currencies, truncated ladders, bulk-tier
picked over retail, foreign-currency rates shipped as INR). The LLM-as-judge over-flags ~7x, so a
human-adjudication step is unavoidable. The biggest structural lesson: **evaluation must be a
first-class part of the design, not an afterthought** — and the agent's own output must carry the
provenance/snapshot needed to evaluate it later.

This task produces a **doc set** that re-imagines the agent as if starting fresh, keeping every
hard-won lesson but dropping backward-compat constraints. Decisions locked with the user:
- **Scope**: the per-bank agent *and* the fleet pipeline that runs it across ~1900 banks.
- **Architecture**: bespoke Node pipeline + direct LLM calls (no agent framework); preserve the
  existing orchestrator/stage approach unless a strong argument emerges in the design.
- **Location**: `docs/agent/rewrite/`.
- **Depth**: detailed and opinionated — concrete schemas, named components, carried-over thresholds.

> Deliverable of *this* task = the documents below. No production code is changed.

### Multi-instrument perspective (continuation)
The system is phase 1 of a broader **Fixed Income Analytics (FIRA)** platform (BharatOmni / UFA =
*Unified Fixed Income Analytics*; FIRA→FIRA rename 2026-05-05), whose future coverage extends beyond
bank deposits to **bonds of various types**. Decisions locked for this addition:
- **Placement**: a dedicated `vision-coverage-extensibility.md` + light cross-reference pointers in
  the three existing specs (each stays self-contained).
- **Design impact = HYBRID**: generalize the *contracts and architecture vocabulary now* (an
  `instrument_type` discriminator, instrument-keyed dispatch/registry/checks, schema versioning) so
  the data model and pipeline are not deposit-locked — but implement **only the deposit instrument's
  concrete extractors/checks** (no speculative bond logic; YAGNI). Bonds slot in later as a new
  instrument module rather than a core refactor.

## Documents in the set

### 1. `functional-spec.md` — what the agent does
- **Purpose & non-goals.** Aggregate INR deposit (FD/RD/savings) rates from Indian banks' own
  sites; one bank at a time; never fabricate; never use aggregators. Bonds out of scope for v2 but
  architecture accommodates them.
- **Domain model & vocabulary.** `instrument_type` discriminator (deposit today); bank_code
  (verbatim, slug rules); the 15 `bank_type` codes; variants (regular/nre/nro/fcnr/gift); deposit
  tiers; currency.
- **Per-bank agent contract.** Inputs (`Bank Name | Category | State`, `$BANK_CODE`, `$OUTPUT_DIR`)
  and the 5 stages as capabilities: find-website → find-rate-pages → classify-scraper-type →
  extract-slabs → emit-config+rates, each with success/failure/uncertainty behaviour.
- **Output schemas (STRICT).** Config + `<bank_code>[_variant]_rates.json`, verbatim from
  `docs/agent/schemas.md`, plus the new `instrument_type` + `schema_version` + `snapshot_ref`
  envelope fields.
- **Fleet pipeline contract.** Registry as source of truth; two-tier model; clobber-protection
  invariants.
- **Discovery-status taxonomy** for the no-rate tail (valid outcomes, not failures).
- **Hard rules & special cases** carried from core + field-learnings.

### 2. `evaluation-spec.md` — how we know the output is correct
- **Why evaluation is first-class** + correctness definition (faithful to the referenced snapshot).
- **Snapshot substrate** as a precondition (capture at fetch time).
- **Six-layer model:** per-slab validity → structural/semantic checks → multi-reference
  rate-reasonableness → independent cross-check → sampling audit (Wilson CI) → golden regression.
- **Human-in-the-loop rule** (judge over-flags ~7x; adjudicated rate is the reported one).
- **Confidence score & tiers**; **release gate** + operator-signed, agent-immune accepts.
- **Cycle metrics** and **acceptance criteria** for the rewrite.
- Framework is instrument-agnostic; Layer-2/3 checks are per-instrument.

### 3. `design.md` — how we build specs 1 & 2
- **Architecture overview** + the snapshot-first and instrument-aware-core design principles.
- **Module layout** with reuse (↻) vs new (✚) markers; instrument-namespaced
  (`lib/instruments/deposit/…`) with a generic core + `lib/instruments/registry.js`.
- **Per-bank agent runtime**, **fetch & extraction**, **two-tier orchestration & registry writes**,
  **evaluation implementation**, **data contracts & storage**.
- **What we deliberately drop** (v1 cruft) + **YAGNI** (no bond logic now).
- **Migration note** (seed from existing artifacts, no compat layer), **open questions/risks**,
  and a functional↔eval↔design **traceability table**.

### 4. `vision-coverage-extensibility.md` — future multi-instrument coverage
- The FIRA vision; envisioned instrument coverage (G-Secs, T-bills, SDLs, corporate bonds/NCDs,
  PSU/tax-free bonds, SGBs, candidates); the hybrid principle + YAGNI guardrail; shared vs
  instrument-specific; how bonds differ (ISIN, yield/price/coupon, rating, market sources, cadence);
  roadmap; bond-phase open questions.

### Hybrid contract edits applied to the existing three docs (light, instrument-aware)
- **functional-spec.md:** non-goals reframed; `instrument_type` in the domain model;
  `instrument_type` + `schema_version` in the rate-file envelope; identity generalizes; pointer.
- **evaluation-spec.md:** framework is instrument-agnostic; Layer-2/3 checks per-instrument; pointer.
- **design.md:** instrument-keyed dispatch/registry/checks; envelope + registry `schema_version`;
  `lib/instruments/deposit/…` layout; YAGNI note; bond open questions; traceability seam.

## Status
1. `functional-spec.md`, `evaluation-spec.md`, `design.md` — **DONE**
2. `README.md` (index + roadmap) — **DONE**
3. `vision-coverage-extensibility.md` + hybrid edits to the three specs + README index — **DONE**

No production code modified; only docs under `docs/agent/rewrite/`.

## Verification (review-based)
- Cross-check every quoted schema field / threshold against the live source file it came from.
- Confirm internal consistency: every functional requirement has a matching evaluation criterion and
  a design component (traceability table in `design.md`).
- Confirm the hybrid is coherent: generic-now / deposit-only-implementation held — no speculative
  bond logic specified, but no contract deposit-locked either.
- Operator reads and confirms scope/architecture + the multi-instrument direction before any
  implementation sprint.

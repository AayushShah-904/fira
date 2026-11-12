# Sprint 003 Week 1 — Decision bars

**Status:** Set 2026-05-15 (Week 1 Day 1). Do not move post-hoc.
**Plan reference:** `sdlc/sprints/sprint-003/re-think-plan.md` — Week 1 decision gate.

This document records the bars Tracks 1, 2, and 3 are measured against so the end-of-week fork (A/B/C/D) is decided on pre-committed thresholds rather than post-hoc judgement.

## Track 1 — packages/scraper acceptance bar

**Question:** Does packages/scraper accept current `output/latest/` agent output? What does its 7-layer validation flag?

**Measurement:** Run `npm run import` and `npm run validate` from `packages/scraper/` against the current `output/latest/` directory (state of branch `azure-openai-agent`). Count banks that:
- Import clean (no validation errors at any layer).
- Import with warnings only (non-blocking flags).
- Import rejected (one or more validators returns error).

**Bars:**
- **≥85% clean import** → safety net works; AI extraction does not need to be perfect; Track 1 votes for Fork A.
- **50–84% clean import** → safety net works but the contract is leaky; Track 1 votes for Fork B (Selective AI / Hybrid) pending Track 2 result.
- **<50% clean import** → either the scraper or the agent's output contract is broken; Track 1 votes for Fork C investigation. Before declaring Fork C, do a 1-day root-cause: is it the scraper expecting schemas the agent never emits (fixable), or is the agent producing genuinely invalid rates (deeper)?

**What "clean" means precisely:** zero entries in the scraper's per-bank validation error list. Warnings (e.g., staleness, missing senior rate) do not disqualify.

**Sample:** all 1,399 files in `output/latest/` (since the repo state already includes ~292 bank-equivalent records across regular + variant files). Subsample only if `packages/scraper` cannot handle that volume in one CLI invocation; if subsampling, stratify by bank_type to ensure each type has ≥5 banks.

## Track 2 — Action-decomposition feasibility bar

**Question:** Can we decompose the monolithic agent into 8 named actions with clean JSON contracts, and does the deterministic dispatcher (one specific action) replace LLM work for the cases it can handle?

**Measurement:**
- Item #1a: design doc at `sdlc/sprints/sprint-003/design/action-contracts.md` lands with all 8 action contracts (find_website, find_rate_page, extract_html_table, extract_pdf_table, extract_via_vision, classify_outcome, commit_to_registry, commit_rates) specified by Day 3.
- Item #1d: deterministic dispatcher wired into a new `extract_html_table` action. Run against the 12-bank Sprint 002 diagnostic sample (`sdlc/sprints/sprint-002/implementation/dccb-failure-analysis.md`). Count which of those 12 banks the dispatcher extracts cleanly without LLM involvement.

**Bars:**
- **#1a contracts all land + dispatcher handles ≥50% of 12-bank sample without LLM** → workflow approach is feasible; Track 2 votes for Fork A.
- **#1a lands but dispatcher handles <50%** → contracts are clean but LLM remains load-bearing for extraction; Track 2 votes for Fork B (Selective AI — keep LLM for hard cases).
- **#1a fails to land cleanly (any of the 8 contracts can't be specified without compromise)** → decomposition is harder than expected; Track 2 votes for Fork C investigation.

**What "extracts cleanly" means precisely:** the dispatcher emits a slab array of correct shape that matches the operator-curated baseline rates for that bank within ±0.05% on `rate_general_pct` and exact match on `tenure_min_days`/`tenure_max_days`. Discrepancies in `effective_date` do not disqualify (A2 in deferred items).

## Track 3 — Framework filter (informational)

**Question:** Are there framework libraries worth POC'ing in Week 2, or do we stay bespoke?

**Measurement:** Apply 4 hard gates to all 8 candidates (Mastra, LlamaIndex.ts, LangGraph.js, OpenWorkflow, Effect, ts-edge, TsWorkflow, workflow-es):
- License: MIT / Apache-2 / BSD / ISC / MPL-2 passes; AGPL / GPL / SSPL / BUSL / Commons-Clause fails.
- Maintenance: last commit ≤ 6 months ago AND not archived passes; >12 months OR archived OR <50 stars without active maintainer fails.
- Runtime fit: runs in Node 20+ single-process (Container Apps Job shape) passes; needs separate scheduler / DB fails.
- TS support: TS-native API OR usable `@types/<pkg>` passes; JS-only without types fails.

**Bars (informational, not gating):**
- **0 survivors** → framework question closed for Sprint 003; stay bespoke.
- **1–2 survivors** → Phase 2 (comparison matrix) in Week 2 if Fork A or B.
- **3+ survivors** → likely over-counting; tighten the maintenance gate in Phase 2.

Track 3 does not vote on the fork — it informs Week 2 framework decisions only.

## Combined fork-decision matrix

| Track 1 | Track 2 | Fork |
|---|---|---|
| ≥85% clean | #1a lands + dispatcher ≥50% | **A — Salvage** |
| ≥85% clean | #1a lands + dispatcher <50% | **B — Selective AI** (LLM stays load-bearing) |
| 50–84% clean | #1a lands + dispatcher ≥50% | **B — Selective AI** (contract gaps to close) |
| 50–84% clean | #1a lands + dispatcher <50% | **B — Selective AI** with narrower scope |
| <50% clean | any | **C — investigate root cause** (1 day) → may resolve to A/B/D |
| any | #1a fails to specify | **C — investigate root cause** |
| <50% clean AND #1a fails | — | **D — Stop** (unless investigation reveals fixable root cause) |

## Operating principles for Week 1

- These bars are pre-commit; if the operator or analyst feels pressure to "round up" Track 1 from 84% to 85%, that's the signal that the bar was wrong — the fork should be B, not A.
- Track 1 and Track 2 run independently; do not let early Track 1 results bias the #1a contract design.
- If a track's measurement reveals a previously-unknown issue (e.g., scraper rejects 80% but the root cause is a 2-line schema mismatch), document it and re-measure rather than re-baselining the bar.
- Cost/cadence numbers (per-bank token spend, wall-clock) are captured during Track 1 + Track 2 runs as a side effect; they inform Week 2 planning but do not gate the fork.

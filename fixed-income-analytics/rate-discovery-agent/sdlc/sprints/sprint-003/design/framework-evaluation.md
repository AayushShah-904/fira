# Framework Evaluation — Phase 1 Hard Gates Filter

> Phase 1 — Hard gates filter, run 2026-05-15. Phase 2 (comparison matrix) deferred to Week 2 if Fork A/B.

Sprint 003 Item #4 desk-filter of 8 TypeScript / JavaScript framework candidates against four hard gates: License, Maintenance, Runtime, TS support. Any single gate failure eliminates the candidate. No POC, no code written.

Gate cutoffs:
- **License**: pass = MIT, Apache-2, BSD-2/3, ISC, MPL-2; fail = AGPL/GPL/SSPL/BUSL/Commons Clause/proprietary.
- **Maintenance**: pass = last commit on or after 2025-11-15 AND not archived; fail = last commit before 2025-05-15 OR archived OR <50 stars without active maintainer.
- **Runtime**: pass = runs in Node 20+ single process; fail = requires separate scheduler / DB / orchestrator process.
- **TS support**: pass = TS-native API OR usable `@types`; fail = JS-only without types.

---

## Survivor summary

| # | Candidate | Category | License | Last commit | Stars | Gate result |
|---|---|---|---|---|---|---|
| 1 | Mastra | A — Agentic | Apache-2.0 (+ EE add-on) | 2026-05-13 | 23.9k | **PASS** |
| 2 | LlamaIndex.ts | A — Agentic | MIT | Archived 2026-04-30 | 3.1k | FAIL — maintenance (archived) |
| 3 | LangGraph.js | A — Agentic | MIT | 2026-05-11 | 2.9k | **PASS** |
| 4 | OpenWorkflow | B — Workflow | Apache-2.0 | 2026-04-14+ | 1.2k | **PASS** |
| 5 | Effect | B — Workflow | MIT | active 2026 | 14.2k | **PASS** |
| 6 | ts-edge | B — Workflow | MIT | 2025-06-24 | 28 | FAIL — maintenance (stale + <50 stars) |
| 7 | TsWorkflow | B — Workflow | MIT | 2023-10-08 | 14 | FAIL — maintenance (stale + <50 stars) |
| 8 | workflow-es | B — Workflow | MIT | 2025-01-18 | 217 | FAIL — maintenance (>12 months stale) |

**Survivors advancing to Phase 2 (4): Mastra, LangGraph.js, OpenWorkflow, Effect.**

Category A retains 2 of 3 (Mastra, LangGraph.js). Category B retains 2 of 5 (OpenWorkflow, Effect). The Category B field is much sparser than expected — three of five candidates are abandoned hobby projects; one (workflow-es) is the original Node port of a .NET library and has had only one cosmetic commit in 2025.

---

## Per-candidate detail

### 1. Mastra
- **GitHub**: https://github.com/mastra-ai/mastra
- **npm**: `mastra`
- **License**: Apache-2.0 for the core framework. An additional Mastra Enterprise License covers files under `ee/` directories (source-available, free for dev/test). The `ee/` packages are optional add-ons; the core that we'd build on is pure Apache-2.0. License gate evaluated against the core.
- **Last commit**: 2026-05-13 (two days before this evaluation).
- **Archived**: No.
- **Stars**: ~23.9k (rough).
- **Weekly downloads**: not retrievable (npm 403'd); GitHub activity and star velocity indicate substantial usage.
- **Runtime**: Node.js single-process; deploys as a standalone server or embedded in Next.js / React. No external scheduler/DB required for core orchestration.
- **TS support**: TS-native, 99.2% TypeScript codebase.
- **What it is**: TS-native agentic framework with built-in agents, workflows, RAG, evals, and observability; integrates 40+ LLM providers.
- **GATE RESULT: PASS** — survives to Phase 2. (Note for Phase 2: review `ee/` license boundary so we never accidentally import enterprise modules.)

### 2. LlamaIndex.ts
- **GitHub**: https://github.com/run-llama/LlamaIndexTS
- **npm**: `llamaindex`
- **License**: MIT.
- **Last commit / status**: Repository **archived on 2026-04-30**. Project officially deprecated; users redirected to LlamaCloud / LlamaParse.
- **Stars**: ~3.1k.
- **Runtime**: Node 20+, Deno, Bun, Vercel Edge, Cloudflare Workers — single-process, no external orchestrator. Would have passed runtime.
- **TS support**: TS-native (98.4% TS).
- **What it is**: Server-side data framework for LLM applications (RAG + query engines + workflows). Successor surface is the Python-only LlamaCloud product.
- **GATE RESULT: FAIL — maintenance gate (archived 2026-04-30, no longer maintained).**

### 3. LangGraph.js
- **GitHub**: https://github.com/langchain-ai/langgraphjs
- **npm**: `@langchain/langgraph`
- **License**: MIT.
- **Last commit**: 2026-05-11 (`@langchain/langgraph-sdk@1.9.2` released same day).
- **Archived**: No.
- **Stars**: ~2.9k.
- **Runtime**: Node.js single-process; also supports Deno (deno.json present). Self-hosting requires only the in-process graph runtime — managed LangGraph Cloud is optional, not required.
- **TS support**: TS-native (98% TS).
- **What it is**: Stateful, graph-based agent runtime (the TS port of Python LangGraph) for building controllable LLM workflows with branching, cycles, checkpointing, and human-in-the-loop.
- **GATE RESULT: PASS** — survives to Phase 2.

### 4. OpenWorkflow
- **GitHub**: https://github.com/openworkflowdev/openworkflow
- **npm**: published via `@openworkflow/*` packages (CLI scaffolds via `npm/pnpm/bun init`)
- **License**: Apache-2.0.
- **Last commit**: Active in 2026 (PRs created 2026-04-14, dependabot activity ongoing; v0.6.2 + `@openworkflow/cli@0.4.0` are the current line).
- **Archived**: No.
- **Stars**: ~1.2k.
- **Runtime**: Node.js or Bun, single-process workers. **Caveat for the gate**: requires a Postgres or SQLite backend for durable state — but this is "your existing database, no separate queue or orchestration service." Per gate criteria this counts as a passable single-process model (workers are in-process; the DB is a library dependency, not a separate orchestrator like Temporal/Airflow). Worth flagging in Phase 2 — if BIRD has no SQLite/Postgres in the agent path today, this adds a dep.
- **TS support**: TS-native; first-class typed inputs/outputs per step.
- **What it is**: Durable, resumable workflow SDK — wrap each step, completed steps survive crashes/deploys, workflows can sleep for months.
- **GATE RESULT: PASS** — survives to Phase 2.

### 5. Effect
- **GitHub**: https://github.com/Effect-TS/effect
- **npm**: `effect`
- **License**: MIT.
- **Last commit**: Actively maintained (7,572 commits, ongoing 2026 releases across `@effect/*` ecosystem packages).
- **Archived**: No.
- **Stars**: ~14.2k.
- **Runtime**: Node.js, Bun, browser via platform-specific packages (`@effect/platform-node`, `-bun`, `-browser`). Pure in-process library; no external services required.
- **TS support**: 100% TypeScript, designed as a TS-first effect system.
- **What it is**: Functional effect system / standard library for TypeScript — provides composable, type-safe primitives for concurrency, retries, dependency injection, schemas, streams. Not workflow-specific but the workflow primitives (Effect, Fiber, Schedule, Layer) are core to the library.
- **GATE RESULT: PASS** — survives to Phase 2. (Phase 2 note: Effect is the most general-purpose of the survivors; the question for the matrix is whether its ergonomics fit a step-graph use case or whether it's too low-level.)

### 6. ts-edge
- **GitHub**: https://github.com/cgoinglove/ts-edge
- **npm**: `ts-edge`
- **License**: MIT.
- **Last commit**: 2025-06-24 (v1.0.4) — ~11 months stale. Borderline on the >12-month cutoff, but the secondary maintenance criterion (<50 stars without an active maintainer) is hit cleanly.
- **Archived**: No.
- **Stars**: ~28.
- **Runtime**: Node.js single-process; no external services.
- **TS support**: TS-native with compile-time type validation of node connections (its differentiator).
- **What it is**: Lightweight graph execution engine where node input/output types are compile-time-validated; supports conditional branches, parallel merge, middleware.
- **GATE RESULT: FAIL — maintenance gate (28 stars + no commits in ~11 months = abandoned solo project).** The compile-time type-safe graph idea is genuinely interesting; if Phase 2 finds Mastra/LangGraph/OpenWorkflow/Effect lacking on type-safe edges, ts-edge's design could be re-implemented rather than depended on.

### 7. TsWorkflow
- **GitHub**: https://github.com/Tmarndt1/TsWorkflow
- **npm**: `ts-workflow-fluent` (per repo)
- **License**: MIT.
- **Last commit**: 2023-10-08 — ~19 months stale, well past the 12-month fail threshold.
- **Archived**: No (but effectively dormant).
- **Stars**: ~14.
- **Runtime**: Node / browser, single-process.
- **TS support**: TS-native (98.7% TS).
- **What it is**: Fluent builder workflow library — `.startWith().parallel().if().delay()` chains for sequential / parallel / conditional steps.
- **GATE RESULT: FAIL — maintenance gate (>12 months stale, 14 stars, abandoned).**

### 8. workflow-es
- **GitHub**: https://github.com/danielgerlag/workflow-es
- **npm**: `workflow-es`
- **License**: MIT.
- **Last commit**: 2025-01-18 (README update only). Last functional release was 2018-03-31. ~16 months since the README touch; the project is essentially dormant — the author moved on to the .NET `workflow-core` project.
- **Archived**: No.
- **Stars**: ~217.
- **Runtime**: Node.js / browser. **Persistence required** — needs a storage provider (memory for testing, MongoDB for production); multi-node requires Redis/Azure queue + distributed lock manager. The single-node `MemoryPersistenceProvider` is in-process and would technically pass the runtime gate, but the project is gated out on maintenance first.
- **TS support**: TS-native (100% TS), dedicated TypeScript guide.
- **What it is**: Workflow / saga / durable-task library — supports parallel for-each, conditional branching, event-waiting. The Node sibling of the (still-active) .NET workflow-core.
- **GATE RESULT: FAIL — maintenance gate (last functional commit 2018; 2025 README edit is the only sign of life in ~7 years).**

---

## Phase 1 conclusions

4 of 8 candidates clear all four gates: **Mastra, LangGraph.js, OpenWorkflow, Effect.** Both categories retain at least two survivors, so the Sprint 003 fork decision (Fork A agentic vs Fork B workflow) still has real options on both sides.

Two findings worth flagging into Phase 2:
1. **The deterministic-workflow space in TS is thin.** Three of five Category B candidates are abandoned hobby projects (<300 stars, no recent commits). Only Effect (general-purpose, not workflow-specific) and OpenWorkflow (purpose-built, but younger and less proven) survive. If Fork B is chosen, expect to either lean heavily on Effect's primitives or accept OpenWorkflow's database dependency.
2. **LlamaIndex.ts being archived 2026-04-30 is recent news** — if any earlier Sprint 003 prep referenced it as a live option, that prep is now stale.

Sources used to populate this report:
- GitHub repos (each candidate's main README + commit history pages, fetched 2026-05-15).
- npm pages 403'd during fetch; weekly download numbers omitted. Star counts and last-commit dates from GitHub are sufficient for the gate decision and acceptable for Phase 2 matrix context.

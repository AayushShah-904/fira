# Sprint 003 — Action decomposition + scraper validation + framework evaluation

**Status:** Plan drafted 2026-05-12. Not yet committed (awaits Sprint 002 close).
**Goal:** Replace the agent's monolithic exploratory-and-extraction prompt with a small set of well-defined actions, validate that the parent BIRD scraper pipeline actually consumes the agent's output end-to-end, and evaluate JS-native agentic-workflow frameworks (Mastra, LlamaIndex.ts, LangGraph.js) as a possible future orchestrator. Sets up Sprint 004 to either stay with bespoke Node scripts or migrate to a framework with confidence.

## Foundational decisions

- [ADR-011](../../../decisions/ADR-011-additive-state-semantics.md) — additive state semantics (DECIDED).
- [ADR-012](../../../decisions/ADR-012-write-discipline.md) — centralized write path + required `extraction_method` (DECIDED).
- All Sprint 001 ADRs carry over.

## Why Sprint 003 looks like this

The Sprint 002 operator-followup session (12 banks triaged on 2026-05-12) surfaced two structural observations that aren't bugs in the strict sense but shape what we should do next:

1. **The agent does inline extraction**, bypassing the deterministic extractor at `scripts/extract_rates.js` that already dispatches by `scraper_type`. The LLM finds a page, fetches it, and parses tables in-prompt — producing rates JSON directly. Selectors / column_mapping in the config get populated for completeness but the deterministic path isn't the primary executor.

2. **The parent BIRD scraper pipeline (`packages/scraper/`) is unused and untested in production.** It contains change-detection, import-with-validation, staleness audit — all the pieces a real downstream pipeline needs — but as of this writing it has no green CI run against real agent output and no operator workflow uses it. The handoff "agent produces files → scraper consumes" is currently aspirational, not validated.

These two observations interact: the agent's inline extraction works fine for a single end-to-end LLM call, but it doesn't compose. Each downstream consumer (BIRD scraper, future Vision API path, multilingual extractor, operator-resolution UI) needs to plug into a clean boundary. Sprint 003 defines those boundaries.

## Scope (in priority + dependency order)

### Item #1 — Action decomposition (the Option A core from the 2026-05-12 reflection)

Refactor the agent's tools and prompt so discovery, extraction, classification, and persistence are explicit named actions with JSON contracts rather than implicit phases inside a single LLM exploratory task.

**Eight initial actions** (~names, refine during design):

| Action | Inputs | Output |
|---|---|---|
| `find_website(bank_name, state)` | bank identity | `{ url, confidence, notes, candidates_considered[] }` |
| `find_rate_page(domain, hints?)` | website URL + optional path hints | `{ url, kind: "html"\|"pdf"\|"image", confidence, notes }` |
| `extract_html_table(url, selectors?)` | rate page URL | `{ slabs[], effective_date?, warnings[] }` or `null` |
| `extract_pdf_table(url)` | rate page URL | `{ slabs[], effective_date?, warnings[] }` or `null` |
| `extract_via_vision(url)` | image / scanned-PDF URL | `{ slabs[], confidence, raw_response }` or `null` (gated on Vision integration — see #5) |
| `classify_outcome(bank_state)` | per-bank artifacts | `{ failure_class, phase_outcomes, failure_signals }` (already exists via lib/failure-classifier.js — wrap as an action) |
| `commit_to_registry(bank_code, updates)` | partial registry-entry diff | `{ wrote: bool, deferredToPending: bool }` (goes through ADR-012's safe-write) |
| `commit_rates(bank_code, slabs, extraction_method)` | rates payload | `{ wrote: bool, deferredToPending: bool }` (safe-write) |

Sub-deliverables:

**1a.** Design doc at `sdlc/sprints/sprint-003/design/action-contracts.md` — finalize each action's JSON schema, error shape, and timing budget. Discuss whether `find_*` actions return ranked candidates (for LLM to pick) vs single results (for orchestrator to chain). ~1 day.

**1b.** Implement actions in `lib/actions/` — one file per action, each <150 LOC, each with unit tests against fixtures. ~2-3 days.

**1c.** Refactor `lib/agent.js` and the discover/extract/expand-nri prompts so the LLM agent calls actions instead of inlining the work. The agent becomes a thinner reasoning layer — "decide which action to call next" — rather than an end-to-end task. The L1/L3/L13 rules from `agent-learnings.md` get re-expressed as preconditions/postconditions on the actions. ~2 days.

**1d.** Wire `scripts/extract_rates.js`'s existing `html_static` / `html_js` / `pdf` / `mixed` dispatcher into the new `extract_html_table` / `extract_pdf_table` actions. **Reuse, don't rewrite** — the dispatcher is good code that's underused. ~half-day.

**1e.** Update `tests/lib/` per-action tests + integration test that walks one bank end-to-end through the action sequence with mocked LLM. ~1 day.

**Acceptance criteria:** the 12 banks from Sprint 002 #7 replay through the action-decomposed agent with the same success/partial/failed distribution (no regression). Cost per bank ≤ current $0.04 average. The deterministic extractor (`extract_via_dispatcher`) handles at least 50% of `automatic_*` extraction-method cases — measurable shift from `llm_inline_extraction` to specific `automatic_html_static` / `automatic_pdf` values.

### Item #2 — Validate `packages/scraper/` end-to-end (it's currently unused + untested in production)

The parent BIRD repo has `packages/scraper/cli/pipeline.ts` running: change-detection → import-with-validation → staleness audit. The code exists; CI status / production usage is unclear; **operator workflow doesn't invoke it** today.

This sprint validates whether the pipeline:
- Imports today's agent output cleanly (no schema drift).
- Catches the validation failures it's supposed to catch (range / monotonicity / completeness / delta).
- Stores rate versions per ADR-equivalent semantics in the parent (need to check).
- Survives operator-curated extraction_method values (Sprint 002 #5 introduced new values; does `import-discovery.ts` handle them?).

Sub-deliverables:

**2a.** Audit doc at `sdlc/sprints/sprint-003/implementation/scraper-pipeline-audit.md` — read `packages/scraper/`'s code, list every input it consumes, list every output / DB write, and the schemas involved. Identify any drift between what the agent produces today and what the scraper expects. ~half-day.

**2b.** Write integration tests at `packages/scraper/src/__tests__/` (or wherever the parent test layout dictates) that exercise the pipeline against a fixture of real agent outputs (the 17 successful banks from the Sprint 002 diagnostic). Each pipeline step (detect, import, validate, staleness) gets an integration test. ~2 days.

**2c.** Run the full pipeline against the current `output/latest/` and document what happens. Bug fixes as they surface. Update agent's `extraction_method` enum (ADR-012) if the scraper expects different values. ~1 day.

**2d.** Operator runbook entry — how to invoke the scraper pipeline after a successful agent batch. Goes into the parent's `sdlc/operator-runbooks/` (or equivalent). ~half-day.

**Acceptance criteria:** the scraper pipeline runs green against the 17 Sprint 002 successes + 4 Phase B successes; rate versions land in the DB with correct provenance tagging from `extraction_method`; staleness validator flags the operator-transcribed Angul / Nizamabad rates as old (effective dates 2023) so the operator knows they're aging. CI step added that runs the integration tests on every PR.

### Item #3 — Operator resolution tooling for pending changes (ADR-011 + ADR-012 backlog)

ADR-011 introduced `bank-domains-pending.json` for registry collisions; ADR-012 introduces `<slug>_rates.pending.json` for rates collisions. Both depend on an operator-resolution flow that doesn't exist yet — currently operators would have to hand-edit JSON to accept/reject pending changes.

Sub-deliverables:

**3a.** CLI tool at `scripts/resolve-pending.js`:
- `node scripts/resolve-pending.js --list` — show all unresolved pending changes (registry + rates)
- `node scripts/resolve-pending.js --bank <slug>` — show pending for one bank, prompt accept/reject
- `node scripts/resolve-pending.js --accept-all` / `--reject-all` — bulk for trivial cases
~1 day.

**3b.** Tests covering accept-flips-registry-and-clears-pending and reject-archives-without-flipping. ~half-day.

**3c.** (Optional, stretch) Web UI at `packages/web/` for the same workflow — defer to Sprint 004 if Sprint 003 capacity is tight.

**Acceptance criteria:** an operator can resolve all pending changes accumulated during Sprint 002 in <30 minutes using only the CLI. The 12-bank Phase B operator-followup session, if redone, completes through the CLI rather than hand-edits.

### Item #4 — Framework evaluation spike (two categories: agentic + workflow)

The 2026-05-12 reflection identified two distinct framework shapes that fit different parts of our system:

- **Agentic frameworks** orchestrate LLM-driven graphs where the model decides the next step. They fit the **discovery** stage where the agent reasons about which action to call (find_website → find_rate_page → extract_*).
- **Workflow libraries** orchestrate deterministic step sequences with retry / branching / saga semantics, often without a heavy server. They fit the **post-discovery** pipeline (extract → classify → commit → change-detect → import → validate → publish) where each step is code, not an LLM choice.

Our system needs both shapes. A future migration might adopt one library per category, or a single library that spans both, or stay with bespoke for one stage while adopting a library for the other. The spike answers which.

#### Category A — Agentic frameworks

| Candidate | What | Notes |
|---|---|---|
| **Mastra** | TS-native agent + workflow framework; YC-backed; new but active | TypeScript-first API; growing community |
| **LlamaIndex.ts** | TS port of LlamaIndex; agent workflows + RAG primitives | More mature than Mastra; broader scope |
| **LangGraph.js** | JS port of LangGraph (Python); state-machine graphs for LLM apps | Smaller community than Python LangGraph; production track record less established in JS |

#### Category B — Workflow libraries (lightweight; no durable-execution server required)

| Candidate | What | Notes |
|---|---|---|
| **OpenWorkflow** | Resumable workflows that can pause for seconds-to-months without extra infrastructure | Single-machine-ok; suspend/resume primitive |
| **Effect** | General-purpose TS library, functional-programming style; widely used for robust workflows with error handling + concurrency | Largest community + ecosystem of the workflow candidates; broader than just workflow but workflow-shaped use is common |
| **ts-edge** | Lightweight type-safe graph-execution engine with compile-time validation of node connections | Strong TS-type fit; small surface area |
| **TsWorkflow** | Fluent lightweight library for orchestrating step sequences with business-logic clarity | Smaller; opinionated DSL |
| **workflow-es** | Structured workflow library — parallel for-each, saga transactions, conditional branching | Has saga-pattern primitive useful for the "agent + downstream pipeline" handoff |

Three-phase structure — most candidates filter out cheaply; POC is reserved for the final 1-2 survivors. This matters because each POC is ~1 day of real code; filtering 8 candidates down to 1-2 keeps the spike from eating the sprint.

#### Phase 1 — Hard gates (~half-day, public-info only)

Walk each candidate against discard criteria; the ones that fail any single gate are out, no further evaluation needed. Result: a small table per candidate saying pass / fail / which gate.

| Gate | Pass | Fail |
|---|---|---|
| **License** | MIT, Apache-2, BSD-2/3, ISC, MPL-2 | AGPL, GPL, SSPL, BUSL, "Commons Clause", non-OSI proprietary |
| **Maintenance** | last commit ≤ 6 months ago AND not archived | last commit > 12 months OR repo archived OR <50 GitHub stars AND no active maintainer |
| **Runtime fit** | runs on Node 20+ in a single-process container (our Container Apps Job shape) | requires a separate scheduler / DB / orchestrator process |
| **TS support** | TS-native API OR `@types/<pkg>` with reasonable quality | JS-only with no usable types AND no community @types |

Failing a gate is terminal. The license gate is especially load-bearing — AGPL / GPL / SSPL libraries are non-starters for this codebase (we can't ship them).

#### Phase 2 — Comparison matrix for survivors (~1 day)

Survivors of Phase 1 get a deeper desktop eval, no code yet — read their docs, scan the source, run their getting-started examples mentally. Score each on:

| Dimension | Why |
|---|---|
| **Adoption / community** | npm weekly downloads, GitHub stars, "production users known" | Stronger signal than docs |
| **Primitives fit (agentic)** | Nodes, edges, state, checkpointing, human-in-the-loop, streaming | Maps to our discovery actions |
| **Primitives fit (workflow)** | Retry, branching, saga, suspend/resume, parallel for-each, conditional | Maps to our post-discovery pipeline |
| **Migration cost** | Port vs rewrite of our action set | Lower is better |
| **Observability** | Built-in tracing, metrics, debug surfaces | Today we hand-roll this |
| **Hosting story** | Container Apps Job compatibility, secrets handling | Cloud must work |
| **Documentation quality** | Discoverability of APIs, examples, migration guides | Tax on every future developer |

Output: ranking with brief justification per dimension. Recommended next step per candidate — `POC` / `wait-and-watch` / `discard`.

#### Phase 3 — POC the survivors (~1-2 days total, NOT per candidate)

Build small POCs for the 1-2 strongest survivors total — not 1-2 per category. Possible outcomes:
- One agentic + one workflow → 2 POCs (~2 days)
- One library that covers both convincingly → 1 POC (~1 day)
- No survivor reaches POC threshold → 0 POCs; recommendation is "stay bespoke" or "defer with triggers"

POC scope:
- **Agentic POC** (if any): run discovery against `bhatinda-central-co-operative-bank-ltd` through the framework's agent graph. Compare LOC, prompt-tokens-per-bank, debuggability, observability against item #1's bespoke action set.
- **Workflow POC** (if any): run the deterministic post-extraction pipeline (extract → classify → commit_to_registry → commit_rates → import-to-scraper) for one bank through the framework's workflow primitives. Compare against `scripts/run-phaseB-rerun.js`.

#### 4c — Recommendation

Same four possible directions (stay bespoke / single lib spans both / one per category / defer with triggers), backed by the matrix + POC evidence. Recommendation gates whether Sprint 004 includes a migration.

#### Estimate

- Phase 1 filter: 0.5 day
- Phase 2 matrix: 1 day
- Phase 3 POC(s): 0-2 days (depends on how many survive Phase 2)
- Recommendation writeup: 0.5 day
- **Total: 2-4 days for item #4** (was 5-7d before this restructure)

#### Acceptance criteria

- Spike doc at `sdlc/sprints/sprint-003/design/framework-evaluation.md` exists with: Phase 1 gate table for all 8 candidates, Phase 2 matrix for survivors, Phase 3 POC outputs (if any), and a recommendation with explicit pros / cons / triggers.
- No candidate is recommended without naming concrete code change in our system it would replace and a measured comparison (LOC delta, token cost delta, observability gain).
- License-gate failures are non-negotiable; no AGPL / GPL / SSPL candidate moves past Phase 1 regardless of other merits.

### Item #5 — Vision-API integration for image-only / scanned-PDF rate cards (L9, L10, L11)

Sprint 002 deferred this. With actions defined in #1, Vision becomes one more action (`extract_via_vision`). The 4 `pending_vision` banks from the Sprint 002 operator session (Banswara, Barmer, Ajmer, plus the image-only Angul wave) unblock when this lands.

Sub-deliverables:

**5a.** Decide on the Vision provider — Azure OpenAI GPT-4 vision, Azure Document AI, Anthropic Claude vision via API, Tesseract+post-processing. Cost / quality / latency tradeoffs in the design doc.

**5b.** Implement `lib/actions/extract_via_vision.js` — takes image URL, returns slab JSON (or null). Tests against the actual Angul rate-card image we have on file.

**5c.** Re-run the 4 pending_vision banks from the Sprint 002 operator session; verify extraction quality matches operator transcription within a tolerance (say, 95% of slabs correctly identified).

~2-3 days total.

**Acceptance criteria:** at least 3 of the 4 pending_vision banks transition to `success` (any extraction_confidence) on a Sprint 003 re-run. Vision-extracted slabs are within 5% of operator-transcribed slabs on the calibration cases (Angul, Nizamabad's Telugu image).

## Out of scope for Sprint 003 (deferred to Sprint 004+)

- Multilingual rate-string parser for tenure text (Hindi / Tamil / Telugu / Kannada / Marathi / Bengali) — L8 codification. Probably folds into the Vision-extracted output (Vision returns canonical English from any input) but worth a dedicated item if Vision doesn't suffice.
- Web UI for pending-change resolution — CLI suffices for Sprint 003.
- Migrating to whichever framework Item #4 recommends — Sprint 003 produces only the evaluation; migration is Sprint 004.
- Bicep cleanup / Flex Consumption spike — still deferred from Sprint 002.

## Acceptance criteria (sprint exit)

- [ ] Item #1 actions implemented; 12-bank replay shows no regression in success rate.
- [ ] Item #2 packages/scraper validated; integration tests in CI; operator runbook entry exists.
- [ ] Item #3 resolve-pending CLI exists; tested; doc exists.
- [ ] Item #4 framework evaluation doc + 3 POCs committed; recommendation made.
- [ ] Item #5 Vision integration unblocks ≥3 of 4 pending_vision banks; calibration acceptable.

## Risks

- **Item #2's scraper audit may reveal significant drift.** If `import-discovery.ts` doesn't accept today's agent output, that's a real schema fix in the parent repo (not just rate-discovery-agent). Reserve buffer days.
- **Item #4's framework POCs may not be feasible in a Sprint** if any framework requires significant setup (DB, deployment, etc.). Drop to 2 frameworks if needed; LangGraph.js + Mastra is the priority pair.
- **Item #5's Vision provider choice has cost implications** — GPT-4 vision is $0.01-0.03 per image, Azure Document AI is more, Tesseract is free but lower quality. The cost-per-category-run math matters for the long-term scale.

## Estimate

- Item #1: ~5-7 days
- Item #2: ~3-4 days
- Item #3: ~1.5 days
- Item #4: ~2-4 days (3-phase filter → matrix → POC only the 1-2 strongest survivors; most candidates filter out at license / maintenance gates)
- Item #5: ~2-3 days
- **Total elapsed: 2-3 weeks**, single developer. Item #4's three-phase structure (filter → matrix → POC survivors only) keeps the framework spike from eating the sprint; the bigger driver of variance is whether item #2's scraper audit finds significant drift.

## Notes on sequencing vs Sprint 002

Sprint 003 starts after Sprint 002 #15 lands (the ADR-012 implementation work). Item #1's actions ALL route writes through `lib/safe-write.js`; without that helper, the action decomposition would just multiply the destructive-write surface area.

Sprint 002 #16 (cloud smoke of the 12-bank subset) may happen during Sprint 003's early days — that's fine; the two don't interfere.

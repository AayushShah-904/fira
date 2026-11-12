# Sprint 003 Week 1 — Fork decision

**Date:** 2026-05-15 (Sprint 003 Week 1 Day 4; one day ahead of plan)
**Decision basis:** Pre-committed bars in `week1-bars.md`; results in `scraper-pipeline-run-2026-05-15.md` (Track 1) and `1d-dispatcher-sample.md` (Track 2); framework Phase 1 result in `design/framework-evaluation.md` (Track 3).
**Decision:** **Fork A — Salvage and commit Sprint 003 as planned.**

## Track results vs. bars

| Track | Bar | Result | Vote |
|---|---|---|---|
| Track 1 (#2c — packages/scraper plumbing) | ≥85% clean import | **90.2%** (258 of 286 banks) | Fork A |
| Track 2 (#1d — deterministic dispatcher) | ≥50% deterministic success | **75%** (9 of 12 banks) | Fork A |
| Track 3 (#4 P1 — framework hard gates) | informational | 4 survivors (Mastra, LangGraph.js, OpenWorkflow, Effect) | feeds Week 2 |

Both load-bearing tracks vote Fork A. Decision is unambiguous.

## Why this is Fork A and not Fork B

The fork-decision matrix in `week1-bars.md` would have produced Fork B if Track 1 were green but Track 2 dropped below 50%. The initial Track 2 run produced 16.7% — which would have voted Fork B (Selective AI / Hybrid). The re-run with TLS verification relaxed produced 75%, voting Fork A.

The 16.7% → 75% delta was entirely TLS handshake failures on `.bank.in` domains, **not** dispatcher logic failures. This is an operator environment issue (missing RBI CA chain in the Windows root store), one-line config fix (`NODE_EXTRA_CA_CERTS`), not a code defect. **The true dispatcher pass rate is 75%, not 16.7%.** Fork A applies.

We do not "round up" to Fork A from genuine Track 2 weakness. We classify the TLS issue as an environment gap and remediate in Sprint 003 #1b operator runbook (one line), not as a methodology failure.

## What this means

Fork A commits Sprint 003 as drafted in `re-think-plan.md` Week 2+ and `plan/scope.md`:

- **Item #1 (action decomposition)** — Week 1 produced #1a (action-contracts.md, operator-answered Q1–Q13) and #1d (dispatcher action wired + measured). Week 2 produces #1b (implement the 9 actions), #1c (refactor lib/agent.js into the deterministic orchestrator with scoped LLM use), #1e (per-action tests + integration test).
- **Item #2 (packages/scraper validation)** — Week 1 produced #2a (audit) and #2c (live import). Week 2 produces #2b (integration tests in CI) and #2d (operator runbook).
- **Item #3 (operator resolution CLI)** — full implementation in Week 2.
- **Item #4 (framework eval)** — Phase 2 (comparison matrix) and Phase 3 (POCs of 1–2 strongest survivors) in Week 2.
- **Item #5 (Vision integration)** — provider selection + implementation in Week 2 / 3.

Sprint 003 estimate from `plan/scope.md`: 2–3 weeks single-developer. We are one day ahead going into Week 2.

## Branching decision (2026-05-15) — stay on `azure-openai-agent`

Operator decision: **skip the `azure-openai-agent` → `main` merge.** Continue Sprint 003 development on the current branch. At Sprint 003 close (when build is stable), the rate-discovery-agent moves to its own repo (per `project_agent_repo_split.md` memory). The repo split is the new merge target, not parent BIRD's `main`.

Implication: deferred item E1 (branch merge) is replaced by E5 (repo extraction at Sprint 003 close). All Week 2+ commits land on `azure-openai-agent`. No mid-sprint branch policy change; no impact on Week 2 task order.

## Week 2 first tasks (in order)

1. **Implement A8 `commit_rates`** ✅ done 2026-05-15 (15 tests, all passing).
2. **Implement A7 `commit_to_registry`** — thin adapter over `lib/domain-cache.js::updateDomainEntry`, half-day.
3. **Implement A3 `extract_html_table`** with cheerio-selector-aware canonical-table picking, `hints.cached_body` support (TLS-bypass-friendly), and **completeness-check logic that surfaces dispatcher-vs-LLM count discrepancies as a warning** (per the LLM under-extraction finding below).
4. **Measure under-extraction scope** (Week 2 Day 1 ad-hoc): for the 56 banks visible to have special-tenure FDs, run the dispatcher against cached HTML and report dispatcher-vs-pack slab counts. This sizes the pack v2 lift before committing to a full re-extraction.
5. **Track 1 follow-up bugs** — *partially done 2026-05-16:* tenure-parser hyphen-separator fixed; JSON 0x1C sanitization done; 5 banks of 8 with critical flags cleaned (Rabobank, Punjab Sind, IDBI IBU GIFT, IndusInd FCNR, South Indian FCNR). Remaining: em-dash IBU slug mismatch (11 unmatched banks) + the 3 banks with real-data critical flags (AB Bank, axis-bank-ibu, punjab-national-bank-ibu) needing operator review.
6. **ADR-014: Validation as a single shared package** — ✅ done 2026-05-16. ADR at `sdlc/decisions/ADR-014-shared-validation-package.md`. Canonical TS module at `packages/shared/src/validation/`. CJS twin at `rate-discovery-agent/scripts/utils/validation-constants.js`. `validate-rates.js` refactored to consume. `packages/scraper/src/validators/{range,delta}.ts` rewired as adapters over the shared module (range.ts: VARIANT_RATE_RANGES, NO_SENIOR_VARIANTS, SENIOR_PREMIUM, SUPER_SENIOR_PREMIUM, CRITICAL_OVERSHOOT, getRateRange; delta.ts: getDeltaThreshold). Verified via Track 1 re-run: 12 critical flags across 3 banks identical pre/post migration; warnings dropped from 1067 to 1045 (the 22-warning delta is intentional — the PSB 7-day short-tenure rates at 2.0-2.5% no longer trip the false "below floor" warning; matches the ADR-014 reconciliation table). 10 drift-check tests pass. **Still deferred to follow-up:** `scripts/refresh/sanity-gate.js` migration (file lives in untracked `scripts/refresh/` so blocked on a separate commit decision for that directory); `format-rules.ts` and `completeness-rules.ts` shared submodules (no current duplication; wait for first one).
7. **Sprint 003 #2b CI integration tests for packages/scraper** — ✅ done 2026-05-16. `packages/scraper/src/__tests__/validator-agreement.test.ts` — 14 vitest tests assert the consolidated validators produce equivalent severity assignments across agent (`scripts/utils/validate-rates.js` via `createRequire`) and scraper (`validators/index.ts`). Coverage: happy path, tenure-order critical, range warning at max+1.0, range critical at max+CRITICAL_OVERSHOOT (12%), in-band-floor 2.0% (ADR-014 reconciliation case — both pass clean), senior<general warning, super-senior at max+SUPER_SENIOR_PREMIUM (11.0%, passes), FCNR variant bounds (USD 4.5% passes, 9.0% warns), delta thresholds (PSB 50 bps warning, SFB 75 bps no-warning at 60bps, 110+bps critical). All 14 pass. Runs via `npx vitest run --project scraper`. **End-to-end import-with-real-DB integration test** deferred — needs a fixture-DB harness; the agreement-on-rules test gives most of the value.

8. **Sprint 003 #1c orchestrator + remaining actions** — ✅ done 2026-05-16. All 9 actions and the orchestrator implemented as real code (no stubs):
   - `lib/actions/classify_outcome.js` — A6, thin adapter over `lib/failure-classifier.js`.
   - `lib/actions/classify_rate_page.js` — A2b, HEAD-fetch + content-sniff classification (html_static / html_js / pdf / image) with mode="discover"|"recheck".
   - `lib/actions/find_rate_page.js` — A2, anchor parsing on homepage HTML, NRI-eligibility gate, path-pattern fallback, mode-aware.
   - `lib/actions/find_website.js` — A1, deterministic-first: try `<slug>.bank.in` (RBI convention) + acronym variants, then web-search via Bing or Azure OpenAI Responses API, rank candidates by TLD priority + name match, reject aggregator domains.
   - `lib/actions/extract_pdf_table.js` — A4, wraps `scripts/extract_rates_pdf.mjs` and applies Q8 multi-page grouping (per-slab `_page` field → page records; heading-based grouping; single-page fallback). Emits `structure_hint` for future-pass optimization.
   - `lib/actions/extract_via_vision.js` — A5, real Azure OpenAI vision call (gpt-4o or `AZURE_OPENAI_VISION_DEPLOYMENT`) with focused JSON-only extraction prompt; FCNR/GIFT currency handling included. Emits `extraction_method: "vision_model"` per Q9. Returns null cleanly when AOAI not configured.
   - `lib/orchestrator.js` — deterministic per-Q13 orchestrator that walks: find_website → commit_to_registry → for each product { find_rate_page → classify_rate_page → extract_* → commit_rates } → classify_outcome. Multi-page PDF support; persists `pdf_structure` hint back to bank-domains.json. NRI variants conditionally queried per `shouldQueryNri(bank_type, bank_code)` (PSB/PVB/FB/IBU always; SFB only for AU/Equitas/Ujjivan/IDFC-First/Bandhan per CLAUDE.md). Every step wrapped so a throw becomes a structured `phase_events` entry; missing/disabled actions degrade gracefully.
   - **59 new tests added** (287 → 346 passing; 1 skipped, 0 failed). Test counts per module: classify_outcome 3, classify_rate_page 10, find_rate_page 11, find_website 13, extract_pdf_table 6, extract_via_vision 7, orchestrator 9.

## Late finding (2026-05-15) — strengthens Fork A

After the Track 2 result landed, operator flagged that "dispatcher over-extracted vs. LLM" was the wrong framing — the LLM might have under-extracted. Verifying against cached HTML revealed both patterns:

- **Capital SFB** — source HTML has 11 rate-bearing rows; dispatcher captured 11; LLM captured 7 (missed 4 special-tenure slabs: 12M, 400D, 600D, 900D). LLM under-extracted **36%** of slabs — exactly the highest-yield "special period" FDs that are most valuable to a consumer comparison product.
- **AB Bank PLC** — source HTML has 23 rate-bearing rows across 3 customer segments and multiple deposit-amount tiers; dispatcher captured 23; LLM captured 8 (representative subset from one segment). Here the LLM was "wisely incomplete" given the schema lacks a `customer_segment` field — but the schema gap is itself a finding.

Scope: **56 banks in the pack visibly have at least one captured special-tenure FD** (tenure between 400 and 999 days). The real exposed population is larger — banks where the LLM missed special tenures entirely don't show up in this scan. The Capital SFB pattern (LLM extracts regular tenures but misses special ones) is the at-risk class.

**This strengthens Fork A's case:** action decomposition is the right architectural primitive to fix this. A3 owns extraction; one completeness check at the action boundary catches the under-extraction across all banks. Without decomposition, fixing this means re-engineering the monolithic LLM prompt and hoping it generalizes.

Both result docs (`1d-dispatcher-sample.md` and `pack-confidence-memo-for-pm.md`) updated with the corrected framing. The PM memo gains an explicit caveat that pack v1 likely under-represents banks' highest-yield rates.

## Constraints carried into Week 2

- **Cloud stays paused.** Kill-switch (`BIRD_DISABLE_GIT_PUBLISH=1`) remains on. Cloud track (deferred items B1–B9) only revisited if Sprint 003 closes with capacity remaining, and only after a fresh end-to-end test gate is in place.
- **Pack v1 stays "preview" with PM.** A v2 refresh ships only at Sprint 003 close, after methodology fixes (A1 validation gate, A2 effective-date LLM, A4 multi-page PDF, dispatcher over-extraction fix).
- **All operator-decisions Q1–Q13 are locked.** Future Week 2/3 implementation must respect the contracts as revised on 2026-05-15.

## What this decision explicitly is NOT

- **Not a declaration that AI works for everything.** The 90.2% scraper-import number is plumbing-passes; correctness gaps remain (PNB column ambiguity, BoB effective-date) and are Sprint 003 Item #1 fixes.
- **Not a green light for cloud.** Cloud's failure modes from Sprint 002 are unaddressed by Week 1's work. Cloud comes back only with a first-class end-to-end test.
- **Not a commitment to any specific framework (Mastra / LangGraph.js / OpenWorkflow / Effect).** Phase 2 in Week 2 evaluates the 4 survivors via the comparison matrix; Phase 3 POCs at most 1–2; final recommendation could still be "stay bespoke".

## Memory and handoff updates

- `project_sprint002_status.md` reflects Sprint 003 reorder and fork decision pending → now decided Fork A.
- `project_workflow_orientation_decision.md` reflects the framework Phase 1 survivor set.
- `MEMORY.md` index already updated.

## Signed off

Operator review: pending (read this doc and the two track results, then explicitly confirm Fork A to authorize Week 2).

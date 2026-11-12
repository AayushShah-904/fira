# Plan: Front-load Sprint 003 to answer the existential question

## Context

We are at an existential decision point on the rate-discovery-agent project.

**The trigger.** Sprint 002 produced two visible outputs:
1. A rate pack (`pack/dist/rates-pack.json`, 2.1 MB, 292 banks, 4,806 slabs) generated 2026-05-14, shipped to the PM with an explicit "be careful" caveat.
2. A cloud-deployed agent (Function App + Container Apps Job + Bicep) that consumed days and ~$64 AOAI on the last attempt alone, producing zero new artifacts.

**Operator stance.** No confidence in what was delivered. The Sprint 002 cloud-state handoff (`sdlc/sprints/sprint-002/retrospection/cloud-state-handoff-2026-05-13.md`) is honest about cloud-track-not-shipped.

**The question.** Can AI reliably extract production-grade rate data for ~1,900 Indian banks, or do we abandon AI for this project? Operator's working hypothesis (from this conversation, matching the 2026-05-12 reflection): the monolithic LLM agent is the wrong primitive; a **workflow of small, focused, context-guided AI actions** wrapped in deterministic orchestration is the right one.

**Why this plan exists.** Sprint 003 has a drafted scope (`sdlc/sprints/sprint-003/plan/scope.md`, 2026-05-12) that already addresses this — Items #1 (action decomposition), #2 (validate packages/scraper end-to-end), #4 (framework eval spike). The risk is committing ~3 weeks to Sprint 003 and learning the answer is "no" at the end. The remedy is reorder, not redesign: front-load the items that answer the existential question for the lowest cost, then commit or pivot.

## What's already true (so we don't relitigate)

Pieces of the answer already exist; the plan must respect them:

- **Sprint 003 scope is drafted and load-bearing.** Items #1, #2, #4 directly address "is the workflow-of-actions approach feasible" and "does the downstream deterministic safety net catch errors". Do not redesign; reorder and use.
- **`packages/scraper` is built but never operated end-to-end.** 7-layer validation, change-detection, import with versioning — all coded, none of it has been run against real agent output. No `.db` file in the repo. Sprint 003 Item #2 is the test.
- **`pack/dist/rates-pack.json` bypasses packages/scraper.** It's a bridge product for PM's standalone UI (per memory `project_rates_pack_purpose.md`). Pack quality and DB-ingestion quality are separable concerns.
- **The refresh pipeline already has multi-stage gating** (sanity-gate + LLM verify @ $0.82) — defensible methodology, not the methodology the user fears. The pack is post-verification, not raw scrape; 93 banks were held back.
- **The 2026-05-12 framework-orientation decision** stands: decompose actions first, evaluate frameworks in Sprint 003 Item #4 with hard gates (license, maintenance, runtime, TS support) before any POC. No commitment yet.
- **Cloud loop is broken in known ways**, fixes committed (`6203417` + four follow-ups) but undeployed. Kill-switch on. Cloud stays paused this plan.

## Reframing: "AI" is not one thing

Important for the workflow-of-actions hypothesis. Several AI capabilities exist; each has its own pre-AI fallback:

| Capability | How AI is used today | Pre-AI fallback |
|---|---|---|
| Bank-website discovery | LLM web search + classification | Manual one-time data entry into `data/bank-domains.json` |
| Rate-page URL discovery | LLM follows homepage links | Hand-curated per bank |
| Scraper-tier classification | LLM inspects fetched HTML | Per-bank manual classification |
| Static HTML table extraction | Deterministic (cheerio + column mapping) | Same — already deterministic |
| JS-rendered table extraction | Playwright + LLM table interpretation | Playwright + per-bank CSS selectors |
| PDF rate-card extraction | LLM reads PDF | OCR + hand-tuned parsers per bank |
| Sanity gate | Deterministic rules | Same — already deterministic |
| LLM verification of suspicious extractions | gpt-4.1-mini re-extracts | Manual review |
| Effective-date extraction | Naïve regex (currently buggy) | LLM extraction (likely more reliable) |

The workflow hypothesis lets us be surgical: keep AI where it earns its keep, replace it where deterministic works. Action decomposition (#1) is what makes the surgical move possible — today the agent does discovery + extraction + classification + write inline in one prompt, so the seams aren't clean enough to swap pieces.

## What is broken (and what kind)

| # | Issue | Kind | Sprint 003 item that handles it |
|---|-------|------|---|
| 1 | `validate-rates.js` records errors inside JSON files but doesn't block writes | Engineering bug | Falls under #1c when actions tighten contracts |
| 2 | Effective-date regex hits page boilerplate (BoB "1st July 1995") | Naïve extractor | #1b — new `extract_*` actions own this |
| 3 | PNB "Existing vs Revised" two-column layouts defeat extraction | AI limitation | #1a/#1b prompt design, possibly #5 vision |
| 4 | Agent generates inconsistent `bank_code`; slug-guard post-corrects | AI discipline | #1c — actions enforce slug contract |
| 5 | Cloud `sync.js push` aborts atomically — one bad JSON kills the run | Infra bug | Out of scope this plan; cloud stays paused |
| 6 | Tool errors at DEBUG only, invisible in cloud logs | Infra observability | Out of scope this plan |
| 7 | Bicep `appSettings` is replace-not-merge | Infra design | Out of scope this plan |
| 8 | Function App layer is structurally unnecessary | Infra overreach | Out of scope this plan |
| 9 | Sprint 001/002 cloud smokes declared success on Job exit-code | Validation discipline | Out of scope this plan |
| 10 | 162 banks (97 unreachable + 65 extraction-failed) = ~36% of cohort produced no new data | Coverage gap | After fork decision |
| 11 | Pack carries forward stale data: 149 of 4,806 slabs are freshly verified | Freshness representation | PM memo, this plan |
| 12 | Discovery debt for ~1,600 banks not yet in `bank-domains.json` | Coverage gap | After fork decision |
| 13 | Branch `azure-openai-agent` is 77 commits ahead of main, never merged | Merge debt | Sprint 003 first task post-decision |

Only #2, #3 are genuine "AI does not handle this" problems, both addressed by Item #1. The rest are engineering or infrastructure.

## The proposal: Sprint 003 Week 1 = existential-answer week

Reorder Sprint 003 so the cheapest existential-question answers come first. After Week 1, commit to the rest of Sprint 003 or pivot — with evidence.

### Week 1 (5–6 days): three answers in parallel

**Track 1 — Validate the deterministic downstream (Sprint 003 Item #2a + #2c, ~2 days).**

Question: *Does packages/scraper actually accept current agent output? What does its 7-layer validation flag?*

- **#2a** Audit doc at `sdlc/sprints/sprint-003/implementation/scraper-pipeline-audit.md`. Read `packages/scraper/src/import/import-discovery.ts` + all 7 validators. List inputs, outputs, schema expectations. Flag drift from today's agent output. (~0.5 day.)
- **#2c** Run `packages/scraper/cli/import.ts` + `validate.ts` against current `output/latest/`. Capture: how many banks imported clean, how many flagged at which layer, what the failure-class distribution looks like. (~1 day.)
- Defer #2b (CI integration tests) and #2d (operator runbook) to after fork decision.

Signal: if packages/scraper accepts ≥85% of agent output without manual fix, the deterministic safety net works and AI doesn't need to be perfect. If it accepts <50%, either the scraper or the agent's contract is broken — investigate which.

**Track 2 — Validate the workflow-of-actions hypothesis (Sprint 003 Item #1a + #1d, ~1.5 days).**

Question: *Can we actually decompose the monolithic agent into 8 named actions with clean JSON contracts, and does at least one (the deterministic dispatcher) replace LLM work?*

- **#1a** Design doc at `sdlc/sprints/sprint-003/design/action-contracts.md` — finalize each action's JSON schema, error shape, timing budget. Decide whether `find_*` actions return ranked candidates or single results. (~1 day.)
- **#1d** Wire `scripts/extract_rates.js`'s existing `html_static`/`html_js`/`pdf`/`mixed` dispatcher into a single new `extract_html_table` action. Pure refactor; no LLM change yet. Run it against the 12-bank Sprint 002 sample; measure tokens saved vs. inline LLM extraction. (~0.5 day.)

Signal: if #1a produces clean contracts the team is happy with, AND #1d shows the deterministic dispatcher handles ≥50% of cases the LLM currently inlines, the workflow approach is feasible. Item #1b/#1c/#1e (the bulk of the implementation work) commits next week.

**Track 3 — Filter framework candidates (Sprint 003 Item #4 Phase 1, ~0.5 day).**

Question: *Are there any framework libraries worth POC'ing, or do we stay bespoke?*

- Apply hard gates (license, maintenance, runtime, TS support) to all 8 candidates: Mastra, LlamaIndex.ts, LangGraph.js, OpenWorkflow, Effect, ts-edge, TsWorkflow, workflow-es.
- Output: gate table per candidate at `sdlc/sprints/sprint-003/design/framework-evaluation.md` Phase 1 section. Survivors get Phase 2 in Week 2 only if Track 1 + Track 2 say "salvage".

Signal: if zero candidates survive Phase 1 (likely 2–4 do), the framework question is closed in half a day and we know we're staying bespoke for now.

### Parallel: PM memo + Sprint 002 close (~1 day, Week 1)

Independent of the three tracks above:

**PM pack confidence memo** (`sdlc/sprints/sprint-003/probe/pack-confidence-memo-for-pm.md`, ~1 hour):
- Freshness: 149 of 4,806 slabs freshly verified; rest carried forward 2–6 months.
- Confidence: 300 high / 8 medium / 2 low / 45 unknown.
- Held-back list: 93 banks from `_suspicious.json`.
- Known-bad list: BoB NRE/NRO effective_date, PNB-style, any `extraction_confidence: "low"`/`"unknown"`.
- Coverage gap: ~162 banks not represented.
- Decision date: end of Week 1.

**Sprint 002 formal retro** (`sdlc/sprints/sprint-002/retrospection/retro.md`, ~0.5 day):
- Split deliverables: "local: shipped" vs. "cloud: not shipped".
- DCCB lift number unknown (cloud-loop didn't produce measurable data).
- Cloud track descoped to Sprint 003 pending fork decision.
- Link to handoff doc + this plan.

### Week 1 decision gate (end of Week 1, ~0.5 day)

Single decision doc at `sdlc/sprints/sprint-003/implementation/week1-decision.md`. Reads the three tracks' outputs and picks one fork:

- **Fork A — Salvage and commit Sprint 003 as planned.** Tracks 1+2 both green. Continue Item #1 (b/c/e), Item #2 (b/d), Item #4 Phases 2+3, then Items #3 and #5. Refresh and ship pack v2 at sprint exit.
- **Fork B — Selective AI / Hybrid.** Track 1 green but Track 2 reveals AI works only for some bank types (e.g., PSB/PVB clean HTML), not others. Sprint 003 continues #1 but scope narrows; long tail gets per-bank deterministic scrapers instead.
- **Fork C — Workflow-not-AI.** Track 1 fails badly (scraper rejects most agent output) AND/OR Track 2 reveals the action decomposition is not better than the monolithic agent. Pivot: keep packages/scraper, replace rate-discovery-agent with per-bank deterministic scrapers, reuse the discovery scaffolding (`data/bank-domains.json`, scraper-tier classifications) as input.
- **Fork D — Stop.** Combined evidence says neither AI nor deterministic-per-bank is economically viable for ~1,900 banks. Hand pack v1 to PM as "research preview" and shelve project pending different product fit.

### What Week 1 does NOT do

- Does not re-run cloud. Kill-switch (`BIRD_DISABLE_GIT_PUBLISH=1`) stays on.
- Does not refresh the PM pack.
- Does not start Item #1b/#1c/#1e (the bulk implementation) — those are Week 2 if fork allows.
- Does not POC any framework — Phase 2/3 of Item #4 only if fork A or B.
- Does not merge `azure-openai-agent` to main — first task of Week 2 if fork A or B.
- Does not modify production code in `lib/` or `scripts/` (except `#1d`'s thin dispatcher wiring, which is genuine Sprint 003 work).

## Decision bars (set before running so they can't move)

- **Track 1 / packages/scraper acceptance**: ≥85% of current `output/latest/` banks import clean (no validation errors). 50–85% triggers fork B; <50% triggers fork C investigation.
- **Track 2 / action decomposition feasibility**: design doc lands with all 8 action contracts agreed on; deterministic dispatcher handles ≥50% of the Sprint 002 12-bank sample without LLM extraction. Either failure triggers fork B/C investigation.
- **Track 3 / framework candidates**: informational only; result feeds Week 2 if fork allows.

These bars are pre-commit; document them in `sdlc/sprints/sprint-003/implementation/week1-bars.md` on Day 1 of Week 1.

## Week 2+ (gated on Week 1 fork)

This plan does not predetermine Week 2. The decision doc at end of Week 1 names the next 2 weeks' scope based on fork. For reference, the original Sprint 003 estimates from `scope.md`:

- Item #1 (action decomposition): ~5–7 days (of which 1.5 land in Week 1)
- Item #2 (scraper validation): ~3–4 days (of which 2 land in Week 1)
- Item #3 (resolve-pending CLI): ~1.5 days
- Item #4 (framework eval): ~2–4 days (of which 0.5 lands in Week 1)
- Item #5 (Vision integration): ~2–3 days

Total ~2–3 weeks single-developer if fork A. Forks B/C compress significantly (Items #3, #5 may not be relevant).

## Critical files to read first (in this order)

1. `sdlc/sprints/sprint-002/retrospection/cloud-state-handoff-2026-05-13.md` — the existing retro; spine of this plan.
2. `sdlc/sprints/sprint-003/plan/scope.md` — the drafted Sprint 003 plan; this plan reorders it, doesn't replace it.
3. `sdlc/sprints/sprint-003/plan/sub-agents.md` — exists; not yet read in this session.
4. `output/refresh/2026-05-13T17-29-11/report.txt` (rest of file, lines 201+).
5. `output/refresh/2026-05-13T17-29-11/_suspicious.json` and `_promoted.json` — for PM memo.
6. `packages/scraper/src/import/import-discovery.ts` — what packages/scraper expects from agent output (Track 1).
7. `packages/scraper/src/validators/` — 7 validators; Track 1 reads these.
8. `scripts/extract_rates.js` — the deterministic dispatcher #1d wires in.
9. `lib/agent.js` and the discover/extract prompts — what gets refactored in Item #1c (Week 2 if fork allows).

## Existing utilities to reuse (do not rebuild)

- `scripts/refresh/{build-cohort,detect-changes,extract-and-diff,sanity-gate,verify-with-llm,promote}.js` — full refresh pipeline.
- `scripts/extract_rates.js` — deterministic dispatcher (Item #1d wires it in).
- `scripts/utils/{slugify,validate-rates}.js` — canonical utilities.
- `lib/safe-write.js`, `lib/slug-guard.js`, `lib/failure-classifier.js` — existing ADR-012 + classification infrastructure.
- `scripts/analysis/compare-cohort-runs.js`, `select-dccb-diagnostic-sample.js` — analysis scaffolding pattern.
- `packages/scraper/src/cli/{import,validate,detect,pipeline}.ts` — Track 1 runs these as-is.

## Week 1 deliverables (concrete artifacts)

By end of Week 1, the following must exist:

- `sdlc/sprints/sprint-003/implementation/week1-bars.md` (Day 1)
- `sdlc/sprints/sprint-003/probe/pack-confidence-memo-for-pm.md` (Day 1)
- `sdlc/sprints/sprint-002/retrospection/retro.md` (Day 2)
- `sdlc/sprints/sprint-003/implementation/scraper-pipeline-audit.md` (#2a, Day 2)
- `sdlc/sprints/sprint-003/design/action-contracts.md` (#1a, Day 3)
- `sdlc/sprints/sprint-003/design/framework-evaluation.md` Phase 1 section (#4 P1, Day 3)
- Track 1 import/validate run output (#2c) — captured at `sdlc/sprints/sprint-003/implementation/scraper-pipeline-run-2026-05-XX.md` (Day 4)
- Track 2 dispatcher wiring (#1d) — code in `lib/actions/extract_html_table.js` + test results (Day 4)
- `sdlc/sprints/sprint-003/implementation/week1-decision.md` — single decision doc naming the fork (Day 5)

## Cleanup: duplicate plan file

The repo currently has `sdlc/sprints/sprint-003/re-think-plan.md` which is a verbatim copy of an earlier version of this plan (probe-shaped). After this plan is approved, that file should be deleted or replaced with a pointer to this plan's accepted version — they will diverge otherwise. Not blocking; flag for end of Week 1 housekeeping.

## Deferred items inventory (do not re-discover)

This section captures every issue and Sprint 003 sub-item this plan defers. Each entry has enough surrounding context — file paths, line numbers, evidence, prior decisions — that a future session can pick up without re-doing the reconnaissance from this session. If new evidence supersedes an entry, update it in place rather than carrying stale assumptions.

### A. Engineering bugs (in rate-discovery-agent codebase)

**A1. `validate-rates.js` records errors inside JSON files but does not block writes.**
- Evidence: `scripts/extract_rates.js:380-410` calls `validateSlabs()` and stores results in the output JSON's `warnings`/`errors` arrays, then writes the file regardless. Only the CLI invocation of `validate-rates.js` (line 188) exits on errors.
- Impact: broken slabs (zero rates, swapped general/senior, missing tenure days) land in `output/latest/`.
- Sprint 003 home: Item #1c — when the agent is refactored to call actions, the `commit_rates` action becomes the single write path and can gate on `validateSlabs()`. Estimate: half-day inside the #1c refactor.
- Cross-check before fixing: confirm packages/scraper's import validator catches the same classes (Track 1 audit) — if it does, this is "double-gate", if not, this fix is the only gate.

**A2. Effective-date extraction regex hits page boilerplate.**
- Evidence: `output/refresh/2026-05-13T17-29-11/report.txt:58-72` — Bank of Baroda NRE/NRO records `"effective_date": "1st July 1995"`, clearly a false positive from a copyright/disclaimer line.
- Affected banks in 2026-05-13 run: BoB NRE/NRO (lines 58-71), several SUCB/DCCB banks with similar pattern (operator should spot-check the `report.txt` for `1st July 1995` and `01-11-2021`-style false dates).
- Root cause: regex extractor in (likely) `scripts/extract_rates.js` or an inline LLM prompt; needs source-locating during fix.
- Sprint 003 home: Item #1b — the `extract_html_table` action owns effective_date detection; replace regex with focused LLM ask ("given this rate page HTML, what is the effective_date in ISO format? Return null if not stated."). Estimate: half-day.

**A3. PNB "Existing vs Revised" two-column rate layouts defeat both deterministic and LLM extraction.**
- Evidence: `cloud-state-handoff-2026-05-13.md:174-199` — handoff doc names this class explicitly. Layout is `Tenure | Existing Rate | Revised Rate` — the LLM picks one column non-deterministically; the deterministic extractor maps `Existing` to `rate_general_pct`.
- Affected banks: punjab-national-bank (most evident), possibly others with similar publication style.
- Sprint 003 home: Item #1a action-contract design must include an explicit "ambiguous-column" outcome; Item #1b prompt design either rejects extraction (with `failure_class: ambiguous_layout`) or returns both columns with metadata. Item #5 (Vision) is an alternative path if PNB publishes images.
- Risk: this is a "long tail" — every few banks have idiosyncratic layouts. The action-contract must allow graceful rejection, not best-guess extraction.

**A4. Agent generates inconsistent `bank_code`; `slug-guard.js` post-corrects.**
- Evidence: `lib/slug-guard.js:84-142` — `enforceSlug` function rewrites mismatched `bank_code` fields after the agent writes; rogue files (e.g., `<slug>_current_rates.json`) get moved to `_rogue/`.
- Sprint 001 observed a "slug-ghost cohort" in DCCB runs (handoff doc line 17). Guard masks this rather than preventing.
- Sprint 003 home: Item #1c — actions enforce slug via the canonical `scripts/utils/slugify.js` at the action boundary. The `commit_rates` action takes `bank_code` as a parameter from the orchestrator (which derives it canonically), not from the LLM's free-text output. Estimate: half-day within #1c.

### B. Cloud infrastructure (kill-switch on; defer until product methodology validated)

**B1. `cloud/sync.js push` aborts atomically — one bad JSON file kills the whole run.**
- Evidence: handoff doc line 45. Today's DCCB attempt: a `raichur-..._config.json` with an unterminated string aborted the push; container exited 2; all ephemeral output lost.
- Fix: committed in `6203417` (best-effort push); not yet built/deployed. Image `7671a11` still runs.
- Sprint 003 home: only if Week 1 fork keeps cloud. If yes, this is the first cloud item — build and deploy `6203417` end-to-end.

**B2. Cloud tool errors log at DEBUG only, invisible in Container Apps logs.**
- Evidence: handoff doc line 49. Agent's "consecutive tool errors, forcing completion" log line gives no tool name or error payload.
- Fix: committed in `6203417` (WARN-level logging); not yet deployed.
- Sprint 003 home: same as B1; ships with the `6203417` deploy.

**B3. Bicep `appSettings` is replace-not-merge; runtime config drifts on every re-apply.**
- Evidence: handoff doc line 51. `WEBSITE_RUN_FROM_PACKAGE` and the kill-switch (`BIRD_DISABLE_GIT_PUBLISH`) get wiped by every `az deployment group create` re-apply.
- Partial mitigation: ADR-013 parameterizes `WEBSITE_RUN_FROM_PACKAGE`. Kill-switch and other deploy-time settings still have the trap.
- Sprint 003 home: only if Week 1 fork keeps cloud. Long-term fix: any setting touched by both Bicep and operator is mis-designed; pick one owner.

**B4. Bicep doesn't sequence first-apply vs. re-apply.**
- Evidence: handoff doc line 53. Today's deploys oscillated kill-switch between 0 and 1 with no warning.
- Sprint 003 home: only if cloud kept. Probably folds into the same fix as B3.

**B5. ACR upload from operator's local network is unreliable.**
- Evidence: handoff doc line 55. Half of today's deploys hung or failed early; same `az acr build` works from Cloud Shell.
- Sprint 003 home: not a code fix — operator workaround (Cloud Shell deploys, or a CI pipeline to build images outside the local network). Document in cloud runbook if cloud is kept.

**B6. No drift detection.**
- Evidence: handoff doc line 57. Function app and job spec drift discovered only via manual ARM REST queries.
- Sprint 003 home: only if cloud kept. Lightweight: a `scripts/cloud/verify-deployment.js` that runs after each Bicep apply.

**B7. No structured run telemetry.**
- Evidence: handoff doc line 59. Today's run analysis required hand-written KQL + blob inventory pulls.
- Sprint 003 home: only if cloud kept. Aggregator script (probably one already exists locally — `_run_analysis.json`) should write to a known blob path on every cloud run.

**B8. Function App layer is structurally unnecessary.**
- Evidence: handoff doc line 69. `az containerapp job start` accomplishes everything the Function App does; Function adds Linux Y1 + UAMI + run-from-package + appSettings replace-not-merge as a dependency chain.
- Decision pending: if cloud is kept, the recommended path in the handoff (line 99-105) is "drop Function App, keep Container Apps Job". This plan does not pre-decide; Sprint 003 fork A revisits.

**B9. Sprint 001 + 002 cloud smokes declared success on Job exit-code, not data freshness.**
- Evidence: handoff doc lines 67, 79. Container ran, exited 0, declared success; no check that today's `run_label` appeared in pulled summaries.
- Sprint 003 home: only if cloud kept. End-to-end test as a first-class deliverable (handoff doc line 107) — deploy clean → trigger smoke → pull artifacts → verify non-empty new content → report lift vs baseline.

### C. Pack and product (PM-facing)

**C1. Pack carries forward stale data: 149 of 4,806 slabs were freshly verified this run.**
- Evidence: `pack/dist/rates-pack.json` totals 4,806 slabs; `output/refresh/2026-05-13T17-29-11/_promoted.json` has 149 verified updates. The rest (4,657 slabs) is carried forward from prior runs, ages ~2–6 months.
- Sprint 003 home: PM memo this week (Week 1 deliverable). Pack v2 refresh: only if fork A.

**C2. Pack v2 refresh — full re-extraction across the 300-bank covered set, post-methodology-fixes.**
- Trigger: fork A and Sprint 003 close.
- Cost estimate: from the 2026-05-13 run ($0.82 LLM verify @ 175 candidates on 286 banks). Sprint 003 should produce a sharper per-bank cost number via Item #2c.
- Sprint 003 home: end-of-sprint deliverable in fork A.

**C3. PM standalone UI integration vs. eventual BIRD merger.**
- Evidence: memory `project_rates_pack_purpose.md` — pack bridges to PM's separate UI until BIRD's `packages/web` is the consumer.
- Sprint 003 home: orthogonal; not blocked by this plan. Revisit after Sprint 003 if `packages/api` + `packages/web` are operationally ready (currently no DB, no live data).

### D. Coverage and scale

**D1. 162 banks (97 unreachable + 65 extraction-failed) produced no new data in the 2026-05-13 run.**
- Evidence: `output/refresh/2026-05-13T17-29-11/report.txt:13-23`. ~36% of cohort.
- Breakdown not yet done (would be a Sprint 003 deliverable): of unreachable, how many are dead URLs vs network/timeout vs CAPTCHA; of extraction-failed, what extraction method and what would unblock.
- Sprint 003 home: after fork decision. Fork A: dedicated remediation item. Fork B: long-tail goes to deterministic scrapers. Fork C: this 162 is the easy starting set for per-bank deterministic work.

**D2. Discovery debt: ~1,600 banks not yet in `bank-domains.json`.**
- Evidence: `data/bank-domains.json` size not yet read in this session — but `output/latest/` has ~300 banks, and the master bank list (per memory `project_overview.md`) is ~1,900.
- Sprint 003 home: after fork decision. The bank-domains discovery work uses different AI capabilities than rate extraction (web search + classification rather than table extraction), so the Track 2 feasibility signal does not directly answer "can AI discover the long tail?"
- Risk: fork A/B may need a separate discovery probe before committing to ~1,900-bank ambition.

**D3. Maintenance cadence: can we actually refresh ~1,900 banks monthly?**
- Open question. The 2026-05-13 run was ~25 min wall-clock for 450 cohort pairs (286 banks). Linear scaling to 1,900 banks suggests ~3 hours per refresh — feasible, but rate limits, LLM throughput, and operator review queue not measured.
- Sprint 003 home: cost-cadence projection becomes a Track 1+2 deliverable in Week 1 (folded into the bars), then formalized post-fork.

### E. Process and repo hygiene

**E1. Branch `azure-openai-agent` is 77 commits ahead of `main`, never merged.**
- Evidence: `git status` at session start; commits visible in `git log main..azure-openai-agent`.
- Sprint 003 home: Week 2 first task if fork A or B. Conflict-resolution effort unknown; likely small since most commits are additive (Sprint 002 work).

**E2. `re-think-plan.md` is duplicate content with this plan.**
- Evidence: `sdlc/sprints/sprint-003/re-think-plan.md` is a verbatim copy of an earlier (probe-shaped) version of this plan.
- Action: operator wants this plan to overwrite `re-think-plan.md` after approval. Original `sdlc/sprints/sprint-003/plan/scope.md` stays intact as the underlying Sprint 003 plan; this plan reorders, doesn't replace.

**E3. `sdlc/sprints/sprint-003/plan/sub-agents.md` exists; not read in this session.**
- Open: may contain decisions about agent decomposition that overlap or conflict with Item #1. Read at the start of Week 1 before drafting `action-contracts.md`.

**E4. Repo split: rate-discovery-agent → its own repo.**
- Evidence: memory `project_agent_repo_split.md` — should eventually move to its own repo; affects branch/repo decisions today.
- Sprint 003 home: orthogonal. Revisit after Sprint 003 scope is settled.

### F. Sprint 003 items deferred from Week 1 to Week 2+ (gated on fork)

| Item | Sprint 003 location | Estimate | Gate |
|---|---|---|---|
| #1b — Implement actions in `lib/actions/` (one file per action, unit tests) | `scope.md:42-48` | 2–3 days | Fork A or B, Track 2 green |
| #1c — Refactor `lib/agent.js` to call actions instead of inlining work | `scope.md:47` | 2 days | Fork A or B, after #1a + #1b |
| #1e — Per-action tests + end-to-end integration test | `scope.md:51` | 1 day | Fork A or B, after #1b + #1c |
| #2b — Integration tests at `packages/scraper/src/__tests__/` against 17-bank fixture | `scope.md:69` | 2 days | Fork A or B |
| #2d — Operator runbook entry for invoking the scraper pipeline | `scope.md:73` | half-day | Fork A or B |
| #3 — Operator resolution tooling for pending changes (CLI + tests) | `scope.md:77-93` | 1.5 days | Fork A or B; stretch web UI deferred to Sprint 004 |
| #4 Phase 2 — Comparison matrix for framework candidates that pass Phase 1 | `scope.md:137-151` | 1 day | Fork A or B, Track 3 produces survivors |
| #4 Phase 3 — POC 1–2 strongest survivors | `scope.md:153-162` | 0–2 days | Fork A only; possible "no POC, stay bespoke" outcome |
| #5 — Vision API integration for image-only / scanned-PDF rate cards | `scope.md:182-196` | 2–3 days | Fork A only |

### G. Items explicitly out of Sprint 003 entirely (per `scope.md:198-203`)

- Multilingual rate-string parser (Hindi / Tamil / Telugu / Kannada / Marathi / Bengali) for tenure text — L8 codification.
- Web UI for pending-change resolution (Sprint 004+).
- Migration to whichever framework Item #4 recommends (Sprint 004+).
- Bicep cleanup / Flex Consumption spike (deferred from Sprint 002).

### H. Triggers to revisit framework adoption (from memory `project_workflow_orientation_decision.md`)

- We get >5 distinct workflow types (currently 3: discovery, extraction, pack rebuild).
- We need multi-operator hand-off, durable agent state across crashes, or real-time human-in-the-loop.
- Mastra or LlamaIndex.ts ships features that map directly onto pain we're feeling.
- We need operator dashboards, cross-product scheduling, or multi-DAG dependency — that's the Airflow trigger, not the agentic-framework trigger.

If any of these fires during or after Sprint 003, revisit the 2026-05-12 framework decision rather than ignoring it.

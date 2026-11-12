# Sprint 002 — Retrospective

**Sprint window:** 2026-04-15 → 2026-05-15
**Branch:** `azure-openai-agent` @ `6203417` (pushed to origin)
**Closed:** 2026-05-15
**Author:** operator + Claude

This is the formal sprint close. The forensic spine of this retro is `cloud-state-handoff-2026-05-13.md` in this directory — that document was written before this one and carries the line-level evidence. This retro stands above it as the operator-facing summary.

## Verdict in one line

**Local track shipped clean. Cloud track did not ship.** Sprint 002 is closed with the cloud track explicitly descoped to Sprint 003 pending the existential-question outcome (see `sdlc/sprints/sprint-003/re-think-plan.md`).

## What shipped (Track A — local)

All Track A items in `plan/scope.md:21-41` landed:

- **#1 ADR-011 (additive state semantics)** — DECIDED 2026-05-10. Adopted Option 1 (Additive) with confidence-aware merge for `bank-domains.json` collisions. Pending-sidecar artifacts (`bank-domains-pending.json`) shipped.
- **#2 Failure-class taxonomy** — v1 (single-axis 10-enum, `a34615c`) replaced by v2 two-tier (`fed5dc7`): tier-1 `phase_outcomes` triple (website + rate_page + extraction) and tier-2 `failure_class` 6-value rollup. `_run_analysis.json` aggregator in place.
- **#3 Local diagnostic run on 12 DCCBs** — completed; output at `implementation/dccb-failure-analysis.md`.
- **#4 Diagnosis writeup** — `implementation/dccb-failure-analysis.md`.
- **#5 Codified learnings** — L1–L13 in `implementation/agent-learnings.md`. Covers no-website pre-classification, JS-heavy state-coop portals, tier-escalation rules.
- **#6 Slug-ghost fix** — agent-emitted `*_current` / `*_dds` / `*_rd` suffixes corrected via `lib/slug-guard.js`; rogue files quarantined to `_rogue/`. Slug-discipline failure is now masked rather than prevented (deferred fix is Sprint 003 Item #1c).
- **#7 Local re-run** — completed; success rate lift documented in operator notes.
- **#14 Agent-side phase-handoff (partial-config emission)** — landed during the sprint; agent now emits a partial `_config.json` at Phase 1 boundary so partial successes populate the failure-class taxonomy correctly.
- **#15 ADR-012 (safe-write discipline)** — DECIDED. `lib/safe-write.js` funnel implemented; 5 writer modules migrated; required `extraction_method` enum added (10 auto-overwriteable + 3 curated values per `lib/extraction-methods.js`).
- **#17 ADR-013 (Bicep deploy-time config via parameters)** — DECIDED. `WEBSITE_RUN_FROM_PACKAGE` parameterized; `iac/deploy-image.sh` made atomic; Windows + Python compat fixes.

Tests: 230 unit tests passing on local agent.

Output: the 2026-05-13 refresh produced `pack/dist/rates-pack.json` v1.0.0 (292 banks, 4,806 slabs); PM has it as preview.

## What did not ship (Track B + Track C — cloud)

Track B work is **code-complete but not deployed end-to-end**:

| Item | State | Reason |
|---|---|---|
| #8 cloud kill-switch | Deployed; flipped on | Worked as designed |
| #9 git-publish path-rooting + reset semantics | Committed (`efb358a`, simplified in `6c86727`); not deployed | Image `7671a11` does not include this; deploy blocked on ACR upload instability + push atomicity |
| #10 sync.js pull-everything | Committed (`2cad012`); not deployed | Same as #9 |
| #11 pack/publish.js verify | Code unchanged; tests added | Depends on #10 being deployed |
| #17 deploy-image.sh + Bicep param | Committed; partially deployed | Image `7671a11` reflects the Bicep-param fix but NOT the `6203417` follow-up |
| #6203417 cloud tool-error WARN + best-effort push | Committed; not deployed | ACR upload from operator's local network unreliable; same path failed today |

Track C (#12 cloud DCCB rerun, #13 lift measurement) **did not happen.** Today's attempt 2026-05-13: ~$64 AOAI spent, zero new banks landed in blob (push atomicity bug ate the run). DCCB lift number from Sprint 002 is **unknown**.

## Acceptance criteria status

From `plan/scope.md:78-88`:

| Criterion | Status |
|---|---|
| ADR-011 DECIDED | ✅ |
| failure_class enum + `_run_analysis.json` | ✅ |
| DCCB failure-analysis writeup | ✅ |
| At least one agent change for dominant failure mode | ✅ (L1–L13 codifications, slug fix, ADR-012 funnel) |
| Slug-ghost test passes | ⚠️ Slug-guard exists; agent still emits ghosts; guard corrects post-hoc. Test passes for guard output, not agent output. Sprint 003 Item #1c addresses the upstream. |
| Cloud-bot commit is additive | ❓ Code fix shipped (`6c86727`); not deployed; cannot verify against live cloud. |
| sync.js pull fetches all output/latest/* | ❓ Code fix shipped; not deployed; cannot verify against live cloud. |
| Pack rebuild contains banks from prior runs | ⚠️ Local refresh produces this; cloud-side unverified. |
| Cloud DCCB rerun success rate measured | ❌ Did not run. |
| Sprint 001 baseline lift documented | ❌ Did not measure. |

**Net: 4 of 10 criteria fully met, 2 partial, 2 unknown (code-shipped but undeployed), 2 not met.** Cloud-track criteria are the ones that didn't land.

## Why the cloud track failed (from `cloud-state-handoff-2026-05-13.md`)

The handoff doc enumerates these in detail; summary here:

1. **Sprint 001 declared cloud-loop done on a smoke that didn't validate it** (handoff line 67). Same mistake repeated in today's Sprint 002 cloud smoke before catching it.
2. **Function App layer was unnecessary** (line 69). `az containerapp job start` accomplishes the same thing; Function App added Linux Y1 + UAMI + run-from-package + appSettings replace-not-merge as a chain of failure modes.
3. **Bicep modules tested in isolation, not as a system** (line 71). Each individually correct; the composition was wrong on three of four parts of the deployed state.
4. **Operator workflow drifted ad-hoc** (line 73). When the Function returned 404, we read ARM REST manually; when RBAC was suspicious, we listed roles manually; no playbook.
5. **Network instability accumulated cost** (line 75). Several local-network ACR uploads succeeded on Azure side but the CLI lost the response; operator re-ran; duplicates burned tokens.
6. **No agent-level instrumentation** (line 77). Tool failures invisible at DEBUG; one log-line fix (`6203417`) cost a full DCCB rerun of debugging time.
7. **Pull-mutate-push model hides destruction** (line 79). Stale blobs persist when no new data is written; smoke looks successful when nothing actually happened.

Throughline: **shipped a cloud loop with too many silent-failure modes and no operator-grade observability, then declared victory on incomplete verification.**

## What we did well

- **Diagnose-before-scale sequencing held.** When Track B was clearly broken, we did not push through to Track C; the cloud kill-switch held; we did not burn more tokens on a broken loop than already lost.
- **The failure-class v1→v2 reshape.** Operator caught that v1 conflated discovery and extraction; v2 unblocked the partial-success cohort that v1 buried.
- **ADR-012 safe-write funnel** centralized writes through one helper; 5 modules migrated cleanly with non-destruction tests; the discipline survives into Sprint 003.
- **The 2026-05-13 refresh produced a real pack despite cloud failure.** Local refresh pipeline (cohort → change-detect → extract → sanity-gate → LLM verify → promote) is now a load-bearing workflow that delivered output even when cloud didn't.
- **The handoff doc is unusually honest.** Naming "ill-thought-out experiment" without flinching is what made Sprint 003's reorder possible.

## What we will not relitigate in Sprint 003

- Sprint 001 architectural choices (Mode A, Y1 Linux Consumption, identity-based AzureWebJobsStorage) — these are infrastructure facts now; Sprint 003 may simplify them but won't re-derive.
- ADR-011, ADR-012, ADR-013 — all DECIDED.
- The 2026-05-12 framework-orientation decision — decompose actions first, evaluate frameworks via three-phase filter, no commitment yet.
- Sprint 002 `deferred.md` items — they're explicit deferrals, not oversights.

## What Sprint 003 inherits

Per `sdlc/sprints/sprint-003/re-think-plan.md`:

- **Existential question:** can AI reliably extract production-grade rate data for ~1,900 banks?
- **Week 1 reorder:** front-load Sprint 003 Items #2a/#2c (validate packages/scraper), #1a/#1d (action-decomposition feasibility), #4 Phase 1 (framework filter).
- **Fork decision at end of Week 1:** A (salvage and commit Sprint 003 as planned), B (Selective AI / Hybrid), C (workflow-not-AI pivot), or D (stop).
- **Cloud stays paused.** Kill-switch on. Track B fixes deploy only if Fork A or B and cloud is kept.
- **PM communication:** memo at `sdlc/sprints/sprint-003/probe/pack-confidence-memo-for-pm.md` covers freshness, confidence, known-bad list. Pack v1 is preview; v2 decision is end of Week 1.

## Pointers

- Forensic state-of-play: `cloud-state-handoff-2026-05-13.md` (in this directory).
- Sprint 003 plan: `../../sprint-003/re-think-plan.md`.
- Sprint 003 Week 1 bars: `../../sprint-003/implementation/week1-bars.md`.
- PM memo: `../../sprint-003/probe/pack-confidence-memo-for-pm.md`.
- Sprint 003 Item #2a audit (Track 1 prep): `../../sprint-003/implementation/scraper-pipeline-audit.md`.
- ADRs touched: 011 (additive state), 012 (write discipline), 013 (Bicep deploy-time config).

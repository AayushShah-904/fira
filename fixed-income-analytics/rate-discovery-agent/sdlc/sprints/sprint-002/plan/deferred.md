# Sprint 002 — Deferred items

Each item below is a conscious choice **not** to do something in Sprint 002, with the reason and the condition under which it should be revisited. Sprint 003 planning reviews this list and pulls in any item whose revisit condition has triggered.

The full input list (all 19 items from Sprint 001's retro) lives in `sdlc/sprints/sprint-001-azure-foundation/retrospection/retro.md` under "Sprint 002 candidate scope." Items not in `scope.md` for this sprint are listed below with rationale.

## 1. Bicep — split `role-assignments.bicep` so Job-MI prereq roles deploy before `containerAppsJob`

**Choice taken:** Continue with the current single-module structure. First-apply for new environments still requires the manual `az role assignment create` for KV access (per the documented workaround in the Sprint 001 retro Section A.3).

**Why deferred:** Cloud is already up. The bug only fires on a from-empty Azure subscription apply, which we don't do mid-sprint. Sprint 002's focus is on data-correctness inside the running system, not on cleaning the bring-up path.

**Revisit when:** we provision a second environment (e.g., a `dev` or sandbox subscription), or a re-bring-up is needed (e.g., subscription change, region failover). At that point, the manual workaround becomes a real friction.

## 2. Bicep — add `WEBSITE_RUN_FROM_PACKAGE` to `function-app.bicep` `appSettings`

**Choice taken:** Continue setting it manually via `az functionapp config appsettings set` after each Bicep apply.

**Why deferred:** Tied to the Flex Consumption decision (item 4). If we move to FC1, this setting goes away entirely. Adding it to Y1 Bicep now creates work to undo if FC1 wins.

**Revisit when:** Flex Consumption decision lands, or we run out of patience with the manual flow.

## 3. Bicep — bump Node 20 → 24 in `function-app.bicep`

**Choice taken:** Continue running on Node 20 despite the EOL warning (Node 20 reached end-of-life 2026-04-30).

**Why deferred:** Azure Functions runtime extends Node 20 support beyond strict Node EOL. Functions still work and the warning is informational. Bumping requires regression-testing the function code; no value vs. risk this sprint.

**Revisit when:** Azure Functions actually drops Node 20 support (announcement on Azure Updates), or we add features that need a newer Node API. Whichever is first.

## 4. Spike — Flex Consumption (FC1) vs Linux Consumption (Y1)

**Choice taken:** Stay on Y1 with the URL-package + 7-day SAS rotation flow.

**Why deferred:** Y1 works. The friction (SAS rotation every 7 days, no live log streaming, manual deploy steps) is real but quantified at "1 operator-hour per week." Doesn't block Sprint 002's data-correctness goals. Flex Consumption is a serious change — pricing model, deploy mechanism, and possibly the runtime worker model — that warrants its own design pass.

**Revisit when:** SAS rotation cadence becomes painful (e.g., we miss a rotation and the function goes down), or we need live log streaming for a specific debugging task that Log Analytics can't serve.

## 5. Application Insights connection

**Choice taken:** Use Log Analytics queries (as we did in Sprint 001) for cloud telemetry.

**Why deferred:** Log Analytics already has all the data Sprint 002 needs — `ContainerAppConsoleLogs_CL` for run logs, custom KQL for failure aggregation. AppInsights would add cross-run analytics and richer telemetry but is incremental, not blocking. Adding it requires Bicep changes, an extra connection-string secret, and SDK instrumentation in the agent.

**Revisit when:** we want to track agent metrics across many runs (e.g., "what's the failure rate by category over the last month") or we add more components (multiple functions, multiple jobs) where correlation across components matters.

## 6. Cloud Shell as primary operator surface

**Choice taken:** Operator may use either local CLI or Cloud Shell; current runbook's local-first phrasing stays.

**Why deferred:** Process change, no code. The local network friction we hit during Sprint 001's deploy session may have been a transient ISP/firewall issue; if it recurs, switching to Cloud Shell is a 30-second pivot, not a meaningful procedural commitment. Don't bake it into runbooks until we see another bad night.

**Revisit when:** local network drops cause a second multi-hour delay, or Sprint 003's runbook rewrite is in flight.

## 7. GitHub Actions deploy for Functions

**Choice taken:** Continue with the manual zip + SAS + appsettings flow.

**Why deferred:** Function code change rate during Sprint 002 will be moderate (item 5 in scope might touch the function for kill-switch wiring; item 9 for git-publish bot fix). Not high enough to amortize the CI setup cost. Sprint 003 / 004 work.

**Revisit when:** Function deploys happen more than ~weekly, or a second person needs to deploy.

## 8. Local replay tool (`npm run replay -- --run-id ... --bank ...`)

**Choice taken:** Sprint 002 Track A item #3 uses *fresh* local runs, not replays of cloud traces.

**Why deferred:** A replay tool is a real engineering artifact (download trace.jsonl, parse the recorded prompt/response sequence, re-walk the agent with the same inputs but verbose logging). Worthwhile but not blocking Sprint 002's diagnosis goal — running 10-15 banks fresh from a curated list gets the same insights with no new tooling.

**Revisit when:** we want to debug a *specific* cloud failure that we can't reproduce locally (e.g., a flaky bank that succeeds locally but fails in cloud). At that point, replay tooling pays for itself.

## 9. Nightly torn-down environment apply test

**Choice taken:** Continue manual first-apply against the existing prod environment.

**Why deferred:** This catches a class of bugs (the three Sprint 001 first-apply bugs) that fired *once*, on the first apply ever, and won't fire again until we provision a second environment. Building automation for a one-shot scenario is wasteful. The right time is when item 1 in this list (split role-assignments module) is in flight — then the test catches whether the split is correct.

**Revisit when:** Sprint 003 or 004 takes on the role-assignments split.

## 10. Runbook rewrites — `cloud-manual-trigger.md`, `azure-prep.md` Step 7

**Choice taken:** Leave the runbooks in their current (partially-misleading) state.

**Why deferred:** The flows they describe will change again in Sprint 002 (deploy mechanism if Flex Consumption lands; first-apply path once role-assignments is split). Rewriting now and again later is double work. Operators in the meantime have the Sprint 001 retro which describes the actual flow used.

**Revisit when:** Track B in this sprint closes with the bot fix and additive sync, OR Flex Consumption is decided. The runbook rewrite then captures the post-Sprint-002 reality.

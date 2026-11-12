# Sprint 001 — Retrospection

**Status:** CLOSED 2026-05-09. Sprint 001 produced a working cloud bring-up validated end-to-end on hdfc-bank-limited (smoke run `caj-bofia-rate-discovery-prod-kf91j0a`, 2026-05-08, 2m13s, all four runbook acceptance criteria + the optional git-publish criterion passed). A subsequent category run for DCCB (`caj-bofia-rate-discovery-prod-3sndth5`, 351 banks, ~3.5h, ~$15-20 AOAI cost) surfaced three additional bugs in the data-accumulation path and a deeper observability gap that wasn't visible from the single-bank smoke. Both runs and their findings are captured below.

The Sprint 001 code work (Phases 0–7) was committed cleanly between 4c9bb13..63540d3 and unit tests passed. The first end-to-end deploy + smoke is the integration test, and that's where the real surprises showed up. Five hours from "first apply" to a registered Function App. Most of that was avoidable.

## What worked

- **Bicep modular split.** Eleven small modules (`keyvault.bicep`, `acr.bicep`, `container-apps-job.bicep`, etc.) made it possible to inspect and reason about individual resources during incidents. When the first apply failed in the Job module, we could read just that module to find the missing role grant, instead of grep-ing one giant template.
- **Deterministic image tag = git SHA.** `iac/deploy-image.sh` computing `git rev-parse --short HEAD` and passing as `imageTag` made it trivial to confirm "the running container is exactly this commit." The placeholder/real-image bootstrap dance was annoying but well-documented and worked first try.
- **Sub-deployment naming with timestamps** (`bofia-first-apply-yyyyMMdd-HHmmss`) made it easy to find the latest attempt and inspect failures via `az deployment sub list`. Saved several diagnostic round-trips.
- **Lazy-required SDKs in Function code.** `dispatch.js` lazy-loading `@azure/arm-appcontainers` kept the unit-test runner fast (no install needed for the test seam to work). The `_setClientForTests` injection point worked exactly as designed.
- **Test seam paid off immediately.** When we found the missing-image bug in production, we modified `dispatch.js`, added a test case for the new failure mode, and ran `node --test` locally in seconds before re-deploying. Closed the loop on the bug fast.

## What didn't

### A. Bicep design bugs that bit on first apply

Five specific bugs surfaced. Three were authored in our Bicep, two were operator-runbook gaps masquerading as Bicep issues. All would have been caught by tearing down and re-applying once before commit.

1. **`keyvault.bicep` recreates disabled placeholder secrets on every apply** — Azure Key Vault creates a *new* secret version on every PUT, so the disabled placeholder beats out the operator-set real value as "latest" each apply. Container Apps Job secret-ref resolution then fails with a misleading "MI cannot fetch" error. Fixed in `ae46fe3` by parameter-gating placeholder creation behind `createPlaceholderSecrets` (default `false`; pass `true` only on first apply).

2. **`role-assignments.bicep` had wrong AcrPull GUID** — `7f951dda-4ed3-11e8-89fc-0a7ae54e0a06` (a fictional GUID I had wrong from generic copy-paste) instead of the real `7f951dda-4ed3-4680-a7ca-43fe172d538d`. ARM rejected with `RoleDefinitionDoesNotExist`. Fixed in `ae46fe3`.

3. **`role-assignments` module depends on `containerAppsJob.outputs.jobResourceId`** — so on first apply, the Job is created *before* the Job MI gets its KV/ACR roles. The Job creation references the KV secret, and ARM aborts because the MI lacks `Key Vault Secrets User`. Tonight's workaround was a manual `az role assignment create` and a re-apply. *Not yet fixed in Bicep.* The clean fix is to split `role-assignments.bicep` into a "Job-MI prerequisite roles" pre-Job module and a "everything else" post-Job module, with `containerAppsJob` `dependsOn` the prerequisite module.

4. **`function-app.bicep` doesn't set `WEBSITE_RUN_FROM_PACKAGE`** — without it, `func azure functionapp publish` returns "Azure Functions Core Tools does not support this deployment path." Tonight's workaround was a manual `appsettings set`. *Not yet fixed in Bicep.* Should be added to the `appSettings` array (and re-evaluated for Linux Consumption — see Section B).

5. **`dispatch.js` assumed ARM merges container overrides** — comment said `image: undefined → inherits from the Job spec (ARM merges overrides)`. ARM does *not* merge containers like that; each container in the start override must fully specify `name+image`. Args, env, and resources merge, but the container itself doesn't. Result: every Job dispatch failed with "Container with name 'rate-discovery' must have an 'Image' property specified." Fixed by adding `getJobImage()` that reads the Job spec on first call and caches the image.

### B. Linux Consumption (Y1) constraints we didn't anticipate

We picked Y1 in `function-trigger.md` for cost. The deploy ergonomics were not factored in.

- **No push-based deploys.** `func azure functionapp publish`, `az functionapp deployment source config-zip`, and `az functionapp deploy` all refuse with "deployment path not supported" and link to `aka.ms/deployfromurl`.
- **Required deploy mode is `WEBSITE_RUN_FROM_PACKAGE=<URL>`** — package must be hosted at an HTTPS URL the runtime fetches on cold-start.
- **Combined with `allowSharedKeyAccess: false`** on the Functions storage (ADR/security choice), the package URL must be a **user-delegation SAS** — and those are capped at **7-day expiry**. So sprint 001's "deploy a Function App" produces an artifact that needs operator-driven SAS rotation every week.
- **SCM endpoints are restricted.** `az webapp log tail` returns 404 for `/logstream` on this combo. Live log streaming requires Application Insights instead.
- **Function discovery doesn't auto-trigger after package change.** After updating `WEBSITE_RUN_FROM_PACKAGE` and restarting, the function list stayed empty until we issued `POST .../syncfunctiontriggers` via ARM. The runbook didn't mention this.

**Recommendation:** evaluate **Flex Consumption (FC1)** for Sprint 002. It supports zip-deploy natively, has better cold-start, and removes the 7-day SAS rotation burden. Cost should be comparable for low-traffic workloads (per-execution model, low baseline).

### C. Operator environment friction

These cost ~30–45 min tonight and aren't project bugs, but the runbook should document workarounds.

- **Local network → ARM connection RSTs.** `ConnectionResetError(10054)` on at least 6 separate `az` calls tonight, especially long-running deployments and SCM/log-stream calls. Cause unknown (VPN? MTU? ISP?). **Workaround:** Cloud Shell sidesteps it but forced us to clone the repo, switch subscription context, and re-derive variables.
- **PowerShell → cmd shim → az** chops query strings on `&`. The `az` binary on Windows is a `.cmd` wrapper around Python; cmd's parser interprets `&` as the command-chain operator even when the value is in double quotes. Reproducible. Affected `WEBSITE_RUN_FROM_PACKAGE=https://.../?se=...&sp=r&sig=...` — only the `?se=...` part landed; rest got executed as separate commands. **Workaround:** pass via `--settings @file.json` so the URL never appears on the command line.
- **Compress-Archive surprise.** Running `Compress-Archive -Path .\*` from `functions/` produced a zip whose entries were prefixed `functions/host.json` etc. — Functions runtime didn't find `host.json` at root and registered no functions. **Workaround:** `tar -a -c -f ../functions.zip *` from inside the directory; tar produces correct root-level entries.

### D. Operator runbook gaps

- **Step 7 prereq order was contradictory.** `azure-prep.md:105-128` said "set GitHub PAT in Key Vault as `github-pat` before first apply" — but KV is created BY the first apply. Logical inconsistency masked by `createPlaceholderSecrets=true` on first apply, but only if you knew that. Fixed by the new bootstrap parameter and updated docs.
- **Phase 5/6 ordering not enforced.** You can run `iac/deploy-image.sh` before or after `func publish`. We were lucky the order didn't matter, but the Function code references a specific image in its dispatch (now via runtime lookup, was effectively hardcoded as undefined).
- **No mention of `syncfunctiontriggers` after `WEBSITE_RUN_FROM_PACKAGE` updates.** Caused a "functions registered: zero" red herring that ate ~15 min.
- **No mention of Linux Consumption deploy quirks.** `cloud-manual-trigger.md:62-80` confidently says `func azure functionapp publish` — which doesn't work on this plan + storage combination.

### E. Genuinely unavoidable platform delays

- ACR + Container Apps Job image-validation chicken-and-egg on first apply (the hello-world placeholder dance). ~3 min of friction, but well-documented and worked first try.
- RBAC propagation latency (30–60s after a new role assignment).
- Linux Consumption cold-start + package fetch (~60–90s).

These add up to maybe 5–10 min of unavoidable wait per first-deploy. Acceptable.

## What to change for Sprint 002

Concrete actions, ordered by priority.

### Bicep fixes still pending

- [ ] Split `role-assignments.bicep` so Job-MI prerequisite roles (KV Secrets User, ACR Pull) deploy *before* `containerAppsJob`. Other assignments can stay post-Job.
- [ ] Add `WEBSITE_RUN_FROM_PACKAGE=1` (or `<url>` placeholder) to `function-app.bicep` `appSettings` array.
- [ ] Bump `linuxFxVersion: 'NODE|20'` → `'NODE|24'` and `WEBSITE_NODE_DEFAULT_VERSION: '~20'` → `'~24'`. Node 20 EOL'd 2026-04-30; Azure prints a deprecation warning on every CLI call.

### Plan-choice re-evaluation

- [ ] Spike: switch `function-app.bicep` from `Y1` (Linux Consumption) to `FC1` (Flex Consumption). Compare deploy ergonomics, cold-start, cost. If Flex resolves the URL-package + SAS-rotation friction without material cost increase, switch in Sprint 002.

### Runbook rewrites

- [ ] `cloud-manual-trigger.md` — replace `func azure functionapp publish` flow with the URL-package flow we used tonight (or update to Flex Consumption flow if we switch). Add the `syncfunctiontriggers` step. Document the cmd-shim escaping issue and the JSON `--settings @file.json` workaround.
- [ ] `azure-prep.md:105-128` — clarify that `github-pat` is set *after* first apply, and that first apply needs `createPlaceholderSecrets=true`.

### Process changes

- [ ] **Tear down + re-apply once before committing IaC.** Three of tonight's bugs (placeholder secrets, AcrPull GUID, role-ordering) only surface on a clean first-apply against an empty environment. CI for Bicep doesn't catch these. A nightly torn-down environment in a sandbox subscription would.
- [ ] **Network-resilient operator path.** Sprint 002 should make Cloud Shell the *primary* operator surface, not the fallback. Document the subscription-set + repo-clone steps as the first step of every operator runbook.
- [ ] **Functions deploy in CI.** Manual zip + SAS + appsettings every week is operationally fragile. GitHub Actions with the `azure/functions-action` (or equivalent) should own deploys by sprint 003.

## Category run findings (DCCB, 2026-05-08)

After the smoke passed, we ran one full category — `{"category": "DCCB"}` — to validate the cloud path at scale. 351 banks dispatched, all completed (`Batch complete: 351 succeeded, 0 failed, 0 skipped`), 3.5 hours wall-clock, ~$15-20 AOAI cost. The infrastructure performed perfectly: stable throughput (1.67 banks/min), no 429s, no MI re-auth issues, no network errors inside the cloud, batch-end push of 2960 files succeeded, rates-pack rebuilt and uploaded, git commit pushed first try.

What that run exposed:

### F. Three accumulation bugs that violate "additive" semantics

The system is supposed to be additive — each cloud run adds to accumulated state, never destroys. Tonight's run violated this in three independent ways. Captured as a spec gap in **ADR-011** (additive state semantics, PROPOSED). All three are Sprint 002 work.

1. **`cloud/sync.js pull` only fetches `bank-domains.json`** (lines 127-146). It does not pull existing `output/latest/*` blobs into `/app/output/latest/`. So every cloud run starts with an empty per-bank dir, regardless of what's already in agent-state.

2. **`cloud/git-publish.js ensureGitRepo()` uses `git reset --soft`** (committed in `725c37c`). After `git init` the index is empty; `--soft` only moves HEAD, leaves index empty. The new commit's tree = only what we explicitly `git add` from the working tree. Files that were in HEAD's tree but aren't re-added get *dropped from the new commit*. Confirmed by inspecting the DCCB cloud-bot commit `1860c66` — it deleted seven `output/latest/hdfc-bank-limited*` files that the previous commit had. **HDFC's data isn't lost** (it's still in agent-state blob storage and in the prior git commit `8eb3053`), but each run's git tip drops the prior run's artifacts.

3. **`pack/publish.js` reads only the local `output/latest/`** which contains only this run's banks (because of bug 1). So `rates-pack.json` is per-run, not cumulative. After the DCCB run the pack has 72 banks; HDFC isn't in it. Local pack/dist/rates-pack.json (April 16, 261 banks from local-only history) was never pushed to cloud, so the cloud pack starts each run from whatever this run produces.

The fix is in ADR-011's recommendation: pull-everything at run start, populate the git index from origin's tree before adding new files, build the pack from the full accumulated `output/latest/`. **Blob storage is already additive** — push is upsert-only — so the existing data is intact and recoverable.

### G. Inefficient discovery for DCCBs (information gap)

35 of 351 dispatched DCCBs (10%) produced extractable rates. Of the rest, the agent tagged most as `Tier 1 (gpt-4.1-mini) quality check failed: no config file produced` (no website found) or `extraction confidence: none` (website found but no rate page). The fail-signal is uniform enough that the *category-level* answer is probably "most DCCBs don't have web presence" — which matches CLAUDE.md's note about co-operative banks.

But we can't *confirm* that hypothesis from the run we have, because the existing observability is too thin for failure analysis at scale:

1. **No failure taxonomy.** `summary.json` has `extraction_confidence: none` but no enum classifying the failure reason (no_website / unreachable / no_rate_page / extraction_failed_t1 / extraction_failed_t2). Different fixes for each.
2. **No discoverability across banks.** To test "are all 246 failures the same?" we'd download 246 trace.jsonl files and grep — there's no per-run analysis index.
3. **No replay mechanism.** A bank's trace.jsonl is in blob, but there's no tool to take it back to local for step-through debugging.

This is the deeper concern Samir raised: *can we debug a cloud-only workflow effectively, or does that drive us back to local?* The answer for Sprint 002 is **both** — cloud for scale, local for pattern development, with enough cloud-side observability to know *which* patterns to develop. Specifically:

- **Option A (Sprint 002)**: agent-side change so each `summary.json` includes a `failure_class` enum, and the run produces a `_run_analysis.json` with counts + exemplars per class. Cheap (~1 day), turns the next category run into actionable signal instead of log scrolling.
- **Local debugging follow-up**: run a curated 5-10 DCCBs with full local logging, identify the actual failure modes, codify into bank-domains.json or scraper logic, and the next cloud DCCB run improves the success rate.

Together, they answer "why are most DCCBs failing?" without requiring a wholesale move back to local-first development.

### H. Slug ghosts in the pack (data quality)

30 of the 72 banks in the post-DCCB pack have `bank_type: null` and slugs ending in `_current`, `_dds`, `_rd` (e.g., `central-co-operative-bank-ltd-ara_current`). These are FD product-type suffixes leaking into the slug, creating fake "banks" that are duplicates of existing bank slugs. The slug rules in CLAUDE.md don't allow `_` — these violate the spec.

Likely cause: somewhere in the agent's per-bank output writer, when a bank has multiple FD product variants on the page, it produces separate output files keyed by `<slug>_<variant>` instead of putting all variants under the single bank's slug.

Sprint 002 fix candidate. Low priority compared to F and G.

## Estimate accuracy

Tonight's deploy session ran ~5h vs the runbook's implied "30 min for first smoke" (Phases 4–7 estimated total). 10× overshoot, mostly project bugs (Section A) and Linux Consumption surprises (Section B) — not estimation error in the workstream sizing. The DCCB category run was on top of that and ran to its 3.5h estimate cleanly.

## Deferred items status

The custom-role-for-Function-MI deferred item from `bicep-modules.md` open question 1 is now joined by the Flex Consumption evaluation and the additive-state remediation (ADR-011) as the leading Sprint 002 candidates.

## Sprint 002 candidate scope (consolidated, not yet committed)

Tagged `[B]` for Bicep, `[D]` for docs, `[P]` for process, `[F]` for Function code, `[A]` for Agent code, `[ADR]` for design.

**Correctness — make the system match the spec:**

1. `[ADR]` ADR-011 (additive state semantics) — review and DECIDE.
2. `[A]` `cloud/sync.js`: pull all `output/latest/*` blobs at run start, not only `bank-domains.json`.
3. `[A]` `cloud/git-publish.js`: change `git reset --soft` to default mixed reset so the index inherits from `origin/<branch>` and prior files survive into new commits.
4. `[A]` `pack/publish.js`: confirm it reads the full local `output/latest/` (will be correct once #2 lands).
5. `[A]` Slug ghost fix — no `_current`/`_dds`/`_rd`-style fake-bank entries; consolidate variants under the parent bank's slug.

**Observability — turn cloud runs into actionable signal:**

6. `[A]` Option A: per-bank `summary.json` gets a `failure_class` enum; run produces `_run_analysis.json` with counts + exemplars per class. Drop-in for the next category run.
7. `[F]` Application Insights connection (compensates for SCM logstream 404 on Linux Consumption + identity-based storage; also cross-run analytics).
8. `[A]` Local replay tool — `npm run replay -- --run-id <id> --bank <slug>` pulls trace.jsonl from blob and re-walks the agent locally with verbose logging. Defer if time-boxed.

**DCCB inefficiency — local investigation, then re-run:**

9. `[A]` Local debugging pass on 5-10 DCCBs from the failed cohort; identify whether failures are uniform "no website" or split across other classes; codify learnings.
10. `[A]` Re-run the DCCB cloud category once Option A and the local fixes are in. Compare success rate, confirm the failure-class distribution matches local hypothesis.

**Bicep cleanup carried over from the deploy session:**

11. `[B]` Split `role-assignments.bicep` so Job-MI prerequisite roles deploy before `containerAppsJob` (eliminates first-apply manual role grant).
12. `[B]` Add `WEBSITE_RUN_FROM_PACKAGE` to `function-app.bicep` `appSettings` (or remove if Flex Consumption switch lands first).
13. `[B]` Bump Node 20 → 24 in `function-app.bicep` (Node 20 EOL'd 2026-04-30).
14. `[B]` Spike Flex Consumption (FC1) vs Linux Consumption (Y1) — Y1's URL-package + 7-day SAS rotation is real friction.

**Docs and process:**

15. `[D]` Rewrite `cloud-manual-trigger.md` with the actual flow used (URL-package + Cloud Shell + JSON @file for setting URLs + `syncfunctiontriggers` step).
16. `[D]` Fix `azure-prep.md` Step 7 to clarify github-pat is set after first apply, and first apply needs `createPlaceholderSecrets=true`.
17. `[P]` Nightly torn-down environment apply test (catches first-apply bugs that only surface on empty environment).
18. `[P]` Cloud Shell as primary operator surface (local network RSTs are unreliable).
19. `[P]` GitHub Actions deploy for Functions (replaces manual zip + SAS + appsettings every week).

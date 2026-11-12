# Sprint 002 cloud deployment — state-of-play handoff

**Date:** 2026-05-13 (end-of-day, before context reset)
**Branch:** `azure-openai-agent` @ `6203417` (pushed to origin)
**Author:** operator session writeup

This is my honest reconstruction of where the Azure-side deployment is and how it got that way. Tone is forensic, not blame-seeking. The local sprint-002 work landed clean; the cloud loop did not.

---

## TL;DR

The local agent works. The cloud agent runs but produces almost nothing useful: every diagnostic and full-DCCB attempt today either (a) re-uploaded stale local state with no new work captured, or (b) completed the work but lost the artifacts at the end-of-run push step. We spent ~$64 of AOAI compute today and have zero new banks' artifacts to show for it. The cloud loop is held together by undocumented assumptions, ad-hoc operator commands, and Bicep that mutates state on every re-apply. There is no single source of truth for "is the deployment healthy", "did the run produce data", or "where does the agent write."

Sprint 002's code deliverables are solid. The cloud loop is not where Sprint 002 declared it.

---

## Current state of Azure resources

Read from ARM REST in the last hour:

- **Container Apps Job `caj-bofia-rate-discovery-prod`**: provisioning Succeeded, image `crbofiarateagentprod.azurecr.io/rate-discovery-agent:7671a11`, replicaTimeout=18000s, parallelism=1.
  - Env has `BIRD_DISABLE_GIT_PUBLISH=1` (kill-switch on). 13 + 2 trigger env vars total.
  - **Image is one commit behind HEAD**: `6203417` (the cloud-loop instrumentation commit) is NOT yet built. ACR upload from this network failed both fail-fast and hang-silently today; we ran out of working time.

- **Function App `func-bofia-trigger-prod`**: in some half-broken state from earlier today.
  - `/admin/host/status` returned `Running`.
  - `/admin/functions` returned `[]` (zero functions registered).
  - `WEBSITE_RUN_FROM_PACKAGE` was wiped by an earlier Bicep apply, then manually re-set, then status was still 503. Untested since the RBAC fix (`697e87b`) committed but not deployed.
  - User stated: keep on hold; not for now.

- **Function MI roles on `stbofiafuncprod01`**: Bicep grants `Storage Blob Data Owner` only. Queue + Table data roles were missing on the deployed state until commit `697e87b` (not yet deployed). Functions runtime with identity-based AzureWebJobsStorage actually needs all three.

- **ACR `crbofiarateagentprod`**: last successful build was `ct4` (image tag `7671a11`) at 2026-05-12 20:41 UTC. Nothing newer queued.

- **Storage `stbofiarateagentprod01`** (agent data) and `stbofiafuncprod01` (function runtime): healthy, contain accumulated state from prior runs.

- **Blob `agent-state/output/latest/`**: ~1395 files, mostly from earlier-sprint runs. Nothing from today's smoke or full DCCB run actually landed in blob (verified by `run_label` field in summaries — every pulled summary's `run_label` is from May 11 or earlier).

---

## What's known broken / not working

1. **End-of-run `cloud/sync.js push` aborts atomically.** One bad JSON file (today: a `raichur-..._config.json` written by the agent with an unterminated string) killed the entire push. Container exited 2; Job execution marked Failed; everything in ephemeral disk was lost. Commit `6203417` fixes this to be best-effort but is not yet deployed.

2. **Agent writes per-bank artifacts to local FS only during the run.** `BIRD_STORAGE=azure` only enables the start/end sync steps, not write-through. The Container Apps Job has no persistent volume. So the run-time ephemeral disk is a single point of failure: if the end-of-run push doesn't succeed, all artifacts produced during the run are lost when the container exits.

3. **Cloud agent's tool-call failure mode is invisible.** Most banks today failed with the agent's `consecutive tool errors, forcing completion` log line — but the actual tool name + error payload only logs at DEBUG, which is suppressed in Container Apps Console. So we know the cloud agent fails at tool calls; we don't know which tool, what error, or why. Commit `6203417` adds WARN-level logging for tool errors but is not yet deployed.

4. **Bicep `appSettings` array is replace-not-merge.** Every re-apply silently wipes any setting set out-of-band (initially `WEBSITE_RUN_FROM_PACKAGE`, also the kill-switch we keep flipping). ADR-013 documents this and fixes `WEBSITE_RUN_FROM_PACKAGE` by parameterizing it; the kill-switch and any future deploy-time settings have the same trap.

5. **Bicep doesn't sequence first-apply vs. re-apply.** Today's deploys oscillated between Job env having `BIRD_DISABLE_GIT_PUBLISH=0` (from Bicep) and `=1` (operator-set). Bicep re-apply during an in-flight diagnostic resets it, with no warning.

6. **ACR upload from this network is unreliable.** Half the deploys today either reset early or hung for 15+ min without progress, despite the previous deploys this week succeeding from the same machine. The same `az acr build` invocation works in Cloud Shell. The local-network → ACR `acrtaskprodsin053.blob.core.windows.net` path appears unstable; we have no telemetry on whether this is sustained, transient, or specific to certain times of day.

7. **No drift detection.** When the function app or job spec drifts (manual env changes, Bicep re-applies wiping things, etc.), we discover it only by reading ARM REST manually. There's no automated check.

8. **No structured run telemetry.** We learned what today's run did by querying Log Analytics with hand-written KQL, scanning thousands of WARN lines, and pulling blob inventories with `cloud/sync.js pull` and counting summaries by `run_label`. None of this is a workflow; it's archaeology.

---

## How we got here

Honest causes, in roughly the order each one bit us:

1. **Sprint 001 declared the cloud loop done after a smoke that didn't actually validate it.** The Sprint 001 cloud smoke status was "Succeeded" because the Job execution returned 0; nobody verified that the per-bank summaries had today's `run_label`. With hindsight, the smoke proved only that the container *ran*, not that it *produced new data*. The same mistake repeated in today's smoke before I caught it.

2. **The function-trigger experiment cost us days.** Forwarding an HTTP POST to `ARM jobs/start` does not need a Function App; a `curl` call against ARM REST accomplishes the same thing. We discovered today that the operator path (direct `az rest POST .../start`) is straightforward; the Function App layer added Linux Y1 + UAMI + storage identity + run-from-package + appSettings replace-not-merge as a chain of dependencies, every link of which has bitten us. The user called this an "ill-thought-out experiment that has wasted so much time" — that read is correct.

3. **Bicep was written piecewise without testing the closed loop.** Each module is correct in isolation. The interactions weren't tested — appSettings + role-assignments + run-from-package + identity-based storage form a system that requires every part to be coherent. Three of the four were missing or wrong on the deployed state. Each fix landed independently; no end-to-end "first apply on a fresh subscription works" gate.

4. **Operator workflow drifted into ad-hoc.** When the Function returned 404, we read ARM REST manually. When RBAC was suspicious, we listed roles by hand. When the run failed, we KQL'd Log Analytics manually. None of this is reproducible — the next operator (or me tomorrow) starts from scratch with no playbook beyond a single runbook that doesn't reflect the actual failure modes.

5. **Network instability accumulated cost.** Many deploys today succeeded on the Azure side but the local CLI lost the response and we retried, sometimes triggering duplicate work. This compounded with (1) — when status was unclear, we re-ran; when re-runs failed silently, we re-ran again. Several hours of clock and ~$60 of AOAI burned on what should have been one DCCB pass.

6. **No agent-level instrumentation.** When tool calls fail in cloud but succeed locally, that gap is the most important signal in the system. We don't capture it. The fix is one log line at WARN level (committed today, not deployed) — but the absence cost us a full DCCB rerun's worth of debugging time.

7. **The pull-mutate-push model hides destruction.** When the cloud agent starts, it pulls the entire blob state to local FS, runs, and pushes back. If runs don't produce new outputs for a bank, the prior content stays in place — looking like a successful update. This is what made the smoke look like it worked when it actually hadn't.

The throughline: **we shipped a cloud loop with too many silent-failure modes and no operator-grade observability, then declared victory based on incomplete verification.** Each individual decision had a defensible Sprint 001 rationale; the composite is brittle in ways no individual decision predicted.

---

## What's salvageable (so the recovery isn't from zero)

- **Local agent works.** Sprint 002's diagnostics, learnings codification, slug consistency, safe-write, failure-class taxonomy, run aggregator/report — all green. 230 unit tests passing.
- **ADRs are sound** (010, 011, 012, 013). Even ADR-013 captures something real even if it didn't fully solve the problem.
- **`scripts/analysis/compare-cohort-runs.js`, `select-dccb-diagnostic-sample.js`, the failure_class taxonomy, the v2 phase_outcomes**: all reusable analysis infrastructure that doesn't depend on cloud working.
- **Build-script POSIX-zip + cross-platform shim**: even if we end up not using ACR-build via `iac/deploy-image.sh`, the Python zip builder is correct.
- **The Sprint 001 forensic snapshot at `C:\sw\BharatOmni\UFA\agent-data-backup\...`**: 350 DCCB summaries with intact tool_calls, useful as a baseline if we ever do measure cloud lift properly.

---

## My honest thoughts on recovery

Not prescribing — the user has the final call — but if I were planning Sprint 003 retro-style:

1. **Pick the architecture and own it.** The current setup carries function app + container apps job + linux y1 + uami + run-from-package + git-bot + sync push + identity storage. Six concepts, each with its own failure mode. Two cleaner options:

   (a) **Drop everything cloud-side.** Operator runs locally. `git push` for results. PM consumes `pack/dist/rates-pack.json` from origin. Zero Azure resources except maybe Key Vault for the AOAI key. ~5 files deleted, ~3 ADRs retired. Loses scheduled refresh, gains weeks of clarity.

   (b) **One compute, no trigger.** Keep Container Apps Job, drop Function App. Operator triggers via `az containerapp job start` (we did this today, it works). PM consumes blob output. Drop `cloud/sync.js push`-at-end in favor of write-through-to-blob from `safe-write.js` (or Azure Files mount). Bicep manages job spec only, no appSettings flag chain.

   I lean (b). It keeps the cloud option open for premier-bank refresh while removing the multi-day function-trigger debugging.

2. **End-to-end test as a first-class deliverable.** Sprint 003 should not close a "cloud works" item without a script that: deploys clean → triggers smoke → pulls artifacts → verifies non-empty new content → reports lift vs baseline. If that script fails, the sprint is not done. Apply same gate retroactively to Sprint 002 (acknowledge cloud-loop not done).

3. **Instrumentation before iteration.** Tool errors at WARN, safe-write events at INFO, run state to a structured `_run_status.json` in blob updated every N banks. Without these, every cloud failure is a 2-hour archaeology dig.

4. **Stop using replace-not-merge ARM resources for runtime config.** If a setting is touched by both Bicep and operator, the design is wrong. Either Bicep owns it (set every deploy from a param) or operator owns it (Bicep doesn't reference it). The current model where both can write to `appSettings` is the bug.

5. **One PR per cloud change, deployed end-to-end before the next.** Today we batched four IaC changes into one deploy and had no way to attribute the failure. Smaller commits + immediate verify would have caught the RBAC gap separately from the run-from-package gap.

6. **Honest retro doc.** Sprint 002 deliverables retro should split into "local: shipped" and "cloud: not shipped". The DCCB lift number is unknown. The cohort comparison report I wrote earlier today was *wrong* (was comparing stale state). Sprint 002 should not be declared complete on the cloud track; that work moves to Sprint 003.

---

## What I'd ask the user to decide before resuming

- Is (a) "drop cloud" or (b) "simplify cloud" the recovery path?
- Is the PM premier-bank refresh worth doing in (a) "local + git" or only if we commit to (b) "simplify cloud"?
- Should Sprint 002 close now with cloud-loop-not-done flagged, or be extended?
- Is there budget for one more compute-burn experiment (Cloud Shell deploy + 5-bank diagnostic) to actually learn why cloud tool calls fail, or is that not worth pursuing given the architecture question above?

These are decisions the user needs to make, not me. After `/clear`, the next session can start from this doc + the user's choices.

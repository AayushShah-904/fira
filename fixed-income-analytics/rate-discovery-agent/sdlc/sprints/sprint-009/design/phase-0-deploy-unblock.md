# Phase 0 — Deploy unblock & baseline (design)

**Sprint:** 009
**Phase:** 0 of 7
**Status:** approved 2026-06-02 (auto mode)
**Companion plan:** `../plan/sprint-009-scope.md`

## Goal

Bring the deployed cloud loop to current HEAD with a Bicep re-apply that does **not** silently flip the kill-switch, then prove it runs end-to-end against a non-WAF target.

## Current state (verified 2026-06-02)

| Layer | Observed | Target |
|---|---|---|
| Container Apps Job image | `crbofiarateagentprod.azurecr.io/rate-discovery-agent:cd9fa75` | image tag == `git rev-parse --short HEAD` after deploy |
| Function App zip | `func-deploy-7671a11.zip` | new `func-deploy-<HEAD>.zip` after deploy (Phase 2 will validate function correctness) |
| Job env `BIRD_DISABLE_GIT_PUBLISH` | `1` (ON) | preserved at `1` after Bicep re-apply (currently *not* preserved — see Trap 1) |
| Last execution | 2026-05-20 (13 days ago) | new green execution after deploy |
| Sprint-004 Bug A (per-bank timeout) | **already fixed at HEAD** (`run-batch.js:70` — `timeout = 900_000` with comment citing the fix) | redeploy is sufficient; no code change |
| ACR network theory | operator believes disabling IPv6 on the LAN resolved the sprint-002 hangs | re-validate by running the deploy; if it hangs again, escalate to Cloud Shell fallback |

The Bug-A fix being already in HEAD is a happy accident — it means Phase 0 is one Bicep re-apply away from a usable cloud loop, not a multi-day code-then-deploy cycle.

## Two traps that must close in this phase

### Trap 1 — Bicep re-apply silently flips the kill-switch

`iac/modules/container-apps-job.bicep:69` defaults `disableGitPublish = '0'`. The cloud is currently running with it at `'1'` (set out-of-band during sprint-002 to neutralize the git-publish path while reset-mode bugs were investigated). `iac/parameters.prod.bicepparam` does **not** override the default. Therefore: running `iac/deploy-image.sh` today re-applies Bicep with `disableGitPublish = '0'` and silently turns the kill-switch off — exactly the failure mode ADR-013 was written to prevent for `WEBSITE_RUN_FROM_PACKAGE`, applied to a setting the operator chose to leave on.

The git-publish path itself is still considered fragile from sprint-002. Whether to keep it neutralized is a separate operator decision — but Phase 0's contract is that Bicep re-apply does **not change the kill-switch state without an explicit operator intent**.

**Fix:** `iac/deploy-image.sh` queries the current `BIRD_DISABLE_GIT_PUBLISH` env value from the deployed Container Apps Job before the Bicep re-apply, and passes it through as an explicit `--parameters disableGitPublish=<current_value>`. Operators can override via env var:

```
DISABLE_GIT_PUBLISH=0 ./iac/deploy-image.sh   # explicit flip
./iac/deploy-image.sh                          # preserve whatever is set
```

If the job doesn't exist yet (first-apply on a fresh subscription), default to `1` (safe — git publish off). This matches the sprint-002 lesson: never assume the loud-by-default state at first deploy.

### Trap 2 — Cohort smoke false-positive

Sprint 001 and the first sprint-004 smoke both reported success because the ARM job execution returned 0, even though no fresh artifacts landed in blob. Phase 0's smoke must verify *both* signals:

1. Job execution status == `Succeeded`
2. At least one fresh per-bank summary in `agent-state/output/latest/` whose `run_label` matches the execution ID (i.e. the run actually wrote something).

Without (2), the smoke is not green.

## Work items (execution order)

| # | Item | File | Type |
|---|---|---|---|
| 1 | Read current `BIRD_DISABLE_GIT_PUBLISH` value from deployed job and forward it as a Bicep parameter; allow `DISABLE_GIT_PUBLISH` env override | `iac/deploy-image.sh` | code |
| 2 | Run `iac/deploy-image.sh` | — | exec |
| 3 | Verify ACR build succeeded (script has retry+verify already — sprint-004 Track B work) | — | exec |
| 4 | Verify Bicep deploy succeeded and `BIRD_DISABLE_GIT_PUBLISH` is unchanged in the deployed job env | az containerapp job show | verify |
| 5 | Run one-bank smoke: `COHORT_BANK=hdfc-bank-limited scripts/azops/smoke.sh` | — | exec |
| 6 | Verify fresh artifact landed in blob: pull `agent-state/output/latest/hdfc-bank-limited_*.json` and confirm `run_label` is from today | `cloud/sync.js pull --bank hdfc-bank-limited` | verify |
| 7 | Write impl report | `../implementation/phase-0-deploy-unblock-2026-06-02.md` | doc |

## Out of scope (deferred to other phases)

- **Function App correctness re-audit:** Phase 2.
- **Drift detection on job spec / structured run telemetry / blob-write heartbeat:** Phase 1. The Phase-0 smoke verification at step 6 is intentionally manual; Phase 1 will turn it into a single KQL query.
- **WAF-block detection:** Phase 3. Phase 0 uses HDFC (no known WAF block from Azure egress) precisely to avoid conflating "cloud loop broken" with "this bank blocks cloud."

## Acceptance criteria

1. `git rev-parse --short HEAD` == image tag deployed on `caj-bofia-rate-discovery-prod`.
2. `BIRD_DISABLE_GIT_PUBLISH` value on the deployed job is unchanged from its pre-deploy state.
3. A new function-zip blob exists at `stbofiafuncprod01/deploy/func-deploy-<HEAD>.zip` and the Function App's `WEBSITE_RUN_FROM_PACKAGE` points at it.
4. A new Container Apps Job execution exists with `properties.status == Succeeded` started by the smoke script.
5. `agent-state/output/latest/hdfc-bank-limited_rates.json` (or `_config.json`) has a `run_label` matching the smoke execution (i.e. this is *new* data, not last sprint's leftover).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| ACR network hangs return (IPv6 theory wrong) | The deploy script already retries 3× with backoff (sprint-004 Track B). If still failing, fall back to Cloud Shell — documented in script comment. Either way, surface immediately, don't burn hours. |
| HDFC site itself returns NOT_FOUND in cloud (unexpected new WAF) | Re-run smoke against a different non-WAF target (SBI). If two unrelated non-WAF banks both fail, the loop itself is broken — escalate to log analysis, do not proceed to Phase 1. |
| Function App fails to load functions after Bicep re-apply | Expected per sprint-002 — Phase 2 is the salvage. Phase 0's exit criteria do **not** include Function App health; the job-only path via `start-cohort.js` is sufficient. The deploy script already has `SKIP_FUNCTION_VERIFY=1` env var for this. |

## Smoke target rationale

HDFC was the original Sprint-004 smoke target. Their site has no Azure-IP block and produces a clean ladder. SBI is the backup. ICICI/Axis/Kotak/BOI-IBU are **forbidden** for Phase 0 smoke — they are the known WAF-blocked banks; using one of them would mask a real deploy issue as a "WAF problem".

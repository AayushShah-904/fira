# Sprint 009 — Phase 2.5: Item 4 — `scripts/azops/deploy-smoke.js`

**Date:** 2026-06-03
**Branch:** `azure-openai-agent`
**Status:** Shipped (code + tests; live cloud run pending operator-driven trigger)
**Driver:** `container-mgmt/doc/cloud-deploy-smoke-operational-handoff.md` item 4

## What the doc asked for

> Create a new script `scripts/azops/deploy-smoke.js`. Use Node. Required
> behavior:
> - Validate it is running from the real repo root.
> - Fail fast if these files are missing: package.json, package-lock.json,
>   Dockerfile, functions/host.json, iac/main.bicep.
> - Build functions.zip. Upload func-deploy-<gitSha>.zip. Build ACR image
>   with tags <gitSha> and latest. Verify ACR tag exists.
> - Read and preserve BIRD_DISABLE_GIT_PUBLISH unless explicitly overridden.
> - Re-apply Bicep with imageTag, runFromPackageUrl, disableGitPublish.
> - Verify Function App loads start-discovery and job-status.
> - Start smoke using direct ARM POST with full env-preserving container override.
> - Poll /api/job-status/<executionId> as the primary status signal.
> - Fall back to ARM plus blob checks only when the status endpoint fails.
> - Print one concise final verdict.
> - Exit 0 only when business outcome is success.

## Design decision: shell out to deploy-image.sh

`iac/deploy-image.sh` already does items 1–7 of the doc's deploy list:
build zip with retry, upload, ACR build with retry + tag verification,
Bicep re-apply with kill-switch preservation (ADR-013), `syncfunctiontriggers`
call, function-load verification loop. Re-implementing in Node would
duplicate ~270 lines of working, debugged bash.

`deploy-smoke.js` spawns `iac/deploy-image.sh` with inherited stdio so the
operator sees streamed progress, and fails fast if exit code is non-zero
(exit 4). Re-using the deploy script keeps it the single source of truth
for the deploy mechanics — the new Node code focuses purely on what's new:
the smoke trigger + receipt-poll + verdict loop.

The doc preferred Node for the operator script. The trigger + poll +
verdict layer IS Node; the deploy mechanics that pre-existed in bash stay
as-is (a future refactor can port them if the bash-vs-Node split becomes
painful).

## Architecture

```
deploy-smoke.js
├── parseArgs(argv)              — CLI surface, validation
├── ensureRepoRoot()              — 5-file pre-flight
├── ensureCohort(name)            — data/cohorts/<name>.json must exist
├── ensureAzAuth(azBin)           — `az account show`
├── confirmProd(opts)             — prompt unless --yes / --dry-run / --env dev
├── runDeployImage()              — spawn iac/deploy-image.sh
├── resolveContext(opts)          — derives jobName / functionAppName / rg
├── readJobSpec(azBin, ctx)       — `az containerapp job show`
├── buildStartBody(opts, spec)    — delegates to start-cohort.js (pinned by test)
├── startExecution(...)           — `az rest POST /jobs/start` with tmp body file
├── getFunctionKey(azBin, ctx)    — `az functionapp keys list --query masterKey`
├── fetchStatus(ctx, exec, key)   — fetch GET /api/job-status/<id>
├── pollUntilTerminal(...)        — loop with transient-error backoff + grace period
└── printVerdict(state, exec)     — operator-readable summary + exit code
```

## Re-use vs duplication

- `buildStartBody` is imported directly from `scripts/azops/start-cohort.js`. start-cohort.js already exports it for testing, so deploy-smoke and start-cohort share the env-preserving ARM body construction. If the body shape changes, both pick it up; the contract is pinned by `tests/scripts/azops-start-cohort.test.js`.
- `_resolveAzBin` is also imported from start-cohort.js (the `az.bat` vs `az` Windows resolution logic).
- Everything else (job-spec read, status GET, poll loop) is new because start-cohort.js used ARM `az containerapp job execution show` for polling (no Function endpoint existed then) and pre-dated the receipt model.

## Exit-code matrix

The doc's "exit 0 only when business_outcome=success" was clear; everything else fans out into specific codes so CI / operator scripts can distinguish failure modes:

| Code | Meaning                                                       |
|-----:|---------------------------------------------------------------|
|    0 | business_outcome=success and receipt landed                   |
|    1 | business_outcome ∈ {failure, partial_failure, no_work}        |
|    2 | ARM terminal but **no receipt blob** — the loud failure mode the receipt model exists to surface |
|    3 | pre-flight failure (wrong cwd, missing files, az not authed)  |
|    4 | deploy-image.sh exited non-zero                               |
|    5 | Function App didn't load both functions within verify window  |
|    6 | /api/job-status unreachable after retries OR poll deadline elapsed |
|    7 | operator declined the prod confirmation prompt                |

Code 2 (the "no receipt" case) is the operational-trust failure the
receipt model is designed to make loud. The handoff doc named it
explicitly: "deploy-smoke script should fail if no final receipt is
found after terminal execution." When poll sees ARM terminal but
receipt is missing, the script waits 3 poll intervals (the typical
bulk-push window from finalize), then declares exit 2.

## Polling behavior

Each poll calls `GET /api/job-status/<execName>` and prints one line:

```
[12:34:56Z] arm=Running   receipt=pending  outcome=pending   0 succeeded, 0 failed, 0 rate-limited, 0 skipped (total 1)
[12:35:11Z] arm=Running   receipt=pending  outcome=pending   0 succeeded, 0 failed, 0 rate-limited, 0 skipped (total 1)
[12:36:24Z] arm=Succeeded receipt=found    outcome=success   1 succeeded, 0 failed, 0 rate-limited, 0 skipped (total 1)
```

Task-meaningful per [[feedback_polling_progress]] — every line carries
arm state + receipt + outcome + counters, not just "status=Running".

Transient errors (5xx, network) are retried up to 5 consecutive times
before bailing with exit 6. Cold-start 502s at execution startup are
common; the retry budget covers that without masking a real outage.

## Testing strategy

Pure-logic helpers (parseArgs, isTerminalArm, shortSummary, printVerdict)
are exported and unit-tested in `tests/scripts/azops-deploy-smoke.test.js`
— 22 tests covering: default values, flag parsing, ARM state classification,
summary formatting, and every exit-code branch of printVerdict (PASS,
business-failure, partial-failure, no_work, missing-receipt, poll-deadline).

The deploy and poll loops touch az CLI + live HTTP, so they're left for
operator-driven cloud smoke validation. Unit-mocking the spawned az
processes would test the harness, not the real failure modes.

## Files added/changed

- `scripts/azops/deploy-smoke.js` (new, ~420 lines)
- `tests/scripts/azops-deploy-smoke.test.js` (new, 22 tests)
- `package.json` — new npm script `cloud:deploy-smoke` for ergonomics

## Quick reference

```bash
# Full deploy + smoke against prod:
npm run cloud:deploy-smoke

# Smoke only (image already deployed):
node scripts/azops/deploy-smoke.js --skip-deploy

# Different cohort:
node scripts/azops/deploy-smoke.js --cohort smoke-pm-q2-pre-flight

# Dev environment:
node scripts/azops/deploy-smoke.js --env dev --yes

# See the planned ARM body without firing it:
node scripts/azops/deploy-smoke.js --skip-deploy --dry-run --yes
```

## Test results

```
$ node --test --test-force-exit tests/scripts/azops-deploy-smoke.test.js
# tests 22   # pass 22   # fail 0

$ npm test
# tests 1314   # pass 1269   # fail 1   (pre-existing fetch_html WAF)
```

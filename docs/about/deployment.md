# Deployment

> Part of the [onboarding guidebook](overview.md). Read [overview.md](overview.md) (esp. §4 "the two stores" and §7 current state) and [architecture.md](architecture.md) first — this page goes one level deeper into *how the cloud side is actually provisioned and wired*. For the day-to-day runbook (commands to run a cohort, deploy an image, reconcile blob/git), see the sibling **operator-guide.md** — this doc is topology/design, not how-to.

## 1. Framing

The agent's cloud identity is a single **Azure Container Apps Job**. It is not a long-running service — there is no listener, no idle replica. It sits at zero cost until something starts an execution, runs `run-batch.js` against a cohort or slug list end-to-end (fetch → extract → write), and exits. Two things trigger it: an operator's `az` command, or a POST to an Azure Function HTTP endpoint. Every execution reads its starting state from blob storage and, on success, writes back to blob **and** commits the durable record to git.

This document is the map of that topology — the Azure resources, the container image, the trigger path, and the run-boundary sync. It is the "onboarding lens": for the deeper authoritative design record (identity model, secret rotation, cost tables, IaC module list) see **`sdlc/deployment.md`**, and for the individual decisions with full rationale, the ADRs listed in §9 below.

**Important naming note:** the project was historically called 'Bank Interest Rate Discovery' (BIRD), then renamed to 'Fixed Interest Rate Aggregator' (FIRA). The Azure resources now carry the fira prefix. Do not attempt to rename them; Terraform/Bicep state considers them locked.

## 2. Azure topology

Single environment, `prod` only (no `dev` — see [ADR-006](../../sdlc/decisions/ADR-006-environment-strategy.md)), region `southindia` (see [ADR-007](../../sdlc/decisions/ADR-007-azure-region.md)).

```
Resource Group: rg-fira-rate-agent-prod-southindia  (region: southindia)
│
├── Azure Container Registry ─────── crfirarateagentprod
│     holds fira-project:<git-sha> and :latest
│
├── Storage Account ─────────────── stfirarateagentprod01
│     ├── container: agent-state    (working state + per-run audit trail)
│     └── container: rates-pack     (published pack; PM reads this only)
│
├── Storage Account (functions) ─── stfirafuncprod01
│     └── container: deploy         (functions.zip, WEBSITE_RUN_FROM_PACKAGE source)
│
├── Key Vault ────────────────────  kv-fira-agent-prod-<suffix>
│     secrets: azure-openai-api-key*, github-pat, docintel-key, ...
│     (*AOAI access is actually managed-identity, per ADR-007 open Q1 — key is a fallback slot)
│
├── Log Analytics workspace ──────  (workspace id 36bea445-1f1b-4ccf-9448-030b702abbc5)
│     Container Apps Environment logs land here
│
├── Container Apps Environment ───  cae-fira-agent-prod  (public-endpoint posture, no VNet)
│     │
│     └── Container Apps Job ─────  caj-fira-rate-discovery-prod        ◄── the agent runtime
│           image:      crfirarateagentprod/fira-project:<sha>
│           profile:    d4-jobs (workload profile, not Consumption)
│           trigger:    Manual  (started via ARM API — see §5)
│           identity:   user-assigned MI (id-fira-rate-agent-prod)
│           timeout:    replicaTimeout up to 72000s (20h) for large cohorts
│
├── Function App ─────────────────  func-fira-trigger-prod (Consumption, Node 20)
│     ├── POST /api/start-discovery   ── starts a Job execution (§5)
│     └── GET  /api/job-status/{id}   ── composite ARM + business-receipt status
│     identity: user-assigned MI (id-fira-trigger-prod), scoped only to
│                Microsoft.App/jobs/{caj-fira-rate-discovery-prod}/start/action
│
└── (cross-RG, referenced not provisioned) Azure OpenAI account
      lives in a separate resource group (bo-ai-dev / bo-ai-dev-api);
      Job MI granted "Cognitive Services OpenAI User" on it via a
      separate cross-RG role-assignment module
```

### Resource table (live names)

| Resource | Name |
|---|---|
| Resource group | `rg-fira-rate-agent-prod-southindia` |
| Region | `southindia` |
| Container Apps Job | `caj-fira-rate-discovery-prod` |
| Container Registry | `crfirarateagentprod` |
| Storage account (agent data) | `stfirarateagentprod01` (containers: `agent-state`, `rates-pack`) |
| Storage account (functions deploy) | `stfirafuncprod01` |
| Function App | `func-fira-trigger-prod` |
| Log Analytics workspace ID | `36bea445-1f1b-4ccf-9448-030b702abbc5` |
| Compute profile | `d4-jobs` (workload profile, not the Consumption Container Apps plan) |
| Environments | prod only — no dev/staging (see [ADR-006](../../sdlc/decisions/ADR-006-environment-strategy.md)) |

These are read straight out of `iac/main.bicep` (`rg-fira-rate-agent-${envName}-${location}`) and `iac/deploy-image.sh` (`ACR_NAME`, `FUNCTIONS_STORAGE_ACCOUNT`, `FUNCTION_APP_NAME`, `JOB_NAME_FOR_KILLSWITCH` defaults) — they match the operator's handover facts.

## 3. The container image

`Dockerfile` (repo root), single-stage on purpose (no build artifacts to discard — runtime just needs Node + Playwright + agent code):

- **Base:** `mcr.microsoft.com/playwright:v1.58.2-jammy` — Microsoft's official Playwright image, so Node 20 + a tested Chromium + its OS-level dependencies are baked in and version-pinned together with `package.json`.
- **Layer 1:** `package.json` + `package-lock.json` → `npm ci --omit=dev`. Cached until the lockfile changes.
- **Layer 2:** `COPY . .` — the rest of the source, filtered by `.dockerignore`. Notably:
  - `output/`, `pack/dist/` are excluded — **never ship scraped operator data into the image**; blob is the data plane.
  - `docs/*` is excluded **except** `docs/agent/**` — that subtree is the single source of truth for the runtime prompt fragments (`lib/prompts/fragments.js` reads it at runtime; excluding it broke cloud runs with `ENOENT` in Sprint 008).
  - `.git/` is **kept** (not excluded) — `cloud/git-publish.js` needs it at runtime to commit rate updates back to the repo in "in-place" mode.
  - `iac/`, `functions/` are excluded — deployed separately (Bicep apply / function zip), not part of the runtime image.
  - `pack/baseline/` (the quality-gate baseline) does ship — the cloud finalize path runs `build-pack.js → quality-gate.js → publish.js` and needs it to compare against.
  - `data/bank-domains.json` ships baked into the image as a fallback copy — see the gotcha below.
- **Entrypoint:** `ENTRYPOINT ["node", "run-batch.js"]`. The Container Apps Job overrides `args[]` at start time — the Function trigger passes the bank slugs / `--category` / `--cohort` / `--dry-run` flags (see §5).
- Visibility env vars `NODE_ENV=production` and `FIRA_STORAGE=azure` are baked in for documentation; the values that actually matter (secrets, endpoints) come from the Job's env / secretRefs at runtime (`iac/modules/container-apps-job.bicep`).

### Gotcha: image vs. blob registry

`data/bank-domains.json` ships inside the image as a snapshot, but **`cloud/sync.js pull` downloads the blob copy at the start of every run and overwrites it** (see [overview.md §4](overview.md#4-the-two-stores-and-cloud-as-source-of-truth)). So a registry fix (new domain, corrected rate-page URL) that's only baked into a new image tag does **not** take effect in the next cloud run — it gets clobbered by the older blob copy the instant the run starts. Registry edits must go to **blob**, not just the image (`scripts/azops/push-bank-domains-merge.js`). This bites people repeatedly; it's the single most common "why didn't my fix apply" cloud surprise.

## 4. Image lifecycle

`iac/deploy-image.sh` is the single command from a clean `git pull` to a deployed agent + function. It does four things atomically, in order:

1. **Build `functions.zip`** (`iac/build-functions-zip.py` — must use Python's `zipfile`, not PowerShell's `Compress-Archive`, which emits backslash path separators the Linux Functions host can't parse; see [ADR-013](../../sdlc/decisions/ADR-013-bicep-appsettings-deploy-config.md)).
2. **Upload the zip** to `stfirafuncprod01/deploy/func-deploy-<git-sha>.zip`.
3. **`az acr build`** the image into `crfirarateagentprod`, tagged `:<git-sha>` and `:latest`, with retry (up to 3 attempts, exponential backoff) and a post-build tag-existence verification.
4. **Re-apply Bicep** (`az deployment sub create`) with **both** `imageTag=<git-sha>` and `runFromPackageUrl=<zip URL>` set together, plus a **preserved** `disableGitPublish` value (read back from the currently-deployed job so a routine image deploy can't silently flip the kill switch — see §6).

Why steps 3+4 must be atomic and paired: a Bicep re-apply that omits `runFromPackageUrl` silently wipes `WEBSITE_RUN_FROM_PACKAGE` (ARM `appSettings` PUT is **replace, not merge** — [ADR-013](../../sdlc/decisions/ADR-013-bicep-appsettings-deploy-config.md)), which took the Function App to zero registered functions in a Sprint 002 incident. `deploy-image.sh` is the fix: it always re-asserts every deploy-time setting on every apply.

After the Bicep apply, the script syncs function triggers (`az resource invoke-action ... syncfunctiontriggers`) and polls `/admin/functions` for up to 5 minutes to confirm both functions loaded, failing loudly rather than leaving a silently broken trigger.

**Operator-authorization gate:** deploys can hit a permission classifier (subscription/tenant-level guardrail) that blocks the `az acr build` or `az deployment sub create` call until an operator explicitly authorizes it. **Do not work around this** — treat a permission block as a stop sign requiring the operator, not an obstacle to route around with elevated credentials or a different code path.

## 5. Trigger architecture

Manual `az containerapp job start` is always available, but the primary programmatic surface is an HTTP Function in front of the Job (decision + full alternatives analysis in [ADR-005](../../sdlc/decisions/ADR-005-trigger-architecture.md)):

```
caller (curl / script / future UI button)
   │  POST /api/start-discovery  { banks: [...] } | { category, cohort, dryRun, ... }
   │  auth: function key
   ▼
functions/start-discovery/index.js
   ├── lib/validate.js     — validates request body shape
   ├── lib/build-argv.js   — translates to a Container Apps Job args[] override
   └── lib/dispatch.js     — startJob(): ARM SDK call
                              client.jobs.beginStartAndWait(rg, jobName, { template: { containers: [overrideContainer] } })
   ▼
Container Apps Job execution starts (202 Accepted returned immediately —
async model; caller gets executionId + statusUrl, does not block)
   ▼
functions/job-status/index.js   — GET /api/job-status/{executionId}
   combines ARM's lifecycle status (Running/Succeeded/Failed) with the
   business-level execution receipt the job itself writes to blob
   (output/latest/_execution_<id>.json) — ARM "Succeeded" only means
   exit 0, which can hide a no-op refresh; the receipt is the real signal.
```

A subtlety in `dispatch.js`: ARM's job-start override **replaces, not merges**, container fields it mentions. So the dispatcher fetches the Job's full current container spec once per cold start, caches it, and overlays only `args` (the resolved cohort/slug list) and a few `TRIGGER_*` env vars on top — otherwise a naive `{name, args, env}` override would wipe the image reference and drop all the baked-in env vars, and the job would fail to start or start misconfigured.

## 6. Run boundaries: blob sync and git publish

Two scripts run at the edges of every cloud execution — both are cloud-only no-ops when `FIRA_STORAGE != 'azure'`.

**`cloud/sync.js`** (blob ↔ local fs), invoked by `run-batch.js`:
- `pull` (run start): downloads `data/bank-domains.json` and every file under `output/latest/` from the `agent-state` container into the container's ephemeral local fs. This is additive state — without it, each execution would start blind to everything prior runs wrote (Sprint 002 lesson).
- `push` (run end): uploads `output/latest/*`, `output/runs/**` (translated to blob `runs/**`), and `data/bank-domains.json` back to `agent-state`. Best-effort per-file — one bad JSON file doesn't abort the whole push.
- There's also an incremental `uploadOneBank()` path (crash safety — lands each bank's artifacts right after it finishes, so a mid-cohort crash doesn't lose banks 1..N-1) and beacon/receipt helpers the Function's `job-status` endpoint reads.

**`cloud/git-publish.js`** (durable record), invoked after a successful run:
- Commits `output/latest/*.json`, `data/bank-domains.json`, and `pack/dist/rates-pack.json` (if a pack rebuild ran) to the `azure-openai-agent` branch — a diffable, human-reviewable history that blob alone doesn't give you.
- Requires `GITHUB_TOKEN` (the `github-pat` Key Vault secret, already wired into the Job) and either an in-place `.git` (local dev) or `GITHUB_REPO` to bootstrap a fresh clone (the cloud image path — `.git` in the image points at the monorepo, but the runtime clone-and-overlay path targets `samir-joshi/fixed-income-yield-advisor` directly, mirroring files under `MONOREPO_SUBPATH=fira-project/`).
- Push uses fetch + rebase + push with up to 3 retries; failure is logged and non-fatal (blob already has the data — git is supplementary, not required for correctness).

**Kill switch:** `FIRA_DISABLE_GIT_PUBLISH` (Bicep param `disableGitPublish`, env var on the Job). Currently **`1`** — git-publish is a no-op, logging and returning cleanly. The git target is fully wired (branch `azure-openai-agent`, repo `samir-joshi/fixed-income-yield-advisor`, `github-pat` secret) and ready to go live the moment an operator flips it to `0`. Flip via `az containerapp job update --set-env-vars FIRA_DISABLE_GIT_PUBLISH=0` (no Bicep re-apply needed for an ad hoc flip) — but note `deploy-image.sh` **preserves whatever value is currently deployed** on every re-apply, specifically so a routine image deploy can't silently revert an operator's kill-switch choice.

## 7. Cost / scaling

- Compute profile is `d4-jobs` — a Container Apps **workload profile** (not the Consumption plan), sized for the Playwright + Chromium + concurrent-LLM-call workload (2.0 vCPU / 4Gi per replica as of the last cost-driven bump in Sprint 009).
- Container Apps **Jobs** (as opposed to long-running Apps) are inherently execution-scoped — there's no listener idling between runs, so the cost model is "pay per execution's vCPU-seconds and memory-seconds," not "pay to keep a replica warm." See [ADR-002](../../sdlc/decisions/ADR-002-compute-platform.md) for why Jobs (not Functions, ACI, AKS, App Service, or a VM) were chosen specifically for this scale-to-zero property.
- **Open item:** actually validating that the `d4-jobs` profile bills as zero at idle (as opposed to Consumption-plan Container Apps Jobs, where zero-idle is a given) is tracked as backlog **`#14`** ("d4-jobs minimumCount 0 validation — stop idle D4 billing; validate scale-from-zero") — parked, not yet confirmed. Treat idle-cost-at-zero as an assumption to verify, not a settled fact, until that item closes.
- Function App is Consumption plan — effectively free at this call volume.

## 8. Known operational hazards

- **Push-back race (backlog `#16`).** The end-of-run `sync.js push()` re-uploads **all** of `output/latest/` (every bank this run's container has locally, which — thanks to the additive `pull()` at start — is the full accumulated set), not just the banks this execution touched. If two executions overlap (e.g., an operator manually restoring/patching a subset of banks in blob while a cohort run is mid-flight), the batch run's final push can clobber the concurrent restore, because "last writer wins" at the file level with no per-bank locking. Backlog item `#16` proposes a **republish-only cloud mode** (`pull → build pack → gate → publish`, skipping both the per-bank agent loop *and* the redundant `output/latest` push-back) specifically to make a cloud republish cheap and race-free.
- **No dev environment.** Per [ADR-006](../../sdlc/decisions/ADR-006-environment-strategy.md), everything Azure-side is `prod`. Bicep changes, image rollouts, and kill-switch flips go straight to the one live environment — there is no staging gate. The mitigating discipline is `bicep what-if` before every apply and smoke-testing the image locally before pushing. This is a deliberate, revisitable trade for a team-of-one with no human-facing SLA, not an oversight.
- **The bank-domains.json image/blob gotcha** from §3 is worth repeating here as an operational hazard, not just a container-build note: it's the most common source of "I fixed the registry but the cloud run still failed" confusion.

## 9. Pointers

| Doc | What it covers |
|---|---|
| [`sdlc/deployment.md`](../../sdlc/deployment.md) | The authoritative, deeper deployment design doc — identity/secret model, secret-rotation runbook, IaC module list, cost envelope tables. Predates the FIRA→FIRA rename in places (`rg-fira-*` naming) — read topology *shape* from it, read *live names* from this page or the operator handover. |
| [ADR-001](../../sdlc/decisions/ADR-001-iac-tool.md) | Why Bicep as the IaC tool |
| [ADR-002](../../sdlc/decisions/ADR-002-compute-platform.md) | Why Container Apps Jobs (vs. Functions/ACI/AKS/App Service/VM) |
| [ADR-005](../../sdlc/decisions/ADR-005-trigger-architecture.md) | Why an HTTP Function fronts the Job (vs. direct ARM calls, Logic Apps, CLI-only) |
| [ADR-006](../../sdlc/decisions/ADR-006-environment-strategy.md) | Why single-env (`prod` only), and the revisit conditions |
| [ADR-007](../../sdlc/decisions/ADR-007-azure-region.md) | Why `southindia` |
| [ADR-013](../../sdlc/decisions/ADR-013-bicep-appsettings-deploy-config.md) | Why deploy-time settings (`WEBSITE_RUN_FROM_PACKAGE`, the git kill-switch) must be threaded as Bicep parameters on every apply |
| [overview.md](overview.md) | Whole-system map — start here if you haven't; §4 covers the two stores, §7 covers current handover state |
| [architecture.md](architecture.md) | Local-vs-cloud runtime picture, the engine's control flow |
| **operator-guide.md** *(sibling doc)* | The actual runbook: commands to run a cohort locally or via the Function, deploy an image, build/gate/publish a pack, reconcile blob vs. git, flip the kill switch, troubleshoot a stuck execution. This page is topology/design; that one is how-to. |

---

*Written for handover, 2026-07-09. Reconciled against `Dockerfile`, `iac/main.bicep`, `iac/deploy-image.sh`, `iac/modules/`, `cloud/sync.js`, `cloud/git-publish.js`, `functions/start-discovery/`, `functions/job-status/`, `run-batch.js`, and ADR-002/005/006/007/013 as of this date.*

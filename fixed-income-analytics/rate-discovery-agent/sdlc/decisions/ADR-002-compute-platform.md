# ADR-002: Compute platform for the agent runtime

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — Container Apps Jobs (no VNet integration in sprint 001) |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-04 |
| Sprint | 001 |
| Supersedes | — |

## Context

The rate-discovery agent is a Node.js process that:
- Runs for minutes to hours per execution (one bank takes ~30s–2min; batch runs of 50 banks take ~30–60min)
- Spawns Chromium via Playwright for JS-rendered bank sites
- Calls Azure OpenAI heavily (the cost driver)
- Reads/writes JSON files (will be backed by blob storage in cloud)
- Currently triggered manually (will add scheduled triggers in sprint 002)

The compute platform must support:
- Long-running execution (no 5–10 min ceiling)
- Container-based deployment (Playwright + Chromium need a known OS environment)
- Scale-to-zero between runs (cost discipline — agent is idle most of the time)
- Cron scheduling (sprint 002)
- Manual / API-triggered invocation (sprint 001)
- Managed identity for Azure resource access
- Reasonable cold-start time (a few seconds is fine; a few minutes is not)

## Options considered

### Option 1: Azure Container Apps Jobs

**What it is:** Azure's managed container platform with first-class support for "jobs" — finite-duration containerized executions, distinct from always-on apps.

**Pros:**
- Job semantics fit perfectly: one execution = one batch run, lifecycle managed by the platform
- Scale-to-zero is automatic and free between runs
- Cron triggers built-in (sprint 002 needs no additional infra)
- Manual triggers via Azure Management API or CLI
- Managed identity supported
- Bring-your-own-image from any registry (ACR fits)
- No execution-time ceiling for jobs (apps have a 1-hour scale-down timer; jobs run as long as needed up to ~7 days hard limit)
- Pay per vCPU-second + memory-second of execution only

**Cons:**
- Per-job-execution cold start ~30–60s (image pull + container start)
- One Container Apps Environment costs ~$0/mo at idle but VNet-integrated environments have a base cost
- Newer service — fewer Stack Overflow answers than Functions
- Limit of 50 jobs per environment by default (raisable; well above our needs)

### Option 2: Azure Functions (Premium plan)

**What it is:** Serverless functions; Premium plan supports long-running (up to 60 min) executions and pre-warmed instances.

**Pros:**
- Mature platform with rich tooling
- HTTP trigger, timer trigger, queue trigger all built-in
- Strong VS Code integration

**Cons:**
- 60-minute hard ceiling per execution — kills batch runs of >20 banks
- Playwright + Chromium on Functions requires custom Docker image (custom-handler or Linux container plan), defeating the "easy serverless" advantage
- Premium plan has a base monthly cost (~$150+) for the always-on instance; Consumption plan caps at 10 min
- Not the right semantic fit — Functions are designed for short event-driven work, not long batch jobs

### Option 3: Azure Container Instances (ACI)

**What it is:** Run a single container in Azure without orchestration overhead.

**Pros:**
- Truly minimal — one container, one billing record
- Per-second billing
- Fast start (~30s)
- Bring-your-own-image

**Cons:**
- No native cron — would need Logic App or Azure Automation to schedule
- No native HTTP trigger — would need a Function in front anyway
- Each execution is a separate ACI deployment — operational ergonomics worse than Container Apps Jobs
- No built-in retry / failure handling
- Effectively "Container Apps Jobs without the platform features" — strictly worse for our use case

### Option 4: Azure Kubernetes Service (AKS)

**What it is:** Managed Kubernetes, run anything you can put in a container.

**Pros:**
- Maximum flexibility
- Industry-standard primitives (CronJob, Job)
- Full control over networking, scheduling, resources

**Cons:**
- Massive operational overhead for a single-job workload (cluster upgrades, node pool management, RBAC, Helm, ingress, monitoring stack)
- Minimum cluster cost ~$70+/mo even if idle
- Disproportionate to current and foreseeable needs
- Would need a dedicated person to operate well

### Option 5: App Service (with WebJobs)

**What it is:** Azure's PaaS for web apps, with WebJobs as the side-car for background tasks.

**Pros:**
- Familiar PaaS model
- WebJobs support continuous, triggered, and scheduled execution

**Cons:**
- App Service Plan must be always-on to host WebJobs reliably (no scale-to-zero) — base cost ~$15+/mo
- Designed for web-app-with-background-tasks, not job-only workloads
- Awkward fit for batch-only execution
- Playwright runtime requires careful plan selection (P1v3 or higher for Chromium reliably)

### Option 6: Self-managed VM

**What it is:** Run the agent on a small Linux VM, schedule with cron, restart with systemd.

**Pros:**
- Total control
- Familiar to anyone with sysadmin background
- Can be cheap (B1s VM ~$8/mo)

**Cons:**
- Not scale-to-zero — pays for idle hours
- OS patching, image hardening, security updates all on us
- No native managed identity story for arbitrary processes
- Manual recovery on VM failure
- Defeats the purpose of using a managed cloud

## Tradeoffs

| Axis | Container Apps Jobs | Functions Premium | ACI | AKS | App Service WebJobs | VM |
|---|---|---|---|---|---|---|
| Long execution support | Excellent (~7 days) | 60 min ceiling | Excellent | Excellent | Excellent | Excellent |
| Scale to zero | Yes | No | Yes | No | No | No |
| Native cron | Yes | Yes | No | Yes (k8s CronJob) | Yes | Yes (cron) |
| Cold start | ~30–60s | ~10s (warm), ~30s (cold) | ~30s | <10s (warm) | <10s | N/A |
| Idle cost | ~$0 | ~$150/mo | ~$0 | ~$70+/mo | ~$15+/mo | ~$8+/mo |
| Operational overhead | Low | Low | Low | High | Medium | High |
| Playwright fit | Native (BYO image) | Awkward | Native | Native | Awkward | Native |
| Managed identity | Yes | Yes | Yes | Yes (workload identity) | Yes | Limited |

## Recommendation

**Azure Container Apps Jobs.**

Reasoning: The job-execution-as-billing-unit model matches the workload exactly. Scale-to-zero handles our intermittent usage pattern. Native cron in sprint 002 is one Bicep property change. Managed identity, Key Vault references, container registry pulls all work out of the box. The only mild concern is cold-start (~30–60s per execution), which is a non-issue for a batch job that runs for tens of minutes.

Functions Premium is the only other plausible candidate, but the 60-minute ceiling is a real problem (a single FB batch can exceed it) and the always-on cost negates the "serverless" benefit.

ACI is essentially a worse Container Apps Jobs. AKS, WebJobs, and VMs are not appropriate for the size of this workload.

## Consequences

If Container Apps Jobs is chosen:
- One Container Apps Environment hosts all jobs (sprint 002 will add more as scheduling tiers are introduced)
- Image lives in ACR (see ADR-001 for IaC; ACR provisioning is part of sprint 001)
- Job definition includes resource limits (memory, vCPU), env vars (Key Vault refs), managed identity binding
- Logs land in Container Apps' built-in log streaming → Log Analytics workspace
- Per-execution telemetry (duration, exit code) is captured by Container Apps automatically

Lock-in: container images are portable to ACI, AKS, or any Kubernetes platform; switching costs are limited to redoing the IaC and trigger plumbing.

## Open questions (resolved)

1. **Multi-day batches?** No. LLM cost would dominate before runtime did. Container Apps Jobs' 7-day ceiling is irrelevant.
2. **GPU?** No. Agent is I/O and LLM-bound; no local model inference. (A future, separate project may need local VLMs — out of scope here.)
3. **VNet-integrated environment from day one?** No. Public-endpoint posture for sprint 001. Cost of VNet from day one (~$33–35/mo for NAT Gateway alone, ~$57/mo with full private endpoints) is not justified by current threat model. Future migration cost (~30 min one-time recreation of the environment + job redeploy) is accepted as the trade. Revisit condition (compliance need surfacing) is tracked in sprint 001 `deferred.md` item 6.

## Decision log

- **2026-05-04** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (Azure Container Apps Jobs)**, public-endpoint posture (no VNet integration).
  - ACI was given a deeper second look as the only plausible runner-up. Concluded that ACI's lower platform overhead doesn't pay off for our pattern: each ACI execution is an imperative resource lifecycle (create / monitor / delete) with no native cron, no native parallelism, no native retries, no execution history. Sprint 002 (scheduled tier-batched runs, possibly with parallelism) would force us to build orchestration glue that Container Apps Jobs provides natively. Per-second cost is essentially identical at our usage (~$5–10/mo).
  - Functions Premium ruled out by 60-min execution ceiling. AKS, App Service WebJobs, dedicated VM ruled out by idle cost or operational overhead disproportionate to the workload.
  - VNet integration analyzed separately: Container Apps Environment cannot be retrofitted with VNet — the env must be recreated. Cost of VNet from day one (NAT Gateway $32+/mo + per-GB egress, optional private endpoints ~$7.50/mo each for Storage / Key Vault / ACR) was weighed against the ~30-min one-time future migration. Public-endpoint posture chosen for sprint 001; deferred VNet item formally tracks the revisit condition.

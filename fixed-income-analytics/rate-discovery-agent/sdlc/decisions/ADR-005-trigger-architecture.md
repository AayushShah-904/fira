# ADR-005: Trigger architecture (manual + future scheduled)

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — HTTP Function in front of Container Apps Job |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-04 |
| Sprint | 001 |
| Supersedes | — |

## Context

The agent needs to be triggered in three ways:

1. **Manually from the operator's machine** (sprint 001) — "run the agent for these banks now"
2. **Programmatically from another system** (sprint 001 or later) — currently undefined consumer; could be a CLI script, a webhook from BIRD, etc.
3. **On a recurring schedule** (sprint 002) — tiered cron (e.g., daily / weekly / monthly groups)

The compute platform (ADR-002 recommends Container Apps Jobs) handles the actual execution. This ADR is about how trigger calls reach the platform.

Constraints:
- Manual trigger should be possible from anywhere (operator's laptop, a CI script, eventually a button in a UI)
- Authentication must be clean — operator-friendly but not insecure
- Scheduled triggers (sprint 002) shouldn't require re-architecting
- No always-on infrastructure if avoidable

## Options considered

### Option 1: HTTP Function in front of Container Apps Job

**What it is:** A small Azure Function exposes an HTTP endpoint (function key auth). When invoked, it validates the request body and calls the Azure Management API to start a Container Apps Job execution with the specified bank list as job arguments.

**Pros:**
- Function is the only public surface — auth happens once, in one place
- Function App (Consumption plan) is essentially free at trivial volume (~$0/mo)
- Clean separation: Function = auth + validation + dispatch; Job = work
- Same trigger surface for manual (curl), programmatic (any HTTP client), and future scheduled (Function timer trigger or cron-on-the-job side)
- Function logs every invocation — built-in audit trail
- Easy to add features later: rate limiting, queuing, retry, payload validation

**Cons:**
- One more service to provision (Function App + plan + storage account for Function metadata)
- Function cold-start adds ~1–2s before the job actually starts (not user-visible — they're already waiting minutes for the agent itself)
- Two-hop architecture (HTTP → Function → ARM API → Job) — slightly more moving parts to debug

### Option 2: Direct ARM API call from caller

**What it is:** No intermediary. Operator (or other caller) directly invokes the Azure REST API to start the job, authenticating with their own Azure credential (`az login` for humans, service principal for automation).

**Pros:**
- No additional infrastructure
- One less service to maintain
- Authentication uses Azure-native identity (no shared function keys)
- Most "Azure-native" approach

**Cons:**
- Caller needs Azure credentials with `Microsoft.App/jobs/start/action` permission — operationally clunky for ad-hoc human use
- Programmatic callers must implement Azure SDK / ARM auth themselves
- No payload validation layer — any bug in caller's input goes straight to the job
- Friction for "I want to give PM a webhook URL" or "I want a button on a status page"
- Audit trail is via Azure Activity Log — usable but less convenient than Function logs

### Option 3: Container App with HTTP ingress (no Function intermediary)

**What it is:** Instead of a job, run the agent as a Container App (continuously running) with HTTP ingress. POST to an endpoint to trigger a run.

**Pros:**
- Single deployable unit
- HTTP ingress + auth handled by Container Apps platform

**Cons:**
- Container Apps Apps are for long-running services, not batch jobs. Forces per-invocation work into a long-lived process — concurrency, lifecycle, and crash semantics get awkward
- Cannot scale to zero (HTTP ingress requires at least one replica running)
- Container restart on crash loses any in-flight work
- Wrong semantic fit — we want "one batch run = one execution," not "service handling many requests"

### Option 4: Azure Logic App / Azure Automation runbook

**What it is:** Use Logic Apps' visual workflow designer or Automation's PowerShell/Python runbooks to handle the trigger and orchestration.

**Pros:**
- No code for simple triggers (Logic App designer is no-code)
- Built-in connectors for many systems (could integrate with email, Slack, etc.)
- Scheduling built-in
- Good fit for "trigger that does multiple Azure things in sequence"

**Cons:**
- Logic Apps Consumption is per-action priced — gets surprisingly expensive at high invocation counts
- The visual designer becomes hard to version-control (JSON export is not human-friendly)
- Automation runbooks are PowerShell-leaning; Python support is more limited
- Overkill for "validate a payload, start a job"
- Adds yet another tool to learn

### Option 5: CLI-only (no programmatic trigger)

**What it is:** Operator runs `az containerapp job start` from their machine. No HTTP surface at all. Programmatic callers use the Azure SDK directly.

**Pros:**
- Zero additional infrastructure
- Genuinely the simplest possible

**Cons:**
- No story for "PM webhook" or "BIRD integration" later
- Operator must have Azure CLI + auth context every time
- Excludes any non-Azure-aware caller forever (or until we add this back)
- Doesn't compose with sprint 002's scheduling story

### Option 6: Container Apps Job with built-in cron only (no manual trigger surface)

**What it is:** Use Container Apps Jobs' native cron trigger and forgo any manual-trigger story. Operator wanting to run on demand uses `az containerapp job start` from the CLI.

**Pros:**
- No HTTP surface to maintain
- Native scheduling

**Cons:**
- Same issues as Option 5 for any non-CLI caller
- Doesn't address sprint 001's manual-trigger requirement cleanly

## Tradeoffs

| Axis | Function front | Direct ARM | App with HTTP | Logic App | CLI only | Cron-only |
|---|---|---|---|---|---|---|
| Manual ad-hoc trigger | curl + key | `az` CLI + auth | curl + auth | curl + auth | `az` CLI + auth | `az` CLI + auth |
| Programmatic trigger | curl from anywhere | Azure SDK | curl from anywhere | curl from anywhere | Azure SDK | Azure SDK |
| Scheduled trigger | Function timer or job cron | Direct cron | Built-in | Built-in | Cron-on-laptop | Native |
| Additional infra | Function App | None | None (replaces job) | Logic App | None | None |
| Additional cost | ~$0 | $0 | Higher (always-on) | Per-action | $0 | $0 |
| Auth flexibility | Function key today, Entra later | Azure-native only | Multiple options | Multiple options | Azure-native only | Azure-native only |
| Validation / observability | Excellent | Minimal | OK | OK | None | None |

## Recommendation

**Option 1: HTTP Function in front of Container Apps Job.**

Reasoning: It's the only option that cleanly handles all three trigger types (manual via curl, programmatic via HTTP, scheduled via Function timer or job cron) with one consistent interface. The Function adds ~$0/mo and ~2s of latency that nobody will notice. Auth, validation, and audit live in the Function — exactly where they should.

Direct ARM API (Option 2) is the runner-up and is genuinely tempting for its simplicity, but it makes "share trigger access with someone who isn't an Azure user" impossible without re-adding a Function later. Cleaner to put the Function in from the start.

Container App with HTTP ingress (Option 3) misuses the platform — apps are for services, jobs are for batches. We have a batch.

The function-key auth choice is documented as deferred (see sprint 001 `deferred.md` item 4 — revisit when shared with another user).

## Consequences

If chosen:
- Provision an Azure Function App (Consumption plan, Linux, Node 20 runtime) under `func-bird-trigger`
- One HTTP-triggered function: `start-discovery` (POST /api/start-discovery)
- Request body: `{ banks: ["slug1", ...], category?: "PSB", refresh_cadence?: "weekly" }` — validation rules TBD in design phase
- Function uses managed identity to call ARM `Microsoft.App/jobs/{name}/start/action`; needs role assignment `Container Apps Jobs Operator` (or custom role with that single permission)
- Function returns `{ executionId, jobName, startedAt }` — caller can poll job status via separate Azure CLI / portal
- Sprint 002 adds either:
  - **Option A:** A timer-triggered function that fires on cron and calls the same dispatch logic (DRY); or
  - **Option B:** Container Apps Jobs' native cron, configured per tier in IaC (no Function involvement for scheduled runs)
  - This sub-decision is left for sprint 002

Lock-in: low. Function is ~50 lines of code; replacing it with a different trigger surface (e.g., Logic App, queue-based, GitHub webhook) is a few hours of work.

## Open questions (deferred to sprint 001 design phase)

These are interface design details to be resolved in `sprints/sprint-001-azure-foundation/design/function-trigger.md`. None changes the architectural choice of an HTTP Function in front of the Job.

1. Request body schema — minimal (`banks` array only) for sprint 001 and grow later, or full envelope (`banks` / `category` / `cadence` / `dry_run`) up front?
2. Async (return execution ID immediately) vs sync (block until job finishes) response model. Async is the obvious choice given runtime length but worth being explicit.
3. Future polling endpoint (`GET /api/job-status/{executionId}`) — not required for sprint 001 but worth designing the path now.
4. Idempotency on duplicate calls — run twice with a warning if last run on same banks was very recent, or deduplicate.

## Decision log

- **2026-05-04** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (HTTP Function in front of Container Apps Job)**.
  - Direct ARM call (Option 2) was the runner-up and genuinely simpler for a sole-operator scenario, but rejected on the basis that any future webhook / status page / external integration would require re-adding a Function later. Cleaner to put the Function in from the start.
  - Container App with HTTP ingress (Option 3) was a misuse of the platform — apps for services, jobs for batches.
  - Logic App, CLI-only, and cron-only were ruled out as variously over- or under-fitted.
  - Sub-decision on scheduling integration (sprint 002): whether scheduled runs flow through the same Function (timer-triggered → dispatch logic) or use Container Apps Jobs' native cron is left for sprint 002 to decide.
  - Function key auth on the trigger endpoint is documented as deferred (see sprint 001 `deferred.md` item 4 — revisit when shared with another user).
  - Interface details deferred to sprint 001 design phase.

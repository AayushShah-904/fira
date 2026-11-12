# ADR-006: Environment strategy (single vs multi-env)

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — Single environment (`prod` only); resource names encode env from day one |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-05 |
| Sprint | 001 |
| Supersedes | — |

## Context

The agent needs deployed compute, storage, secrets, and trigger surfaces in Azure. The standard SaaS playbook deploys these to multiple parallel environments (dev / staging / prod) so changes can be tested before reaching production. This ADR is about whether that's appropriate now.

Operating realities of this agent:
- The agent is **read-only on the world** (it scrapes public bank pages)
- Output is **regenerable on failure** (re-run the discovery; no irreversible side effects)
- The published pack is **idempotent** — re-publishing the same data has no consequence
- There is **no human-impacting SLA** — PM consumes the pack on a refresh cycle measured in days, not seconds
- The team is **one person** (you) for now

The classic case for multi-env (catch breaking changes before they reach customers) is weaker here than in a typical web service.

## Options considered

### Option 1: Single environment (`prod` only)

**What it is:** One resource group, one Container Apps Job, one storage account, one Function. All work happens against production.

**Pros:**
- Lowest cost (~$15–25/mo infra)
- Lowest operational overhead (one deploy target, one set of secrets, one runbook)
- Faster iteration — change → deploy → see effect, no env-promotion ceremony
- Matches current scale and team size
- "Local development" effectively serves as the test environment for code changes (the storage adapter from ADR-004 enables this)

**Cons:**
- Bicep changes go straight to prod — no staging gate to catch IaC mistakes
- A botched container image rollout could disrupt the pack publish pipeline
- Refactors that touch the Azure-side of the storage adapter can't be tested except by deploying

### Option 2: Two environments (`dev` + `prod`)

**What it is:** Two resource groups (or one RG with naming-convention separation), each running the same Bicep with different parameter files. Changes deploy to `dev` first, get smoke-tested, then deploy to `prod`.

**Pros:**
- Standard SaaS hygiene — risky changes can be tested before reaching prod
- IaC changes get a `what-if` against dev before prod
- Container image can be smoke-tested in dev before promoting

**Cons:**
- Roughly double the infra cost (~$30–50/mo)
- Twice the secrets to manage (Azure OpenAI keys, Function keys, PM service principal — separate per env)
- Twice the deploy steps for any change
- Dev environment will sit idle most of the time — paying for unused capacity
- Adds an env-promotion procedure to the runbook
- For the current team-of-one, the second environment will mostly be neglected after initial setup ("I'll just deploy straight to prod, dev's drifted anyway") — this is the realistic failure mode

### Option 3: Three environments (`dev` + `staging` + `prod`)

**What it is:** Full SaaS multi-env with a staging tier between dev and prod for pre-release validation.

**Pros:**
- Best practice for customer-facing systems
- Clear separation between "engineering iteration" (dev), "release candidate" (staging), and "live" (prod)
- Scales well for multi-engineer teams

**Cons:**
- Triple infra cost (~$45–75/mo)
- Triple the secrets, triple the deploys
- Significant overkill for a one-person batch agent with no SLA
- Staging environment will be even more neglected than a two-env dev

### Option 4: Ephemeral per-PR environments

**What it is:** Each pull request spins up a temporary environment for testing, torn down on merge.

**Pros:**
- Each change gets full E2E validation against real Azure
- Strong CI/CD discipline

**Cons:**
- Requires CI/CD pipeline (deferred to sprint 004)
- Ephemeral envs need full provisioning automation, including DNS, secrets, etc.
- Per-env provisioning takes time (~10 min for full Bicep apply) — slows down PRs
- Disproportionate complexity for current team size and change rate
- Best for established multi-engineer teams with mature CI/CD

### Option 5: "Local" as `dev`, Azure as `prod` only

**What it is:** Use the local-development setup (storage adapter in `local` mode, fs-based storage, `.env` file) as the de facto dev environment. Skip a parallel Azure dev env entirely. Azure only hosts production.

**Pros:**
- Zero added cost
- Local dev parity (already required by ADR-004) doubles as the test environment
- Fastest iteration — change → run locally → see effect → push
- Azure-side changes (Bicep, container image, Function) still need careful staging, but those are infrequent

**Cons:**
- Doesn't catch issues specific to the Azure runtime (blob SDK behavior, managed identity quirks, Container Apps Job lifecycle)
- A bad Bicep change still goes straight to prod when applied
- Container image changes get tested only post-deploy

## Tradeoffs

| Axis | Single env | Dev + prod | Dev + staging + prod | Ephemeral PR | Local + prod |
|---|---|---|---|---|---|
| Monthly infra cost | ~$15–25 | ~$30–50 | ~$45–75 | Variable | ~$15–25 |
| Operational overhead | Low | Medium | High | High (after CI/CD) | Low |
| Catches Azure-side bugs pre-prod | No | Yes | Yes | Yes | No |
| Catches IaC bugs pre-prod | No | Yes | Yes | Yes | No |
| Fits team-of-one | Yes | Marginal | No | No | Yes |
| Fits batch agent semantics | Yes | Yes | Yes (overkill) | Yes (overkill) | Yes |
| "Realistic" given likely engineering practice | Yes | Doubtful | Doubtful | No | Yes |

## Recommendation

**Option 1: Single environment (`prod` only).**

Reasoning: The agent's risk profile (read-only on the world, regenerable on failure, no human SLA) doesn't justify parallel environments. The honest assessment for a team-of-one is that a `dev` environment will be neglected within weeks ("I'll just deploy to prod, dev's drifted") — the operational hygiene benefit on paper doesn't materialize in practice. Local development with the storage adapter (ADR-004) covers the "test before deploying to prod" need for everything except Azure-runtime-specific behavior.

The risks (botched IaC, bad container image) are mitigated by:
- Bicep `what-if` before every apply
- Smoke-test the container image locally before pushing to ACR
- Keep the published pack idempotent — even if a run produces bad data, the next correct run overwrites it

This decision is **explicitly revisitable** when:
- A second engineer joins (real need for shared sandbox)
- The pack consumer becomes business-critical with a defined SLA
- A non-trivial pipeline change needs end-to-end testing without risk

Sprint 005 owns the multi-env split when it triggers.

## Consequences

If single-env is chosen:
- One resource group: `rg-bird-rate-agent-southindia`
- One set of Bicep parameters: `iac/parameters.prod.bicepparam`
- One storage account, one Container Apps Environment, one Job, one Function App, one Key Vault, one ACR
- One PM service principal with read access to `rates-pack`
- Operational discipline: `bicep what-if` before every apply, smoke-test image locally before push
- Future split: when triggered, Sprint 005 introduces `parameters.dev.bicepparam` (and possibly `staging`), reusing the same Bicep modules. Infra cost roughly doubles per added env.

Lock-in: very low. Adding environments later is straightforward — same Bicep modules, new parameter files. The risk is that names baked into URLs / configs need to be parameterized; sprint 001 design should keep this in mind even if only one env exists.

## Open questions (resolved + deferred)

1. **Resource name conventions:** RESOLVED — names encode environment from day one (e.g., `rg-bird-rate-agent-prod-southindia`, `stbirdratepackprod<suffix>`, `caj-rate-discovery-prod`). Cost is zero today; saves rename pain when multi-env arrives. Bicep parameter `envName` defaults to `prod`; future `dev`/`staging` envs supply different values.
2. **Compliance / audit mandates:** DEFERRED — no known driver today. To be re-checked if the agent ever processes non-public data or comes under a compliance regime.
3. **SLA propagation from PM's downstream consumers:** DEFERRED — depends on PM's commitments to their users. Re-check at the next ADR review when PM's user base is known.

## Decision log

- **2026-05-05** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (single environment, `prod` only)**.
  - Two-env (Option 2) and three-env (Option 3) ruled out as disproportionate to a team-of-one workload with no human-impacting SLA. Honest assessment: a parallel `dev` env would realistically be neglected within weeks.
  - Local development (with the storage adapter from ADR-004) substitutes for `dev` for everything except Azure-runtime-specific behavior. Azure-side risks (botched IaC, bad container image) are mitigated by `bicep what-if` before every apply and local smoke-testing of the image before push.
  - **Sub-decision: resource names encode environment from day one** (`-prod-` suffix in resource names, `envName` parameter in Bicep). Cost is zero today; saves rename pain if multi-env is introduced later.
  - Sprint 005 owns the multi-env split when its revisit condition triggers (second engineer, defined SLA, or pipeline-change-needs-testing scenario).

# ADR-001: IaC tool

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — Bicep |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-04 |
| Sprint | 001 |
| Supersedes | — |

## Context

We need to provision and maintain a small set of Azure resources for the agent (ACR, storage account, Key Vault, Container Apps environment + job, Function app, Entra app registration). The footprint is currently ~7 resources but will grow as later sprints add observability, scheduling, and possibly a second environment.

We need:
- Repeatable, reviewable provisioning (no clickops drift)
- Plain-text definitions in the repo
- Preview / dry-run before applying
- Reasonable handling of the eventual second environment (sprint 005)

We don't need:
- Multi-cloud abstraction — Azure is the only target
- A heavyweight platform (no need for service mesh, complex policy engines, etc.)

## Options considered

### Option 1: Bicep (Microsoft's Azure DSL)

**What it is:** A domain-specific language that transpiles to ARM JSON. First-party Microsoft tool. No state file — Azure is the source of truth.

**Pros:**
- Zero state-file management overhead (no remote state backend, no locking concerns)
- First-class support for new Azure resources (often available before Terraform's AzureRM provider catches up)
- `az deployment group what-if` produces accurate previews
- Modular (`module` keyword), parameter files (`.bicepparam`)
- VS Code extension is excellent (intellisense, type checking)
- No license, no fee

**Cons:**
- Azure-only (we don't care, but worth noting)
- Smaller ecosystem than Terraform — fewer published reusable modules
- Some advanced patterns (loops, conditionals, nested deployments) get awkward
- Single-vendor dependency

### Option 2: Terraform

**What it is:** HashiCorp's multi-cloud IaC tool using HCL. AzureRM provider for Azure resources. Requires a state backend.

**Pros:**
- Mature ecosystem, large community, abundant published modules
- Multi-cloud (irrelevant here, but a future hedge)
- Strong type system, plan/apply workflow well-understood
- Rich CI/CD integrations

**Cons:**
- Requires a state backend (typically a storage account + blob lock) — adds one more thing to bootstrap
- AzureRM provider sometimes lags Azure feature releases (Container Apps Jobs support specifically had ~6-month lag historically)
- HCL is its own language — yet another DSL to learn
- HashiCorp's BSL license change (2023) may matter for some organizations; OpenTofu fork exists

### Option 3: Pulumi

**What it is:** IaC in TypeScript / Python / Go / C#. Uses cloud-provider SDKs under the hood. Requires a state backend (Pulumi-hosted or self-hosted).

**Pros:**
- Real programming language (TypeScript fits the rest of the stack)
- Full type safety, IDE refactoring tools work
- Easy to abstract patterns into shared library functions
- Multi-cloud

**Cons:**
- More moving parts (Pulumi engine, state backend, language runtime)
- Higher barrier to entry — IaC and code intermix can become opaque
- Free tier exists but commercial licensing applies above team-of-3
- Smaller community than Terraform

### Option 4: Azure Developer CLI (azd)

**What it is:** Higher-level Microsoft tool that wraps Bicep + app build + deploy in a single `azd up` command, using opinionated project conventions.

**Pros:**
- One command provisions infra and deploys apps
- Good for greenfield projects starting from a template
- Built on Bicep, so all of Bicep's benefits apply
- Strong story for "init → deploy in 5 minutes"

**Cons:**
- Opinionated project layout may not fit our existing structure
- Hides Bicep details under conventions — debugging requires understanding both layers
- Best fit for service apps, not batch jobs
- Adds another tool to learn for limited gain over plain Bicep

### Option 5: Azure CLI scripts (bash)

**What it is:** Shell scripts that invoke `az` commands imperatively.

**Pros:**
- No DSL to learn — anyone who knows `az` can read it
- Trivial to start
- No state, no backend, no engine

**Cons:**
- Imperative, not declarative — drift detection is impossible
- No preview / dry-run
- Idempotency is the script author's problem
- Doesn't scale beyond ~5 resources before becoming unmaintainable
- No modularity story

### Option 6: ARM templates (raw JSON)

**What it is:** Azure's native template language, JSON-based.

**Pros:**
- No transpilation step
- 1:1 with Azure REST API

**Cons:**
- Verbose to the point of unreadable
- Microsoft itself has effectively replaced ARM with Bicep
- No reason to choose this in 2026

## Tradeoffs

| Axis | Bicep | Terraform | Pulumi | azd | Scripts | ARM |
|---|---|---|---|---|---|---|
| Setup overhead | Low | Medium (state backend) | Medium-high | Low | None | None |
| Azure-feature freshness | Best | Good (sometimes lags) | Good | Best | N/A | Best |
| Modularity | Good | Excellent | Excellent | Good | Poor | Poor |
| Ecosystem | Medium | Excellent | Good | Small | N/A | Small |
| Learning curve | Low-medium | Medium | Medium-high | Low | Low | High |
| Drift detection | Yes (`what-if`) | Yes (`plan`) | Yes (`preview`) | Yes (via Bicep) | No | Yes |
| Multi-cloud future | No | Yes | Yes | No | Manual | No |
| Lock-in | High | Low | Low | High | None | High |

## Recommendation

**Bicep.**

Reasoning: The footprint is small, the target is Azure-only, and the agent has no foreseeable multi-cloud requirement. The tradeoff calculation comes down to "what's the lowest-overhead tool that gives us reviewable, repeatable, previewable provisioning?" — and Bicep wins on that axis without giving up anything we'd actually use.

The Terraform argument ("we might need multi-cloud someday") is a hypothetical that doesn't justify the state-backend overhead today. Pulumi is interesting because the rest of the stack is TypeScript, but the IaC code is small enough that the language uniformity benefit doesn't pay back the added complexity. azd is a reasonable contender if we want one-command bootstrap, but our flow (provision rarely, deploy app frequently) doesn't match its sweet spot.

If the team has existing Terraform fluency from another project, that flips the recommendation — switching costs would dominate. **Open question for decision: is there existing IaC tooling familiarity that should bias this choice?**

## Consequences

If Bicep is chosen:
- IaC lives under `iac/` as `.bicep` files (modules + entry points + parameter files)
- Apply via `az deployment group create`
- No state backend required; Azure RG is the source of truth
- New environments come from new `.bicepparam` files (sprint 005)
- Migration path to Terraform later is non-trivial but possible (existing tools exist for ARM→Terraform conversion)

If Terraform is chosen instead:
- Need to provision state-backend storage account first (chicken-and-egg — typically done once manually)
- Need `provider "azurerm"` and lock-versions discipline
- CI/CD pipeline needs `terraform init` step

## Open questions (resolved)

1. **Existing IaC fluency on the team?** Decider has Terraform fluency from AWS (HCL, plan/apply workflow, state backend setup). This made Terraform appear to be the lowest-cost choice on switching grounds.
2. **Any organizational mandate?** No.
3. **Non-Azure infrastructure within the next year?** Not anticipated. The agent's footprint is Azure-only.

## Decision log

- **2026-05-04** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (Bicep)**.
  - Initial recommendation favored Bicep on small-footprint / no-state-backend grounds.
  - Decider's existing Terraform-on-AWS fluency was raised; revised analysis flipped the recommendation toward Terraform on lowest-effort grounds.
  - AzureRM provider feature parity for sprint 001 needs (Container Apps Jobs, Key Vault secret refs, managed identity, ACR pull) was verified against provider v4.71.0 (released 2026-04-30) — fully supported, GA.
  - Decider then asked whether choosing Terraform would forgo Azure-native learning. Honest revised framing distinguished what Terraform abstracts (ARM template structure, deployment scopes, Microsoft documentation idiom) from what it doesn't (the Azure resources themselves, RBAC, managed identity, runtime SDK use).
  - State management implications discussed: Bicep has no state file (Azure is source of truth), trades Terraform's explicit state-manipulation toolkit for a simpler model that can't drift between tool and reality.
  - Final decision: Bicep, on the basis that (a) the trajectory is Azure-only, (b) Microsoft documentation defaults to Bicep so day-to-day docs friction is lower, (c) state-backend overhead is avoided, (d) sprint 001 is partly a learning vehicle for Azure-native deployment patterns, (e) the 2–3 day Bicep learning curve amortizes well across future Azure work.
  - Lock-in risk acknowledged and accepted.

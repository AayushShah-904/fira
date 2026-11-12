# Architecture Decision Records

ADRs are the authoritative record of significant technical decisions for the rate-discovery-agent. The top-level SDLC documents (`architecture.md`, `deployment.md`, `data-model.md`, `test-strategy.md`) reference ADRs by number rather than re-stating decisions — when you want to know *why* something is the way it is, the ADR is the source of truth.

## Status legend

| Status | Meaning |
|---|---|
| `PROPOSED` | Drafted with options + recommendation, awaiting review/decision. The recommended option is **not** yet in effect. Referencing docs note "see ADR-NNN (proposed)". |
| `DECIDED` | Accepted. The decision is in effect. Referencing docs cite the ADR as authoritative. |
| `SUPERSEDED` | Replaced by a later ADR (referenced in the header). Kept for history. |
| `WITHDRAWN` | Drafted but never accepted; abandoned without a successor. Kept for history. |

## Index

| # | Title | Status | Decided by | Date |
|---|---|---|---|---|
| [001](ADR-001-iac-tool.md) | IaC tool — **Bicep** | DECIDED | Samir Joshi | 2026-05-04 |
| [002](ADR-002-compute-platform.md) | Compute platform — **Container Apps Jobs** (no VNet) | DECIDED | Samir Joshi | 2026-05-04 |
| [003](ADR-003-pm-auth-model.md) | PM pack auth — **Entra ID SP + bearer token** | DECIDED | Samir Joshi | 2026-05-04 |
| [004](ADR-004-storage-abstraction.md) | Storage abstraction — **adapter pattern** | DECIDED | Samir Joshi | 2026-05-04 |
| [005](ADR-005-trigger-architecture.md) | Trigger architecture — **HTTP Function → Job** | DECIDED | Samir Joshi | 2026-05-04 |
| [006](ADR-006-environment-strategy.md) | Environment strategy — **single env (`prod`)** | DECIDED | Samir Joshi | 2026-05-05 |
| [007](ADR-007-azure-region.md) | Azure region — **South India** | DECIDED | Samir Joshi | 2026-05-05 |
| [008](ADR-008-test-runner.md) | Test runner — **`node --test`** | DECIDED | Samir Joshi | 2026-05-05 |
| [009](ADR-009-local-blob-emulation.md) | Local blob emulation — **Azurite (gated) + MemoryStorage** | DECIDED | Samir Joshi | 2026-05-05 |
| [010](ADR-010-blob-layout.md) | Blob layout — **1 account, 2 containers** | DECIDED | Samir Joshi | 2026-05-05 |
| [011](ADR-011-additive-state-semantics.md) | Additive state semantics across cloud runs — **Option 1 + confidence-aware registry merge** | DECIDED | Samir Joshi | 2026-05-10 |
| [012](ADR-012-write-discipline.md) | Centralized write path + required provenance for per-bank artifacts — **Option 1** | DECIDED | Samir Joshi | 2026-05-12 |

## Process

1. **Drafted** in PROPOSED state with: context, options considered, tradeoffs, recommendation, consequences, open questions.
2. **Reviewed** in conversation / PR comments. Options can be challenged, alternatives added, recommendation overridden.
3. **Decided** — the chosen option is recorded, status changes to DECIDED, "Decided by" and "Date" are filled in. Recommendation may or may not match the chosen option.
4. **Decision log** at the bottom of each ADR is append-only — captures the date and reason for any subsequent status change (e.g., DECIDED → SUPERSEDED when ADR-NNN+k replaces it).

ADRs are not deleted. If a decision turns out wrong, write a new ADR that supersedes it. The original stays for history.

## When to write a new ADR

Write one when:
- A choice has at least two reasonable options
- The choice will be hard to reverse once made (lock-in cost is non-trivial)
- The choice will be referenced repeatedly across the codebase or operational procedures
- A future engineer would reasonably ask "why was this chosen?"

Don't write one for:
- Implementation details that are easy to change (file naming, log formats, default timeouts)
- Decisions where there is genuinely no alternative worth considering
- Anything purely cosmetic

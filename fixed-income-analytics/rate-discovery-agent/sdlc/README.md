# SDLC — Rate Discovery Agent

This folder is the durable record of how the agent is built, deployed, and evolved. Sprint plans live under `sprints/sprint-NNN-<slug>/`. Cross-sprint references (architecture, data model, test strategy, deployment) live at the top level so each sprint can cite them rather than re-derive.

## Top-level documents

| File | Purpose |
|---|---|
| [`architecture.md`](architecture.md) | System components, runtime modes (local vs containerized), how the pieces fit |
| [`data-model.md`](data-model.md) | File and blob schemas, naming conventions, container layout |
| [`test-strategy.md`](test-strategy.md) | Unit / integration / regression layering, local vs container parity |
| [`deployment.md`](deployment.md) | Azure topology, IaC choice, secret/identity management, runbooks |

These documents describe the **target state**. They are updated as part of a sprint when the design changes — never speculatively. If a sprint deviates from one of these, the sprint's `implementation/` folder records the deviation and the top-level doc is updated at retrospection.

## Sprint folder layout

Every sprint follows the same shape:

```
sprints/sprint-NNN-<slug>/
├── plan/             scope, success criteria, risks, dependencies, deferred items
├── design/           technical design: interfaces, IaC modules, data flows
├── implementation/   what was actually built; deviations from design
├── test/             test results, coverage, manual verification log
└── retrospection/    what worked, what didn't, what to change for next sprint
```

`plan/` is written first and reviewed before any code. `design/` is written before implementation. `implementation/` and `test/` accumulate during the sprint. `retrospection/` is written at the end. Each subfolder may contain one or more markdown files; there is no fixed file list.

## Sprint map

| Sprint | Slug | Status | Summary |
|---|---|---|---|
| 001 | [azure-foundation](sprints/sprint-001-azure-foundation/) | Planning | Minimum viable Azure footprint: ACR, storage, Key Vault, Container Apps Job (manual trigger), Entra SP for PM access. Local-dev parity preserved. |

Future sprints — not yet scoped:

- **002 — scheduling**: tiered cron schedules, bank-cadence field in `bank-domains.json`, batch dispatch
- **003 — observability**: Application Insights, agent-run dashboards, cost tracking per bank
- **004 — CI/CD**: image build on push, Bicep deploy on merge, environment promotion
- **005 — split environments**: dev / staging / prod separation, blue-green for the trigger Function

These slugs are placeholders. Real scope is set when the sprint is opened.

## Conventions

- **One sprint open at a time.** Don't accumulate parallel WIP sprints.
- **Sprint numbers never reused.** If a sprint is abandoned, mark its plan "abandoned, see sprint NNN" and move on.
- **Top-level docs cite the sprint** that introduced or last revised a section: e.g., "Storage adapter — introduced in sprint 001, see `sprints/sprint-001-azure-foundation/design/storage-adapter.md`."
- **Deferred items** are tracked per sprint in `plan/deferred.md`. Each item has: choice taken, why deferred, condition to revisit. They are *not* tracked separately as a global backlog — when sprint NNN+1 opens, its plan reviews deferred items from prior sprints and pulls in any whose revisit condition has triggered.

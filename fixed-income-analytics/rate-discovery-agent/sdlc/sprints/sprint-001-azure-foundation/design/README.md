# Sprint 001 — Design

Technical design documents produced **before** implementation begins. All five drafted 2026-05-05 / 2026-05-06; reviewed against the relevant ADRs.

| Doc | Implements | Purpose |
|---|---|---|
| [`storage-adapter.md`](./storage-adapter.md) | ADR-004, ADR-009, ADR-010 | `Storage` interface (on top of `unstorage`), three drivers (`fs`, `azure-storage-blob`, `memory`), key conventions, error model, refactor surface across ~30 call sites |
| [`bicep-modules.md`](./bicep-modules.md) | ADR-001, ADR-002, ADR-006, ADR-007, ADR-010 | IaC layout: 11 module files, naming convention (`bofia` prefix), per-module contracts, RBAC composition, operator permissions required to apply, apply procedure |
| [`function-trigger.md`](./function-trigger.md) | ADR-005 | HTTP contract for `POST /api/start-discovery`, validation rules, dispatch logic via ARM SDK, Job-side category expansion (Function has zero blob roles on agent storage), error responses, async/polling story |
| [`container-image.md`](./container-image.md) | ADR-002 | Base image (`mcr.microsoft.com/playwright:vX-jammy`), layer composition, entrypoint contract (`node run-batch.js` + argv), tag strategy (`:latest` + `:<git-sha>`), `az acr build` procedure, three-layer smoke testing without local Docker |
| [`entra-app-pm-access.md`](./entra-app-pm-access.md) | ADR-003 | App registration shape, RBAC scoped to `rates-pack` container only, encrypted-file + voice-passphrase handoff procedure, SDK code samples (Node / Python / .NET), 90-day rotation runbook, migration path when PM moves to Azure |

Designs are written as prose + interface signatures + small diagrams as needed. They are NOT code. Implementation begins after this folder closes — see `../implementation/` for deviations and gotchas captured during the build.

## Cross-cutting decisions

A handful of choices span multiple docs and are worth surfacing here:

- **`bofia` prefix everywhere new** (Azure resources). The earlier `bird` prefix in `scope.md` and similar pre-2026-05-05 artifacts is intentionally not bulk-rewritten — see `bicep-modules.md` for the canonical resource name table.
- **Two storage accounts, not one.** The agent data account (`stbofiarateagentprod01`, hosting `agent-state` + `rates-pack` per ADR-010) is separate from the Functions runtime account (`stbofiafuncprod01`). The split preserves RBAC isolation: Function MI has zero role on the agent data account.
- **Function trigger is auth + dispatch only.** Bank-list resolution (category expansion via `bank-domains.json`) happens Job-side; the Function never reads the agent's data plane. See `function-trigger.md` "Why no blob access from the Function" for the reasoning.
- **No local Docker.** Image builds happen exclusively via `az acr build`. Agent code is verified locally without containers (Node + npm-Azurite); image-runtime regressions are caught only post-deploy. See `container-image.md` "Smoke testing — three layers, no local Docker".
- **PM handoff via passphrase-encrypted file**, not a third-party password manager. Two-channel delivery (encrypted archive on any channel + voice passphrase) suits the friendly low-volume relationship without requiring shared tooling.

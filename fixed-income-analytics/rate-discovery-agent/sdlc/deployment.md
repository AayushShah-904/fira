# Deployment

This document describes the **target Azure topology** for the agent and its supporting services, along with the IaC approach, identity/secret model, and operational runbook outline. Sprint 001 implements the foundation; later sprints layer on scheduling, observability, and CI/CD. Architectural decisions are recorded in [`decisions/`](decisions/) — this document references them rather than re-stating the rationale.

## Region

**South India** (`southindia`) — see [ADR-007](decisions/ADR-007-azure-region.md). An existing Azure OpenAI resource in South India is referenced (not re-provisioned).

## Azure topology (target state)

Resource names encode the environment (`prod`) per [ADR-006](decisions/ADR-006-environment-strategy.md) so adding `dev`/`staging` later is mechanical.

```
Resource Group:  rg-bird-rate-agent-prod-southindia
Region:          southindia

Existing (referenced, not provisioned):
  └── Azure OpenAI resource in South India  ─ see ADR-007
        └── Used by agent at runtime; no separate provisioning step

Provisioned by sprint 001 Bicep:

  ├── Azure Container Registry (Basic SKU)
  │     acrbirdprod<unique>.azurecr.io
  │     ─ Image: rate-discovery-agent:<tag>
  │
  ├── Storage Account (Standard_LRS, StorageV2)              ─ see ADR-010
  │     stbirdratepackprod<unique>
  │     ├── Container: agent-state          (private)
  │     └── Container: rates-pack           (private)
  │
  ├── Key Vault
  │     kv-bird-agent-prod-<unique>
  │     ├── Secret: azure-openai-api-key
  │     ├── Secret: azure-openai-endpoint
  │     └── (additional secrets added as needed)
  │
  ├── Container Apps Environment                              ─ public-endpoint posture
  │     cae-bird-agent-prod
  │
  ├── Container Apps Job                                      ─ see ADR-002
  │     caj-rate-discovery-prod
  │     ├── Image: ACR ref
  │     ├── Identity: system-assigned managed identity
  │     ├── Trigger type: Manual (initially); + Schedule (sprint 002)
  │     ├── Env: KV-referenced secrets, BIRD_STORAGE=azure, AZURE_STORAGE_ACCOUNT_NAME
  │     └── RBAC: Storage Blob Data Contributor on agent-state + rates-pack;
  │              Cognitive Services OpenAI User on the existing OpenAI resource
  │
  ├── Function App  (Consumption plan, Node 20)               ─ see ADR-005
  │     func-bird-trigger-prod
  │     ├── HTTP trigger: POST /api/start-discovery
  │     ├── Auth: function key
  │     ├── Identity: system-assigned managed identity
  │     └── RBAC: Microsoft.App/jobs/start/action on caj-rate-discovery-prod
  │
  └── Entra ID App Registration (tenant-scoped, not in resource group)  ─ see ADR-003
        app-bird-pm-rates-reader-prod
        ├── Service principal in tenant
        ├── Client secret (90-day rotation, stored in 1Password / equivalent)
        └── RBAC: Storage Blob Data Reader scoped to rates-pack container only
```

`<unique>` is a deterministic suffix (e.g., short hash of resource group name) to keep globally-unique names predictable. Final convention chosen in sprint 001 design phase (see ADR-010 open question).

## Identity model

| Principal | What it is | What it can do |
|---|---|---|
| Container Apps Job managed identity | System-assigned, lifecycle of the job | Read/write blobs in `agent-state` and `rates-pack`; read secrets from Key Vault; call Azure OpenAI (`Cognitive Services OpenAI User`) |
| Function App managed identity | System-assigned, lifecycle of the function | Start the Container Apps Job (no other rights) |
| `app-bird-pm-rates-reader-prod` service principal | Hand-created in Entra ID, tenant-scoped | Read blobs in `rates-pack` container only — nothing else |
| Developer (you) | Entra ID user | Owner / Contributor on the resource group; full access to Key Vault during dev |

Three principles (see [ADR-003](decisions/ADR-003-pm-auth-model.md) for the PM-access rationale):

1. **Managed identity over secrets** wherever both endpoints are in Azure.
2. **Service principal with client secret** only where a non-Azure caller (PM's third-party VM) needs access. Auto-resolves to managed identity when PM moves to Azure.
3. **No SAS tokens.** The query-string-credential pattern is excluded by design (logs, leaks, no role scoping).

## Secret rotation runbook (skeleton)

| Secret | Rotation cadence | Procedure |
|---|---|---|
| Azure OpenAI API key | On compromise; otherwise annually | Regenerate in Azure OpenAI portal → update Key Vault secret → Container App auto-picks up on next run |
| PM service principal client secret | 90 days | Generate new secret in Entra ID → hand to PM securely → confirm PM has switched → revoke old secret |
| Function key | On compromise; otherwise quarterly | Regenerate in Function portal → update PM's caller config (if PM triggers runs) |
| ACR admin (if used) | N/A — admin user disabled; Container App pulls via managed identity | — |

The full runbook is fleshed out in sprint 001's `implementation/` once the resources actually exist.

## IaC choice: Bicep

See [ADR-001](decisions/ADR-001-iac-tool.md). Module structure (decided in sprint 001 design phase):

```
rate-discovery-agent/iac/
├── main.bicep                   ← entry point; references all modules
├── parameters.prod.bicepparam   ← `prod` parameter values
└── modules/
    ├── acr.bicep
    ├── storage.bicep
    ├── keyvault.bicep
    ├── container-apps-env.bicep
    ├── container-apps-job.bicep
    ├── function-app.bicep
    └── entra-app-reg.bicep       ← separate (tenant-scoped deployment)
```

Apply via `az deployment group create --resource-group rg-bird-rate-agent-prod-southindia --template-file iac/main.bicep --parameters iac/parameters.prod.bicepparam`.

Future environments (deferred to sprint 005 — see ADR-006) add a new `parameters.<env>.bicepparam` file; modules are unchanged.

## Environments

Single environment (`prod` only) — see [ADR-006](decisions/ADR-006-environment-strategy.md). Resource names encode environment from day one so adding a parallel env is purely a new parameter file.

Revisit conditions (when to add a `dev`/`staging` env) and the rationale for staying single-env are in the ADR.

## Local development escape hatch

Per the architecture document, local development never touches Azure infrastructure beyond the Azure OpenAI endpoint. Specifically:

- `BIRD_STORAGE=local` (default) → all I/O hits the developer's filesystem.
- `pack/publish.js` → only invoked when `BIRD_STORAGE=azure`. Local builds stop at `pack/dist/`.
- `.env` file (gitignored) → holds the dev's Azure OpenAI key. No Key Vault dependency.

A developer with no Azure subscription at all can still run the unit and (most) integration tests, build a pack, and inspect it locally. The Azure-specific tests (Azurite-gated, Container App smoke) are gated behind environment variables and skip cleanly.

## Cost envelope (target)

Reproduced from the architecture discussion for traceability:

| Component | Estimated monthly cost |
|---|---:|
| Container Apps Jobs (scale-to-zero, ~5 hrs/wk runtime) | $5–15 |
| ACR Basic | $5 |
| Storage Account (LRS, ~few GB, low egress) | $1–3 |
| Key Vault (operations) | <$1 |
| Function App (Consumption, trivial volume) | $0 |
| **Infrastructure subtotal** | **~$15–25** |
| Azure OpenAI usage | Variable; gap-fill batch was ~$55 / 251 banks |

Cost is monitored by the per-run `*.summary.json` (already captured) plus Azure Cost Management at the resource group level. A cost alert at $100/month is a reasonable initial guardrail (set up in sprint 001).

## Operational runbook (skeleton — fleshed out in sprint 001)

- **Trigger a manual run:** `curl -X POST -H "x-functions-key: <key>" "https://func-bird-trigger-prod.azurewebsites.net/api/start-discovery" -d '{"banks": ["hdfc-bank-limited"]}'`
- **Watch logs:** `az containerapp job execution show ...` or stream from the Azure portal.
- **Inspect output:** browse `agent-state` container in the storage account.
- **Republish pack:** the publish step runs automatically at the end of each successful job.
- **Rotate PM service principal secret:** see secret rotation runbook above.
- **Rebuild image:** `az acr build --registry acrbirdprod<unique> --image rate-discovery-agent:<tag> .`

Each of these gets a dedicated short doc (link from here) once sprint 001 is in flight.

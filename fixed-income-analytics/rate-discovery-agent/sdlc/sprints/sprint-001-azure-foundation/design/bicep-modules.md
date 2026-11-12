# Design — Bicep modules

**Status:** Design draft 2026-05-06; implementation pending review
**Implements:** [ADR-001](../../../decisions/ADR-001-iac-tool.md), [ADR-002](../../../decisions/ADR-002-compute-platform.md), [ADR-006](../../../decisions/ADR-006-environment-strategy.md), [ADR-007](../../../decisions/ADR-007-azure-region.md), [ADR-010](../../../decisions/ADR-010-blob-layout.md)
**Touches:** new directory `iac/` — modules, entry point, parameter file
**New tooling:** Bicep CLI (`az bicep install`); no runtime dependency

## Scope

This doc pins down the IaC layout: which modules exist, what each one provisions, what parameters and outputs each one declares, the resource-naming convention, the RBAC assignments composed across modules, and the apply procedure. The architectural choice (Bicep, single env, public endpoints) is decided in the ADRs above; this doc is the implementation-level contract for sprint 001 IaC.

A note on the `bird`/`bofia` prefix: the project was renamed BIRD → FIA on 2026-05-05. Azure resources provisioned new use the `bofia` prefix. Earlier docs (scope.md from 2026-05-03) reference `bird`-prefixed names; those are intentionally not bulk-rewritten. This design uses `bofia` throughout — it's the canonical set of resource names.

## Naming convention

Pattern: `<resource-type-prefix>-bofia-rate-agent-<env>[-<location>]` (or no-dash, all-lowercase variants where Azure rules forbid dashes — e.g., storage accounts, ACR).

| Resource | Name | Notes |
|---|---|---|
| Resource group | `rg-bofia-rate-agent-prod-southindia` | Region in name per ADR-007 |
| ACR | `crbofiarateagentprod` | No dashes, lowercase, ≤50 chars; globally unique |
| Storage account (data) | `stbofiarateagentprod01` | No dashes, lowercase, ≤24 chars; globally unique; `01` suffix allows future re-creation |
| Storage account (Function backing) | `stbofiafuncprod01` | Functions runtime needs its own; kept separate for blast-radius isolation |
| Key Vault | `kv-bofia-rate-agent-prod` | ≤24 chars; globally unique |
| Log Analytics workspace | `log-bofia-rate-agent-prod` | Required for Container Apps Env |
| Container Apps Environment | `cae-bofia-rate-agent-prod` | Hosts the Job |
| Container Apps Job | `caj-bofia-rate-discovery-prod` | Single Job in sprint 001 |
| Function App | `func-bofia-trigger-prod` | Hosts the HTTP trigger |
| Function App plan | `plan-bofia-trigger-prod` | Linux Consumption (Y1) |
| User-assigned MI (Job) | `id-bofia-rate-agent-prod` | Job binds this; gets RBAC on storage / Key Vault / ACR / AOAI |
| User-assigned MI (Function) | `id-bofia-trigger-prod` | Function binds this; gets RBAC to start the Job |
| Entra app (PM reader) | `app-bofia-rates-reader-prod` | Created manually in `azure-prep.md`, not by Bicep — see [entra-app-pm-access.md](./entra-app-pm-access.md) |

The `envName` Bicep parameter is `'prod'` for sprint 001; future envs supply different values per ADR-006.

## Module layout

```
iac/
├── main.bicep                          (entry; subscription-scope deployment)
├── parameters.prod.bicepparam
└── modules/
    ├── log-analytics.bicep
    ├── managed-identity.bicep          (parameterized; called twice — Job MI + Function MI)
    ├── acr.bicep
    ├── storage.bicep                   (data account + 2 containers + lifecycle policy)
    ├── storage-functions.bicep         (separate account for Function runtime)
    ├── keyvault.bicep
    ├── container-apps-env.bicep
    ├── container-apps-job.bicep
    ├── function-app.bicep
    └── role-assignments.bicep          (cross-cutting; called from main with all consumers wired up)
```

Eleven `.bicep` files total. The split keeps each module ≤120 lines and aligned with one logical resource family. `role-assignments.bicep` is centralized — the alternative (each module emits its own role assignments) makes cross-module RBAC harder to audit.

### Why a separate Functions storage account?

Azure Functions requires a backing storage account for its own runtime (host metadata, queue triggers, Functions key storage). Putting that on the same account as `agent-state`/`rates-pack` mixes platform internals with application data, complicating diagnostic settings, lifecycle policies, and RBAC scoping. The cost of a second account is the base overhead (~$0/mo at zero usage) — well worth the separation.

## Per-module contracts

### `main.bicep` (entry point, subscription scope)

**Why subscription-scope:** the resource group itself is provisioned by Bicep — we want one `az deployment sub create` to produce the entire footprint. Per ADR-006 the env-encoded RG name is part of the deployment; if Bicep is RG-scoped instead, the RG must pre-exist (chicken-and-egg).

**Targets:** `targetScope = 'subscription'`

**Parameters:**
```bicep
param envName string = 'prod'
param location string = 'southindia'
param azureOpenAIResourceGroupName string       // RG of the existing AOAI resource (cross-RG)
param azureOpenAIAccountName string              // existing AOAI account name
param pmServicePrincipalObjectId string          // from azure-prep.md Step 3
param logRetentionDays int = 1095                // for agent-state/runs/ + *_source_*.pdf lifecycle (3 years)
param tags object = { project: 'fia', environment: 'prod', managedBy: 'bicep' }
```

**Resources:**
- `Microsoft.Resources/resourceGroups@2024-03-01` — the RG itself
- All module invocations as nested deployments scoped to the new RG

**Outputs:** none from `main` (each module emits its own; `main` doesn't republish).

### `log-analytics.bicep`

Provisions the Log Analytics workspace required by Container Apps Environment.

**Parameters:** `envName`, `location`, `tags`, `retentionInDays` (default 30)
**Resource:** `Microsoft.OperationalInsights/workspaces@2023-09-01`
**Outputs:** `workspaceId`, `customerId` (consumed by container-apps-env)

### `managed-identity.bicep`

Generic user-assigned MI module, called twice from `main`.

**Parameters:** `name`, `location`, `tags`
**Resource:** `Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31`
**Outputs:** `principalId`, `clientId`, `resourceId`

### `acr.bicep`

**Parameters:** `envName`, `location`, `tags`
**Resource:** `Microsoft.ContainerRegistry/registries@2023-11-01-preview` — SKU `Basic`, admin user disabled (managed identity pulls only).
**Outputs:** `loginServer`, `acrId`

### `storage.bicep` (data account)

**Parameters:** `envName`, `location`, `tags`, `runsRetentionDays` (default 1095 — 3 years)

**Resources:**
- `Microsoft.Storage/storageAccounts@2023-05-01` — kind `StorageV2`, SKU `Standard_LRS`, hierarchical namespace **disabled** per ADR-010 Option 5 ruling, public network access **enabled** (public endpoints per scope.md), `allowSharedKeyAccess: false` (force AAD auth), `minimumTlsVersion: TLS1_2`.
- `Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01` × 2 — `agent-state` and `rates-pack`. Both private (no anonymous access).
- `Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01` — two rules: delete blobs under prefix `runs/` older than `runsRetentionDays`; delete blobs matching `*_source_*` (PDF / image cache) older than `runsRetentionDays`. (Open question A from ADR-010 resolved: 3 years for both. Cost impact at our volume is ~$25/year — well worth the audit headroom.)

**Outputs:** `accountName`, `accountResourceId`, `agentStateContainerName`, `ratesPackContainerName`

### `storage-functions.bicep`

Single storage account for the Function App runtime. No containers explicitly defined (Functions creates them on first start).

**Parameters:** `envName`, `location`, `tags`
**Resource:** `Microsoft.Storage/storageAccounts@2023-05-01` — same hardening as data account (TLS 1.2, no shared key access? — see open question 5 below).
**Outputs:** `accountName`, `accountResourceId`, `connectionStringSecretName` (the secret name in Key Vault, set to a placeholder by Bicep and rotated manually).

### `keyvault.bicep`

**Parameters:** `envName`, `location`, `tags`, `tenantId` (resolved from `subscription().tenantId` in main)

**Resources:**
- `Microsoft.KeyVault/vaults@2023-07-01` — SKU `standard`, RBAC mode (`enableRbacAuthorization: true`, not access policies), soft delete + purge protection enabled, public network access enabled (no VNet per scope.md).
- Initial secrets created as empty placeholders by Bicep (so the Job can reference them via secret refs without hardcoding values), populated manually post-deploy:
  - `azure-openai-api-key` — the AOAI key (alternative to managed identity; managed identity is preferred so this may stay unused — see open question 4)
  - `github-pat` — fine-grained GitHub Personal Access Token for `cloud/git-publish.js` to push rate data back to the repo at the end of a cloud run. Scope: `contents: read+write` on this repo only. Surfaced to the Container Apps Job as `GITHUB_TOKEN` env var via Bicep `secretRef`. 90-day rotation cadence (same cycle as the PM service principal secret — operationally adjacent). If left empty, `cloud/git-publish.js` skips with a warning rather than failing the run (blob push already succeeded).

**Outputs:** `vaultName`, `vaultUri`, `vaultResourceId`

### `container-apps-env.bicep`

**Parameters:** `envName`, `location`, `tags`, `logAnalyticsWorkspaceId`, `logAnalyticsCustomerId`

**Resource:** `Microsoft.App/managedEnvironments@2024-03-01` — log destination Log Analytics, no VNet integration (`vnetConfiguration` omitted per ADR-002 / scope.md), zone redundancy disabled (single-region, single-instance).

**Outputs:** `environmentId`, `defaultDomain`

### `container-apps-job.bicep`

**Parameters:**
- `envName`, `location`, `tags`
- `containerAppsEnvironmentId`
- `acrLoginServer`, `imageName` (default `rate-discovery-agent`), `imageTag` (default `latest` — see [container-image.md](./container-image.md))
- `userAssignedIdentityResourceId`, `userAssignedIdentityClientId`
- `storageAccountName` (data account), `agentStateContainerName`
- `keyVaultUri`
- `azureOpenAIEndpoint`, `azureOpenAIDeploymentName`

**Resource:** `Microsoft.App/jobs@2024-03-01` with:
- `triggerType: 'Manual'` (sprint 001 — sprint 002 may add `Schedule` triggers per ADR-002)
- `replicaTimeout: 7200` seconds (2 hours per replica; covers a long batch)
- `replicaRetryLimit: 0` (failures are observable; we don't want silent retries duplicating LLM cost)
- `parallelism: 1`, `replicaCompletionCount: 1` (one execution = one batch)
- `manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }`
- `registries: [{ server: <acrLoginServer>, identity: <userAssignedIdentityResourceId> }]` (ACR pull via MI; no admin creds)
- `template.containers[0]`:
  - `image: '<acrLoginServer>/<imageName>:<imageTag>'`
  - `resources: { cpu: 1.0, memory: '2Gi' }` (Playwright + Node — 2GiB minimum for Chromium reliability)
  - `env`: `BIRD_STORAGE=azure`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_CONTAINER_NAME=agent-state`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_CLIENT_ID` (the user-assigned MI clientId, lets `DefaultAzureCredential` pick the right identity), `KEY_VAULT_URI`, `GIT_BRANCH=azure-openai-agent` (configurable; target branch for `cloud/git-publish.js`), `GITHUB_TOKEN` via `secretRef: github-pat` (Key Vault secret reference). **Args** (the bank list) come at runtime from the Function trigger — see [function-trigger.md](./function-trigger.md).
- `identity: { type: 'UserAssigned', userAssignedIdentities: { '<id-bofia-rate-agent-prod-resource-id>': {} } }`

**Outputs:** `jobName`, `jobResourceId`

### `function-app.bicep`

**Parameters:**
- `envName`, `location`, `tags`
- `userAssignedIdentityResourceId`, `userAssignedIdentityClientId`
- `functionsStorageAccountName`, `functionsStorageAccountResourceId`
- `containerAppsJobResourceId` (passed as env var to the Function code so it knows what to start)
- `containerAppsJobName`, `resourceGroupName`, `subscriptionId`

**Resources:**
- `Microsoft.Web/serverfarms@2023-12-01` — Linux Consumption (`Y1`/`Dynamic`), `reserved: true`
- `Microsoft.Web/sites@2023-12-01` (kind `functionapp,linux`) — Node 20 runtime, user-assigned MI bound, app settings:
  - `AzureWebJobsStorage__accountName` (managed-identity storage binding — no connection string)
  - `FUNCTIONS_WORKER_RUNTIME=node`, `FUNCTIONS_EXTENSION_VERSION=~4`
  - `WEBSITE_NODE_DEFAULT_VERSION=~20`
  - `JOB_RESOURCE_ID`, `JOB_NAME`, `SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `AZURE_CLIENT_ID` (MI)

**Outputs:** `functionAppName`, `defaultHostname`, `principalId`

### `role-assignments.bicep`

**Why centralized:** RBAC composition spans modules (e.g., the Job MI needs roles on storage, Key Vault, ACR, AOAI — provisioned across 4+ different modules). Centralizing keeps the full RBAC surface in one auditable file.

**Parameters:** all the principal IDs and resource IDs from the modules above.

**Role assignments created:**

| Principal | Role | Scope | Notes |
|---|---|---|---|
| Job MI | `Storage Blob Data Contributor` | data storage account | R/W on both containers per ADR-010 |
| Job MI | `Key Vault Secrets User` | Key Vault | Read secrets (placeholder for sprint 001) |
| Job MI | `AcrPull` | ACR | Pull image |
| Job MI | `Cognitive Services OpenAI User` | existing AOAI account (cross-RG) | Read-only AOAI inference |
| Function MI | `Storage Blob Data Owner` | Functions storage account | Required for AzureWebJobsStorage MI mode |
| Function MI | _custom: see below_ | Container Apps Job | Permission to start the job |
| PM SP | `Storage Blob Data Reader` | `rates-pack` container only | ADR-003 |

**Function MI → Job: custom role.** Built-in `Container Apps Jobs Operator` works but grants more than needed (full `Microsoft.App/jobs/*`, including write/delete). For sprint 001 we accept this and use the built-in role; a custom role with only `Microsoft.App/jobs/start/action` is a deferred refinement (open question 1 below). The built-in role is `ContainerApp Jobs Operator` (role definition GUID resolved at deploy time via `subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '<guid>')`).

**Cross-RG role assignment for AOAI:** the Job MI's role assignment on the existing AOAI account targets a different resource group. Bicep handles this with a nested module deployment scoped to the AOAI RG, parameterized by the Job MI principal ID.

**Outputs:** none (role assignments are sinks).

## Parameter file

`iac/parameters.prod.bicepparam`:

```bicep
using 'main.bicep'

param envName = 'prod'
param location = 'southindia'
param azureOpenAIResourceGroupName = '<filled-in-during-azure-prep>'
param azureOpenAIAccountName = '<filled-in-during-azure-prep>'
param pmServicePrincipalObjectId = '<filled-in-during-azure-prep>'
param logRetentionDays = 1095
param tags = {
  project: 'fia'
  environment: 'prod'
  managedBy: 'bicep'
  costCenter: 'rate-discovery'
}
```

The three `<filled-in-during-azure-prep>` placeholders come from the manual prep session (azure-prep.md). The file is committed to the repo with placeholders stripped to `''` so the deployment fails fast if they're missing rather than silently using empty strings.

## Operator permissions required to apply

The human (or service principal) running `az deployment sub create` needs the following permissions across two surfaces. Use this as the authoritative checklist; `azure-prep.md` Step 0 verifies these before any other prep step.

### Azure RBAC (subscription / resource scope)

| Bicep operation | Role required | Scope | Underlying permission |
|---|---|---|---|
| Create the resource group | `Contributor` (or `Owner`) | Subscription | `Microsoft.Resources/resourceGroups/write` |
| Provision Storage Accounts (×2) | `Contributor` (inherited) | Subscription | `Microsoft.Storage/storageAccounts/*/write` |
| Provision ACR | `Contributor` | Subscription | `Microsoft.ContainerRegistry/registries/write` |
| Provision Key Vault | `Contributor` | Subscription | `Microsoft.KeyVault/vaults/write` |
| Provision Log Analytics workspace | `Contributor` | Subscription | `Microsoft.OperationalInsights/workspaces/write` |
| Provision Container Apps Environment + Job | `Contributor` | Subscription | `Microsoft.App/managedEnvironments/write`, `Microsoft.App/jobs/write` |
| Provision Function App + plan | `Contributor` | Subscription | `Microsoft.Web/serverfarms/write`, `Microsoft.Web/sites/write` |
| Provision User-Assigned MIs (×2) | `Contributor` | Subscription | `Microsoft.ManagedIdentity/userAssignedIdentities/write` |
| Create role assignments (Job MI, Function MI, PM SP) | **`User Access Administrator`** OR **`Owner`** | Subscription | `Microsoft.Authorization/roleAssignments/write` — `Contributor` alone does NOT include this |
| Cross-RG role assignment for AOAI access | **`User Access Administrator`** OR **`Owner`** | Existing AOAI resource (or its RG) | Same permission, different scope |
| Read existing AOAI account during deploy | `Reader` (minimum) | AOAI RG | `Microsoft.CognitiveServices/accounts/read` |

**Net practical recommendation:** the operator needs **`Owner` on the subscription** for the cleanest one-shot apply. The alternative (`Contributor` + `User Access Administrator` combined at subscription scope) is functionally equivalent but requires two role assignments instead of one — useful in environments where `Owner` is unavailable to the operator's account but is otherwise more bureaucratic.

If the existing AOAI resource lives in a different subscription than the deploy target (rare), the operator additionally needs `Reader` on the AOAI subscription and `User Access Administrator` on the AOAI RG.

### Entra ID (tenant scope) — for the manual prep steps only

These permissions are **not** used by Bicep itself. They are needed for the manual app-registration creation in `azure-prep.md` Steps 2–4, which precedes the first Bicep apply.

| Operation | Role | Scope | Underlying permission |
|---|---|---|---|
| Create app registration | `Application Developer` (Entra role) | Tenant | `microsoft.directory/applications/createAsOwner` |
| Create service principal for the app | `Application Developer` (auto-owner of the new SP) | Tenant | `microsoft.directory/servicePrincipals/createAsOwner` |
| Generate client secret on the app | App owner OR `Cloud Application Administrator` | Per-app (operator owns the app they just created) | `microsoft.directory/applications/credentials/update` |

`Application Developer` is a built-in Entra role; if the operator does not have it, a Tenant Admin or Privileged Role Administrator must assign it (or perform the prep steps themselves).

### Verification commands

Before starting the prep session, run these to confirm permissions:

```bash
# Azure RBAC check
OPERATOR_ID=$(az ad signed-in-user show --query id -o tsv)
az role assignment list --assignee $OPERATOR_ID --scope /subscriptions/<sub-id> --output table

# Look for: Owner, OR (Contributor AND User Access Administrator) at subscription scope.
# If the AOAI resource is in a different RG, also check that scope.

# Entra role check (shows directory roles assigned to operator)
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/me/memberOf?\$select=displayName,id" \
  --query "value[?'@odata.type'=='#microsoft.graph.directoryRole'].displayName" -o table

# Look for: Application Developer, Cloud Application Administrator, Application Administrator, or Global Administrator.
```

If any check fails, request the missing role from the appropriate admin **before** starting the prep session. Mid-session permission requests stall everything.

### What the operator does NOT need

- `Global Administrator` (Entra) — overkill; `Application Developer` is sufficient
- `Privileged Role Administrator` — only needed if assigning Entra roles to others
- `Storage Account Key Operator Service Role` — we don't use shared-key auth (`allowSharedKeyAccess: false`)
- Any direct role on the existing Azure OpenAI resource other than `Reader` — the Job MI gets `Cognitive Services OpenAI User` via Bicep, not the operator

### After deployment

Once Bicep has applied, the operator's elevated permissions are no longer required for ongoing operations. Day-to-day:
- Pushing new images: `AcrPush` on the ACR (Bicep can grant this to the operator's account if desired; otherwise scope-limited admin)
- Triggering jobs: function key for the HTTP trigger (no Azure RBAC on the operator)
- Inspecting logs / blob contents: `Reader` + `Storage Blob Data Reader` on the storage account

The elevated `Owner` / `User Access Administrator` is needed only for re-applying Bicep (typically rare — image/code changes don't require it).

## Apply procedure

### First apply (clean subscription)

```bash
# From azure-prep.md, the operator has already:
#   - run az login + az account set --subscription <sub-id>
#   - created the Entra app (gives pmServicePrincipalObjectId)
#   - identified the existing AOAI RG + account name
#   - filled those into parameters.prod.bicepparam

# What-if first
az deployment sub what-if \
  --location southindia \
  --template-file iac/main.bicep \
  --parameters iac/parameters.prod.bicepparam

# Apply
az deployment sub create \
  --name bofia-rate-agent-prod-$(date +%Y%m%d-%H%M%S) \
  --location southindia \
  --template-file iac/main.bicep \
  --parameters iac/parameters.prod.bicepparam
```

Expected runtime: ~8–10 minutes for full footprint. The bulk of the time is Container Apps Environment provisioning (~5 min — backed by Log Analytics + dataplane setup).

### Subsequent applies

The same command. `what-if` returns no changes when nothing has drifted. Idempotency is the property under test in success criterion 2 from `scope.md`.

### Container Apps Job image bootstrap problem

The Bicep deployment will fail on first apply if the ACR exists but no image has been pushed yet — Container Apps Job validates the image reference at deploy time. Resolution: the **first** apply must use a placeholder image (`mcr.microsoft.com/azuredocs/aci-helloworld:latest`); after that, push the real image to ACR (see [container-image.md](./container-image.md) push procedure), then re-apply with the real `imageTag` to swap.

This adds one ordering constraint to the runbook but avoids needing to split Bicep into "infra-only" and "image-bound" deployments.

## RBAC summary diagram

```
                       ┌──────────────────────────────────────┐
                       │ HTTP caller (operator/PM webhook)    │
                       └──────────────┬───────────────────────┘
                                      │ POST /api/start-discovery (function key)
                                      ▼
       ┌─────────────────────────────────────────────────────────┐
       │ Function App  ──identity──>  id-bofia-trigger-prod (MI) │
       │ func-bofia-trigger-prod                                  │
       └──────────────┬──────────────────────────────────────────┘
                      │ ARM: Microsoft.App/jobs/start/action
                      │ (built-in: ContainerApp Jobs Operator)
                      ▼
       ┌─────────────────────────────────────────────────────────┐
       │ Container Apps Job  ──identity──>  id-bofia-rate-agent  │
       │ caj-bofia-rate-discovery-prod                           │
       └─┬───────────┬────────────┬─────────────┬─────────────────┘
         │           │            │             │
   AcrPull    Blob Data        KV Secrets   Cog Svcs OpenAI User
         │   Contributor       User             │
         ▼           ▼            ▼             ▼
       ACR        Storage     Key Vault   Existing AOAI account
                  account                   (cross-RG)
                  ↑
                  │ Blob Data Reader (rates-pack only)
                  │
       ┌──────────┴──────────┐
       │ PM Service          │
       │ Principal           │
       │ app-bofia-pm-       │
       │ rates-reader-prod   │
       └─────────────────────┘
```

## Idempotency and re-apply guarantees

- All resources use deterministic names (no `uniqueString()` randomness in resource names beyond what's globally required for ACR / storage). The two storage accounts use a `01` suffix so a future re-create can use `02` if a previous one is in soft-delete.
- Role assignments use `guid(scope, principalId, roleDefinitionId)` for their names — deterministic, idempotent.
- Key Vault secrets are not overwritten on re-apply (Bicep uses `existing` reference for secrets created post-deploy). Initial provisioning creates them with placeholder values; manual rotation does not require re-running Bicep.
- Container Apps Job re-applied with a new `imageTag` updates the job in place — no destroy/recreate.

## Testing approach

Bicep doesn't have unit tests in the conventional sense. Validation:

1. **Syntactic** — `bicep build iac/main.bicep` must succeed with no errors and no warnings.
2. **What-if dry run** — every apply preceded by `az deployment sub what-if` reviewed by the operator. Catches resource churn (delete-and-recreate) before it happens.
3. **First-apply smoke** — after first successful apply, `az resource list --resource-group rg-bofia-rate-agent-prod-southindia` enumerates all expected resources by name. A small `iac/verify.sh` script can encode the expected list.
4. **No second-apply drift** — re-running `what-if` immediately after a successful apply must report "no changes". Any unexpected churn surfaces a non-idempotent module.

Bicep linting via `az bicep lint` is enabled with `bicepconfig.json` (strict mode) at the `iac/` root.

## Open implementation questions

These are decided during implementation (not blocking design):

1. **Custom role for Function → Job start.** The built-in `ContainerApp Jobs Operator` role grants more than `Microsoft.App/jobs/start/action`. Sprint 001 uses the built-in; sprint 003 (observability + hardening) defines a custom role. Acceptable risk — the Function MI is already isolated to a single function app.
2. **AOAI key in Key Vault as fallback?** Managed identity should be the only auth path to AOAI. The KV secret slot is provisioned but unused unless we hit a managed-identity issue (e.g., AOAI cross-RG MI-auth quirks). Decision: provision the placeholder secret; leave it empty; if MI works in smoke test, never populate.
3. **Lifecycle policy precision.** Two rules in `storage.bicep`'s management policy: one for `runs/` prefix, one for the `*_source_*` binary cache pattern. Both at the same TTL (3 years per `runsRetentionDays`) for sprint 001 — uniform retention is simpler than splitting. If observability dashboards (sprint 003) ever need different cadences, splitting is a parameter addition.
4. **Function App: Consumption (Y1) vs Flex Consumption (FC1).** Y1 is the mature option; FC1 (GA mid-2025) is the modern replacement with always-warm slots and better cold-start. For sprint 001, use Y1 — universally supported, lowest cold-start overhead is not a sprint 001 concern. Migration to FC1 is a parameter change in `function-app.bicep`.
5. **`allowSharedKeyAccess: false` on storage accounts.** Forces AAD auth everywhere, which is what we want — but Functions runtime historically required shared-key access for `AzureWebJobsStorage`. As of Functions runtime 4.x with the MI-binding pattern (`AzureWebJobsStorage__accountName`), shared-key access can be disabled. Verify in smoke; if Functions startup fails, enable shared-key on the Functions storage account only (not the data account).
6. **Tags on role assignments.** Bicep doesn't support tags on `Microsoft.Authorization/roleAssignments`. Audit reports rely on the role definition + scope + principal — tags would have been a nicety for cost attribution but aren't available.

## Acceptance criteria

The design is implemented when:

- `iac/main.bicep` + 10 module files commit and `bicep build` passes with zero warnings
- `parameters.prod.bicepparam` template is checked in with placeholders for the three azure-prep values
- `az deployment sub what-if` against an empty subscription reports the full expected resource set
- `az deployment sub create` completes in under 10 minutes on a clean subscription
- A second `what-if` immediately after returns "no changes"
- All resource names match the convention table above
- All RBAC assignments listed in the role assignments table exist after apply, verified via `az role assignment list --assignee <principalId>`
- `iac/verify.sh` (a thin `az resource list | jq` script) returns the full expected resource list

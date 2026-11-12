# Sprint 001 — Azure prep checklist

**Status:** Living document — populated during design phase, finalized when design closes
**Purpose:** Single batched session to provision elevated-access prerequisites before implementation begins. Avoids context-switching between IaC work and tenant-admin tasks.

This doc is intentionally a flat checklist. Run top-to-bottom in one sitting; capture outputs into `parameters.prod.bicepparam` as you go.

## Permissions to verify on operator account

| Scope | Role required | Why | How to verify |
|---|---|---|---|
| Subscription | `Contributor` (or `Owner`) | Create resource group, deploy Bicep | `az role assignment list --assignee $(az ad signed-in-user show --query id -o tsv) --scope /subscriptions/<sub-id>` |
| Resource group (after creation) | `Owner` OR (`Contributor` + `User Access Administrator`) | Bicep creates role assignments — needs `Microsoft.Authorization/roleAssignments/write` | Same command at RG scope |
| Tenant | `Application Administrator` (or `Cloud Application Administrator`) | Create Entra app registration + service principal | `az role assignment list --assignee $(az ad signed-in-user show --query id -o tsv) --scope /` (or check Entra portal → Roles and administrators) |
| Existing Azure OpenAI resource | `Cognitive Services Contributor` (or read access) | Look up resource ID; verify model deployments | Azure portal → AOAI resource → Access control (IAM) |
| New ACR (after Bicep creates it) | `AcrPush` | `az acr build` to push image | Created during Bicep deploy or assigned manually |

## Information to gather (write into `parameters.prod.bicepparam`)

| Item | Source | Goes into param |
|---|---|---|
| Tenant ID | `az account show --query tenantId -o tsv` | (used for PM handoff doc) |
| Subscription ID | `az account show --query id -o tsv` | (implicit in `az deployment` target) |
| Existing Azure OpenAI RG name | Azure portal → CognitiveServices → your AOAI resource → Overview | `azureOpenAIResourceGroupName` |
| Existing Azure OpenAI account name | Same screen | `azureOpenAIAccountName` |
| AOAI model deployment names + versions | AOAI resource → Deployments tab | (verify; agent's `.env` references these) |

## Quotas to verify in South India

Run `az vm list-usage --location southindia` (and equivalent for other resource families) or check Azure portal → Subscriptions → Usage + quotas.

| Resource | Minimum needed |
|---|---|
| Container Apps Jobs (cores) | Default ~100 cores; sprint 001 uses ~2 vCPU per job execution — fine |
| Storage Account count | Default 250; we need 1 |
| Key Vault count | Default 25; we need 1 |
| Function App (Linux Consumption) | Default ~100; we need 1 |
| Azure OpenAI tokens-per-minute on the agent's model | Verify against current agent's burn rate (gap-fill batch was ~$55 / 251 banks; check TPM hits ceiling) |

## CLI / tooling prerequisites

| Tool | Minimum version | Install command |
|---|---|---|
| Azure CLI | ≥ 2.50 | `az version` to check |
| Bicep CLI | latest | `az bicep install` (then `az bicep upgrade`) |
| `jq` (for shell-piping outputs) | any | `apt-get install jq` / `brew install jq` |
| Logged in to Azure | — | `az login` then `az account set --subscription <id>` |

## Manual steps to perform in the prep session

Run these in order. Each step's output feeds later steps or `parameters.prod.bicepparam`.

### Step 1: Create the resource group

```bash
az group create \
  --name rg-bofia-rate-agent-prod-southindia \
  --location southindia \
  --tags project=fia environment=prod managedBy=manual
```

### Step 2: Create the Entra app registration for PM access

```bash
APP_ID=$(az ad app create \
  --display-name app-bofia-rates-reader-prod \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
echo "Entra App ID: $APP_ID"
```

### Step 3: Create the service principal for that app

```bash
SP_OBJECT_ID=$(az ad sp create --id $APP_ID --query id -o tsv)
echo "Service Principal Object ID: $SP_OBJECT_ID"
```

### Step 4: Generate initial client secret (1-year for first deploy; 90-day rotations after)

```bash
CLIENT_SECRET=$(az ad app credential reset \
  --id $APP_ID \
  --years 1 \
  --display-name "initial-setup-2026-05-05" \
  --query password -o tsv)
echo "Client Secret (store securely, will not be shown again): $CLIENT_SECRET"
```

Store `$APP_ID`, `$SP_OBJECT_ID`, `$CLIENT_SECRET`, and the tenant ID immediately in 1Password (or equivalent) — the secret cannot be retrieved later, only regenerated.

### Step 5: Capture values for `parameters.prod.bicepparam`

| Param | Value source |
|---|---|
| `pmServicePrincipalObjectId` | `$SP_OBJECT_ID` from Step 3 |
| `azureOpenAIResourceGroupName` | Existing AOAI portal lookup |
| `azureOpenAIAccountName` | Same |
| (other resource names) | Per the naming table in `bicep-modules.md` design |

### Step 6: Set up cost alert

Azure portal → Cost Management → Cost Alerts → Add → target the resource group → threshold $100/month, notify operator email.

### Step 7 (post-Bicep): Generate GitHub PAT and store in Key Vault

The Container Apps Job uses `cloud/git-publish.js` to commit each cloud
run's rate data back to the repo. That requires a GitHub Personal Access
Token, which the Job picks up from Key Vault via a secret reference.

This step happens **after** the first Bicep apply (Bicep creates the
Key Vault and the empty `github-pat` secret slot; you populate it here).

1. Open https://github.com/settings/personal-access-tokens/new (fine-grained PAT).
2. Configure:
   - **Token name:** `bofia-cloud-git-publish-prod`
   - **Expiration:** 90 days (set a calendar reminder for rotation)
   - **Repository access:** Only select repositories → pick this repo
   - **Repository permissions:** `Contents: Read and write` — nothing else
3. Generate the token; copy the `github_pat_…` value (shown once).
4. Store in Key Vault:
   ```bash
   az keyvault secret set \
     --vault-name kv-bofia-rate-agent-prod \
     --name github-pat \
     --value "<github_pat_…>"
   ```
5. Verify by reading back (don't print the value):
   ```bash
   az keyvault secret show --vault-name kv-bofia-rate-agent-prod \
     --name github-pat --query "{name:name, version:properties.versionId}" -o json
   ```

Rotation: 90 days. Same cadence as the PM service principal secret. The
calendar reminder triggers a manual flow: generate new PAT → `az keyvault
secret set` (which creates a new version) → next Container Apps Job
execution picks up the new version automatically (Key Vault references
in Container Apps Jobs use `latest` by default).

If you don't set this secret, `cloud/git-publish.js` skips with a warning
rather than failing the run (blob sync already succeeded; git is
supplementary). Set it before the first cloud run if you want git
publishing to work.

### Step 8: Hand off to PM

Create handoff document (template lives in `entra-app-pm-access.md` design — to be written) containing:
- Tenant ID
- App ID (`$APP_ID`)
- Client Secret (`$CLIENT_SECRET` — initial; PM rotates after 90 days alongside us)
- Storage account name (`stbofiarateagentprod01`) — for blob URL construction
- Container name (`rates-pack`)
- Sample SDK code for PM's stack (Node / Python / .NET — to be confirmed in design)

Deliver via 1Password share or equivalent secure channel. Confirm PM successfully fetches the pack with these credentials before considering handoff complete.

## RBAC assignments (created automatically by Bicep — listed here for visibility)

These are NOT manual — Bicep creates them. Listed so you know what permissions get granted during deployment:

| Assignee | Role | Scope |
|---|---|---|
| Container Apps Job MI | `Storage Blob Data Contributor` | Storage account (or scoped to `agent-state` and `rates-pack` individually) |
| Container Apps Job MI | `Key Vault Secrets User` | Key Vault |
| Container Apps Job MI | `AcrPull` | ACR |
| Container Apps Job MI | `Cognitive Services OpenAI User` | Existing AOAI resource (cross-RG) |
| Function App MI | Custom role: `Microsoft.App/jobs/start/action` | Container Apps Job |
| PM Service Principal | `Storage Blob Data Reader` | `rates-pack` container only |

Note: the Function App MI's permission to start a Container Apps Job may require a custom role definition (the built-in `Container Apps Jobs Contributor` is broader than needed). Confirm during Bicep design / implementation whether the narrow permission can be bound directly or needs a custom role.

## Open prep items (will be filled as design progresses)

These will be populated as remaining design docs (`function-trigger.md`, `container-image.md`, `entra-app-pm-access.md`) close:

- [ ] Function trigger function-key — generation method (auto on deploy vs manual)
- [ ] Container base image variant choice (jammy vs noble; Node version)
- [ ] PM SDK code samples per stack (depends on PM stack confirmation)
- [ ] Secret rotation runbook (initial 1-year secret, then 90-day cycles)
- [ ] Container image registry credentials (managed identity-based pull, but verify)

## Acceptance — prep is done when

- All operator permissions verified at the right scopes
- All info captured into `parameters.prod.bicepparam` (paste-ready)
- Resource group exists in South India
- Entra app + SP created; secret stored securely
- Cost alert configured at $100/month
- Quotas confirmed sufficient for sprint 001 needs
- All required CLI tools installed and `az login` is active

After this checklist passes, sprint 001 implementation can run uninterrupted — no further admin prompts needed.

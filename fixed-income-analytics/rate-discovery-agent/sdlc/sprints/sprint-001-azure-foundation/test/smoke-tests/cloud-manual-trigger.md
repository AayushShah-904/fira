# Smoke test — Cloud manual trigger (sprint 001 success criterion 3)

**Status:** Runbook (steps to execute). Outcome will be appended below as a "Run log" section after the smoke runs successfully.

This is sprint 001's end-to-end test. It exercises the full path from
Function trigger → Container Apps Job → blob updates → git commit. Run
this once after Phase 4 (Bicep) and Phase 6 (Function code) are in
place, and any time you want to regression-check the cloud path.

## Prerequisites

All of these are one-time setup; subsequent smokes start at "Run the
smoke" below.

- [ ] **Phase 0 complete** (azure-prep.md): RG exists, Entra app
      `app-bofia-rates-reader-prod` created, parameters.prod.bicepparam
      populated.
- [ ] **First Bicep apply** complete with `placeholderImage` override
      (see "First apply" below).
- [ ] **First image build** via `iac/deploy-image.sh` (which also
      re-applies Bicep with the real imageTag).
- [ ] **Function code published** via `func azure functionapp publish`.
- [ ] **GitHub PAT set** in Key Vault as `github-pat` (azure-prep.md
      Step 7).
- [ ] **operator's az is authenticated**: `az account show` succeeds.
- [ ] **Azure Functions Core Tools** installed locally OR using Cloud
      Shell (which has it pre-installed): `func --version`.

## First apply (run-once, the bootstrap path)

Container Apps Jobs validate the image reference at deploy time. ACR
is empty until you push, so the first apply needs a public placeholder
image. After `az acr build` produces a real image, re-apply with the
real tag.

```bash
# Step 1: First apply with placeholder image. Deploys all infra except
# resolves the Job to a public hello-world image.
az deployment sub create \
  --location southindia \
  --template-file iac/main.bicep \
  --parameters iac/parameters.prod.bicepparam \
  --parameters placeholderImage=mcr.microsoft.com/azuredocs/aci-helloworld:latest
```

Expected: ~8-10 min runtime. After it succeeds, every resource exists
but the Job points at the placeholder image (not what we want — only
useful to make Bicep deploy succeed).

```bash
# Step 2: Build the real image and update the Job to point at it.
./iac/deploy-image.sh
```

This script (1) computes a short git SHA, (2) runs `az acr build` to
upload the build context and produce both `:latest` and `:<sha>`
tagged images in ACR, (3) re-applies Bicep with `imageTag=<sha>` and
empty `placeholderImage`, which updates the Job spec in place.

Expected: ~5 min total.

## Function code deploy (run-once after Bicep, then on every code change)

```bash
cd functions
npm install                                  # one-time per environment
func azure functionapp publish func-bofia-trigger-prod --javascript
```

Or from Cloud Shell:

```bash
git pull
cd functions
npm install
func azure functionapp publish func-bofia-trigger-prod --javascript
```

Expected: ~3-5 min upload + restart. The two functions registered
should be `start-discovery` and `job-status`.

## GitHub PAT (run-once; rotate every 90 days)

See azure-prep.md Step 7. The smoke will succeed without this — git
publish will skip with a warning — but for full validation, set it.

## Run the smoke

```bash
# Get the function key (cached locally; re-run only if the key rotates)
FUNCTION_KEY=$(az functionapp keys list \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --name func-bofia-trigger-prod \
  --query functionKeys.default -o tsv)
echo "Function key fetched (length: ${#FUNCTION_KEY})"

# Trigger one bank
RESPONSE=$(curl -sS -X POST \
  -H "x-functions-key: $FUNCTION_KEY" \
  -H "Content-Type: application/json" \
  "https://func-bofia-trigger-prod.azurewebsites.net/api/start-discovery" \
  -d '{"banks": ["hdfc-bank-limited"]}')
echo "$RESPONSE" | jq .

EXECUTION_ID=$(echo "$RESPONSE" | jq -r .executionId)
echo "Execution: $EXECUTION_ID"
```

Expected response (status 202):

```json
{
  "executionId": "caj-bofia-rate-discovery-prod-XXXXX",
  "jobName": "caj-bofia-rate-discovery-prod",
  "startedAt": "2026-05-XX...",
  "bankCount": 1,
  "dryRun": false,
  "statusUrl": "https://func-bofia-trigger-prod.azurewebsites.net/api/job-status/caj-bofia-rate-discovery-prod-XXXXX"
}
```

## Wait + observe

```bash
# Watch the Job execution status. Expected: 'Running' → 'Succeeded'
# in about 2-5 min for one bank.
az containerapp job execution show \
  --name "$EXECUTION_ID" \
  --job-name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --query "{name:name, status:properties.status, start:properties.startTime, end:properties.endTime}" -o json

# Stream the execution logs (helpful while it's running)
az containerapp job logs show \
  --name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --container rate-discovery \
  --execution-name "$EXECUTION_ID" \
  --follow
```

## Verify (the four things that have to be true)

```bash
# 1. Job execution succeeded
az containerapp job execution show \
  --name "$EXECUTION_ID" \
  --job-name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --query "properties.status" -o tsv
# Expected: Succeeded

# 2. agent-state has the per-bank artifacts
az storage blob list \
  --account-name stbofiarateagentprod01 \
  --container-name agent-state \
  --prefix output/latest/hdfc-bank-limited \
  --auth-mode login --query "[].name" -o tsv
# Expected: at least output/latest/hdfc-bank-limited_config.json
#                  and output/latest/hdfc-bank-limited_rates.json

# 3. rates-pack has the published pack
az storage blob list \
  --account-name stbofiarateagentprod01 \
  --container-name rates-pack \
  --auth-mode login --query "[].{name:name, type:properties.contentSettings.contentType, cache:properties.contentSettings.cacheControl}" -o table
# Expected: rates-pack.json (application/json), rates-pack.schema.json,
#           README.md (text/markdown). All with Cache-Control: no-cache.

# 4. git received the cloud commit (if GITHUB_TOKEN was configured)
git fetch origin azure-openai-agent
git log origin/azure-openai-agent --oneline -1 --grep="Cloud refresh"
# Expected: a commit titled 'Cloud refresh: hdfc-bank-limited [<exec-id>]'
#           on origin/azure-openai-agent
```

## Acceptance — smoke passes when

- [ ] Function returns 202 with a non-null executionId
- [ ] Job execution reports `Succeeded` within ~5 min
- [ ] `agent-state/output/latest/hdfc-bank-limited_*.json` blobs exist
- [ ] `rates-pack/rates-pack.json` blob exists with
      `Content-Type: application/json` and `Cache-Control: no-cache`
- [ ] (optional, if PAT configured) New `Cloud refresh: ...` commit on
      origin/azure-openai-agent

## Run log

_(Append a section here per smoke run — date, who ran it, executionId,
notes on anything that wasn't smooth. Acts as the sprint's manual-test
record per the test-strategy.md layered approach.)_

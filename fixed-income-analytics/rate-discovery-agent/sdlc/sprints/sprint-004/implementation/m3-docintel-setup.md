# M3 — Azure Document Intelligence (Form Recognizer) provisioning

> Canonical record of the az CLI based, key-auth setup performed for M3 OCR-fallback.
> Design ref: [`../design/ocr-fallback.md`](../design/ocr-fallback.md)
>
> **Auth pattern**: key-based (simpler for dev). Production should migrate to
> managed identity (`Cognitive Services User` role) before scaled cohort runs.

## Pre-flight

- Subscription: `BO Azure subscription` (id `06c83a79-f46e-4011-b91f-68c8ce6cc6a5`)
- Tenant user: `samir@bharatomni.com`
- Target RG: `rg-bofia-rate-agent-prod-southindia` (already exists, located in `southindia`)
- DI service availability: **`southindia` does NOT support `kind=FormRecognizer`** (verified
  via `az cognitiveservices account create`). Fell back to **`centralindia`** — the next-
  closest region with DI Layout. The RG itself stays in southindia; the cross-region
  resource adds only network latency on calls (~80ms inter-region). Acceptable.
- Naming convention: **the region MUST be embedded in the resource name when the
  resource sits in a region different from its RG.** Initial attempt used
  `bofia-docintel-prod` and was deleted + recreated as
  `bofia-docintel-prod-centralindia` to make the cross-region placement explicit.

## Provisioning steps (PowerShell)

```powershell
# Variables — note: name embeds the region because RG is in a different region
$RG    = 'rg-bofia-rate-agent-prod-southindia'
$LOC   = 'centralindia'                       # not southindia — DI not available there
$NAME  = "bofia-docintel-prod-$LOC"           # bofia-docintel-prod-centralindia
$SKU   = 'S0'

# 1. Create the Cognitive Services account (kind=FormRecognizer covers DI)
az cognitiveservices account create `
  --name $NAME `
  --resource-group $RG `
  --kind FormRecognizer `
  --sku $SKU `
  --location $LOC `
  --custom-domain $NAME `
  --tags project=fia environment=prod managedBy=cli costCenter=rate-discovery `
  --yes

# 2. Fetch endpoint + key1 (key1 lands in .env, never committed)
$ENDPOINT = az cognitiveservices account show --name $NAME --resource-group $RG --query properties.endpoint -o tsv
$KEY      = az cognitiveservices account keys list --name $NAME --resource-group $RG --query key1 -o tsv

Write-Host "Endpoint: $ENDPOINT"
Write-Host "Key length: $($KEY.Length) chars"  # do not print the key itself
```

## Local-dev wiring

Append to local `.env` (gitignored):

```dotenv
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://bofia-docintel-prod.cognitiveservices.azure.com/
AZURE_DOCUMENT_INTELLIGENCE_KEY=<key1>
```

Install the SDK in the rate-discovery-agent project:

```bash
npm install @azure/ai-form-recognizer
```

## Smoke test

Saved as `scripts/analysis/docintel-smoke.js`. Reads an image/PDF path,
calls the `prebuilt-layout` model, prints page + table summary.

```bash
node scripts/analysis/docintel-smoke.js path/to/sample.jpg
```

Expected output: pages count + table count + per-table (rows × cols).

## Cost guardrail

Budget alert at $10/month with 80% threshold:

```powershell
# Requires Azure CLI consumption extension (preview) — install once:
az extension add --name costmanagement --upgrade

# Note: az consumption budget create is the supported command but operates on
# the subscription scope. Adapt if you want the budget scoped to the RG:
az consumption budget create `
  --budget-name docintel-monthly `
  --amount 10 `
  --time-grain Monthly `
  --start-date "$(Get-Date -Format 'yyyy-MM-01')" `
  --end-date  "$(Get-Date -Format 'yyyy-MM-01' -Year 2030)" `
  --category Cost `
  --notifications '[{"enabled":true,"operator":"GreaterThan","threshold":80,"contactEmails":["samirajoshi@gmail.com"],"notificationLanguage":"en-us"}]'
```

If the budget command shape varies on your CLI version, set the alert via Azure Portal → Cost Management → Budgets — same outcome.

## Verification

After provisioning, run:

```powershell
az cognitiveservices account show --name $NAME --resource-group $RG `
  --query "{name:name, sku:sku.name, kind:kind, endpoint:properties.endpoint, state:properties.provisioningState}" -o json
```

Expected: `state: "Succeeded"`, `kind: "FormRecognizer"`, `sku: "S0"`,
`endpoint: "https://bofia-docintel-prod.cognitiveservices.azure.com/"`.

## Cleanup (if backing out)

```powershell
az cognitiveservices account delete --name $NAME --resource-group $RG --yes
# Soft-deletes for 48h. To free the name immediately:
az cognitiveservices account purge --name $NAME --resource-group $RG --location $LOC
```

## Migration to managed identity (later)

When ready to remove the key dependency:

```powershell
$JOB_MI_PRINCIPAL = '<the user-assigned MI principalId already used for AOAI>'
$ACCOUNT_ID = az cognitiveservices account show --name $NAME -g $RG --query id -o tsv

az role assignment create `
  --assignee-object-id $JOB_MI_PRINCIPAL `
  --assignee-principal-type ServicePrincipal `
  --role "Cognitive Services User" `
  --scope $ACCOUNT_ID
```

Then strip `AZURE_DOCUMENT_INTELLIGENCE_KEY` from app settings, switch
`extract_via_ocr.js` from `AzureKeyCredential` to `DefaultAzureCredential`
from `@azure/identity`.

## Record of this provisioning run

| Field | Value |
|---|---|
| Date | 2026-05-22 |
| Provisioned by | claude-code (operator-authorised) |
| Resource name | `bofia-docintel-prod-centralindia` |
| Endpoint | `https://bofia-docintel-prod-centralindia.cognitiveservices.azure.com/` |
| SKU | S0 (Standard, pay-as-you-go) |
| Region | centralindia (RG is in southindia) |
| Auth pattern | key-based (key1, stored in local `.env`) |
| Provisioning state | Succeeded |

### Smoke-test results (2026-05-22)

Smoke script: `scripts/analysis/docintel-smoke.js` (uses `@azure/ai-form-recognizer`).

| Input | Pages | Tables | Elapsed | Outcome |
|---|---:|---:|---:|---|
| `https://tmb.bank.in/assets/images/8a9d8963-0334-4f44-a375-6f3288b5ce73.jpg` | 1 | 0 | 7.5s | API works; this particular JPEG turned out to be a marketing banner ("Get higher rate of interest..."), not the rate card. Need to locate the actual rate card image URL during M3 implementation. |
| Microsoft sample layout PDF (`Azure-Samples/.../sample-layout.pdf`) | 1 | 2 | 6.1s | Layout API correctly extracted both tables (5×3 and 2×2) with per-cell `rowIndex`/`columnIndex` — confirms table-extraction path works end-to-end. |

The resource is live and table extraction works. Next action (task #25) is to
implement `lib/actions/extract_via_ocr.js`, wire it into the orchestrator's
tier-router, locate the genuine TMB rate-card image URL, and re-run the
image-bearing bank cohort.

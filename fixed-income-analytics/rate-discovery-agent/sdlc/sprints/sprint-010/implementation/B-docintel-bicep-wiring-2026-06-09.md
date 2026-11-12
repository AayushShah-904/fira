# Sprint 010 Phase B — Azure Document Intelligence wired into CAJ Bicep

**Date:** 2026-06-09
**Outcome:** ✅ Bicep changes ready. Operator action required: push `docintel-key` into Key Vault before the next `iac/deploy-image.sh` run (Phase E/F/G).

## What changed

Three files in the Bicep stack:

### `iac/main.bicep`

- New parameter `azureDocumentIntelligenceEndpoint` (default = the prod endpoint `https://bofia-docintel-prod-centralindia.cognitiveservices.azure.com/`)
- Passed through to the container-apps-job module

### `iac/modules/container-apps-job.bicep`

- New required param `azureDocumentIntelligenceEndpoint`
- New entry in `secrets[]`: `docintel-key` (Key Vault secret-ref via job MI)
- New env vars on the container:
  - `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` (plain value)
  - `AZURE_DOCUMENT_INTELLIGENCE_KEY` (secretRef → `docintel-key`)

### `iac/modules/keyvault.bicep`

- New placeholder secret `docintel-key`, conditional on the same `createPlaceholderSecrets` flag used for `github-pat`. On the prod KV (already past first-apply), this is a no-op — the operator just pushes the real value once.

## Operator action — push the key

Before the next deploy (`bash iac/deploy-image.sh`), push the production key into Key Vault. The value is currently in `.env` as `AZURE_DOCUMENT_INTELLIGENCE_KEY=...`.

```powershell
# PowerShell (Windows)
$key = (Get-Content .env | Select-String "^AZURE_DOCUMENT_INTELLIGENCE_KEY=").ToString().Split('=', 2)[1]
$env:AZ_BIN = "C:\Users\Samir Joshi\AppData\Roaming\Python\Python311\Scripts\az.bat"
& $env:AZ_BIN keyvault secret set `
  --vault-name kv-bofia-rate-agent-prod `
  --name docintel-key `
  --value $key
```

```bash
# Bash equivalent
KEY=$(grep '^AZURE_DOCUMENT_INTELLIGENCE_KEY=' .env | cut -d= -f2-)
az keyvault secret set --vault-name kv-bofia-rate-agent-prod --name docintel-key --value "$KEY"
```

Pre-requisite: operator (or someone with KV Secrets Officer on `kv-bofia-rate-agent-prod`) has access. The job MI (`id-bofia-rate-agent-prod`) already has Key Vault Secrets User (granted by `iac/modules/role-assignments.bicep`), so once the secret exists the next deploy resolves it.

## What this unlocks

The orchestrator's `extract_via_ocr` action (`lib/actions/extract_via_ocr.js`, Sprint 004 M3) and the DocIntel fallback in `lib/fetch/fetch_pdf.js` (Sprint 006) both fail-soft today in cloud with `DOCINTEL_NOT_CONFIGURED` because the env vars don't exist on the container. After Phase B + the secret push:

- Banks with `extraction.<key>.type === 'image_ocr'` hints (currently 6 banks in the registry — Ajmer CCB, Axis IBU, BB&K, Banswara CCB, Barmer CCB, …) will route to OCR via the orchestrator template-dispatch.
- Banks whose `fetch_pdf` hits a non-text PDF (scanned image, OCR-text-layer artifact, etc.) will fall back to DocIntel Layout instead of returning empty text.

Sprint 009's audit listed 53 DCCBs + 32 NSUCBs in the cloud-zero set; many of those publish image-only PDFs. The exact uplift depends on which of them have `image_ocr` hints already vs which need operator authoring — but the **infrastructure side** is now in place.

## Files

- `iac/main.bicep` — new param + module pass-through
- `iac/modules/container-apps-job.bicep` — new param, new secrets[] entry, new env vars
- `iac/modules/keyvault.bicep` — new placeholder secret
- `sdlc/sprints/sprint-010/implementation/B-docintel-bicep-wiring-2026-06-09.md` — this doc

## Verification

After the secret push and next deploy:

```bash
# In the running container (or via az containerapp job execution logs):
echo $AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
# expected: https://bofia-docintel-prod-centralindia.cognitiveservices.azure.com/

# Smoke a bank with an image_ocr hint, e.g., banswara-central-co-operative-bank-ltd,
# and confirm the orchestrator's extract_via_ocr action fires (look for cost_pages > 0
# in the summary JSON's ocr_cost_usd / ocr_pages fields).
```

The Phase E + F cloud smokes will exercise this end-to-end.

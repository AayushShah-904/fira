# Operator runbook — cloud cohort runs (2026-05-18)

This runbook walks an operator from a fresh laptop through running a cohort of banks in the production Azure Container App Job. Mirrors the Sprint 4 Track B design — see `../design/track-b-deployment-and-blob-upload.md` for the implementation reasoning.

## Prerequisites

- Azure CLI 2.50+ (`az --version`)
- Logged in: `az login` (uses your operator identity, NOT the Job's managed identity)
- Correct subscription set: `az account set --subscription <id>` if you have more than one
- Read access to the prod resource group (`rg-bofia-rate-agent-prod-southindia`) and the storage account `stbofiarateagentprod01`
- This repo cloned and `npm install` run at least once
- `bicep` CLI installed if you'll redeploy the image (`az bicep install`)

## First-time setup — validate end-to-end before any real cohort

1. **Run the smoke script** — single-bank cloud run from kickoff to terminal state, all the way through blob:

   ```bash
   scripts/azops/smoke.sh                       # uses smoke-1 cohort (hdfc-bank-limited), env=dev
   ENV=prod scripts/azops/smoke.sh              # smoke prod instead of dev
   COHORT_BANK=hdfc-bank-limited scripts/azops/smoke.sh   # one-off bank, dev
   ```

   What success looks like:

   ```
   ✓ cohort "smoke-1": 1 banks
   ✓ azure cli authenticated as ...
   ✓ job caj-bofia-rate-discovery-dev exists
   ✓ image: crbofiarateagentdev.azurecr.io/rate-discovery-agent:<sha>

   Kicked off execution: <exec-name>

   Watching execution <exec-name> in caj-bofia-rate-discovery-dev (poll every 30s, Ctrl-C to stop watcher only)
   Portal: https://portal.azure.com/...

   [00:00:30] state: Running
   [00:01:00] bank 1/1: hdfc-bank-limited committed
   [00:01:30] state: Succeeded

   Execution <exec-name> reached terminal state: Succeeded
   Banks observed in blob: 1 / 1
   ```

   If you see "✗ pre-flight failed", fix that problem (usually `az login` or "Job not deployed yet — run `iac/deploy-image.sh`") and re-run the smoke.

2. **Confirm the per-bank blob upload landed** (Sprint 4 B2):

   ```bash
   az storage blob list \
     --account-name stbofiarateagentdev01 \
     --container-name agent-state \
     --prefix output/latest/hdfc-bank-limited \
     --auth-mode login \
     --query "[].name" -o tsv
   ```

   Expect to see at minimum: `_config.json`, `_*_rates.json`, `.summary.json`, and the new `-bank-domains-fragment.json`. If the fragment is missing, the bank isn't yet in `bank-domains.json` (first-discovery case — that's OK, just unusual).

## Normal trigger — running a real cohort

```bash
# Default: attach + live progress. Stay at the terminal.
node scripts/azops/start-cohort.js --cohort top-200 --env prod

# Fire-and-forget. Exits after kickoff with the exec name.
node scripts/azops/start-cohort.js --cohort top-200 --env prod --detach
```

The script prompts you to type `yes` for prod runs. Use `--yes` to skip the prompt in scripted contexts.

Live output looks like:

```
[00:00:30] state: Running
[00:01:42] bank 1/200: hdfc-bank-limited committed
[00:02:48] bank 2/200: state-bank-of-india committed
[00:03:55] bank 3/200: bank-of-india-ibu committed
...
```

If you Ctrl-C the watcher, the Container App Job **keeps running** — you only killed the local poll loop. Re-attach with:

```bash
node scripts/azops/status.js <exec-name> --env prod
```

## Mid-run inspection

While a cohort is in flight you can independently check progress:

```bash
# Total banks committed so far
az storage blob list \
  --account-name stbofiarateagentprod01 \
  --container-name agent-state \
  --prefix output/latest/ \
  --auth-mode login \
  --query "[?ends_with(name, '_config.json')] | length(@)"

# Execution state
az containerapp job execution show \
  --name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --job-execution-name <exec-name> \
  --query "properties.status"

# Stream container logs in near-real-time
az containerapp job logs show \
  --name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --execution <exec-name> \
  --follow
```

## Image deploy (when code changes need to go to cloud)

```bash
iac/deploy-image.sh
```

Sprint 4 Track B / B3 added: automatic retry on transient ACR failures (up to 3 attempts, backoff 30s/60s/90s) plus a tag-exists verification step before Bicep re-apply. Most "ACR upload flaky" scenarios are now self-healing. If the script does exhaust its retries, the message names the env var to bump:

```bash
ACR_BUILD_MAX_ATTEMPTS=5 iac/deploy-image.sh
```

After the deploy completes, the script verifies the Function host loaded both functions (waits up to 5 min on Y1 cold start). If verification fails, the script prints the diagnostic command.

## Troubleshooting

### "✗ pre-flight failed: azure cli is not authenticated"

```bash
az login
az account set --subscription <id>
```

### "✗ pre-flight failed: container app job ... not found"

The Job hasn't been deployed in that env yet. Run `iac/deploy-image.sh` (default `ENV_NAME=prod`; set `ENV_NAME=dev` for the dev env).

### "✗ pre-flight failed: job is still on placeholder image"

First deploy after Bicep resource creation. Run `iac/deploy-image.sh` to build + push the real image and re-apply Bicep with the right `imageTag` parameter.

### Cohort run stuck in "Running" state much longer than expected

Container App Job's `replicaTimeout` is 7200s (2 hours). For a 200-bank run averaging ~90s/bank that's the planned upper bound. If you cross 2.5 hours, check container logs (`az containerapp job logs show ... --follow`) for stalls.

### Partial run, then process killed mid-cohort

Per Sprint 4 B2, the per-bank blob upload pushes each bank's artifacts after `safeWriteArtifact()` succeeds. So banks 1..(N-1) are durable in blob even though the Job execution is marked Failed. To resume from the last completed bank:

1. Identify which banks finished:

   ```bash
   az storage blob list \
     --account-name stbofiarateagentprod01 \
     --container-name agent-state \
     --prefix output/latest/ \
     --auth-mode login \
     --query "[?ends_with(name, '_config.json')].name" -o tsv
   ```

2. Either restart the whole cohort (additive-upsert means existing files survive intact) or manually edit `data/cohorts/<name>.json` to remove the already-completed banks before re-triggering.

### "✗ pre-flight failed: cohort file not found"

```bash
ls data/cohorts/
```

Available cohorts ship with the repo:
- `smoke-1.json` — one-bank smoke
- `top-200-banks.json` — main cohort (Sprint 4 Track C; lands separately)

Add new cohorts by dropping a JSON file with the documented array shape into `data/cohorts/`. Loader rejects path-traversal in names.

## Dashboards & telemetry

**Application Insights / Log Analytics URL:** _(TODO Sprint 5+ — telemetry wiring is captured as a Sprint 5 candidate. Today the operator uses `az containerapp job logs show --follow` and the blob storage query above. The dashboard URL section will be filled in once Sprint 5 ships the App Insights workspace.)_

**Cost telemetry:** Each bank's `summary.json` in blob includes `total_cost_usd`, `input_tokens`, `output_tokens`. Aggregate across a run with:

```bash
az storage blob list \
  --account-name stbofiarateagentprod01 \
  --container-name agent-state \
  --prefix output/latest/ \
  --auth-mode login \
  --query "[?ends_with(name, '.summary.json')].name" -o tsv | while read blob; do
    az storage blob download --account-name stbofiarateagentprod01 \
      --container-name agent-state --name "$blob" --file /tmp/s.json \
      --auth-mode login --no-progress
    node -e "const d=require('/tmp/s.json'); console.log(d.bank_code||'?', d.total_cost_usd||0)"
  done
```

(Hacky one-liner; a proper cost-rollup script is a Sprint 5 candidate.)

## Killing a runaway execution

```bash
az containerapp job execution stop \
  --name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --job-execution-name <exec-name>
```

The Job's `replicaRetryLimit` is 0 so it won't auto-restart. Per-bank blob uploads from before the stop are preserved.

## Known limitations (Sprint 4 → Sprint 5 carry-over)

- **No `rollback-image.sh`** — if a bad image deploys, manually edit the Bicep parameter for `imageTag` to the previous SHA and re-apply (`iac/deploy-image.sh` skips ACR build by setting `ACR_BUILD_MAX_ATTEMPTS=1` and the verify will short-circuit since the tag already exists; or use `az containerapp job update --image <previous-image>`). A proper rollback script is a Sprint 5 candidate.
- **No App Insights dashboard URL yet** — operator-side telemetry is `az containerapp job logs show --follow` + the blob queries above.
- **No CI-driven image build** — `iac/deploy-image.sh` is still operator-run from a developer machine. CI integration is a Sprint 5 candidate.
- **Bulk cost rollup** — manual one-liner above; a proper `scripts/azops/cost-rollup.js` is a Sprint 5 candidate.

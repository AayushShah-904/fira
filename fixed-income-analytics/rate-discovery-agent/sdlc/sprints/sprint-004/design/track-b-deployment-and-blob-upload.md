# Track B design — operator CLI + per-bank blob upload + ACR upload robustness

## Context

Sprint 4's deployment track has three sub-deliverables, all clarified with the operator on 2026-05-18. The single thread connecting them: the operator should be able to launch a 200-bank cloud run with one command, watch live progress, and trust that a mid-run crash leaves every completed bank durably in blob without manual intervention. Today none of those properties hold.

This doc designs all three pieces in one place because they share the same `cloud/sync.js` surface, the same `iac/` deployment surface, and the same operator-runbook narrative. Splitting into three docs would multiply cross-references without separating concerns.

## Sub-deliverable B1 — Operator CLI (`scripts/azops/start-cohort.js`)

### Behavior

```
node scripts/azops/start-cohort.js --cohort top-200 --env prod [--detach] [--dry-run] [--yes]
```

| Flag | Default | Effect |
|---|---|---|
| `--cohort <name>` | required | Loads `data/cohorts/<name>.json`; fails fast if missing |
| `--env <dev|prod>` | required | Selects the Container App Job target; `prod` adds confirm prompt unless `--yes` |
| `--detach` | false | After kickoff, print exec ID + portal URL + ETA and exit. No polling. |
| `--dry-run` | false | Print the `az containerapp job start` invocation that would be issued and exit 0 |
| `--yes` | false | Skip the prod confirm prompt |

Flow:

1. **Pre-flight** — validate cohort file shape (array of `{bank_code, category, state}` per `scripts/utils/load-cohort.js`); confirm Azure CLI is available (`az account show`); confirm the target Container App Job exists (`az containerapp job show --name caj-bofia-rate-discovery-${env}`); confirm the image tag in the Job is NOT a placeholder (`mcr.microsoft.com/azuredocs/aci-helloworld`). Fail fast on any of these with operator-friendly messages.

2. **Kickoff** — invoke `az containerapp job start --name caj-bofia-rate-discovery-${env} --args "--cohort=${cohort}" "--env=${env}"`. Parse the response for the execution ID.

3. **Attach mode (default)** — poll `az containerapp job execution show --name caj-bofia-rate-discovery-${env} --job-execution-name <exec-id>` every 30 s for state transitions. In parallel, poll blob storage every 30 s with `az storage blob list --account-name ${storageAccount} --container agent-state --prefix output/latest/ --query "[?contains(name, '_config.json')].name"` and diff against the previous poll to detect new banks. Print a line per detected bank: `[<elapsed>] bank <N>/<total>: <bank-code> committed <slabs> slabs, $<cost> so far`. Exit when state reaches `Succeeded` / `Failed` / `Cancelled`.

4. **Detach mode (`--detach`)** — print the exec ID + Azure portal URL + ETA (calculated as `cohort.length * 90s / parallelism`) and exit 0. Operator can re-attach later with `scripts/azops/status.js <exec-id>`.

### Companion: `scripts/azops/status.js`

```
node scripts/azops/status.js <exec-id> [--env prod] [--tail]
```

Re-implements the attach-mode poll loop. `--tail` keeps streaming until completion; without it, prints a snapshot and exits.

### Reuse / new code budget

- Reuse `scripts/analysis/build-job-start-body.js` for the ARM body construction.
- Reuse `cloud/sync.js`'s `getBlobClient()` helper for the blob list polling.
- New code: ~250 LOC across `start-cohort.js` (180) + `status.js` (70).

### Failure modes + responses

| Condition | Response |
|---|---|
| Cohort file missing | Exit 1, message lists `data/cohorts/*.json` files found |
| Azure CLI not authenticated | Exit 1, message tells operator to run `az login` |
| Job placeholder image still in use | Exit 1, message says to run `iac/deploy-image.sh` first |
| `az containerapp job start` returns non-zero | Exit 1, raw `az` error preserved |
| Network blip during polling | Log warning, retry once after 10 s, then continue |
| Ctrl-C in attach mode | Print "watcher stopped; cloud run continues" + exec ID + status.js invocation, exit 130 |

## Sub-deliverable B2 — Per-bank blob upload (`cloud/sync.js` `uploadOneBank`)

### Behavior

```js
async function uploadOneBank(bankCode, { runDir, outputLatestDir, domainsFile, logger }) {
  // Upload, in order:
  //   1. output/latest/<bankCode>_config.json
  //   2. output/latest/<bankCode>_*_rates.json     (all variants)
  //   3. output/runs/<runLabel>/<bankCode>.trace.jsonl
  //   4. output/runs/<runLabel>/<bankCode>.summary.json
  //   5. (NEW) <bankCode>-bank-domains-fragment.json
  //
  // Targets blob path: agent-state/output/latest/<bankCode>_*.json (mirroring local)
  //                    agent-state/runs/<runLabel>/<bankCode>.*
  //                    agent-state/output/latest/<bankCode>-bank-domains-fragment.json
  //
  // Returns { uploaded: [...], skipped: [...], errors: [...] }
  //   - uploaded: paths that pushed successfully
  //   - skipped:  paths that didn't exist locally (e.g., bank had no fcnr variant)
  //   - errors:   paths that failed upload (each entry has { path, error_message })
  //
  // Does NOT throw on individual upload failures — collects errors and continues
  // so one flaky blob call doesn't kill the rest of the batch. Caller logs and
  // continues to the next bank.
}
```

### Per-bank registry fragment

Per operator clarification: do NOT push the full `bank-domains.json` after each bank — too large, too much churn for ~2 KB of actual delta. Instead, after `commit_to_registry` runs in `lib/orchestrator.js`, extract just the entry for the bank-in-question and serialise to `<bankCode>-bank-domains-fragment.json`:

```json
{
  "_meta": {
    "bank_code": "hdfc-bank-limited",
    "extracted_at": "2026-05-18T13:42:00Z",
    "source": "bank-domains.json",
    "source_sha": "<sha256 of bank-domains.json at extraction time>"
  },
  "domain": "hdfc.bank.in",
  "rate_pages": { "fd": "/fixed-deposit/fd-interest-rate", ... },
  "scraper_type": "html_js",
  "notes": "..."
}
```

The fragment is one-way (blob receives it; nothing reads it back as authoritative). It exists so a cloud-side aggregator (later sprint) or an operator debugging a single bank can read the registry state for that bank without downloading the whole 1.9-MB file.

Helper: new `scripts/utils/extract-bank-fragment.js`. ~30 LOC.

### Wire-in to `run-batch.js`

After each bank completes (success OR failure), if `BIRD_STORAGE=azure`:

```js
const result = await runOneBank(bankCode, ...);
await safeWriteArtifact(bankCode, result, ...);    // existing
if (process.env.BIRD_STORAGE === 'azure') {
  await uploadOneBank(bankCode, { runDir, outputLatestDir, domainsFile, logger })
    .catch(err => logger.warn(`uploadOneBank ${bankCode} failed: ${err.message}; will retry at batch end`));
}
```

The end-of-batch `cloud/sync.js push` still runs and re-uploads everything (additive-upsert, idempotent), so a failed per-bank upload self-heals at batch end. The per-bank upload is best-effort for crash safety, not the primary persistence path.

### Cost / IO ceiling

Each per-bank upload is ≤ 5 files, each ≤ ~100 KB. For 200 banks: 1000 PUT operations, ~20 MB total. Negligible against blob storage pricing. Wall-clock impact: ~1 s per bank assuming sequential upload, parallelisable to negligible if needed.

### Failure modes

| Condition | Response |
|---|---|
| Blob client init fails | Skip uploads for the whole batch (log warning); end-of-batch push still runs |
| Individual file upload fails | Log warning, continue to next file. Caller logs and continues to next bank. |
| Fragment extraction fails (bank not in bank-domains.json) | Skip the fragment, push the other files |

## Sub-deliverable B3 — ACR upload robustness (`iac/deploy-image.sh`)

### Pain points to address (from operator)

1. `az acr build` occasionally fails on transient errors (network, upload timeout). Operator currently has to detect this manually and re-run.
2. After ACR build succeeds, the operator has no automatic verification that the tag is actually present before Bicep re-apply.
3. Image tagging convention is inconsistent — sometimes `<git-sha>`, sometimes a feature name, sometimes nothing. Hard to tell which image a deployed Job is running.

### Fix

Rewrite the ACR-touching portion of `iac/deploy-image.sh`. Approximate flow:

```bash
GIT_SHA=$(git rev-parse --short HEAD)
ACR_NAME=crbofiarateagentprod
IMAGE_NAME=rate-discovery-agent

# Tag discipline: always tag both <git-sha> and "latest"
build_with_retry() {
  local attempt=1
  local max=3
  while [ $attempt -le $max ]; do
    echo "[deploy] az acr build attempt ${attempt}/${max}..."
    if az acr build \
        --registry "$ACR_NAME" \
        --image "$IMAGE_NAME:$GIT_SHA" \
        --image "$IMAGE_NAME:latest" \
        --file Dockerfile \
        . ; then
      return 0
    fi
    echo "[deploy] attempt ${attempt} failed"
    attempt=$((attempt + 1))
    [ $attempt -le $max ] && sleep $((attempt * 30))
  done
  echo "[deploy] ERROR: az acr build failed after ${max} attempts"
  return 1
}

verify_tag_exists() {
  local tags
  tags=$(az acr repository show-tags --name "$ACR_NAME" --repository "$IMAGE_NAME" -o tsv)
  if echo "$tags" | grep -q "^${GIT_SHA}$"; then
    echo "[deploy] verified: ${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${GIT_SHA} is in ACR"
    return 0
  fi
  echo "[deploy] ERROR: tag ${GIT_SHA} not found in ACR after build"
  return 1
}

if ! build_with_retry; then exit 1; fi
if ! verify_tag_exists; then exit 1; fi
echo "[deploy] image upload complete; proceeding to Bicep re-apply"
# ... existing Bicep apply logic continues unchanged
```

Notes:
- Backoff: 30 s, 60 s, 90 s between retries. Enough to clear most transient network blips.
- `--image` twice produces both tags from a single build (no double upload).
- `verify_tag_exists` catches the case where build returns 0 but the tag landed elsewhere (rare; observed once in Sprint 002).
- Bicep parameters reference `${IMAGE_NAME}:${GIT_SHA}` (not `latest`) so the Job's image tag is deterministic for rollback / audit purposes.

### Reuse / new code budget

- Reuse the existing `iac/deploy-image.sh` shell + Bicep flow.
- Modify only the ACR-touching section. ~80 LOC change (mostly retry/verify).
- No new files.

### Out of scope

- `iac/rollback-image.sh` — deferred per operator; current Bicep re-apply behavior is acceptable once upload retries succeed.
- ACR image pruning — captured for Sprint 5+.
- CI-driven build — manual flow stays for now.

## Sub-deliverable B4 — Operator runbook + smoke

### `scripts/azops/smoke.sh`

One-bank cloud smoke for first-run validation. Approximate flow:

```bash
#!/usr/bin/env bash
# Smokes a single bank through the cloud Container App Job. Use after
# iac/deploy-image.sh to verify the deploy works end-to-end before
# committing to a 200-bank run.
#
# Usage: scripts/azops/smoke.sh [--env dev]

ENV=${ENV:-dev}
BANK=${SMOKE_BANK:-hdfc-bank-limited}

node scripts/azops/start-cohort.js \
  --cohort smoke-1 \
  --env "$ENV" \
  --yes
```

Where `data/cohorts/smoke-1.json` is a single-bank cohort that ships with the codebase. ~20 LOC.

### Runbook structure

`sdlc/sprints/sprint-004/implementation/operator-runbook-2026-05-XX.md` sections:

1. **Prerequisites** — Azure CLI 2.50+, `az login`, env vars
2. **First-time setup** — clone repo, npm install, run `scripts/azops/smoke.sh --env dev` to validate
3. **Normal trigger** — `node scripts/azops/start-cohort.js --cohort top-200 --env prod`
4. **Mid-run inspection** — `az containerapp job execution show`, `az storage blob list`, the new `status.js` re-attach
5. **Troubleshooting** — what to do when ACR upload fails, when Job execution is stuck, when partial results are in blob
6. **Dashboard URLs** — Log Analytics workspace + Application Insights link (TBD; check what telemetry exists today). If no dashboard exists, note "TODO: Sprint 5+" rather than blocking the runbook.

## File / path overview

| Path | Action | LOC |
|---|---|---:|
| `scripts/azops/start-cohort.js` | NEW | ~180 |
| `scripts/azops/status.js` | NEW | ~70 |
| `scripts/azops/smoke.sh` | NEW | ~20 |
| `scripts/utils/extract-bank-fragment.js` | NEW | ~30 |
| `cloud/sync.js` | MODIFY (add `uploadOneBank`) | ~80 added |
| `run-batch.js` | MODIFY (call `uploadOneBank` after each bank) | ~15 added |
| `iac/deploy-image.sh` | MODIFY (retry + tag discipline + verify) | ~80 changed |
| `data/cohorts/smoke-1.json` | NEW | 1 bank |
| `tests/cloud/sync.test.js` | MODIFY (uploadOneBank tests) | ~60 added |
| `tests/scripts/extract-bank-fragment.test.js` | NEW | ~40 |
| `sdlc/sprints/sprint-004/implementation/operator-runbook-2026-05-XX.md` | NEW | ~200 lines of markdown |

Total new code: ~575 LOC across 6 files; modifications: ~235 LOC across 3 files; new tests: ~100 LOC.

## Existing functions / utilities to reuse

- `cloud/sync.js` — `push()` already implements the additive-upsert blob upload. `uploadOneBank` wraps a narrower path through the same client + path translation logic. Don't reinvent.
- `scripts/analysis/build-job-start-body.js` — already constructs the ARM body for `az containerapp job start`. `start-cohort.js` calls it.
- `lib/safe-write.js` — per-bank blob upload happens AFTER local safe-write succeeds, never before. Reuse the existing ADR-012 ordering.
- `lib/registry-skip.js` — `start-cohort.js` consults it in pre-flight to warn the operator if a large fraction of the cohort is already marked as `registry_skip` (so they don't accidentally re-bill).
- `iac/modules/container-apps-job.bicep` — Job spec is shape-correct; Track B doesn't redefine the Job, only the deploy/trigger surface.
- `scripts/utils/load-cohort.js` (Track C) — `start-cohort.js` uses it to validate the cohort file before kickoff. Cross-track dependency.

## Verification (per sub-deliverable)

### B1 (CLI)

1. `node scripts/azops/start-cohort.js --cohort smoke-1 --env dev --dry-run` — prints the exact `az` command, exits 0.
2. `node scripts/azops/start-cohort.js --cohort smoke-1 --env dev --yes` — launches real exec, polls every 30 s, prints per-bank progress, exits when state=Succeeded.
3. Same as #2 with `--detach` — exits immediately, prints exec ID + portal URL.
4. `node scripts/azops/status.js <exec-id>` — re-attaches, polls until completion, exits.
5. Ctrl-C during attach — watcher stops cleanly, cloud run continues (verify via portal).

### B2 (per-bank blob)

1. Unit tests for `uploadOneBank` with mocked blob client cover the success / skip / partial-failure paths.
2. Local smoke: `BIRD_STORAGE=azure node run-batch.js smoke-1 --output-dir output/runs/local-with-blob`. After each bank, verify the blob count grew by `az storage blob list --prefix output/latest/ | wc -l`.
3. Cohort fragment file is present in blob for each completed bank; its content matches the relevant entry in `data/bank-domains.json` at the moment of upload.

### B3 (ACR)

1. Run `iac/deploy-image.sh` on a clean checkout; verify both `<sha>` and `latest` tags exist after a successful run via `az acr repository show-tags`.
2. Induce a transient failure (revoke network briefly, or set up a mock `az acr build` wrapper that fails the first 2 attempts) — verify the script retries and succeeds.
3. Verify the Bicep parameters reference `<sha>` not `latest`; verify the deployed Job's image tag matches the SHA.

### B4 (runbook + smoke)

1. `scripts/azops/smoke.sh --env dev` runs end-to-end without operator intervention. Exit 0 on success.
2. Runbook is read by a fresh operator (or simulated by re-reading it cold), and they can complete the smoke without asking for help.

## Sequencing within Track B

Recommended order (each builds on the prior):

1. **B2 first** — `uploadOneBank` + `extract-bank-fragment.js` + `run-batch.js` wire-in. Tests + local smoke before touching cloud. ~1 day.
2. **B3 next** — ACR retry + tag discipline. Lower risk (shell script changes); validates against a real ACR. ~half day.
3. **B1 then** — start-cohort.js + status.js. Depends on B3 for a known-good image; depends on B2 for incremental progress visibility. ~1-1.5 days.
4. **B4 last** — smoke script + runbook are written once B1-B3 are stable. ~half day.

Track B total budget: ~3.5 days of focused work. Fits within the two-week Sprint 4 window comfortably alongside Track A + early Track C.

## Open questions

- Will the cohort-progress poll cost matter? Each `az containerapp job execution show` + `az storage blob list` call is ~$0 individually but at 30 s × 2 hours × 2 calls = 480 calls per run. Should be negligible but worth measuring.
- The dashboard URL section of the runbook depends on whether Application Insights / Log Analytics is wired up today. If not, that section becomes "TODO Sprint 5+".
- Per-bank upload failure rate in the real cloud — we'll know after the 50-bank smoke run.

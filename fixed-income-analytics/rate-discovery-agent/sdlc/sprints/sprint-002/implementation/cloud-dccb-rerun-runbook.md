# Cloud DCCB rerun runbook — Sprint 002 #12 + #13

**Status:** Runbook (steps to execute). Outcomes appended as a "Run log" section after #12 + #13 complete.
**Purpose:** Sprint 002's exit criterion — re-run the full DCCB category in cloud with all Sprint 002 fixes deployed, then compare the success rate to the Sprint 001 baseline of 35 / 351 (10%).
**Owner:** Samir Joshi.

## What this exercises

End-to-end of the Sprint 002 fixes against real cloud infrastructure:

- #2 v2 failure-class taxonomy (classifier + aggregator + run report)
- #5 codified learnings (L1–L13 prompt-side rules + skip-gate)
- #6 slug consistency (canonical slug injected into prompt + slugify tool + slug-guard)
- #8 cloud kill-switch
- #9 cloud/git-publish path rooting + clone-based bootstrap
- #10 cloud/sync.js pull-everything (additive state hydration)
- #11 pack rebuild verification
- #15 ADR-012 safe-write + required `extraction_method` (no destructive overwrites)

## Prerequisites (one-time / verify)

- [ ] All Sprint 002 commits up to and including `54d64d5` (#11) on `azure-openai-agent` branch.
- [ ] `npm test` passes locally — 221 tests, 220 pass, 1 pre-existing Azurite skip, 0 fail. Specifically `npm run check:writes` must be clean (ADR-012 enforcement).
- [ ] Local 12-bank Phase B comparison verified the prompt + skip-gate work end-to-end (Sprint 002 #4 writeup).
- [ ] `gh auth status` shows the operator's GitHub auth (for verifying the cloud bot's commit afterwards).
- [ ] `az account show` shows the operator's Azure auth.

## Step 1 — Atomic deploy: function code + image + Bicep re-apply (~10 min)

```bash
# From the project root
cd rate-discovery-agent
iac/deploy-image.sh
```

The script (post-#17 / ADR-013) performs all three steps atomically per `iac/deploy-image.sh`:

1. Builds `functions.zip` (Python-based, POSIX path entries) and uploads to `stbofiafuncprod01/deploy/func-deploy-<sha>.zip`.
2. Runs `az acr build` to push the new container image.
3. Calls `az deployment sub create` with **both** `imageTag` and `runFromPackageUrl` parameters so the Bicep re-apply can't silently wipe either one (this was the Sprint 002 #12 blocker — ADR-013 documents the root cause).
4. Polls `/admin/functions` for up to 5 minutes; non-zero exit if the function host doesn't report both functions loaded.

If the verification step in (4) fails, the deploy is broken and the rest of this runbook must NOT proceed. Investigate via:

```bash
az functionapp log tail --name func-bofia-trigger-prod --resource-group rg-bofia-rate-agent-prod-southindia
```

Verify final state:

```bash
az acr repository show-tags --name crbofiarateagentprod --repository rate-discovery-agent --output table | head -5
# Should show the new git-SHA at the top
```

## Step 2 — Engage the kill-switch precaution (until verification)

```bash
az containerapp job update \
  --name <jobname> \
  --resource-group <rg> \
  --set-env-vars BIRD_DISABLE_GIT_PUBLISH=1
```

This keeps the safety net on while we sanity-check Step 3's smoke. We'll flip it back to `0` in Step 4 before the full DCCB rerun.

## Step 3 — Smoke against a single bank to validate the image

Pick one bank with a known-good registry entry (e.g., `abhyudaya-co-operative-bank-ltd-mumbai`). Trigger via the same path operators use today:

```bash
curl -X POST "https://<function-app>.azurewebsites.net/api/start-discovery" \
  -H "Content-Type: application/json" \
  -d '{"bank": "Abhyudaya Co-operative Bank Ltd., Mumbai", "category": "Scheduled Urban Co-operative Bank"}'
```

Wait for the Job to complete (Cloud Console → Container Apps Job execution log). Verify in blob (or via `node cloud/sync.js pull` locally):

- `output/latest/abhyudaya-co-operative-bank-ltd-mumbai_config.json` exists and carries `extraction_method` (per ADR-012).
- `output/latest/abhyudaya-co-operative-bank-ltd-mumbai_rates.json` carries `extraction_method` and >= 1 slab (or a clear warning).
- Summary file shows `failure_class` and `phase_outcomes` (v2 taxonomy populated).
- Job log includes `[git-publish] disabled by env (BIRD_DISABLE_GIT_PUBLISH=1); skipping git publish` (kill-switch holding).

If anything in this list fails: STOP — debug before proceeding to Step 4.

## Step 4 — Flip kill-switch off; trigger DCCB category run

```bash
az containerapp job update \
  --name <jobname> \
  --resource-group <rg> \
  --set-env-vars BIRD_DISABLE_GIT_PUBLISH=0
```

Then trigger:

```bash
curl -X POST "https://<function-app>.azurewebsites.net/api/start-discovery" \
  -H "Content-Type: application/json" \
  -d '{"category": "District Central Co-operative Bank"}'
```

Expected wall clock: ~3.5 hours (matching the Sprint 001 baseline). Expected cost: ~$15-20 AOAI, possibly less due to skip-gate honoring the operator-curated `discovery_status` entries.

## Step 5 — Watch the run

Stream Job logs in Cloud Shell or Azure Portal. Look for:

- **Skip-gate firing** for the 4 banks we tagged in Sprint 002 #5 (azamgarh, gondia → `no_website_known`; dhanbad, bankura → `website_known_no_rate_page`). Logs should show `Skipping discovery: discovery_status=...`.
- **No "preserve operator-curated" errors** during writes — the safe-write helper should silently accept all auto-overwrites.
- **No `failed to push` errors** from `cloud/git-publish.js` (the clone-based bootstrap should succeed cleanly on the second + later commits).

If the Job completes with exit code 0 and the cloud bot's git commit lands on `origin/azure-openai-agent`, proceed to Step 6.

## Step 6 — Verify the bot's commit (no whole-tree destruction)

```bash
git fetch origin
git log origin/azure-openai-agent -3 --stat | head -20
```

Expected:
- **Recent commits include the bot's DCCB run** with a delta showing per-bank file adds in `rate-discovery-agent/output/latest/...`.
- **The diff is small and additive** (per-run delta, not whole-tree replacement). The Sprint 001 failure mode (the `8eb3053` / `1860c66` whole-tree-rewrite) must NOT recur.
- **Files outside `rate-discovery-agent/`** (e.g., `packages/web/...`, top-level READMEs) survive in the commit's tree.

If the commit is destructive: **STOP — flip the kill-switch back on, debug.** This is Sprint 002's most important regression to avoid.

## Step 7 — Pull the new run's outputs locally

```bash
node cloud/sync.js pull
# Pulls bank-domains.json AND every output/latest/*.json blob (Sprint 002 #10)
```

Confirm `output/latest/` now contains the full DCCB cohort (350+ banks) plus accumulated prior-run state (HDFC etc.).

## Step 8 — Rebuild the pack locally and inspect

```bash
node pack/build-pack.js
# Or via npm: npm run build-pack
```

Open `pack/dist/rates-pack.json` and check `counts.banks_total`. Should be the union of accumulated state, not just this run.

## Step 9 — Sprint 002 #13: compare to Sprint 001 baseline

```bash
node scripts/analysis/compare-cohort-runs.js \
  C:/sw/BharatOmni/UFA/agent-data-backup/fixed-income-yield-advisor/output/latest \
  output/latest \
  --label-baseline "Sprint 001 cloud (2026-05-08)" \
  --label-new "Sprint 002 cloud rerun ($(date +%Y-%m-%d))" \
  --output sdlc/sprints/sprint-002/implementation/cloud-rerun-comparison.md
```

This produces the lift-measurement report. Then:

- Read the tier-2 distribution side-by-side. Sprint 001 baseline was 4.9% success / 32.9% partial / 61.1% discovery_failed.
- **Sprint exit criterion:** success rate is **measurably higher** than the 10% (35 / 351) baseline.
- Document the actual delta in `sdlc/sprints/sprint-002/retrospection/retro.md` (creating that file in the next step).

## Step 10 — Sprint 002 retro

Create `sdlc/sprints/sprint-002/retrospection/retro.md` covering:

- What shipped (all scope items + addendum items + Track A/B/C deliverables).
- The DCCB cohort lift measurement (Step 9's report).
- What's deferred to Sprint 003 (action decomposition, framework eval, Vision API, multilingual extractor, the 9 TODO-migrate writers from #15d).
- Open items (e.g., the `safe-write` migration of scripts/, cloud/sync.js's local-fs registry pull).

Mirror the structure of `sdlc/sprints/sprint-001-azure-foundation/retrospection/retro.md`.

## Cost guard rail

If the Job exceeds 4 hours wall clock or the AOAI bill projects >$30 mid-run:

```bash
az containerapp job execution cancel \
  --name <jobname> \
  --resource-group <rg> \
  --execution <execution-id>
```

The kill-switch flip from Step 4 means the bot's git publish wouldn't fire on cancel, so no partial-state corruption risk. The blob layer is additive — partial outputs are still recoverable on the next run.

---

## Run log

### 2026-05-13 operator attempt — blocked at Step 3, surfaced ADR-013

Attempted to execute Steps 1–10 in operator mode. Outcome: blocked at Step 3 by a function-trigger 404. Sequence:

- **Step 1a (ACR build):** image `crbofiarateagentprod.azurecr.io/rate-discovery-agent:afede38` built and pushed (third attempt; first two failed with TLS connection resets to acrtaskprodsin053.blob.core.windows.net, third succeeded in 5m08s).
- **Step 1b (Bicep apply):** deployment `bofia-rate-agent-deploy-20260513-000527` succeeded in 1m14s.
- **Step 2 (kill-switch):** `BIRD_DISABLE_GIT_PUBLISH=1` set and verified.
- **Step 3 (smoke):** POST to `/api/start-discovery` returned 404. `/admin/host/status` reported `state: Running` but `/admin/functions` returned `[]` — zero functions loaded.

Root cause (full writeup in ADR-013): the Bicep re-apply at Step 1b silently wiped `WEBSITE_RUN_FROM_PACKAGE` (set out-of-band during Sprint 001's deploy). The function host restarted under empty `WEBSITE_RUN_FROM_PACKAGE` and registered zero functions. ARM PUT on appSettings is replace-not-merge — same bug class as ADR-012, but at the IaC layer.

In-session remediation:
- Diagnosed the wiped env var via `/admin/functions` returning `[]` and ARM REST appsettings dump.
- Rebuilt `functions.zip` with Python (PowerShell `Compress-Archive` emits backslash entries that the Linux Function host treats as literal-name files — adjacent failure mode also captured in ADR-013).
- Uploaded to `stbofiafuncprod01/deploy/func-deploy-20260513-011248.zip`.
- Set `WEBSITE_RUN_FROM_PACKAGE` back to the new blob URL via `az webapp config appsettings set`.
- Function still 503'd; with the May-8 known-good blob, also 503'd. Investigation paused per operator instruction; the structural fix took priority over chasing the 503.

Items shipped in this session (Sprint 002 #17 per scope-addendum.md):
- `iac/modules/function-app.bicep`: `runFromPackageUrl` parameter, conditional appSetting via `concat()`.
- `iac/main.bicep`: parameter threaded through.
- `iac/build-functions-zip.py`: POSIX-path zip builder.
- `iac/deploy-image.sh`: rewritten as an atomic deploy (zip → upload → image → Bicep → verify).
- `tests/iac/build-functions-zip.test.js`: contract test (zero backslash entries; required files present).
- `sdlc/decisions/ADR-013-bicep-appsettings-deploy-config.md`.

State at session end:
- Kill-switch ON (`BIRD_DISABLE_GIT_PUBLISH=1`).
- Image `afede38` deployed to Container Apps Job.
- Function still 503 — out-of-band `WEBSITE_RUN_FROM_PACKAGE` set to a manually-uploaded zip; not validated as working.
- Sprint 002 #17 code merged but not deployed via the new `iac/deploy-image.sh`. The next operator session should run `iac/deploy-image.sh` (the new atomic version) and the post-deploy verification will confirm whether the fix unblocks #12.

### Step 1 — Image build

- Tag: `<TBD>`
- Bicep apply: `<TBD>`

### Step 4 — DCCB trigger

- Triggered at: `<TBD>`
- Job execution id: `<TBD>`

### Step 5 — Run completion

- Completed at: `<TBD>`
- Wall clock: `<TBD>`
- AOAI cost: `<TBD>`
- Tier-2 distribution:
  - success: `<TBD>`
  - partial_success: `<TBD>`
  - extraction_failed: `<TBD>`
  - discovery_failed: `<TBD>`
  - no_rates_expected: `<TBD>`
  - agent_error: `<TBD>`

### Step 6 — Bot commit verification

- Commit SHA: `<TBD>`
- Diff size: `<TBD>` files
- Whole-tree-rewrite check: `<TBD>` (PASS / FAIL)

### Step 9 — Comparison report

- Report path: `<TBD>`
- Headline lift: `<TBD>` (success rate Δ pp; Sprint 001 baseline was 4.9%)

### Step 10 — Retro

- Retro doc: `<TBD>`
- Sprint exit decision: `<TBD>`

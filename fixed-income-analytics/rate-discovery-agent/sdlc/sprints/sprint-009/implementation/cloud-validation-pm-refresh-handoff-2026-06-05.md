# Sprint 009 — 513-bank pm-refresh cohort: session handoff

**Authored:** 2026-06-05 09:25 UTC
**Purpose:** If this session terminates before the cohort finishes (~14-16h
wall time), a fresh session can pick up monitoring without re-discovering
context. Read this end-to-end before any actions.

## What's running

- **Cohort:** `data/cohorts/pm-refresh-2026-q2.json` (513 banks)
- **Execution name:** `caj-bofia-rate-discovery-prod-5kz1vm8`
- **Image:** `crbofiarateagentprod.azurecr.io/rate-discovery-agent:5ee0b99`
- **Started:** 2026-06-05 09:11 UTC
- **Expected completion:** 2026-06-05 ~23:00 UTC to 2026-06-06 ~01:00 UTC
- **replicaTimeoutSec:** 72000 (20h) — gives buffer beyond the ~14-16h projection.
- **Local deploy-smoke log:** `deploy-smoke-pm-refresh.log` (Phase 3 polling every 5 min)
- **Background task id (if still alive):** `bc72rsce6`

## Why this run matters (Sprint 009 close-out)

This is the final validation for Sprint 009. All 8 phases + Phase 9
(cohort-runtime fixes) are code-complete. Five prior cloud-validation
rounds were done at 12 and 50 banks — see
`sdlc/sprints/sprint-009/implementation/cloud-validation-*.md`. This
500-bank run is the original Phase 6 exit criterion, gated on the Playwright
spawn ETIMEDOUT problem which was resolved via `playwright_disabled` in
Phase 9.

## What "done" looks like

The poll log will end with a `Smoke Verdict` block. Expected:

```
──────────────────────────────────────────────────────────────
 Smoke Verdict
──────────────────────────────────────────────────────────────
 Execution:        caj-bofia-rate-discovery-prod-5kz1vm8
 Platform:         <Succeeded|Failed>
 Receipt:          found
 Business outcome: <success|partial_failure>
 Banks:            N succeeded, M failed, R rate-limited, S skipped (total 513)
```

**Expected outcome:** `partial_failure` (some bank failures are expected;
BoI-IBU at minimum will fail-fast intentionally).

**Pre-run projection of skips (computed 2026-06-05 09:00 UTC):**
- 80 curated-skip (instant)
- 61 discovery-status skip (instant)
- 2 playwright_disabled (~30s each)
- 370 regular extraction

**Pass thresholds for sprint-009 close** (operator decision; flexible):
- Total slab count (extracted + curated-preserved) ≥ sprint-008 pack
  baseline (~10,000 slabs across ~600 banks per sprint-008 numbers)
- No silent overwrites of curated data (check via `safe-write: incoming
  routed to pending` log lines — non-zero count is fine; means
  ADR-012 protection fired correctly)
- Receipt landed with `business_outcome` set (i.e., didn't time out
  silently)

## How to check progress (fresh session, no context)

### 1. Resume environment

```powershell
cd C:\sw\BharatOmni\UFA\BIRD\rate-discovery-agent
$env:AZ_BIN = "C:\Users\Samir Joshi\AppData\Roaming\Python\Python311\Scripts\az.bat"
az account show -o table  # verify logged in as samir@bharatomni.com on BO Azure subscription
```

If `az` not logged in: `az login` first.

### 2. Quick status from deploy-smoke poll log

```bash
tail -10 deploy-smoke-pm-refresh.log
```

You'll see lines like:
```
[HH:MM:SSZ] arm=Running  N succeeded, M failed, 0 rate-limited, 0 skipped (total 513)
```

### 3. Direct ARM status (more accurate)

```powershell
az containerapp job execution show -n caj-bofia-rate-discovery-prod -g rg-bofia-rate-agent-prod-southindia --job-execution-name caj-bofia-rate-discovery-prod-5kz1vm8 --query "{status:properties.status,startTime:properties.startTime,endTime:properties.endTime}" -o json
```

### 4. Read the receipt blob directly

```powershell
az storage blob download --account-name stbofiarateagentprod01 --auth-mode login --container-name agent-state --name "output:latest:_execution_caj-bofia-rate-discovery-prod-5kz1vm8.json" --file receipt-5kz1vm8.json --no-progress
Get-Content receipt-5kz1vm8.json | ConvertFrom-Json | Format-List
```

Key fields:
- `phase`: `running` while in flight; `succeeded` / `failed` when done
- `summary.succeeded` / `.failed`
- `started_at` / `updated_at` / `completed_at`

### 5. Per-bank outcomes from Log Analytics

Workspace customer ID (for the `-w` flag): `36bea445-1f1b-4ccf-9448-030b702abbc5`

```powershell
$q = "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith 'caj-bofia-rate-discovery-prod-5kz1vm8' | where Log_s contains ' OK ' or Log_s contains ' FAIL ' or Log_s contains 'Skipping discovery' or Log_s contains '>>> [' | order by TimeGenerated asc | project TimeGenerated, Log_s"
$result = az monitor log-analytics query -w 36bea445-1f1b-4ccf-9448-030b702abbc5 --analytics-query $q -o json | ConvertFrom-Json
"Total events: $($result.Count)"
$result | ForEach-Object { "$($_.TimeGenerated.Substring(11,12)) $($_.Log_s.Substring(0,[Math]::Min(200,$_.Log_s.Length)))" } | Select-Object -Last 30
```

## What to do when the cohort finishes

### 1. Capture the verdict

```bash
tail -30 deploy-smoke-pm-refresh.log > /tmp/verdict.txt
```

### 2. Pull per-bank breakdown (full cohort)

```powershell
$q = "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith 'caj-bofia-rate-discovery-prod-5kz1vm8' | where Log_s contains ' OK ' or Log_s contains ' FAIL ' or Log_s contains 'TIMEOUT for' or Log_s contains 'ZERO-SLAB' or Log_s contains 'Skipping discovery' or Log_s contains '>>> [' | order by TimeGenerated asc | project TimeGenerated, Log_s"
$result = az monitor log-analytics query -w 36bea445-1f1b-4ccf-9448-030b702abbc5 --analytics-query $q -o json | ConvertFrom-Json
$result | ForEach-Object { "$($_.TimeGenerated.Substring(11,12)) $($_.Log_s.Substring(0,[Math]::Min(220,$_.Log_s.Length)))" } | Out-File pm-refresh-perbank.txt
```

### 3. Compute slab totals

Two paths to slab counts: (a) sum from the per-bank `OK NNs | ... | <slabs>`
log lines, (b) read each rate file from blob and sum `.rate_slabs.length`.

Approach (a) is faster — already in the per-bank breakdown. Approach (b)
is authoritative.

For (b):
```bash
# in the repo, after the cohort completes, the cloud-sync push will
# refresh output/latest from blob. To verify directly from blob:
# (use scripts/azops/pull-cohort-output.js if it exists, or iterate manually)
```

### 4. Write the implementation note

`sdlc/sprints/sprint-009/implementation/cloud-validation-pm-refresh-2026-06-05.md`

Template — match the structure of the prior validation impl docs (especially
`cloud-validation-phase9-fix-validate-2026-06-05.md`).

Required sections:
- Cohort metadata (image, exec name, wall time, cost)
- Verdict + per-bank summary table (or aggregated counts by outcome)
- Total slab tally (extracted + curated-preserved)
- Comparison to sprint-008 baseline (if known)
- Sprint 009 exit-criteria final check (the table from the Phase 9 outcome doc)
- Operator pickup queue for sprint-010 (BoI-IBU, partial_silent drift, etc.)

### 5. Commit + push

```bash
git add sdlc/sprints/sprint-009/implementation/cloud-validation-pm-refresh-2026-06-05.md
git commit -m "rate-discovery(sprint-009): pm-refresh 513-bank cohort outcome
<body>"
git push origin azure-openai-agent
```

### 6. Update sprint plan + retro

If the verdict is good enough to close Sprint 009:
- Update `sdlc/sprints/sprint-009/plan/sprint-009-scope.md` exit-criteria
  rows to "✓ verified via pm-refresh cohort 5kz1vm8"
- Append a new section to `sdlc/sprints/sprint-009/retrospection/retro.md`
  covering the final validation
- Update `~/.claude/projects/.../memory/project_sprint009_status.md` —
  mark as "closed"

## Failure scenarios to watch for

### A. ARM goes `Failed` early (< 1h in)

That's not platform-level failure — it's the cohort exit code reflecting
the first bank failure. Phase 1 / 2.5 makes `Failed` the truthful exit
when any bank fails. Receipt should still be `found` and totals should
show meaningful progress. **Don't panic; check the receipt and Log
Analytics before acting.**

### B. Receipt stays `pending` past first bank completion

That means the durable-receipt path (Phase 2.5 item 3) didn't fire. Check
`scripts/azops/cloud-status.js` output. Could be a cloud-sync auth issue.
Operator may need to check.

### C. Cohort stalls (no progress for > 30 min on one bank)

Could be a specific bank with a deadlock. The per-bank timeout in
`run-batch.js` is 900s (15 min). After that the bank is killed and the
next one starts. If you see >30min stall on one bank, that's anomalous —
worth investigating via Log Analytics for that bank's window.

### D. Cohort hits 20h replicaTimeoutSec

Container Apps will SIGKILL. The receipt should reflect last-known state.
You'd see ARM=`Failed` with cause `OperationTimeout`. Note for sprint
retro and consider concurrency=3 next time.

### E. LLM rate limiting (HTTP 429 from AOAI)

run-batch detects these and reclassifies as `rate_limited` (not failure).
If you see many `rate_limited` outcomes, the AOAI deployment's TPM/RPM
quota was exceeded. May need to scale the deployment in Azure portal.

### F. `npm test` after the cohort

```bash
npm test --silent 2>&1 | tail -10
```

Expected: 1397 / 0 / 44 (or higher if more tests landed). If any test
fails after the cohort, that's a regression introduced during the run
(extremely unlikely — the cohort is read-mostly on registry).

## Key resource locations

| Resource | Name | RG |
|---|---|---|
| Container Apps Job | `caj-bofia-rate-discovery-prod` | `rg-bofia-rate-agent-prod-southindia` |
| Function App | `func-bofia-trigger-prod` | same |
| Storage account (data) | `stbofiarateagentprod01` | same |
| Storage account (functions) | `stbofiafuncprod01` | same |
| Container Registry | `crbofiarateagentprod` | same |
| Log Analytics workspace | `log-bofia-rate-agent-prod` | same |
| Workspace customerId | `36bea445-1f1b-4ccf-9448-030b702abbc5` | (for `-w` flag) |
| Subscription | `BO Azure subscription` (`06c83a79-f46e-4011-b91f-68c8ce6cc6a5`) | — |
| Operator UPN | `samir@bharatomni.com` | — |

## Branch state at handoff

- Branch: `azure-openai-agent`
- HEAD (at handoff): `5ee0b99` — replicaTimeoutSec bump
- Tip: every commit since `b480d28` is on this branch and pushed to origin
- Latest sprint plan: `sdlc/sprints/sprint-009/plan/sprint-009-scope.md`
  (Phase 9 row added 2026-06-05)
- Latest impl docs: `sdlc/sprints/sprint-009/implementation/`

## Phase 9 fixes summary (for context)

The 6 fixes shipped in commit `a177522` and validated in cohort `356tto5`:

| Item | Validation outcome (Phase 9 fix-validate cohort, 11 banks, 8 min) |
|---|---|
| 9.1 SBI agent-loop guard | SBI 0 → 60 slabs ✓ |
| 9.2 Zero-slab inspector carve-out | 5 curated banks no longer misclassified ✓ |
| 9.3 Curated NRI variant bootstrap | 86 files uploaded; ~500 slabs of curated data now in blob ✓ |
| 9.4 AB Bank `foreign_currency_not_inr` skip | Skipped in <1s ✓ |
| 9.5 `tls_skip_verify` (Arunachal + Ahmedabad) | Both went FAIL → OK with 10/11 slabs ✓ |
| 9.6 CSB operator-curated | Skipped, 73 slabs preserved ✓ |

## Cohort composition (for sanity-checking the verdict)

From `data/cohorts/pm-refresh-2026-q2.json` (513 banks):

| Category | Count |
|---|---|
| Non-Scheduled Urban Co-operative Bank | 132 |
| District Central Co-operative Bank | 130 |
| Scheduled Urban Co-operative Bank | 52 |
| Foreign Bank | 44 |
| IFSC Banking Unit (IFSCA) | 37 |
| Regional Rural Bank | 28 |
| Scheduled State Co-operative Bank | 24 |
| Private Sector Bank (Indian) | 21 |
| Public Sector Bank | 12 |
| Small Finance Bank | 11 |
| Non-Scheduled State Co-operative Bank | 10 |
| Payments Bank | 6 |
| Financial Institution | 4 |
| Local Area Bank | 2 |

## What's already validated this sprint (don't re-litigate)

| Sprint 009 exit criterion | Verified by |
|---|---|
| Cloud loop on HEAD | All 5 prior validation rounds |
| Observability proves blob writes | Phase 1.4 KQL |
| Bicep re-apply safe (kill-switch preserved) | All 5 rounds |
| Function App green | All 5 rounds |
| Split + merge reproducible | Phase 6 synthetic E2E |
| 500-bank pack-quality ≥ sprint-008 baseline | **← this run (5kz1vm8)** |

Only one criterion is gated on this run. Everything else is green.

## Recommendation if cohort succeeds

If `business_outcome` is `partial_failure` with mostly-correct counts (e.g.,
≥ 400 succeeded / ≤ 100 failed / 0 rate-limited), that's a passing outcome
— `partial_failure` is the truthful reflection of the ~20-30 banks that
genuinely can't extract in cloud (and we knew this going in). Don't
require `success` outcome — that would mean zero failures, which is
unrealistic at 513-bank scale.

If you see `succeeded < 350`, that's surprising; pause and investigate
before declaring sprint 009 closed.

## Memory + handoff hand-off

If you write a new impl doc or close the sprint, update
`~/.claude/projects/C--sw-BharatOmni-UFA-BIRD/memory/project_sprint009_status.md`
to mark the run as closed and add the final slab count to the description.

# Sprint 010 — session handoff (2026-06-09 ~01:30 UTC)

**Why this doc:** session exited mid-Phase-G. The 513-cohort is running in Azure (Container Apps Job, independent of any local process). Phases H + I are pending and need a future session to complete.

## In-flight state

| Asset | Where | Status |
|---|---|---|
| 513-cohort execution | Azure CAJ `caj-bofia-rate-discovery-prod-*` (latest name in `logs/sprint-010/deploy-smoke-513-d4.log` line "started: ...") | Running on D4. At session exit: 325 succeeded / 125 failed of 513 (≈ 87.7 % through). ETA ~50 min from 02:20 Z. |
| Bicep state | `azure-openai-agent` branch HEAD (`fbe00e8`) | Job on `d4-jobs`, env has Consumption + d4-jobs. D4 baseline billing ≈ \$0.20/hr accruing. |
| Code | All sprint-010 work committed up to `fbe00e8`, pushed to origin | A1, A2, B, C, D, F all shipped + impl docs |
| Local poller | Background bash task `bu79p95pz` | Dies with session; harmless |

## Resume checklist (when next session starts)

### 1. Locate the latest execution + verify it finished

```powershell
$env:AZ_BIN = "C:\Users\Samir Joshi\AppData\Roaming\Python\Python311\Scripts\az.bat"
& $env:AZ_BIN containerapp job execution list `
  --name caj-bofia-rate-discovery-prod `
  --resource-group rg-bofia-rate-agent-prod-southindia `
  --query "[0].{name:name,state:properties.status,start:properties.startTime,end:properties.endTime}" -o table
```

Find the execution name in `logs/sprint-010/deploy-smoke-513-d4.log` (look for `started: caj-bofia-...`).

### 2. Pull receipt + batch results

```powershell
# Substitute <EXEC> with the execution name from above
$execName = "<paste-execution-name>"
$blobs = & $env:AZ_BIN storage blob list --account-name stbofiarateagentprod01 --container-name agent-state --auth-mode login -o tsv --query "[].name" --num-results 20000 2>$null
$blobs | Select-String $execName

# Receipt:
& $env:AZ_BIN storage blob download --account-name stbofiarateagentprod01 --container-name agent-state `
  --name "output:latest:_execution_${execName}.json" `
  --file "logs/sprint-010/execution-513-receipt.json" --auth-mode login --overwrite

# Batch results path is inside the receipt; download similarly.
```

### 3. Phase H — revert D4 to Consumption (two-step, mandatory)

Per Sprint 009 close-out playbook (`sdlc/sprints/sprint-009/implementation/dedicated-profile-switch-2026-06-06.md`):

**Step 1:** flip the job's profile back to Consumption, KEEP d4-jobs in env (otherwise `WorkloadProfileInUse`):

```
# Edit iac/modules/container-apps-job.bicep:
#   workloadProfileName: 'd4-jobs'  →  'Consumption'
# Edit iac/modules/container-apps-env.bicep:
#   leave d4-jobs in workloadProfiles[] for now
git commit -am "sprint-010(H step 1): CAJ → Consumption (keep d4-jobs profile for in-use guard)"
bash iac/deploy-image.sh
```

Wait for deploy success. Verify job is on Consumption:
```powershell
& $env:AZ_BIN containerapp job show --name caj-bofia-rate-discovery-prod --resource-group rg-bofia-rate-agent-prod-southindia --query "properties.workloadProfileName" -o tsv
# expected: Consumption
```

**Step 2:** drain d4-jobs from env:

```
# Edit iac/modules/container-apps-env.bicep:
#   remove the d4-jobs entry from workloadProfiles[]
git commit -am "sprint-010(H step 2): drain d4-jobs workload profile (revert complete)"
bash iac/deploy-image.sh
```

After step 2, baseline billing stops.

### 4. Phase I — analysis + retro DRAFT

Adapt `scripts/analysis/cloud-outcome-recount.js` for the new cohort label, run, compare against `logs/sprint-009/baseline-pack-2026-05-28.json`.

Pull `output/latest/` from blob:
```
node cloud/sync.js pull
node pack/build-pack.js
node pack/quality-gate.js   # may BLOCK on the Erode regression; --accept-regression if intentional
node scripts/quality-gate.js pack/dist/rates-pack.json logs/sprint-009/baseline-pack-2026-05-28.json --out-dir logs/sprint-010
```

Write retro **DRAFT** at `sdlc/sprints/sprint-010/retrospection/retro.md` per the existing Sprint 009 retro template. **Do NOT use "closed" wording until operator explicitly approves the close** (per `feedback_sprint_close_consent` memory).

## What was committed this session (Sprint 010 extension A1..F)

```
fbe00e8 sprint-010(F): 12-bank validation cohort — 9/12 succeeded
4dd5382 sprint-010(F): 12-bank validation cohort (balanced)
261d55e sprint-010(F): switch CAJ to D4 dedicated profile + cohort fire prep
2500037 sprint-010: scope doc — live status table for phases A1..I
7dc8603 sprint-010(D): HDFC misclassification = analysis-script bug
23bb869 sprint-010(C): tenure_min_below_1 normalizer fix
469980f sprint-010(B): wire Azure Document Intelligence env into CAJ Bicep
2077bfd sprint-010(A2): orchestrator null-bank_type safety
f4d68eb sprint-010(A1): orchestrator-only path; retire lib/agent.js#runAgent
```

## Operator decisions still pending (post-cohort)

1. **Erode DCCB regression** — `pack/quality-gate.js` will block publish (Phase 1 work). `--accept-regression "<reason>"` or fix in Sprint 011.
2. **The ~125 failed banks in the 513 cohort** — categorize and either mark cloud-incapable (Phase 2/4 work auto-populates this on next cohort) or carry to Sprint 011.
3. **Sprint 010 close** — only operator can sign off.

## Files written this session in logs/sprint-010/

- `deploy-d4-with-docintel.log` — Phase F deploy log
- `deploy-smoke-validation-12.log` — Phase F cohort fire
- `execution-xdxc51b-receipt.json` — Phase F receipt
- `batch-xdxc51b.json` — Phase F per-bank results
- `deploy-smoke-513-d4.log` — Phase G cohort fire (in flight at session exit)
- `cloud-outcome-buckets.json`, `cloud-outcome-buckets-v2.json` — analysis from earlier
- `quality-report.{md,json}` — Sprint 008 Phase 7 gate output from earlier audit

## What works post-Sprint-010

| Capability | Pre-sprint | Post-sprint |
|---|---|---|
| Orchestrator path | Optional, ~140/513 banks | **Universal, 513/513** |
| Cloud DocIntel OCR | Code present, env unwired | **Wired + key live + verified on banswara** |
| `--path llm` retired | Deprecated since Sprint 6 | **Deleted (lib/agent.js gone)** |
| Bare CLI without --category | Crashes | **Derives from registry** |
| Tenure parser min < 1 | Slipped through gate | **Normalized to 1** |
| 513-cohort on Consumption | Freezes > ~300 banks | (still untested post-A1) |
| 513-cohort on D4 | Validated by 9zulerb (198) | **Validated by this session's run (in progress, 87.7% done at exit)** |

End of handoff.

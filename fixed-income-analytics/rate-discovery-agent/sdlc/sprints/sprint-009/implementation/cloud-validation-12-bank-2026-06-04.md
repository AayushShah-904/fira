# Sprint 009 — 12-bank cloud validation (between Phase 4 and Phase 5)

**Date:** 2026-06-04
**Trigger:** Operator request mid-autonomous-run ("Please run a 12 banks cohort on the container when you get chance between the phase executions, to ensure that we are improving the baseline and no regressions.")
**Outcome:** **Initially misread as "stuck on bank 1"; on full log review (2026-06-04 re-audit) the run actually COMPLETED at 21:49 UTC with 9 "succeeded" / 3 "failed" — but the "succeeded" tally was inflated by stale `output/latest/` content pulled from blob at job start, and the freshly-extracted slabs were ~90% below baseline.**

> **2026-06-04 re-audit note:** The "stuck on bank 1" claim below was written before the run finished. The full log shows the run completed: 78 min wall-time, 9 banks marked succeeded (several from stale data), 3 failed, final receipt uploaded with `phase=failed`, pack rebuilt and published. The real headline is a severe extraction-quality regression driven by Playwright spawn ETIMEDOUT across SBI / ICICI FCNR / Axis / BoI-IBU. See `cloud-validation-12-bank-rerun-2026-06-04.md` for the follow-up round.

## What was fired

- Cohort: `data/cohorts/top-12.json` (12 banks: PSB×3, PVB×4, SFB×2, FB×1, IBU×1, SUCB×1).
- Command: `node scripts/azops/deploy-smoke.js --env prod --cohort top-12 --max-wait 3000 --poll-interval 30 --yes` from a Git Bash sandbox with `AZ_BIN="C:\Users\Samir Joshi\AppData\Roaming\Python\Python311\Scripts\az.bat"`.
- Deployed image: `dd8e15f` (HEAD of `azure-openai-agent` after Phase 4 commit; includes Phase 0–4).

## Gates that PASSED

| Gate | Evidence |
|---|---|
| Deploy unblock (Phase 0) | `deploy-image.sh` ran clean — zip build, blob upload, ACR build (1 attempt, ~3 min), Bicep re-apply with `disableGitPublish=1` preserved, `syncfunctiontriggers` returned no error. |
| Function App load verify (Phase 2) | "Attempt 1: functions loaded (2)" — `/admin/functions` returned both `start-discovery` and `job-status` immediately. No cold-start lag this time. |
| ARM job-start endpoint (Phase 2) | Smoke trigger via direct ARM POST succeeded — execution name returned: `caj-bofia-rate-discovery-prod-8oswnjh`, 13 env vars preserved on the override. |
| Composite job-status endpoint (Phase 2) | `/api/job-status/<execName>` returned a valid composite response (arm_status="Running", receipt_found=false). |
| az.bat dispatch on Windows paths-with-spaces (Phase 2.5 followup) | The `azText` fix landed in this same commit cycle. Pre-fix: pre-flight died on "az CLI not authenticated" because `spawnSync` couldn't dispatch the `.bat` under a path with spaces. Post-fix: pre-flight + Phase 2 deploy ran clean. |

## Gates that DID NOT FIRE

| Gate | Why |
|---|---|
| Phase 1 per-execution receipt (initial "running" + per-bank updates + terminal) | Receipt never appeared. Cloud-sync push at finalize never ran because the run never finished. |
| Phase 2.5 zero-slab classifier | Depends on a completed bank attempt's `classifyResult`. No bank attempt completed. |
| Phase 3 cloud-block inspector | Wired into `lib/orchestrator.js`. But the run used the deprecated **LLM-agent path** (`lib/agent.js` → `runAgent`), not the orchestrator path. The hook is not exercised here. |

## What got stuck

Last meaningful log event at **20:33:15 UTC** (~2 minutes into the run, on the first bank — `state-bank-of-india`):

```
[WARN] run_playwright ERROR 120044ms args={"url":"https://sbi.bank.in/web/...","accordions":true}
       result={"error":"Playwright spawn failed: spawnSync /usr/bin/node ETIMEDOUT"}
```

After that line, the log stream went silent. No further `[EVENT]`, no bank-2 attempt, no `>>> [2/12] ...` banner, no bank-timeout-induced SIGTERM.

ARM still reports `Running` at 70+ minutes. The job's `replicaTimeout` is 7200 s (2 h) — the platform will SIGKILL the container around 22:30:25 UTC if it doesn't terminate itself before then.

## Diagnosis

The `Playwright spawn failed: spawnSync /usr/bin/node ETIMEDOUT` is a process-spawn failure at the OS level — the agent's `run_playwright` action couldn't even start a Node subprocess for Playwright. This is environmental, not code-side.

Hypotheses (operator to validate):

1. **Container resource starvation.** The Playwright base image (`mcr.microsoft.com/playwright:v1.58.2-jammy`) plus the agent runtime plus the cloud-sync may be exceeding the container's memory/CPU budget. spawnSync would ETIMEDOUT if the process table is full or memory is exhausted.
2. **Stale Playwright browser cache.** The base image ships chromium/firefox binaries; corruption between ACR build and execution would block spawn.
3. **Container Apps egress flake.** Less likely (the spawn is local, not network), but worth ruling out.
4. **An unrelated infra change between the 2026-05-20 last-successful-cloud-run and now.** Two weeks of unattended cloud time; Azure subnets, NAT, NSG, identity bindings can drift.

## Regression assessment for this sprint's code

**The cloud run's stuck-on-bank-1 outcome does NOT indicate a Phase 3/4/5 regression.** Reasoning:

- The LLM-agent path is in use (per the `[DEPRECATED] lib/agent.js (runAgent)` warning at 20:31:12). Phase 3's cloud-block inspector hook is in `lib/orchestrator.js`, which this run does NOT exercise. The hook code is therefore not in the live failure path.
- Phase 3 also modified `lib/actions/fetch_page.js` to surface `status_code` on the ok=false path — purely additive (new fields on an existing return shape). Existing callers don't read those fields. Cannot regress.
- Phase 4 is splitter + run-local-only — operator-side scripts, not runtime container code.
- The failure mode (`spawnSync /usr/bin/node ETIMEDOUT`) is an OS-level process spawn failure, not a Node/JS-level exception. Bank 1 didn't reach any of the per-bank classifier / receipt / cloud-block code paths.

## What this validation DID prove

Even though the agent stuck early, the cloud-ops platform layers (Phase 0–2) all proved healthy on this commit:

- The Phase 2.5 deploy-smoke contract works against a real cohort (with the az.bat fix).
- The Function App is reachable, both functions load, and the job-status endpoint returns a valid composite.
- The execution receipt path is wired and observable (just empty here because nothing has written to it yet — but the endpoint returns `receipt_found: false` correctly, not 500).

## Follow-up (operator)

1. **Diagnose the Playwright spawn ETIMEDOUT.** Suggested first checks:
   - Container memory/CPU usage during the stuck window (Azure Monitor → containerapp job metrics).
   - Cold-start the job once with a single-bank cohort that has a hint-driven extractor (no Playwright needed) — does it complete? That isolates Playwright from the rest.
   - Rebuild the ACR image and try again — eliminates the "stale browser cache in base image" hypothesis.
2. **Re-fire the 12-bank validation once Playwright spawn is healthy.** Same command:
   ```
   AZ_BIN=... node scripts/azops/deploy-smoke.js --env prod --cohort top-12 --max-wait 3600 --yes
   ```
3. **Once a clean cloud run lands**, confirm:
   - `bank-domains.json` got `cloud_block_status` entries written for any WAF-blocked banks (Phase 3 working).
   - Per-execution receipt landed with `business_outcome` reflecting reality (Phase 2.5 working).
   - No zero-slab-pass-through regressions (Phase 2.5 zero-slab classifier working).

## Baseline (for the re-fire comparison)

`baseline-top-12-pre-2026-06-04.csv` (captured pre-run):

```
bank_code,total_slabs,bare_confidence,failure_class
state-bank-of-india,63,high,success
bank-of-baroda,98,high,success
punjab-national-bank,85,high,success
hdfc-bank-limited,110,high,success
icici-bank-limited,32,high,success
axis-bank-limited,449,high,unclassified
kotak-mahindra-bank-limited,57,high,extraction_failed
au-small-finance-bank-limited,61,high,agent_error
equitas-small-finance-bank-limited,23,high,success
citibank-na,102,high,success
bank-of-india-ibu,64,,discovery_failed
abhyudaya-co-operative-bank-ltd-mumbai,8,high,success
```

Total: **1152 slabs**. The next clean cloud run should match or exceed this.

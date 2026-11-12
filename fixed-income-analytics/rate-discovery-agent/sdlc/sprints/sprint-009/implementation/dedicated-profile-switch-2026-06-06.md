# Sprint 009 — temporary switch to Container Apps Dedicated profile (D4)

**Date:** 2026-06-06
**Driver:** Two Consumption-profile cohort runs (`5kz1vm8`, `fpecv10`) silently
froze at the kernel level. Phase 9.7 watchdog can't detect frozen-event-loop
cases. Operator-approved hypothesis: kernel-level isolation via Dedicated
profile eliminates the freeze. Sub-option 2c (apply temporarily, validate,
revert) chosen 2026-06-06.

## Changes

### `iac/modules/container-apps-env.bicep`

Added a `d4-jobs` profile to the `workloadProfiles` list (alongside the
existing `Consumption` profile):

```bicep
{
  name: 'd4-jobs'
  workloadProfileType: 'D4'
  minimumCount: 1
  maximumCount: 1
}
```

D4 = 4 vCPU / 16 GiB per node, single dedicated VM.

### `iac/modules/container-apps-job.bicep`

Switched the job's `workloadProfileName` from `'Consumption'` to `'d4-jobs'`.
Per-replica CPU/memory unchanged (2.0 vCPU / 4 GiB) — D4 host has room.

## Deployment

```
$env:AZ_BIN = "C:\Users\Samir Joshi\AppData\Roaming\Python\Python311\Scripts\az.bat"
bash iac/deploy-image.sh
```

That builds a fresh ACR image at the current git SHA and re-applies Bicep
(which provisions the D4 profile and switches the job).

> **Note:** the application code hasn't changed since image `f38f0a0`. The
> deploy is purely to thread the new image tag through Bicep so ARM
> notices the workload-profile change. (A `--skip-image-rebuild` shortcut
> doesn't exist in the script; rebuilding is the cleaner gate.)

## Cost implication (active immediately upon deploy)

- D4 dedicated node: ~$0.20/hour = **~$144/month** baseline, regardless of
  execution activity.
- Compare to Consumption: ~$0.50 per cohort run, $0 at idle.
- Continuous cost runs from deploy time until revert is applied.

## Revert playbook (apply after Sprint 009 closes)

When the operator decides to revert to Consumption:

1. Revert the two Bicep changes:
   - In `iac/modules/container-apps-job.bicep`, change `workloadProfileName`
     back to `'Consumption'`.
   - In `iac/modules/container-apps-env.bicep`, remove the `d4-jobs` entry
     from `workloadProfiles` (or leave it — unused dedicated profiles also
     bill, so remove it).
2. Re-deploy via `bash iac/deploy-image.sh`.
3. The dedicated D4 node deprovisions; billing stops.

Revert as a single commit + deploy keeps the change atomic and traceable.

## Validation plan (operator-driven, NOT in this commit)

After deploy lands and the operator chooses to fire:

1. Fire the resume cohort: `pm-refresh-2026-q2-resume.json` (198 banks).
2. Expected: no silent freeze; cohort completes in ~5-6h end-to-end.
3. If hang recurs: the Dedicated hypothesis was wrong; investigate further
   (chunking, Sprint 010 candidate).
4. If clean: revert per playbook above.

## Files touched in this commit

- `iac/modules/container-apps-env.bicep` (added profile)
- `iac/modules/container-apps-job.bicep` (switched profile)
- `sdlc/sprints/sprint-009/implementation/dedicated-profile-switch-2026-06-06.md` (this file)

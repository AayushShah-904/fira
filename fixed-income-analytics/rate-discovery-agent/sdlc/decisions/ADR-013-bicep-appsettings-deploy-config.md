# ADR-013: Deploy-time function config flows through Bicep parameters

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | All deploy-time function config (initially `WEBSITE_RUN_FROM_PACKAGE`; extensible to any other replace-not-merge appSetting) MUST be declared in `iac/modules/function-app.bicep` and threaded as a Bicep parameter from `iac/deploy-image.sh`. Bicep does not "see through" to deploy state, so the parameter is re-asserted on every apply. |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-13 |
| Date decided | 2026-05-13 |
| Sprint | 002 (addendum) |
| Supersedes | — |

## Context

Sprint 002 cloud DCCB rerun (#12) was blocked when `func-bofia-trigger-prod` returned 404 on every `/api/start-discovery` call. Diagnosis:

1. The function host's `/admin/host/status` reported `state: Running`, but `/admin/functions` returned `[]` — host healthy, zero functions registered.
2. `WEBSITE_RUN_FROM_PACKAGE` (the env var that tells the Linux Consumption + identity-based-storage host *where* its code lives) was empty.
3. Sprint 001 deployed function code via a manual two-step that was never captured in IaC: upload `functions.zip` to `stbofiafunc<envName>01/deploy/`, then set `WEBSITE_RUN_FROM_PACKAGE` to the blob URL with `az webapp config appsettings set`. That state survived Sprint 001 because no one re-applied Bicep afterwards.
4. Today's Sprint 002 deploy ran `iac/deploy-image.sh`, which calls `az deployment sub create` to push the new Container image tag. The Bicep `Microsoft.Web/sites` resource declares `appSettings` as an inline 11-element array. **ARM PUT on appSettings is replace-not-merge** — the re-apply silently overwrote the deploy pointer that had been set out-of-band. Function host restarted under empty `WEBSITE_RUN_FROM_PACKAGE`, registered zero functions, started serving 404s.

This is the exact same class of bug ADR-012 addressed for per-bank artifacts (writers silently dropping operator-set fields), but at the IaC layer: Bicep silently dropped operator-set appSettings.

The pattern is generalizable: **any Azure resource whose configuration is a "complete spec" array (appSettings, connection strings, role assignments inline on the resource, etc.) loses anything not declared in Bicep on every re-apply.** Other deploy-time settings the team is likely to add — Application Insights instrumentation key from a separate KV lookup, custom env vars for ad-hoc feature flags, post-deploy-tuned settings — would hit the same trap.

Sprint 001's manual two-step worked but was undocumented; nobody knew the Bicep re-apply was a destructive operation on the function's deploy pointer. The failure mode is silent (`az deployment` succeeds; function goes to 0 functions until the next operator looks at the deploy URL).

## Spec being decided

### Part A — Bicep parameter for deploy-time settings

`iac/modules/function-app.bicep` declares a parameter for every deploy-time setting that lives on the resource but is computed at deploy time:

```bicep
@description('Deploy-from-URL blob URL for the function code package.')
param runFromPackageUrl string = ''
```

Default empty string so first-apply (when the storage account does not yet exist) succeeds; the function will not load code until `deploy-image.sh` populates the URL on the next apply.

`appSettings` is built via `concat()` so the parameter-driven settings are appended conditionally on non-empty values:

```bicep
appSettings: concat(
  [ /* ... 11 fixed settings ... */ ],
  empty(runFromPackageUrl) ? [] : [
    { name: 'WEBSITE_RUN_FROM_PACKAGE', value: runFromPackageUrl }
  ]
)
```

`iac/main.bicep` adds the same parameter at the top level and threads it through to the `functionApp` module. The Bicep parameters file does not specify a value — the deploy script computes it.

### Part B — Deploy script computes and passes the value

`iac/deploy-image.sh` rebuilds and re-uploads `functions.zip` on every run (using a deterministic blob name `func-deploy-<git-sha>.zip`), then passes the resulting URL to Bicep:

```bash
ZIP_URL="https://${FUNCTIONS_STORAGE_ACCOUNT}.blob.core.windows.net/deploy/func-deploy-${GIT_SHA}.zip"
# ... upload zip ...
az deployment sub create \
  --parameters runFromPackageUrl="$ZIP_URL" imageTag="$GIT_SHA" ...
```

This makes the deploy single-step atomic again: a Bicep re-apply *always* includes both the image tag and the function deploy URL, so neither can be silently wiped by the other's plumbing.

### Part C — Post-deploy verification

The deploy script polls `/admin/functions` for up to 5 minutes after the Bicep apply. If the host doesn't load both functions, the script exits non-zero. Future regressions where deploy "succeeds" but the function host is broken will fail loudly in the operator's terminal instead of being discovered later when someone tries to use the trigger.

Toggle with `SKIP_FUNCTION_VERIFY=1` for the rare case where the operator deliberately wants to skip the verification step (e.g., redeploying when the function app is intentionally stopped).

### Part D — The zip itself uses POSIX path entries

Sprint 002's first-attempt fix (rebuild zip via PowerShell `Compress-Archive`) reproduced an adjacent failure mode: Windows PowerShell 5.1's `Compress-Archive` emits zip entries with **backslash** path separators. The Linux Functions host treats `start-discovery\index.js` as a literal-name file in the root, not a directory hierarchy — so the package extracts to a flat directory of 6000 mis-named files and the host registers zero functions.

`iac/build-functions-zip.py` uses Python's `zipfile` (POSIX separators per the ZIP spec) and verifies key entries exist post-build. A Node test (`tests/iac/build-functions-zip.test.js`) pins the contract: zero backslash entries and all required entries present.

## Consequences

**Positive:**

- A Bicep re-apply (for any reason — new image, kill-switch flip, AOAI deployment rename) can no longer silently break the function trigger.
- Operators see deploy failures in the terminal at deploy time, not days later when they try to trigger a run.
- The pattern generalizes: future deploy-time settings get the same treatment without re-litigating.

**Negative:**

- `deploy-image.sh` now does more work per run (zip build + upload). On modern hardware + reasonable internet, this is <30s; on slow links it's <2 min. Acceptable.
- First-apply on a brand-new environment requires two passes (apply with empty `runFromPackageUrl` → storage account exists → re-run `deploy-image.sh` to populate). Documented in `iac/main.bicep` header comment.

**Operational:**

- The `deploy` container in the functions storage account now accumulates one zip per git SHA. A future sprint should add a lifecycle rule (e.g., delete blobs older than 30 days, keep the 5 most recent). Tracked in Sprint 002 retro carryover.
- Existing zips (`func-deploy-20260508-*.zip` etc.) are timestamp-named. The new naming is git-SHA-based. Both can coexist; the timestamp-named zips become unreferenced after the next deploy and can be cleaned manually.

## Alternatives considered

- **Bicep stops managing appSettings entirely** (delegates to a post-deploy `az webapp config appsettings set` script). Cleaner separation but more script surface; loses Bicep's drift detection for the settings that *are* known at template time. Rejected.
- **Use `Microsoft.Web/sites/config@... type=appsettings` as a separate resource.** Same replace-not-merge behavior; doesn't help. Rejected.
- **Hand-edit Bicep to include the latest known URL.** Brittle; the URL changes on every deploy. Rejected.

## Rollout

The change set is additive — first deploy after merge will both (a) upload a new git-SHA-named zip and (b) re-apply Bicep with the URL. Existing `WEBSITE_RUN_FROM_PACKAGE` (manually set during Sprint 002 incident response) gets overwritten with the new URL on the next deploy, which is the correct end state.

No data migration needed; no operator action needed beyond running `iac/deploy-image.sh` once after this lands.

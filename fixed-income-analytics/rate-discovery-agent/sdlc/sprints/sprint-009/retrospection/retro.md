# Sprint 009 — Retrospection

**Sprint:** 009
**Branch:** `azure-openai-agent`
**Opened:** 2026-06-02
**Closed (code complete):** 2026-06-04
**Scope:** Cloud deployment + observability + split-execution & merge for WAF-blocked banks.
**Outcome:** **Code complete on all phases. Real-cohort validation (Phase 6 step 7) is the only operator-pending gate.**

## What shipped, by phase

| Phase | Status | Commit(s) | Headline |
|---|---|---|---|
| **0 — Deploy unblock + baseline** | ✓ | `e35b42c` | Sprint-004 Bug A fix; Bicep-parameterised kill-switch; one-bank smoke green. |
| **1 — Observability hardening** | ✓ | `f03a0f2`, `939fe8c`, `d0bfb7b`, `bd9b975` | Per-execution receipt + truthful exit; run beacon + drift + `cloud:status`; structured per-bank events; single-query KQL reconciliation. |
| **2 — Function App salvage** | ✓ | `674de46`, `0410f4d` | Composite `/api/job-status/{executionId}` endpoint; 2026-06-03 incident hotfix (`WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID`); Function App diagnostics shipped to Log Analytics. |
| **2.5 — Operational trust (inserted from handoff doc)** | ✓ | `11f580f`, `06f69a3`, `7776a33`, `ae031ca`, `1ab7b2c` | 6 items: receipt-blob colon-form fix; zero-slab exit-0 classification; durable + early receipts (loud-log on terminal upload failure); Bicep diagnostic categories reconciled; `scripts/azops/deploy-smoke.js` (`npm run cloud:deploy-smoke`); operator runbook. |
| **3 — Cloud-block detection + registry** | ✓ | `9c6c681` | `lib/cloud-block/{observer,inspector,registry-updater}.js`; orchestrator wires `inspectFetchForCloudBlock` after every fetchPage; `bank-domains.json#cloud_block_status` auto-populates with 30-day decay; safe-write source `'cloud-block-detector'`. Also closed pre-existing fetch_html WAF-classifier test failure. |
| **4 — Split-execution orchestration** | ✓ | `dd8e15f` | `lib/cohort/splitter.js` pure function; `scripts/cohort/split.js` + `scripts/cohort/run-local-only.js` CLIs; `data/peer-runs/<cohort>.json` beacon hand-off contract. |
| **5 — Merge mechanism** | ✓ | (this autonomous run) | `lib/merge/merge-bank.js` (pure) + `lib/merge/run-merger.js` (runner) + `scripts/merge/merge-runs.js` (CLI). 44 fixture tests covering every conflict rule + ADR-012 curated-protection + idempotency. New `'merger'` source on safe-write. Also includes the `az.bat` dispatch fix for Windows paths-with-spaces. |
| **6 — E2E split-cohort validation** | ✓ (synthetic) / ⏸ (real cohort) | (this run) | `scripts/e2e/synth-validate.js` proves the full chain on fixture data — 6 anti-regression assertions pass. Real 500-bank cohort handed off to operator via `container-mgmt/doc/runbook-split-cohort-500bank.md`. |
| **7 — Retro** | ✓ | this file | — |

## Headline numbers

- **Commits this sprint:** 14 (e35b42c → this commit), 100% pushed to origin per phase milestone.
- **Tests added:** ~250 across the sprint (cloud-block, splitter, merger, e2e harness, plus extraction-inspector and deploy-smoke from Phase 2.5).
- **Full suite:** 1377 pass / 0 fail / 44 skipped — up from 1247 / 1 pre-existing fail at sprint start.
- **Pre-existing failures closed:** 1 (fetch_html.test.js Cloudflare-classifier; Phase 3 housekeeping aligned the fixture to the post-sprint-7 tightened regex).

## What went well

1. **Phase-by-phase commit + push discipline.** Each phase shipped as one commit, design doc + impl note co-located, pushed to origin at milestones. Made resume-from-snapshot trivial across sessions.
2. **Phase 1 observability moving ahead of Phase 4 was correct.** The operator's sprint-open decision to do this paid off: the 2026-06-03 incident on `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID` would have been multi-hour-unobservable without the diagnostic settings shipped in Phase 1.7.
3. **Handoff doc → Phase 2.5 path.** Receiving a write-up from another agent and folding its 6 items into a discrete sub-phase (rather than reopening Phases 0–2) kept the original 7-phase plan intact while addressing real operational gaps.
4. **`safeWriteArtifact` already had the API surface** (kinds + sources) that Phase 3 and Phase 5 needed. Just adding two source values (`'cloud-block-detector'`, `'merger'`) was the whole touch. ADR-012's design paid forward.
5. **Pure-function + thin-CLI separation.** Every phase's logic lives in `lib/<area>/<name>.js` (testable, importable) with `scripts/<area>/<name>.js` as the thin wrapper. Unit tests cover the lib; CLI is smoke-tested manually. Made the merger's 33 + 11 fixture tests trivial to write because no spawn/HTTP infrastructure to mock.

## What got bumpy

1. **Events go to stderr, not disk.** Phase 3 design assumed on-disk JSONL event log (Option III in the design doc). Discovered mid-implementation that `lib/events.js` writes to stderr only. Pivoted to per-bank sidecar files written inline by `lib/cloud-block/observer.js`. Same end-to-end semantics, different intermediate format. Lesson: when you reference an artifact, **verify the artifact's actual shape on disk** during design, don't assume from naming.
2. **`az.bat` dispatch under Windows paths-with-spaces.** Sprint 002's `start-cohort.js` works in the operator's environment because `az.bat` is on PATH. In a Bash sandbox without `az.bat` on PATH (only the Python-script shim `az`), `spawnSync('az.bat', ...)` returns EINVAL. Required a one-line fix to `deploy-smoke.js`'s `azText` helper. Operator's day-to-day environment is unaffected; the fix only matters when running from environments without `az.bat` on PATH.
3. **The 12-bank cloud validation stuck on bank 1.** Operator requested mid-sprint validation between Phase 4 and 5. Platform-layer gates all passed; bank-extraction stuck on Playwright spawn ETIMEDOUT. **Sprint-009 code was never exercised** in the live failure path (the deprecated LLM-agent codepath is in use, not the orchestrator hook Phase 3 wires into). Real validation remains pending operator diagnosis of the Playwright infrastructure issue.

## Decisions I made autonomously that the operator should know about

Operator delegated Phases 4–7 decisions 2026-06-04. Recorded inline in
each phase's design + implementation note. Highlights:

### Phase 4 splitter

- `data/cohorts/<cohort>-cloud.json` + `<cohort>-local.json` co-located with the input cohort. Splitter overwrites them each run (they're derived).
- No-block-record / blocked=false / stale block / low-confidence block → route cloud. medium/high fresh block → route local.
- Single peer-run beacon per cohort at `data/peer-runs/<cohort>.json` (vs per-side beacons).
- Empty local-cohort short-circuits `run-local-only.js` with exit 3 (no-op success).

### Phase 5 merger

- **Slab tiebreak: local wins.** Operator's "richer-set-wins for slab arrays" rule was silent on equal-length. Picked local because local artifacts have higher operator-curation likelihood.
- **Identity-field mismatch throws** (vs silently picking one). Cross-bank reads or cohort-construction bugs should surface, not silently corrupt data.
- **Summary file is NOT merged.** Summaries are per-run telemetry, not canonical data. Per-run summary files at `output/runs/<label>/<bank>.summary.json` are preserved untouched.
- **CLI `--dry-run` proceeds but logs a TODO.** A clean dry-run requires threading a writer injection into `runMerger`; deferred. The flag is currently informational.

### Phase 6 cohort run

- **Did NOT autonomously fire the real 500-bank cohort.** Blast radius (~$100–500 AOAI, 6–12 h wall time, partial-failure judgment) too high for unsupervised execution. Built the synthetic harness + operator runbook instead.
- **DID fire the operator-requested 12-bank cohort.** Got stuck on a pre-existing infrastructure issue (Playwright spawn ETIMEDOUT). Documented in `cloud-validation-12-bank-2026-06-04.md`.

### Other

- **Renamed `scripts/analysis/test-az-spawn.js` → `check-az-spawn.js`** because Node's test runner auto-discovers `test-*.js` files and would treat the diagnostic as a (failing) test.
- **Added a `safe-write-exempt:` comment to `scripts/e2e/synth-validate.js`** for its tmp-fixture writes (ADR-012's "tests / fixtures use fs.writeFileSync legitimately" carve-out).

## Open follow-ups for the operator

These are documented in their respective phase impl notes; consolidated here so they don't get lost:

1. **Real 500-bank cohort validation** (Phase 6 step 7). Runbook at `container-mgmt/doc/runbook-split-cohort-500bank.md`.
2. **Re-fire the 12-bank validation after Playwright spawn ETIMEDOUT is diagnosed**. The deployed image is at `dd8e15f` so any code-correctness concerns are settled by the test suite; the open gate is environmental.
3. **Cloud-side beacon patch via deploy-smoke.js** (Phase 5 follow-up). Currently the operator passes `--cloud-run-label` to merge-runs.js; auto-patching from deploy-smoke would close that loop.
4. **`--dry-run` actually inhibits writes in merge-runs.js** (Phase 5 follow-up). Today it logs a TODO and proceeds.
5. **`lib/manifest/per-bank-manifest.js` wire-up into production** (Sprint 006 Step 4 leftover). Orthogonal to Sprint 009 but still loose ends.
6. **Three-way merge dedup of `source_runs[]` across re-runs** (Phase 5 follow-up). The merger doesn't currently de-dup when re-merging; provenance grows linearly. Not a problem at scale but worth tidying.

## Sprint exit criteria — final check

From the scope doc:

| Criterion | Status |
|---|---|
| Cloud loop on HEAD (deployed image SHA == git HEAD on smoke commit) | ✓ proved during 12-bank validation: image `dd8e15f` = `git rev-parse HEAD` at the time |
| Observability proves blob writes (one KQL query for "did rates for bank X land?") | ✓ Phase 1.4 reconciliation KQL |
| Bicep re-apply doesn't flip kill-switch or wipe WEBSITE_RUN_FROM_PACKAGE | ✓ verified during 12-bank deploy — `disableGitPublish: 1 (source: preserved-from-deployed-job)` |
| Function App green (`/admin/functions` lists start-discovery; POST returns execution-id) | ✓ verified during 12-bank deploy |
| Cloud-block registry self-populates | ⏸ deferred — registry-updater unit tests pass; live cohort validation pending Playwright fix |
| Split + merge reproducible | ✓ synthetic E2E proves split → merge is deterministic; idempotency test in merge-bank suite |
| Pack quality unchanged or better | ⏸ deferred — pack rebuild after the 500-bank cohort |

**5/7 fully exited; 2 pending live-cohort validation gated on an
external Playwright infrastructure issue.** The code is operationally
trusted; the real-data verification is the operator's call when ready.

---

# Sprint 009 — Addendum (close-out, 2026-06-06)

The 2026-06-04 retro above closed on "code complete, real-cohort validation pending." Sprint 009 then ran two extra days of operational work to push that validation through. This section captures what landed on 2026-06-05 and 2026-06-06.

## What shipped in the close-out window

| Phase | Status | Commit(s) | Headline |
|---|---|---|---|
| **9.1 — SBI playwright_disabled regression** | ✓ | (squashed into phase-9-cohort-runtime-fixes) | Agent-loop guard's `consecutiveErrors++` no longer fires on the routing-signal `"playwright_disabled":true`. |
| **9.2 — zero-slab misclassified as failure** | ✓ | same | `lib/extraction-inspector.js` gets `SKIP_OUTPUT_METHODS` covering `registry_skip` and the curated extraction methods. Receipt accounting no longer counts curated-skipped banks as failures. |
| **9.3 — terminal discovery statuses** | ✓ | same | `tier-router.js` adds `foreign_currency_not_inr` to `TERMINAL_DISCOVERY_STATUSES` so the agent stops re-attempting impossible discovery. |
| **9.4 — TLS skip-verify for self-signed co-op sites** | ✓ | same | `tools.js` + `scripts/fetch_rates_playwright.js` honour `tls_skip_verify: true` on `bank-domains.json` entries — used for Arunachal-Pradesh-RB and Ahmedabad-Mercantile-CB. |
| **9.5 — Curated NRI variant data loss in blob** | ✓ | (bootstrap script + operator-run upload) | `scripts/azops/bootstrap-curated-rate-files.js` + a one-shot operator upload restored 86 NRI variant files (Axis, Kotak, CSB, DCB families) that were stripped on a prior unsafe-overwrite pass. |
| **9.6 — Cohort hang on Consumption profile** | ✓ (validated; root cause deferred) | `4ac9de7` (D4 apply), `18995c9` (revert) | D4 Dedicated profile cleared cohort `9zulerb` (198 banks, 3h57m, no freeze). Validates the kernel-isolation hypothesis. Bicep reverted to Consumption immediately on cohort completion (Option 2c). |
| **9.7 — Cohort-level no-progress watchdog** | ✓ (mitigation) | `f38f0a0` | `run-batch.js` gains a 25-minute no-progress watchdog that emits a structured `cohort_no_progress` event, flushes a `aborted_no_progress` receipt, and exits with code 7. Note: the watchdog is a *mitigation* and doesn't fire on full event-loop freezes (which is what happens on the Consumption profile — see addendum's lessons-learned). |

## Real-cohort validation — final headline

Three executions across two profiles cover 512 of the 513 `pm-refresh-2026-q2` banks (bank #315 was the freeze trigger and was intentionally skipped by the resume cohort).

- **5kz1vm8** (Consumption, 2026-06-05): 314 banks processed, then froze at the kernel layer.
- **fpecv10** (Consumption, resume #1, 2026-06-05): 28 banks processed, then froze at the kernel layer.
- **9zulerb** (Dedicated D4, 2026-06-06): **198 / 198 banks processed cleanly in 3h57m**, no freeze.

Detailed outcome and pack comparison: `sdlc/sprints/sprint-009/implementation/cohort-9zulerb-outcome-and-pack-comparison-2026-06-06.md`.

## Sprint exit criteria — re-checked after close-out

| Criterion | 06-04 status | 06-06 final |
|---|---|---|
| Cloud loop on HEAD | ✓ | ✓ |
| Observability proves blob writes | ✓ | ✓ |
| Bicep re-apply doesn't flip kill-switch | ✓ | ✓ |
| Function App green | ✓ | ✓ |
| Cloud-block registry self-populates | ⏸ | ✓ (proven in `9zulerb` run — registry rows landed for the WAF-blocked banks) |
| Split + merge reproducible | ✓ | ✓ |
| **Pack quality unchanged or better** | ⏸ | ❌ **regressed** — 8,369 → 6,390 slabs (−24%); 428 → 341 banks-with-any-variant. See § 3 of the outcome-and-comparison doc. |

**Final score: 6 / 7 exited. The pack-quality criterion is a confirmed regression, not a deferral.** The freeze fix landed; the content refresh didn't, because re-extraction over multiple top banks (Axis, BoB, Bandhan, Union, ICICI, …) produced narrower slab sets than before — most likely via `partial_silent` short-circuits on multi-tab pages stripping NRI/FCNR variants. Sprint 010 owns the recovery.

## What worked in close-out

- **Honest failure diagnosis ahead of action.** Both Consumption-profile freezes were investigated (not papered over) before choosing the D4 path. The "watchdog can't fire when the event loop is dead" limitation was *documented in the design doc* before being hit operationally, so the operator hadn't been led to expect it to save the resume cohort.
- **Option 2c (temporary D4, revert immediately).** The validation cost ~\$1.50 of D4 baseline rather than a month of \$144 — apply-and-revert kept the bill bounded to the validation window.
- **Per-bank receipt accounting fix (Phase 9.2).** Surfaced as a 10/1 vs would-have-been 5/6 swing in the fix-validate cohort. Real, measurable correctness improvement.
- **`bootstrap-curated-rate-files.js` as one-shot operator tool.** Restored 86 missing variant files in a single CLI run instead of a manual-upload campaign.

## What hurt in close-out (lessons)

- **Re-extraction without a coverage gate.** The pm-refresh-2026-q2 cohort was a refresh, but no automated check compared post-run slab counts to baseline before pack-build. A single pre-publish gate ("did total_slabs drop > X% on banks that previously had high confidence?") would have caught the 24% regression before any of it touched the dist pack.
- **Watchdog limitation became operational before it was tested.** Phase 9.7 design doc called out that the no-progress watchdog runs on the Node event loop and won't fire if the loop itself is frozen — and that's exactly what happened on the resume cohort. The fix (Dedicated profile) was the right next step, but it would have been cheaper to have known the watchdog wouldn't catch this *before* designing it as the primary mitigation.
- **Sprint 009 grew well past its original 7-phase scope.** Phases 9.1–9.7 added two days of operational work after "code complete" — partly because the original scope ducked the cohort-runtime question, and partly because each new freeze surfaced another sub-issue. Better to scope a single follow-on sprint for "make a 500-bank cohort actually run" than to let one sprint expand.
- **Receipt-blob naming with colons trips Windows / shell path handling.** Hit twice during close-out (downloads silently fail without quoting). Worth migrating to forward-slash blob paths, even if the existing colon convention is grandfathered for compatibility.

## Sprint 010 — candidate backlog

In priority order, smallest first:

1. **Pack-quality regression recovery.** Re-author the 18 partial_silent banks (ICICI, AXIS, BoB, BoI, Bandhan, Yes, Kotak, Barclays, etc.) using the bulk-author `--from-report` workflow. Target: restore the 8,369 baseline before any new cohort runs.
2. **Pre-publish slab-coverage gate.** Block `pack/build-pack.js` from overwriting `dist/rates-pack.json` if `total_slabs` drops > 10% vs the previous build, or if any HIGH-confidence bank loses all slabs. Surface in `pack/dist/REPORT.md`.
3. **Banswara + Barmer CCB 3-second crash.** Repro locally and identify the pre-flight failure. Both are Rajasthan CCBs — likely a config-load / slug-lookup pre-flight check that crashes when both happen on the same shard.
4. **Bank #315 single-bank smoke.** The cohort freeze bank was never processed. Confirm whether it's actually a runaway bank (which would justify a `tier-router` block) or just bad luck on cohort timing.
5. **Cohort-watchdog v2 — out-of-process heartbeat.** The Node-side watchdog can't survive an event-loop freeze. A second container or a sidecar process polling the cohort's progress blob would catch the case Phase 9.7 doesn't.
6. **Consumption-profile root cause.** Run a 500-bank cohort on Consumption with the v2 watchdog and `strace`-style telemetry to confirm whether it's PID/fd pressure, SNAT exhaustion, or a Kubernetes-side container kill. Outcome decides whether D4 needs to be the permanent profile (~\$144/mo baseline) or whether Consumption is salvageable.
7. **Receipt-blob path migration off colons.** Either escape during download or switch to forward-slash paths. Quality-of-life, not blocking.
8. **`lib/manifest/per-bank-manifest.js` wire-up** (carried over from Sprint 006 Step 4 and the original Sprint 009 retro). Increasingly needed as the post-run diff above showed.

Items 1 + 2 + 3 are the minimum viable Sprint 010 — without them, no fresh pack ships. Items 4–8 are scope to add if the slot is open.

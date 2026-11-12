# Sprint 004 — Cloud-scale rate discovery + robust deployment

**Sprint window:** 2026-05-18 → 2026-06-01 (two weeks; one operator + Claude)
**Branch:** `azure-openai-agent` (continues from Sprint 003; rebase / merge decision deferred to mid-sprint)
**Status:** Plan drafted 2026-05-18.

## Goal in one sentence

An operator types one command, watches real-time blob telemetry, and produces a trustworthy 200-bank rates pack at the end — with Sprint-3's anti-fabrication guarantees intact and provably stronger after exposure to a larger cohort.

## Why Sprint 004 looks like this

Sprint 003 closed with the orchestrator path producing trustworthy slabs on a 5-bank smoke (see `../../sprint-003/retrospection/retro.md`). Three risks remain before this work is production-grade across the 1,900-bank Indian banking population:

1. **Generalisability is unproven.** The 5-bank smoke is too narrow to catch the next round of pattern variants. A4 (multi-tier section-header propagation, AU SFB-style stacked deposit tables) is the known deferred issue, but we expect more pattern classes when we widen the sample. Sprint 4 must establish what "broad enough" coverage looks like.

2. **Cloud deployment is fragile.** ACR image build is a manual `iac/deploy-image.sh` walk; operator-triggering a cohort requires either an HTTP function or a manual `az containerapp job start`; blob upload happens once at batch end so a mid-run crash loses every bank processed since the last upload. None of this is ready for an unattended 200-bank run.

3. **No "top 200" cohort exists as a tangible artifact.** It's been a strategic reference. Sprint 4 promotes it to a versioned data file we can actually run against.

## Three tracks

Each track produces design docs in `design/`, implementation tracking in `implementation/`, and feeds into the retrospection at sprint close. Tracks work in parallel — they touch disjoint files.

### Track A — Solidify + generalise Sprint 3

Operator constraint (2026-05-18): do **not** jump straight from the 5-bank smoke to the 50-bank smoke. Use a 12-bank category-spanning sample drawn from the top-200 priority categories — PSB / PVB / SFB / FB / IBU / SUCB — as the first rung, local AND cloud. Fail small before failing larger. Only after the 12-bank cloud run is green do we ramp to 50.

Important: the Sprint 3 "Phase B 12-bank set" (all DCCBs) is preserved as a historical artifact at `data/cohorts/phase-b-12-historical.json` for the 2026-05-18 backward comparison (see `implementation/dccb-12-bank-historical-comparison-2026-05-18.md`), but it is NOT the Sprint 4 smoke target — DCCB is second-from-last in the top-200 priority ordering and would not validate the cohorts we actually care about. The Sprint 4 smoke target is `data/cohorts/top-12.json`:

| # | Bank | Category |
|---|---|---|
| 1 | State Bank of India | PSB |
| 2 | Bank of Baroda | PSB |
| 3 | Punjab National Bank | PSB (PNB; known existing-vs-revised W.E.F. layout class) |
| 4 | HDFC Bank Limited | PVB |
| 5 | ICICI Bank Limited | PVB |
| 6 | Axis Bank Limited | PVB |
| 7 | Kotak Mahindra Bank Limited | PVB |
| 8 | AU Small Finance Bank Limited | SFB (A4 stacked-tier candidate) |
| 9 | Equitas Small Finance Bank Limited | SFB |
| 10 | Citibank N.A. | FB |
| 11 | Bank of India IBU | IBU |
| 12 | Abhyudaya Co-operative Bank Ltd., Mumbai | SUCB |

5 of these (SBI, HDFC, AU SFB, BOI-IBU, Abhyudaya) are in our Sprint 3 5-bank smoke and have a known baseline. The other 7 are new category-spanning exposure. Payment Banks are deliberately excluded — regulation prohibits them from holding fixed deposits.

Rung structure:

| Rung | Cohort | Where | Purpose |
|---|---|---|---|
| 1 | 5-bank (Sprint-3 smoke) | local | baseline, already passed |
| 2 | 12-bank DCCB (`phase-b-12.json`) | local | confirm A4 doesn't regress Sprint-3 ground truth |
| 3 | 12-bank DCCB | **cloud** | first end-to-end cloud validation via Track B's `start-cohort.js` |
| 4 | 50-bank category-spanning | local | surface anomalies across categories |
| 5 | 50-bank category-spanning | **cloud** | optional gate before Track C's 200 |
| 6 | 200-bank top-tier | cloud (Track C) | production target |

| Sub-item | Output |
|---|---|
| A4 design | `design/tier-header-propagation.md` |
| A4 implementation | `lib/actions/_cheerio_tables.js`, `lib/actions/extract_html_table.js`, tests |
| 12-bank top-200-priority cohort file | `data/cohorts/top-12.json` |
| 12-bank DCCB historical comparison (one-time backward look) | `implementation/dccb-12-bank-historical-comparison-2026-05-18.md` + `data/cohorts/phase-b-12-historical.json` |
| 12-bank local smoke (rung 2) | `implementation/cohort-smoke-12-local-2026-05-XX.md` |
| 12-bank cloud smoke (rung 3) | `implementation/cohort-smoke-12-cloud-2026-05-XX.md` |
| 50-bank cohort design (after rung 3 green) | `design/cohort-smoke-50-categories.md` |
| 50-bank local smoke (rung 4) | `implementation/cohort-smoke-50-local-2026-05-XX.md` |
| 50-bank cloud smoke (rung 5) | `implementation/cohort-smoke-50-cloud-2026-05-XX.md` |
| Newly-surfaced anomalies (A5+) | `implementation/slab-quality-anomalies-2026-05-XX.md` (numbering continues from A4) |

**Per-rung acceptance:**
- **Rung 2** (12-bank top-12 local): no regression for the 5 banks that overlap the Sprint 3 smoke (SBI / HDFC / AU SFB / BOI-IBU / Abhyudaya — each must produce ≥ the previous post-A1+A2+A3 slab count); the 7 new banks must each produce ≥ 5 trustworthy slabs OR have a captured anomaly note. A4-affected banks (AU SFB; possibly PSB bulk-tier pages) extract with correct tier labels under `RDA_TIER_AWARE_DEDUP=1`.
- **Rung 3** (12-bank top-12 cloud): same outcomes as rung 2 in cloud. Per-bank blob upload (Track B / B2) lands all 12 banks durable. `node scripts/azops/start-cohort.js --cohort top-12 --env prod` returns 0. Operator runbook validated by walking it from a fresh laptop.
- **Rungs 4-5** (50-bank): the existing acceptance — ≥ 5 trustworthy slabs for ≥ 80 % of banks (40 / 50); AU-style tier-stacked layout extracts correctly with tier labels; all newly-surfaced anomaly classes either fixed in-sprint or have a written follow-up doc with a reproduction command.

**Stop conditions specific to Track A:**
- If rung 2 surfaces a regression vs Sprint 2/3 baseline, fix in-sprint or revert A4 before rung 3 — the 12-bank DCCB set is small enough that a single-bank regression is investigable.
- If rung 3 (cloud) fails for any reason that's not anomaly-class growth (e.g., infra / Track B bug), pause Track A and circle back to Track B before consuming any more cloud budget on rungs 4-5.

### Track B — Robust deployment + ops

Scope clarified 2026-05-18 with operator. Focused on the three pain points:

1. **Operator-initiated cloud trigger** via a single command, with live progress streaming by default and a `--detach` flag for fire-and-forget.
2. **Smooth ACR image upload** — the existing manual `iac/deploy-image.sh` walk has needed manual retries; add automated retry + tag discipline so the operator never re-runs by hand.
3. **Crash-safe per-bank blob upload** — push rates + trace + summary + per-bank registry fragment after each bank, so a mid-run crash leaves banks 1..(N-1) durably in blob.

| Sub-item | Output |
|---|---|
| Operator CLI UX | `design/operator-trigger-cli.md` |
| Operator CLI implementation | `scripts/azops/start-cohort.js` (new) — default attach with progress poll; `--detach` flag; companion `scripts/azops/status.js <exec-id>` for re-attach |
| Per-bank blob upload design | `design/incremental-blob-upload.md` |
| Per-bank blob upload implementation | `cloud/sync.js` `uploadOneBank(bankCode, runDir)` API; uploads `<bank>_config.json`, `<bank>_*_rates.json`, `<bank>.trace.jsonl`, `<bank>.summary.json`, and a new `<bank>-bank-domains-fragment.json` (extracted slice of bank-domains.json for that bank only). `run-batch.js` calls it after each per-bank `safeWriteArtifact()` succeeds. |
| ACR upload robustness | `iac/deploy-image.sh` rewrite — retry transient ACR failures up to 3× with exponential backoff; tag every image with both `<git-sha>` and `latest`; verify the tag exists in ACR (`az acr repository show-tags`) before Bicep re-apply; surface meaningful errors when ACR build returns non-zero. |
| Operator runbook + smoke | `implementation/operator-runbook-2026-05-XX.md` + `scripts/azops/smoke.sh` (one-bank cloud smoke for first-run validation) + Log Analytics / Application Insights dashboard URL documented in the runbook |

**Acceptance:**
- `node scripts/azops/start-cohort.js --cohort sample-5 --env dev --dry-run` prints the exact `az` command it would issue.
- Same command without `--dry-run` launches a real cloud execution; by default the script stays attached and streams per-bank progress (e.g., "bank 3/5: hdfc-bank-limited committed 71 slabs, $0.05 so far") by polling blob storage every 30 s. `--detach` exits immediately after kickoff and prints exec ID + portal URL.
- `node scripts/azops/status.js <exec-id>` re-attaches to a running or completed execution.
- Mid-run, blob files appear per bank — verified via `az storage blob list --prefix output/latest/` count growing as the run progresses.
- `iac/deploy-image.sh` retries on transient ACR failures; the operator does not have to manually re-run when ACR is flaky.
- `scripts/azops/smoke.sh` runs a one-bank cloud smoke end-to-end without operator intervention beyond starting it.

**Out of scope for Sprint 4** (capture if surfaced; defer to Sprint 5+):
- Atomic image swap + `iac/rollback-image.sh` (deferred — current Bicep re-apply behavior is "good enough" once upload retries succeed).
- Image vulnerability scan gate.
- CI-driven build (GitHub Actions) — manual operator-run flow stays for now.
- ACR image pruning / age-based cleanup.

### Track C — Run 200 top banks in cloud

| Sub-item | Output |
|---|---|
| Cohort design | `design/top-200-cohort.md` (composition + selection rationale) |
| Cohort data file | `data/cohorts/top-200-banks.json` (new) |
| Cohort loader | `scripts/utils/load-cohort.js` (new); `--cohort` flag wired into `run-batch.js` |
| Local dry-run validation | `implementation/cohort-validation-200-2026-05-XX.md` |
| Cloud run report | `implementation/cloud-run-top-200-2026-05-XX.md` |

**Composition target** (subject to data availability):
- 12 PSB
- 21 PVB
- 11 SFB
- 6 PB
- 6 FB
- 12 IBU
- 30 SUCB (top by deposit size or geographic spread)
- 30 RRB
- 4 LAB
- 68 curated co-ops / DCCBs across states
- **Total = 200**

**Acceptance:**
- Cloud run < 2-hour wall clock, < $30 total LLM cost.
- ≥ 160/200 banks with non-zero slab count.
- `rates-pack.json` increment written to `rates-pack` container.
- Per-bank trust rate, total cost, wall clock, failure classes captured in the implementation report.
- Fix queue for the 1,800-bank Sprint-5 ramp seeded.

## Files / paths overview

| Path | Purpose | Track |
|---|---|---|
| `sdlc/sprints/sprint-004/plan/sprint-004-scope.md` | This doc | meta |
| `sdlc/sprints/sprint-004/design/tier-header-propagation.md` | A4 design | A |
| `sdlc/sprints/sprint-004/design/cohort-smoke-50-categories.md` | 50-bank smoke selection | A |
| `sdlc/sprints/sprint-004/design/operator-trigger-cli.md` | start-cohort.js UX | B |
| `sdlc/sprints/sprint-004/design/incremental-blob-upload.md` | Per-bank push sequencing | B |
| `sdlc/sprints/sprint-004/design/top-200-cohort.md` | Cohort composition | C |
| `sdlc/sprints/sprint-004/implementation/cohort-smoke-50-2026-05-XX.md` | 50-bank report | A |
| `sdlc/sprints/sprint-004/implementation/operator-runbook-2026-05-XX.md` | Track B usage doc | B |
| `sdlc/sprints/sprint-004/implementation/cohort-validation-200-2026-05-XX.md` | Local dry-run | C |
| `sdlc/sprints/sprint-004/implementation/cloud-run-top-200-2026-05-XX.md` | Cloud run report | C |
| `sdlc/sprints/sprint-004/retrospection/` | End-of-sprint retro | meta |
| `data/cohorts/top-200-banks.json` | Versioned cohort file | C |
| `lib/actions/_cheerio_tables.js` | Tier-header capture | A |
| `lib/actions/extract_html_table.js` | Tier-aware dedup | A |
| `cloud/sync.js` | `uploadOneBank` API | B |
| `run-batch.js` | Wire incremental upload + `--cohort` flag | B / C |
| `scripts/azops/start-cohort.js` (new) | Operator CLI | B |
| `scripts/utils/load-cohort.js` (new) | Cohort loader | C |
| `iac/deploy-image.sh` | Idempotency + rollback | B |
| `iac/rollback-image.sh` (new) | Image rollback helper | B |

## Existing functions / utilities to reuse (no reinvention)

- `cloud/sync.js push` — additive-upsert blob upload; `uploadOneBank` wraps a narrower path through this same code.
- `lib/safe-write.js` — ADR-012 atomic write semantics; per-bank blob upload happens AFTER safe-write succeeds locally.
- `lib/registry-skip.js` — resume / skip semantics; `start-cohort.js` consults it before launching to avoid re-billing finished banks.
- `scripts/refresh/build-cohort.js` — existing cohort builder; the new `data/cohorts/top-200-banks.json` may share its bank-selection conventions even though the new file is hand-curated.
- `lib/actions/_cheerio_tables.js`'s existing `extractTableChunks` + `buildTableContext` — A4 extends these, doesn't replace them.
- `scripts/analysis/build-job-start-body.js` — already constructs the ARM body; `start-cohort.js` calls it instead of duplicating logic.
- `iac/modules/container-apps-job.bicep` — Job spec is shape-correct; Track B doesn't redefine the Job, only the deploy/trigger surface.

## Verification

End-to-end:
1. **Track A local smoke** — `node run-batch.js --cohort sample-50 --output-dir output/runs/sprint-004-smoke-50`. Report: ≥ 40 of 50 banks produce ≥ 5 trustworthy slabs; no LLM-emitted `errors[]` survive into committed files; all slabs trace back to source HTML.
2. **Track B operator trigger** — `node scripts/azops/start-cohort.js --cohort sample-5 --env dev` launches a real cloud execution, polls until completion, blob files appear incrementally.
3. **Track C 200-bank cloud run** — `node scripts/azops/start-cohort.js --cohort top-200 --env prod`. Expected: < 2-hour wall clock, < $30 total cost, ≥ 160/200 banks with non-zero slab count, `rates-pack.json` increment in the `rates-pack` container.
4. **Unit tests** — `SKIP_PLAYWRIGHT_TESTS=1 npm test` must stay green through every commit (current baseline 480 pass / 0 fail).
5. **Anomaly catalog grows but is contained** — at most 3 new anomaly classes (A5/A6/A7) surface from the 50-bank smoke; each either ships a fix in-sprint or has a dedicated SDLC follow-up doc with a written stop-condition.

## Stop conditions / Sprint 5 carve-outs

Defer to Sprint 5 if any of these triggers:
- Cloud trust rate < 80 % of LLM-baseline coverage on the 200-bank run — Sprint 5 focuses on coverage uplift before scaling further.
- A4 fix surfaces > 2 weeks of architectural rework (chunk schema change, cross-table state) — ship the 50-bank smoke without A4 and defer the AU-style fix.
- The new anomaly catalog has > 6 classes — capture all but fix only the top 3 by impact.
- ACR build flakiness exceeds 2 retries per deploy — pause Track B advancement and root-cause the ACR pipeline before continuing.

Hard non-goals for Sprint 4 (capture in backlog, do not start):
- Full 1,800-bank cloud run — Sprint 5+ once 200 is stable.
- PM-facing rates-pack UI / dashboard work — separate stream.
- Repo-extraction / domain-generalisation (`entity_id` rename per `sdlc/backlog.md` P1) — wait for cloud stability.
- Vision API integration for image rate cards — exists but unexercised; gated on 200-bank coverage.
- `packages/scraper/` pipeline validation (Sprint 3 Item #2) — held until 200-bank cohort outputs exist.
- Operator-resolution CLI (Sprint 3 Item #3) — held until pending-sidecar accumulation justifies it.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Per-bank blob upload doubles cloud cost / IO if poorly batched | Coalesce to one blob upload per `(bank, ≥3 files)` group; reuse the existing `cloud/sync.js` upsert connection. Measure on the 50-bank smoke before going to 200. |
| Operator CLI accidentally launches against `prod` from a dev machine | Require explicit `--env prod` and a confirm prompt unless `--yes` is passed. Default to `dev`. |
| 50-bank smoke surfaces 5+ pattern classes and we can't fix them all | Sprint 4 ships fixes for the top-3-by-impact, captures the rest with reproduction commands, and the 200-bank cloud run goes ahead with explicit "expected partial coverage" framing. |
| AU SFB tier-header fix breaks already-passing banks | Add tier-aware logic behind a feature flag (`RDA_TIER_AWARE_DEDUP=1` default off until 50-bank smoke confirms no regression). |
| ACR rollback never tested under real failure | Track B explicitly induces one bad deploy (placeholder image tag) and runs `rollback-image.sh` against it as part of verification. |
| `azure-openai-agent` branch has 10 unpushed commits — push timing | Push at start of Sprint 4 (after this plan is committed) so PR review surface is current. No force-push to `main`. |

## Sub-agents / specialised reviewers

Reuse the existing claude-code-guide / code-simplifier / Explore subagents already in the project. No new sub-agent definitions needed for Sprint 4.

## Next action

After plan approval: commit this scope doc + the empty `design/` / `implementation/` / `retrospection/` placeholder. Then start Track A (A4 design pass) and Track B (incremental blob upload + start-cohort.js skeleton) in parallel — they touch disjoint files. Track C cohort file work can start in parallel with either.

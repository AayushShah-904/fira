# Sprint 009 — Cloud deployment, observability, split-execution & merge

**Sprint window:** 2026-06-02 → TBD
**Branch:** `azure-openai-agent` (continues from Sprint 008)
**Status:** Plan approved by operator 2026-06-02 (auto mode). SDLC scaffolding in progress.

## Goal in one sentence

Get the cloud loop running on HEAD with **operational trust** — we can see what each run did and prove it landed in blob — then split each cohort into cloud-runnable vs WAF-blocked banks, run them in their respective environments, and merge the results back into a single coherent pack without losing the sprint-008 correctness gains.

## Why Sprint 009 looks like this

Two things make the cloud loop currently un-trustworthy and a substantial gap to local:

1. **The cloud image is 50 commits behind HEAD** (`cd9fa75` deployed, `0088324` HEAD). Sprints 005–008 — extractor registry, `.bank.in` co-op family, per-bank manifest, 500-bank Tier-1/Tier-2 cohort pipeline, the entire CONFIDENCE program (snapshot substrate, semantic checks, sampling audit, cross-check, composite confidence score, golden gate) plus seven post-Phase-7 correctness fixes — are local-only. Nothing has run in cloud since 2026-05-20.

2. **Cloud runs have repeatedly looked-successful-but-weren't.** Sprint 002's handoff documented runs where the container exited 0, ARM marked the job Succeeded, and yet zero new artifacts landed in blob (the end-of-run push aborted atomically, the in-flight kill-switch was reset by Bicep, the per-bank timeout truncated the retry loop before the marker file was written). The operator's quote: "we had no idea what happened." Telemetry was archaeology — hand-written KQL over thousands of WARN lines and blob inventory diffs after the fact.

That second class is what makes observability **Phase 1**, not Phase 4. Until a cloud run produces an unambiguous, structured "this is what I tried, this is what landed in blob, this is what failed and why" trail, every downstream sprint goal — cloud-block detection, split execution, merge — sits on top of a signal we can't trust.

A third structural gap, raised in this sprint's planning conversation: many banks' WAFs block the Azure egress IP (ICICI/Axis/Kotak/BOI-IBU are the known ones, but the actual list is unbounded). Sprint 004 deferred these to "augment locally" in the Q2 refresh plan. That's not a workflow. They need a first-class registry + split-execution path so cohort runs are reproducible from a config, not a memory of which banks the operator hand-ran last quarter.

The Function App was tentatively retired in the Sprint 002 cloud handoff ("ill-thought-out experiment"). Operator decision this sprint: **salvage it** — it's the clean integration seam for the website (`packages/web`) to trigger refreshes without granting the web tier `ARM jobs/start` permission. Revisit every assumption from sprint 002 (RBAC, run-from-package, AzureWebJobsStorage identity, appSettings replace-not-merge).

## Operator decisions (2026-06-02)

| Question | Decision |
|---|---|
| Phase ordering | **Observability before detection/split/merge.** Sprint 002's "blob writes silently didn't happen" pain is the load-bearing concern. |
| Registry storage for cloud-block status | Extend `data/per-bank-manifest/<bank>.json` — keep per-bank truth in one place. |
| Merge precedence on field conflicts | **Richer-set-wins** for slab arrays (more slabs wins); **local-wins** for `extraction_method` / `source_url` / curated fields (local is where ground-truthing happened). |
| Function App fate | **Salvage**, do not retire. Needed for clean website integration. Revisit every assumption from sprint 002. |
| Snapshot store in cloud | Cloud-replicated to `agent-state/snapshots/` for any bank that runs in cloud — keeps sprint-008 cross-check reproducible from artifacts. |
| Scope ambition | **All phases.** Phase 5 (merge) flagged as highest-risk. |
| ACR upload instability (sprint-002 issue #1) | Operator recalls disabling IPv6 on the local network resolved it; treat as closed unless re-observed in Phase 0. |

## Authoritative plan

This file plus the per-phase design docs in `../design/`. There is no separate scratch — `~/.claude/plans/` is no longer in use for sprint-level planning.

## Eight phases

| # | Phase | Primary deliverables | Depends on | Status |
|---|---|---|---|---|
| 0 | **Deploy unblock + baseline** | Fresh HEAD image in ACR; Sprint-004 Bug A fix (run-batch per-bank timeout 5 min → 15 min, or move marker write to parent); Bicep parameterizes kill-switch + any other deploy-time settings (ADR-013 pattern); one-bank cloud smoke green; HEAD image deployed to job | — | Pending |
| 1 | **Observability hardening** | Run beacon (start + end JSON written to `agent-state/runs/<run_label>/`); structured per-bank events (`ATTEMPT`, `EXTRACTED`, `BLOB_WRITE`, `SKIPPED`, `FAILED`) at WARN+ for KQL; single KQL query "did the last run end-to-end work" with bank-count reconciliation against the cohort; drift check on job spec (image, env, kill-switch); `npm run cloud:status` summarising last N executions with task-meaningful progress, not just "Running" | Phase 0 | Pending |
| 2 | **Function App salvage** | Re-derive every dependency: identity-based AzureWebJobsStorage roles (Blob Data Owner + Queue Data Contributor + Table Data Contributor), `WEBSITE_RUN_FROM_PACKAGE` Bicep-parameterized, host registered functions visible at `/admin/functions`, end-to-end POST → ARM `jobs/start` → execution-id returned, integration contract documented for `packages/web` consumption | Phase 1 (we need to see failures) | Pending |
| 3 | **Cloud-block detection + registry** | Define block fingerprint (HTTP 403/406, WAF challenge HTML, Cloudflare/Akamai signatures, sustained NOT_FOUND-after-retry from cloud-only); persist as `cloud_block_status` block in per-bank manifest with `last_observed`, `evidence_url`, `http_status`, `reason`, `confidence`; auto-populate from Phase 1 events | Phase 1 (block signals are observability outputs) | Pending |
| 4 | **Split-execution orchestration** | Cohort splitter takes `cohort.json` + manifest → emits `cohort-cloud.json` + `cohort-local.json`; cloud-side skips blocked banks before AOAI spend; local mode `run-local-only.js` mirrors cloud's output layout and writes a peer run beacon for Phase 5 to join on | Phase 3 | Pending |
| 5 | **Merge mechanism** | Per-bank reconciliation: cloud artifact + local artifact → single canonical output; conflict rules per the operator decision above; provenance `source_runs: [{run_id, source, contributed_fields}]`; respects ADR-012 safe-write + clobber-protection so a thinner run never overwrites a richer one; tests over synthetic cloud/local pair fixtures | Phase 4 | Pending |
| 6 | **End-to-end split-cohort validation** | 500-bank Q2 cohort run, split → cloud + local → merge → comparison against pure-local pack; metrics: total slab count, per-variant coverage, zero silent overwrites of richer data | Phase 5 | Pending |
| 7 | **Retro** | `retrospection/retro.md` per the standard rhythm | Phase 6 | Pending |
| **9** | **Cohort-runtime fixes (post-validation cluster)** | Six items surfaced by the top-50 cohort outcome on 2026-06-05: (9.1) SBI playwright_disabled + agent-loop guard interaction; (9.2) zero-slab misclassification of curated/skipped banks; (9.3) **DATA LOSS — curated NRI variant files missing from cloud blob**, one-shot bootstrap upload required; (9.4) AB Bank PLC `foreign_currency_not_inr` skip; (9.5/9.6) promote Arunachal RRB / Ahmedabad Mercantile / CSB Bank to operator-curated extraction_method. Design at `sdlc/sprints/sprint-009/design/phase-9-cohort-runtime-fixes.md`. | Phase 6 top-50 outcome | Pending operator approval |

Delivery order: strictly sequential 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 1 may share scaffolding with Phase 0 (we'll want some KQL handy to validate the smoke), but its formal exit is after Phase 0.

Phase 9 was added 2026-06-05 after the top-50 cohort run (execution `lezfcsq`) surfaced a cluster of follow-up items not anticipated in the original scope. Numbering skips 8 to leave room for an inserted operational phase if the future requires one (mirroring the Phase 2.5 precedent).

### Phase 1 follow-ups folded from container-mgmt acceptance (2026-06-02)

The independent-review packet under `container-mgmt/` proposed a Function-App-recovery design (per-execution receipt blob + composite `/api/job-status/{executionId}`). On acceptance review two minor items were deferred to Phase 1, where the receipt becomes the primary observability signal:

- **Tighten `computeRunOutcome` for the "all-skipped" case.** Current rule treats `failed === 0 && rateLimited === 0` as `success`, which means a resume-mode run that skips every bank reports `success` despite zero work performed. Design narrative says success requires "at least one bank ran." Fix: require `succeeded > 0` for `success`; otherwise return a new `no_work` outcome that maps to a non-zero exit and a `phase: "no_work"` receipt. Update Function status response to surface `no_work` distinctly from `partial_failure`.
- **Mirror `.toLowerCase()` on the receipt-read path.** `cloud/sync.js:467` (`uploadExecutionReceipt`) lowercases the blob key on write; `functions/job-status/index.js:69` does not lowercase on read. Container Apps execution names are always lowercase today, so it works — but the asymmetry is a latent trap if Azure ever changes naming. Hardening: lowercase the executionId before composing the blob URL on the read side, with a unit test pinning the casing contract.

## Exit criteria

- **Cloud loop on HEAD.** Deployed image SHA == `git rev-parse HEAD` on the green smoke commit.
- **Observability proves blob writes.** For any run, the operator can answer "did rates for bank X land in blob?" from a single KQL query, without listing blob containers.
- **Bicep re-apply safe.** Re-applying the Bicep deployment does not silently flip the kill-switch or wipe `WEBSITE_RUN_FROM_PACKAGE`. Verified by an explicit test.
- **Function App green.** `/admin/host/status` Running, `/admin/functions` lists the start-discovery function, a documented POST returns an ARM execution-id, that execution is visible in Phase 1 observability.
- **Cloud-block registry self-populating.** A cohort run mutates per-bank manifests with `cloud_block_status` evidence for any bank whose cloud fetch matches the block fingerprint — no manual edits.
- **Split + merge reproducible.** Same cohort + same manifest state → same split → same merge output, twice in a row.
- **Pack quality unchanged or better.** Sprint-009 merged pack has **≥ sprint-008 pack** slab count for the same cohort and **zero** instances of a thinner run overwriting richer data.

## Out of scope

- Adding new bank coverage (sprint 009 is plumbing; coverage is sprint 010).
- Migration to CI/CD (still deferred per Sprint 004 retro; deploy-image.sh stays operator-driven).
- Multi-region failover (cohort runs are single-region by design).

## Risks

- **Phase 5 merge is the highest-risk phase.** Conflict rules look simple until two runs produce overlapping-but-not-identical slab sets — write extensive fixture tests before turning it on for real cohorts.
- **Function App revival may re-encounter sprint-002 traps.** Mitigation: every assumption gets a design-doc line item and a verification step in implementation. No "should work" moves to closed.
- **Observability changes are agent-side code; that means rebuilding + redeploying.** Phase 1 may have a 1-2 day deploy-loop iteration cycle. Plan for that, not for instant feedback.

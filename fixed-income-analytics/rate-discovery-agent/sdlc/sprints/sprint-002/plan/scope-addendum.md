# Sprint 002 — Scope addendum

This addendum extends `scope.md` with work that emerged after the plan was committed (49769a2 on 2026-05-09). Each entry has the same shape as items in the main scope.

## Item #15 — ADR-012 implementation: centralized write path + required `extraction_method`

**Added:** 2026-05-12, after ADR-012 was DECIDED.
**Spawned by:** Phase B incident (commit `6ae6c6e` patched the symptoms; the ADR addresses the class of bug).
**Belongs to:** Track A (agent-side correctness).

**Why:** Sprint 002 #5 (codify learnings) so far has tightened prompts, added a skip-gate, and patched the two destructive writers we caught. The ADR-012 work is the structural answer: one funnel for writes (`lib/safe-write.js`), required `extraction_method` schema field, default-to-merge norm enforced via pre-commit hook. Without this, the next destructive writer ships in the next sprint and bites us again.

**Work breakdown (5 sub-deliverables, ~2 days total):**

15a. **`lib/safe-write.js` — the funnel.** ~150 LOC. Function `safeWriteArtifact({ path, incoming, kind, source, force })`. Reads existing, checks curated provenance, either writes or routes to pending sidecar. Atomic (temp + rename). Tests: 8-10 unit covering the four kinds (config, rates, summary, registry-entry) × the three cases (no existing, existing-auto, existing-curated).

15b. **Migrate all existing writers.** Five call sites enumerated in ADR-012:
- `lib/domain-cache.js` `updateDomainEntry` → `safeWriteArtifact({ kind: 'registry-entry', source: 'agent' })`
- `run-discovery.js` copy-to-latest → per-file calls
- `lib/agent.js` `write_file` tool → guard at the tool layer
- `lib/slug-guard.js` `correctBankCodeInPlace` → `source: 'agent'`
- `lib/registry-skip.js` `writeSkipOutputs` → `source: 'skip-gate'`

15c. **Required `extraction_method` schema field.** Modify the rates / config writers to emit the field; modify `safeWriteArtifact` to reject untagged writes. The classifier and aggregator already read it; tagging operator-touched artifacts during this turn's session (Angul, Nizamabad, Banswara, Barmer, Ajmer) is already in place.

15d. **Pre-commit hook / CI grep.** A simple shell check that refuses commits adding `fs.writeFileSync` to `output/latest/**` or `data/bank-domains.json` outside `lib/safe-write.js`. Hard block in CI; local pre-commit hook with `--allow-direct-write` escape for tests.

15e. **Non-destruction tests** for every migrated writer. Each gets a test asserting "given operator-curated `extraction_method` at the target, the write either preserves the curated artifact or routes incoming to a pending sidecar." 4 of these landed pre-emptively in this turn (`tests/lib/domain-cache.test.js`); the rest follow with the migration.

**Acceptance criteria for #15:**

- [ ] `lib/safe-write.js` exists with unit tests; full test suite stays green.
- [ ] All 5 enumerated writers route through it.
- [ ] Required-`extraction_method` validation is in effect; the agent's existing prompts (or the `write_file` tool wrapper) emit a valid value.
- [ ] Pre-commit hook OR CI step refuses bypass.
- [ ] Re-running the Sprint 002 #7 12-bank set (`scripts/run-phaseB-rerun.js`) preserves Angul + Nizamabad + Banswara + Barmer + Ajmer operator-curated artifacts. Net `success` count >= the 4 already achieved; no regression in slabs.

**Out of scope for #15 (deferred to Sprint 003):**

- The operator-side pending-resolver UI/CLI (ADR-011 already deferred this; #15 just produces pending sidecars without a fancy tool to resolve them).
- File-locking for `bank-domains.json` (open question 2 in ADR-012; small follow-up).
- Lazy-migration tagging of the 6,732 legacy registry entries (happens on first write per entry, no big-bang sweep).

## Sequencing note for #15

Belongs to Track A. Sequenced **after** the operator-session work (banks 1-12 triaged with their registry updates committed) and **before** the cloud loop work in Track B. Rationale: Track B's cloud rerun (#12) needs `safeWriteArtifact` in place; otherwise the cloud bot's writes would re-introduce the very destructiveness this ADR fixes.

Cloud kill-switch (#8) stays engaged through #15 implementation. After #15 lands and `tests/` are green, the kill-switch can be lifted for a cloud smoke (proposed item #16 below).

## Item #16 — Cloud smoke of the 12-bank operator-followup subset (cohort-comparison guard)

**Added:** 2026-05-12.
**Spawned by:** Sprint 002 #4 writeup recommendation — before #12's full DCCB rerun, run the SAME 12 banks in cloud to isolate any local-vs-cloud environmental gap. Without this, #13's lift measurement is uninterpretable.

**Belongs to:** Track C (validation), sequenced before #12.

**Cost:** <$5 AOAI (the 12 banks ran for $0.48 locally; cloud might be similar or 2× depending on the same environmental factors we're trying to isolate).

**Acceptance criteria:**

- [ ] Cloud Job triggered against the 12-slug list with all #5 / #15 fixes deployed.
- [ ] Comparison table: cohort transitions cloud-Phase-B vs local-Phase-B. If the cohort-relative numbers match within ~10 pp, the local lift is a real agent lift (and #13's full-DCCB measurement is meaningful). If they diverge wildly, dig into the environmental difference before #12.

This item depends on:
- #8 kill-switch already in place (✓).
- #9 cloud/git-publish path-rooting + clone fix already in place (✓).
- #15 safe-write helper in place (so cloud bot doesn't destroy curated data).
- #10 (cloud/sync.js pull-everything) — still open; partly mitigated by #9's clone-based bootstrap but worth landing for full additive-state correctness.

If #10 ships before #16, the cloud smoke uses the additive path. If not, the smoke runs on the clone-based path that doesn't pull existing `output/latest/*` blobs and just exercises the new agent path — still informative for the local-vs-cloud comparison.

## Item #17 — ADR-013 implementation: deploy-time function config flows through Bicep parameters

**Added:** 2026-05-13, after the cloud DCCB rerun (#12) was blocked by `WEBSITE_RUN_FROM_PACKAGE` being wiped by a Bicep re-apply.
**Spawned by:** Cloud DCCB rerun blocker — Sprint 002 cannot close without a working function trigger.
**Belongs to:** Track B (cloud loop trustworthiness).

**Why:** The runbook for #12 ran `iac/deploy-image.sh` to push the new image. The Bicep re-apply wiped `WEBSITE_RUN_FROM_PACKAGE` (set out-of-band by Sprint 001's manual deploy steps), so the function host loaded 0 functions and the trigger started returning 404. Same class of bug as ADR-012 (silent overwrite of operator-set state during routine re-applies) but at the IaC layer. ADR-013 captures the decision; #17 ships it.

**Work breakdown (already implemented in this turn):**

17a. **`iac/modules/function-app.bicep` — `runFromPackageUrl` parameter** with `concat()`-based conditional inclusion in appSettings. ~10 LOC.
17b. **`iac/main.bicep` — thread parameter through** to the functionApp module. ~5 LOC.
17c. **`iac/build-functions-zip.py` — POSIX-path zip builder** (replaces PowerShell `Compress-Archive` which emits backslash entries that break Linux Function host extraction).
17d. **`iac/deploy-image.sh` — atomic deploy** (zip build → upload → image build → Bicep apply → post-deploy `/admin/functions` verification). Replaces the previous script which only handled the image.
17e. **`tests/iac/build-functions-zip.test.js`** — pins the contract (zero backslash entries, all required files present).

**Acceptance criteria for #17:**

- [x] `az bicep build iac/main.bicep` succeeds.
- [x] `npm test` includes the new IaC test and stays green (230 tests; 229 pass + 1 pre-existing Azurite skip).
- [ ] One full `iac/deploy-image.sh` run completes end-to-end, including the post-deploy verification step (function host reports both functions loaded). This is the deliverable that lets #12 proceed.

**Out of scope for #17 (deferred):**

- Lifecycle rule on the `deploy/` blob container (keep N most recent zips, auto-delete older). Operational cleanup, not a correctness issue. Tracked as Sprint 002 retro carryover.
- Generalizing the pattern to other replace-not-merge appSettings (Application Insights, custom env vars). Out of scope until the next deploy-time setting arrives.

## Sequencing note for #17

#17 must land before #12 can run. #12 was blocked by the very bug #17 fixes. Once #17 lands, the runbook in `cloud-dccb-rerun-runbook.md` should be re-checked (Step 1 changes meaningfully — the operator runs the new atomic `deploy-image.sh` instead of separate image+function steps).

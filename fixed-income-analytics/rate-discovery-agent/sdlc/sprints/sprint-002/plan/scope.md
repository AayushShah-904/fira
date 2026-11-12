# Sprint 002 — Cloud loop: trustworthy + analyzable

**Status:** Plan approved (2026-05-09) — ready for design phase
**Goal:** Make the cloud rate-discovery loop *correct* (additive state, no destructive commits) and *legible* (we can answer "why did the DCCB run extract only 10%?" without log scrolling). Validate by lifting DCCB extraction success rate measurably above the Sprint 001 baseline of 10%.

Sprint 001 proved the cloud path runs. Sprint 002 makes it run *right*.

## Foundational decisions

- [ADR-011](../../../decisions/ADR-011-additive-state-semantics.md) — additive state semantics across cloud runs. Currently PROPOSED; first action in Sprint 002 is to review and DECIDE. Sprint 002 implements the recommended option.
- All Sprint 001 ADRs (001-010) carry over unchanged.

## Sequencing principle (the single most important decision in this scope)

**Diagnose locally before scaling in cloud.** Sprint 001's DCCB run ($15-20 of AOAI calls) extracted rates from 35 of 351 banks (10%). Re-running in cloud with no agent improvements would just spend the same budget for the same result. The Sprint 002 sequence puts local debugging *first*, codifies what we learn, then re-runs in cloud with the upgraded agent. Cloud is for scale; local is for figuring out what to scale.

This means **Track A (DCCB diagnostic + agent fixes) precedes Track B (cloud loop fixes)** in elapsed time, even though Track B is a smaller code change. The cloud loop is broken-but-frozen during Track A; nobody triggers cloud runs until Track B closes.

## Scope (in priority + dependency order)

### Track A — Diagnose and fix DCCB extraction (local-first)

1. **ADR-011 review and decision.** Quick: confirm the four invariants and the recommended fix. Mark DECIDED (or amend). All subsequent code work cites the decided ADR.

2. **Add `failure_class` enum + `_run_analysis.json` index** (Option A from Sprint 001 retro Section G). Per-bank `summary.json` gets a `failure_class` field with one of: `no_website_found` / `website_unreachable` / `rate_page_not_found` / `extraction_failed_t1` / `extraction_failed_t2` / `success`. Run-end produces `output/latest/_run_analysis.json` aggregating counts + 3-5 exemplar bank slugs per class. Works identically in local and cloud — same code, no Bicep change.

3. **Local diagnostic run on 10-15 representative DCCBs.** Curated from Sprint 001's failure cohort: pick banks across the geography (north India, south India, north-east) and across the failure-class distribution (mix of `no_website_found`, `extraction_failed_t1`, `low_confidence`). Run with `BIRD_STORAGE=local` and `DEBUG=*`-style verbose logging. Capture full stdout, full trace.jsonl, screenshots if Playwright was used.

4. **Diagnosis writeup.** A short doc — `sdlc/sprints/sprint-002/implementation/dccb-failure-analysis.md` — listing the failure modes seen, their relative frequency, and concrete root causes. This is the deliverable that informs item #5.

5. **Codify learnings.** Whatever item #4 reveals. Probable directions:
   - **Pre-classify known-no-website banks** in `bank-domains.json` with a `discovery_status: "no_website_known"` field. The agent skips them with a fast `scraper_type: "manual"` config rather than burning Tier 1 calls.
   - **New scraper-tier rules** for cooperative-bank patterns (e.g., regional-language URL roots, JS-heavy state-coop portals). Update `lib/agent.js` or `lib/discovery.js` accordingly.
   - **Better tier escalation logic** — currently Tier 1 → "no config" → batch-end. Maybe Tier 1 should escalate to Tier 2 more aggressively for specific failure classes.
   The exact codification is unknown until item #4 lands. Allow ~2-3 days of agent work here.

6. **Slug ghost fix** (Sprint 001 retro Section H). 30 of the 72 DCCB-run pack entries had slugs like `*_current`, `*_dds`, `*_rd` — product-type suffixes leaking into the slug from somewhere in the per-bank output writer. Trace the bug, fix in agent code, add a test that asserts no `_` characters in produced slugs.

7. **Local re-run on the same 10-15 sample, verify lift.** Same banks, post-fix. Document the delta in extraction success rate. Goal: meaningfully better than the Sprint 001 baseline for this category. If we can't move the needle locally, more agent work is needed before any cloud run.

14. **Agent-side phase-handoff: emit partial configs at phase boundaries.** Spawned 2026-05-10 from the v2 failure-class taxonomy ([design](../design/failure-class-taxonomy.md)). Today the discover prompt is a single sequential task: find website → find rate page → extract. If Phase 2 fails, the agent gives up without writing the website it just identified, so the operator-actionable `partial_success / website found / rate page not found` cohort never populates from live runs. Modify `lib/prompts/discover.md` and `lib/agent.js` so the agent writes a partial `_config.json` the moment Phase 1 commits (`website` set, `rate_page_urls.fd: null`, `scraper_type: "to_determine"`), then upgrades it as later phases land or definitively fail. Sequenced after #6 (slug-ghost fix) so the partial-config writer doesn't compound that bug. **May land in Sprint 003 if Sprint 002 capacity is tight** — this taxonomy work doesn't depend on it (the classifier still classifies what data exists today; new states naturally start populating once the agent emits them).

### Track B — Make the cloud loop correct (deferred until Track A's agent is ready)

8. **Cloud kill-switch — `BIRD_DISABLE_GIT_PUBLISH=1`** env var honored by `cloud/git-publish.js` (skip with `[git-publish] disabled by env`). Wire through `iac/modules/container-apps-job.bicep` so we can flip it via `az containerapp job update --set-env-vars` without re-applying. **Set to `1` immediately** so any cloud run during Sprint 002 doesn't re-corrupt origin via the existing bug.

9. **Fix `cloud/git-publish.js` per ADR-011 + the path-rooting bug discovered 2026-05-09.** Two changes:
   - **Path rooting.** Today's bootstrap operates from `/app/` and commits at root paths (`output/latest/...`), which doesn't match the monorepo's `rate-discovery-agent/` subdir layout. The bot's commits replaced the entire repo tree with just the rate data, deleting all source code. Fix: stage files at the correct sub-path before adding (e.g., copy to `.git-stage/rate-discovery-agent/output/latest/`), or operate the git repo against a sub-mounted parent.
   - **Reset semantics.** `git reset --soft origin/<branch>` after `git init` produces an empty index, so the new commit's tree is only what the bot adds — every file in HEAD's tree that isn't re-added gets dropped. Fix: change to `git reset` (default `--mixed`) so the index inherits from origin's tree.

   With both fixes, future bot commits add only their delta on top of HEAD's full tree. No more whole-tree replacement. No more silent file deletions. Add tests against a temp git repo simulating a fresh-bootstrap scenario.

10. **Fix `cloud/sync.js pull` to fetch all `output/latest/*`** blobs at run start, in addition to `bank-domains.json`. Per ADR-011's recommended option. Adds ~30-60 seconds per cloud run cold-start; restores additive semantics for both pack and git in a single change.

11. **Verify `pack/publish.js`** is correct after item #10 — once pull populates the local `output/latest/` from accumulated state, the existing rebuild walks the full set without code change. Add a test that runs `pack/publish.js` against a fixture with multiple banks (HDFC + a DCCB or two) and confirms the output pack contains all of them.

### Track C — Validation (the sprint's exit criterion)

12. **Cloud DCCB rerun (full 351)** with kill-switch off and all Tracks A + B fixes deployed. Before triggering: re-build image, re-apply Bicep with new SHA, set `BIRD_DISABLE_GIT_PUBLISH=0`. Use the same operator runbook flow.

13. **Compare success rate to Sprint 001 baseline.** Concrete exit criterion: meaningfully more banks produce extracted rates than the 35 of 351 (10%) baseline. The "meaningfully more" target isn't fixed — it depends on what item #4 reveals about achievable lift — but Sprint 002 is not closed until item #13 produces a measured delta and a written analysis.

## Out of scope (deferred to Sprint 003+)

The full deferred list with revisit conditions lives in [`deferred.md`](deferred.md). Headlines:

- Bicep cleanup (split role-assignments, add WEBSITE_RUN_FROM_PACKAGE, Node 20 → 24 bump) — operational polish.
- Flex Consumption (FC1) vs Linux Consumption (Y1) spike — the Y1 friction (URL-package + 7-day SAS rotation) is real but not blocking.
- Application Insights + log-stream — Log Analytics queries are sufficient for Sprint 002.
- Cloud Shell as primary operator surface — process, no code.
- GitHub Actions deploy for Functions — replaces a manual step; not blocking.
- Local replay tool (download a bank's trace.jsonl from blob, walk locally) — defer; manual local runs in Track A item #3 substitute.
- Nightly torn-down environment apply test — Sprint 4+ infra work.
- Runbook rewrites (`cloud-manual-trigger.md`, `azure-prep.md`) — blocked on Sprint 002's bot fix and the Flex Consumption decision; rewriting now and again in Sprint 3 wastes effort.

## Acceptance criteria

Sprint 002 is closed when ALL of the following hold:

- [ ] ADR-011 status is DECIDED (not PROPOSED).
- [ ] Each bank's `summary.json` carries a `failure_class` enum value; each run produces `_run_analysis.json` with per-class counts.
- [ ] DCCB failure-analysis writeup is in `implementation/dccb-failure-analysis.md` and lists root causes with frequencies.
- [ ] At least one agent change (item #5) shipped to address the dominant failure mode.
- [ ] Slug ghosts (no `_` in produced slugs) — agent test passes.
- [ ] Cloud-bot's commit on `origin/azure-openai-agent` after a category run is *additive* (verified by `git diff` showing only deltas, not whole-tree replacement).
- [ ] `cloud/sync.js pull` fetches all `output/latest/*` blobs at run start (verified by container log line + receiving file count).
- [ ] Pack rebuild after a cloud run contains banks from prior runs (verified by `rates-pack.json` having both HDFC and the freshly-run category's banks).
- [ ] Cloud DCCB rerun success rate is measured and documented; lift over Sprint 001's 10% baseline is positive and explained.

## Risks

- **DCCB failures may be irreducibly long-tail.** If item #4 reveals that 90%+ of DCCBs simply have no web presence (which is the leading hypothesis), item #5's agent change is just "tag them as `manual` cleanly" rather than recovering rates. The lift in item #13 would then be small in extraction terms but high in data-quality terms (every bank has a tracked, classified entry instead of confusion). Sprint exit criterion accounts for this — the writeup matters more than a number.
- **Path-rooting fix in item #9 has hidden complexity.** The cleanest fix may require either re-architecting the bot to operate against a real clone of the parent monorepo, or a careful staging-dir approach. Reserve a buffer day.
- **Local run on 10-15 banks is high-touch.** Item #3 needs operator attention (curating the sample, watching the runs, reading traces). Schedule it as a focused half-day rather than time-boxed across a week.

## Estimate

- Track A: ~3-5 days (item #5 dominates; item #4's writeup drives the size of #5)
- Track B: ~2-3 days (item #9 is the unknown-shape part; the rest is straightforward)
- Track C: ~1 day (3-4h cloud run + analysis)
- Total elapsed: 1-2 weeks, single developer.

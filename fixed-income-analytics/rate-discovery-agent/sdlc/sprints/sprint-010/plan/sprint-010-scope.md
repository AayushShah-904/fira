# Sprint 010 — Pack quality recovery & cloud-capability routing

**Sprint window:** 2026-06-06 (opens) → TBD
**Branch:** `azure-openai-agent` (continues from Sprint 009)
**Status:** In progress. Phases 0–6 + 8 (retro draft) committed; extension phases A1, A2, B, C, D committed (2026-06-09). Phase E was deleted (operator chose to smoke at F's 12-bank scale rather than 1-bank scale). Phase F in flight as of 2026-06-09 (deploy running, fire pending). Sprint NOT closed pending operator sign-off.

## Sprint extension (2026-06-09, operator-directed)

Phases 0–8 from the original scope are committed. After the audit of the combined 513-cohort cloud outcome, operator added a second-half objective: **apply the highest-leverage extraction-pipeline fixes, then validate a clean 513-bank cohort run in cloud on D4 dedicated.**

Phases A–I extend the sprint. They are operator-approved (2026-06-09):

| Phase | Work | Status | Commit |
|---|---|---|---|
| **A1** | Remove `agentPath='llm'` path entirely; retire `lib/agent.js#runAgent` (Sprint 6 Step 5 carryover). Orchestrator becomes the only path. Auto-fallback chain (`_generic-html-3col` → `_llm-fallback`, both Azure OpenAI) covers banks without templates. | ✅ shipped | `f4d68eb` |
| **A2** | Orchestrator + `find_website` + `commit_config` tolerate missing `bank_type`; CLI derives `category` from registry; action sentinel `'UNKNOWN'` accepted downstream. | ✅ shipped (banswara verified locally — 33 slabs in 15 s vs prior crash) | `2077bfd` |
| **B** | `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` + `_KEY` (Key Vault secret ref) wired into `iac/modules/container-apps-job.bicep`; placeholder in `keyvault.bicep`. Operator pushed `docintel-key` to KV (2026-06-09). | ✅ shipped + secret live | `469980f` |
| **C** | Tenure-parser-bug fix in `scripts/utils/normalize-rates.js#normalizeRatesObject` — "Up to N" / `UPTO N` / `<= N` patterns with `tenure_min_days < 1` get clamped to 1. 9 unit tests cover normalisation. | ✅ shipped | `23bb869` |
| **D** | HDFC investigation — "86 slabs extracted but failed" turned out to be **analysis-script parser bug**, not an agent bug. HDFC's orchestrator-path run committed 86 slabs across 3 variants (FCNR alone failed because of JS-rendered page; Sprint 011 carry-over). `scripts/analysis/cloud-outcome-recount.js` extended to parse orchestrator JSON. | ✅ shipped (no agent code change needed) | `7dc8603` |
| ~~E~~ | ~~Single-bank cloud smoke of `indusind-bank-ibu`~~ — operator decided to skip the 1-bank smoke and combine it into F's 12-bank validation. | ⏭ skipped (2026-06-09) | — |
| **F** | 12-bank cloud smoke on D4 dedicated. Cohort `data/cohorts/sprint010-validation-12.json` covers PSB / PVB (templated + untemplated) / SFB / FB / IBU×2 / SUCB / DCCB (with OCR hint to exercise DocIntel) / NSUCB / RRB. Bicep switched to D4 (`261d55e`); image build + deploy in flight. | 🚧 in flight (deploy running, fire pending) | `261d55e`, `4dd5382` |
| **G** | **513-cohort fire on D4 dedicated.** Cohort = `data/cohorts/pm-refresh-2026-q2.json`. Operator-triggered after F outcome review. | ⏳ pending F outcome | — |
| **H** | D4 auto-revert post-cohort — two-step Bicep (job → Consumption, then env drains d4-jobs). Per operator: don't pay for containers when no run is active. | ⏳ pending G | — |
| **I** | Post-cohort analysis — re-measure `cloud_capability` outcomes, run all quality gates, write sprint-close retro DRAFT (per `feedback_sprint_close_consent`, operator approves close). | ⏳ pending G + H | — |

## Goal in one sentence

Restore the 2026-05-28 pack baseline (8,369 slabs, 428 banks-with-any-variant), wire `cloud_capability` into the cohort splitter so cloud-incapable banks route to local automatically, and ship a pre-publish slab-coverage gate so a Sprint-009-style regression can't reach the PM consumer again.

## Why Sprint 010 looks like this

Sprint 009 closed with two mixed results:

1. **Infrastructure goal — met.** The 198-bank `9zulerb` cohort ran cleanly on the Dedicated D4 profile in 3h57m; the kernel-isolation hypothesis is confirmed. Bicep is back on Consumption and the cohort-level no-progress watchdog (Phase 9.7) is wired.

2. **Content goal — regressed.** The post-cohort pack rebuild shows +60 net-new banks but **−1,979 total slabs (−24 %)** versus the May-28 baseline. 18 top banks (Axis, BoB, ICICI, Yes, Bandhan, Kotak, Barclays, …) hit `partial_silent` short-circuits during the cohort and lost variant slabs; ~90 small co-ops / DCCBs / RRBs regressed to zero slabs. Neither effect would have shipped if a pre-publish coverage gate had blocked the pack.

Sprint 009 close-out also produced a 132-bank cloud-incapable *candidate* list (`data/sprint-009-cloud-incapable-candidates.json`) with 19 high-confidence multi-signal banks. That list isn't actionable yet — `lib/cohort/splitter.js` only reads `cloud_block_status`, not capability — but it's the seed for the cloud/local lane policy this sprint wires in.

Sprint 010's job is to make sure a refresh cohort *and* a fresh pack are both net-positive before the next publish, and to make the routing system structurally aware of which banks belong in cloud at all.

## Operator decisions needed (before sprint opens)

| # | Question | Default if no decision |
|---|---|---|
| 1 | **Recovery policy for the lost slabs** — git-checkout the prior `output/latest/*` files for the 18 partial_silent banks (option A from the close-out), or local-run them fresh (option B)? | A — git-checkout per-bank is cheapest and restores known-good state. |
| 2 | **Pre-publish gate threshold** — block pack build on >10 % slab drop? >5 %? Any HIGH-confidence bank losing all slabs? | >10 % global drop OR any HIGH-confidence bank losing > 50 % of slabs. |
| 3 | **`cloud_capability` decay window** — how long until a bank flagged cloud-incapable gets re-probed? | 60 days (longer than the 30-day WAF window because capability changes more slowly). |
| 4 | **Bank #315** (the 5kz1vm8 freeze bank) — investigate or skip? | Investigate via single-bank local smoke before any further cohort run includes it. |
| 5 | **Banswara + Barmer 3-second crash** — investigate this sprint or defer? | Investigate; both Rajasthan CCBs with identical signatures, likely a one-line config-load bug. |

## Eight phases (proposed)

| # | Phase | Primary deliverables | Depends on | Risk |
|---|---|---|---|---|
| 0 | **Slab restoration (path A)** | `git checkout` `output/latest/<bank>_*_rates.json` for the 18 partial_silent banks from the pre-cohort SHA; rebuild pack; confirm slab count ≥ baseline. No code changes. | — | Low — mechanical |
| 1 | **Pre-publish slab-coverage gate** | `pack/build-pack.js` reads `pack/dist/rates-pack.json` (the previous publish) before writing; blocks if `total_slabs` drops > N % or any `confidence: high` bank loses > M % of slabs; surfaces in `dist/REPORT.md` + non-zero exit; operator override flag `--accept-regression <reason>`. Tests over synthetic before/after fixtures. | — (Phase 0 not strictly required) | Med — need to nail thresholds |
| 2 | **`cloud_capability` registry field** | Add `cloud_capability` to `bank-domains.json` entry schema with shape: `{capable: bool, confidence: enum, reason: string, first_observed: iso, last_observed: iso, observation_count: int}`. Validator updated. Migration tool to seed the 19 multi-signal banks from the Sprint-009 candidate list. Operator-override CLI: `node scripts/registry/mark-capability.js <bank> <capable|incapable> <reason>`. | — | Low |
| 3 | **Splitter integration** | Extend `lib/cohort/splitter.js#decide` to read `cloud_capability` alongside `cloud_block_status`; `capable: false` with fresh evidence → `local` lane. Tests over the 19 multi-signal banks. CLI `scripts/cohort/split.js` surfaces both reason families in its summary. | Phase 2 | Low |
| 4 | **Capability auto-update** | Post-bank hook in `run-batch.js` derives capability evidence (status, slab_count, partial_silent fingerprint emitted) per bank; rolls up to `cloud_capability` per Phase 2 schema via `safe-write`. Decay rule: after 60 days, `last_observed` is considered stale by Phase 3 splitter (analogous to Phase 9.3 WAF freshness check). | Phases 2, 3 | Med — same plumbing risk as Sprint 009 Phase 3 |
| 5 | **partial_silent recovery on top banks** | Investigate why the cohort emitted `partial_silent` on 18 top banks' multi-tab pages (ICICI, AXIS, BoB, Bandhan, Yes, …). Hypothesis: the per-tab Playwright timeout is too tight for cloud profile. Fix or carve out per-bank, then re-run the 23 single-signal `partial_silent` banks to recover slabs. | — (Phase 1 helps catch any further regression) | High — root-cause work; outcome uncertain |
| 6 | **banswara + barmer crash + bank #315** | Reproduce locally (banswara, barmer = 3-second exit code 1; bank #315 = the 5kz1vm8 freeze trigger). Fix or carve to local lane. | — | Med — debug-heavy |
| 7 | **Out-of-process cohort heartbeat (watchdog v2)** | A sidecar process or secondary container polling the cohort's progress blob from outside the cohort container. Catches event-loop-frozen cases the Phase 9.7 watchdog can't. Decision point: is this Sprint 010 scope or deferred to a Container-side investigation sprint? | Phase 9.7 (existing) | High — first encounter with multi-container CAJ orchestration |
| 8 | **Retro** | Standard close-out per `feedback_sdlc_process`. | All | — |

Phases 0–4 are the minimum viable Sprint 010 — without them, no fresh pack ships with quality guarantees. Phases 5–7 are scope-as-budget-allows.

## Exit criteria

| # | Criterion | How we'll measure |
|---|---|---|
| 1 | Restored pack ≥ 2026-05-28 baseline on `total_slabs` and `banks_with_any_variant` | `pack/dist/rates-pack.json` counts vs `logs/sprint-009/baseline-pack-2026-05-28.json` |
| 2 | Pre-publish gate blocks a synthetic > 10 % regression in tests | `tests/pack/coverage-gate.test.js` (new) |
| 3 | `cloud_capability` populated for ≥ 19 banks (the Sprint-009 multi-signal candidates) | `bank-domains.json` diff |
| 4 | Splitter routes the 19 to `local` lane in a dry-run over `pm-refresh-2026-q2.json` | `node scripts/cohort/split.js --dry-run` output |
| 5 | partial_silent root cause identified for ≥ 1 of the 18 single-signal banks | impl doc + commit |
| 6 | Banswara / Barmer reproducible locally with a clear root cause | impl doc |
| 7 | Sprint retro committed | `sdlc/sprints/sprint-010/retrospection/retro.md` |

## Non-goals

- **No new cohort run in cloud** until phases 0–4 are landed. We'd just regress the pack again.
- **No D4 dedicated profile.** Sprint 010 lives on Consumption; Sprint 011 may revisit if Phase 6 + 7 outcomes warrant.
- **No `lib/manifest/per-bank-manifest.js` wire-up.** Carried over from Sprint 006 Step 4 / Sprint 009 retro item; still desirable but not in scope this sprint.
- **No pack schema change.** Adding `cloud_capability` is registry-side only.

## Sprint 009 carry-overs absorbed into this sprint

- Pack-quality regression recovery (Sprint 009 retro item 1) → Phase 0.
- Pre-publish slab-coverage gate (Sprint 009 retro item 2) → Phase 1.
- Banswara + Barmer crash (item 3) → Phase 6.
- Bank #315 single-bank smoke (item 4) → Phase 6.
- Out-of-process cohort heartbeat (item 5) → Phase 7 (conditional).
- Consumption-profile root cause (item 6) → deferred to Sprint 011 (depends on Phase 7 outcome).
- Receipt-blob colon-path migration (item 7) → deferred (quality-of-life).
- `lib/manifest/per-bank-manifest.js` wire-up (item 8) → deferred.

## File pointers

- Sprint 009 retro (addendum at bottom): `sdlc/sprints/sprint-009/retrospection/retro.md`
- Cohort outcome + pack comparison: `sdlc/sprints/sprint-009/implementation/cohort-9zulerb-outcome-and-pack-comparison-2026-06-06.md`
- Cloud-incapable candidates: `sdlc/sprints/sprint-009/implementation/cloud-incapable-candidates-2026-06-06.md`
- Candidate JSON: `data/sprint-009-cloud-incapable-candidates.json`
- Baseline pack snapshot: `logs/sprint-009/baseline-pack-2026-05-28.json`

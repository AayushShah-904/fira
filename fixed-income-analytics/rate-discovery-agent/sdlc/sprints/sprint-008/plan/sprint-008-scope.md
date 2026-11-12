# Sprint 008 — extraction-correctness confidence program

**Sprint window:** 2026-05-27 → TBD
**Branch:** `azure-openai-agent` (continues from Sprint 007)
**Status:** Plan approved by operator 2026-05-27 (auto mode). SDLC scaffolding in progress.

## Goal in one sentence

Make extraction correctness **measurable and continuously enforced** — for template *and* non-template banks — so the operator can state, with a number, how much of the published pack to trust, and so the bug classes that silently shipped in Sprint 007 are caught automatically.

## Why Sprint 008 looks like this

Sprint 007 delivered a 517-bank / 8,591-slab pack (zipped + emailed to the PM, 2026-05-26). But independent Tier-2 verification of 55 flagged quality-gate items found **29 genuinely wrong** — senior/general column swaps, a loan table read as FD, a Sri-Lankan currency table, collapsed FCNR currencies, truncated ladders. These all produce *plausible* numbers, so every existing gate (bounds + vs-baseline regression) passed them. The operator does not have full faith in the data, and the data justifies that.

The root causes are structural, not one-off:

1. **No durable source snapshot.** Re-verifying a slab requires a live re-fetch of a page that may have changed; there is no ground truth to check against. (`scripts/refresh/detect-changes.js#persistBody` fetches bodies but discards `unchanged`/`unreachable` and buries the rest under transient `output/refresh/<ts>/fetched/`.)
2. **No semantic checks.** Nothing classifies FD-vs-loan/savings tables, nothing checks senior-premium against peers, nothing detects an intrinsically truncated ladder. The gate only sees absolute bounds and deltas vs a baseline that may itself be wrong.
3. **No measured error rate.** The doubt is unquantified. The golden tests that *would* measure correctness (`tests/extractors/golden.test.js`, ~50 fixtures) are dormant — live assertions skipped because `<bank>.html` companions were never captured, and not enforced in CI.

There is good news the program builds on: an honest cross-check seam already exists (`scripts/refresh/verify-with-llm.js` re-extracts via LLM and diffs via `diffSlabs()` from `extract-and-diff.js`), the anti-fabrication `source_row_text` contract is solid, and four independent extractors (template/vision/OCR/PDF) are wired.

## Operator decisions (2026-05-27)

| Question | Decision |
|---|---|
| Publish timing | Pack already published (zipped + emailed to PM) → confidence work is the next cycle, not a ship blocker |
| Scope ambition | **Full 6-phase program** |
| Audit verification mode | **Hybrid** — LLM-as-judge over snapshots; human adjudicates only CONTRADICT cases |
| Snapshot storage (adopted default) | Local `output/snapshots/` — blobs gitignored, `index/` + `_index.json` tracked as a provenance ledger; keep N=3 per variant + golden-pinned |
| Surface confidence in published pack (adopted default) | Behind `BIRD_EMIT_CONFIDENCE` (default off); internal report always on. Flip on once numbers are trusted |

## Authoritative plan

Working scratch: `~/.claude/plans/lexical-bubbling-naur.md`. The authoritative committed copy is this file plus the per-phase design docs in `../design/`.

## Six phases

| # | Phase | Primary files | Depends on | Status |
|---|---|---|---|---|
| 3 | **Deterministic semantic checks** (ship first; independent) | `lib/checks/structural-checks.js`, `scripts/analysis/rate-sanity-audit.js`, `scripts/quality-gate.js` | — | Pending |
| 1 | **Source-snapshot substrate** (keystone) | `lib/snapshot/snapshot-store.js`, `scripts/refresh/detect-changes.js`, `lib/actions/fetch_page.js`, `lib/fetch/fetch_pdf.js`, `scripts/snapshot/backfill-snapshots.js` | — | Pending |
| 2 | **Sampling correctness audit** (hybrid) | `scripts/audit/sample-correctness-audit.js` | Phase 1 | Pending |
| 4 | **Systematic independent cross-check** | `lib/llm/reextract-prompt.js`, `scripts/audit/cross-check-all.js` | Phase 1 | Pending |
| 5 | **Composite confidence score + tiered publication** | `lib/confidence/score.js`, `pack/build-pack.js`, `scripts/quality-gate.js` | Phases 2/3/4 | Pending |
| 6 | **Activate dormant golden regression gate** | `scripts/snapshot/backfill-golden-from-snapshots.js`, `tests/extractors/golden.test.js`, `package.json` | Phase 1 | Pending |

Delivery order: **3 → 1 → 2 → 4 → 6 → 5** (Phase 3 first for immediate catches; Phase 1 keystone unblocks 2/4/6; Phase 5 last as it consumes signals from 2/3/4).

## Exit criteria

| # | Criterion | Verification |
|---|---|---|
| 1 | Four semantic checks live in `lib/checks/structural-checks.js`, consumed by both audit + gate; each maps to a Sprint-007 bug class | `tests/checks/` pass; planted wrong-table / column-swap fixture is flagged by `rate-sanity-audit.js` and `quality-gate.js` |
| 2 | Snapshot store persists content-addressed sources; any slab resolvable to the exact bytes it came from | `tests/snapshot/` pass; `backfill-snapshots.js --limit 10` writes blobs + tracked index; `getSnapshotAtScrapedAt` round-trips |
| 3 | Measured per-method error rate with 95% CI produced | `sample-correctness-audit.js --judge llm --seed 42` emits `report.md` with per-stratum Wilson CI; human worklist round-trips via `--ingest` |
| 4 | Systematic cross-check yields per-method % FULL agreement; reuses `diffSlabs` + shared prompt module | `cross-check-all.js --strata template,tier2 --max-calls 50` emits `cross-check.json`; re-run confirms incremental skip |
| 5 | Per-variant `confidence_score`/`confidence_tier` emitted behind `BIRD_EMIT_CONFIDENCE`; pack schema extended | `BIRD_EMIT_CONFIDENCE=1 npm run build-pack` → variants carry fields; pack-shape test passes; `quality-gate` surfaces `needs_review` INFO count |
| 6 | Dormant golden live-assertions activated and enforced in CI | `npm run test:golden` green on current data; perturb one fixture → assertion BLOCKs |

## Risks

| Risk | Mitigation |
|---|---|
| Backfill snapshot bytes differ from original scrape (page changed) | Manifest flags `post_hoc:true`; Phase 2 labels such verdicts distinctly; mismatch routes to Phase 4, not counted as extraction error |
| LLM-as-judge is itself fallible (judging with an LLM the thing we distrust) | Hybrid: human adjudicates every CONTRADICT; report separates CONFIRM/CONTRADICT/NOT_FOUND so judge-uncertainty is visible, not hidden |
| New semantic checks produce false-positive blocks mid-cycle | `wrong_table`/`truncated_ladder` BLOCK; `senior_premium_peer_outlier`/`fcnr` WARN-only until tuned; all reuse the signed-accept escape hatch |
| Snapshot blob storage growth | Content-addressed dedup + `trim(keepN=3)` + orphan GC; blobs gitignored |
| Cross-check LLM cost across 586 variants | `MAX_CALLS` cap + `--strata` tiering + incremental skip keyed by snapshot+slabs hash; gpt-4.1-mini default |

## Out of scope / deferred

- Auto-replacement of low-agreement variants (cross-check MEASURES only; `verify-with-llm.js` keeps the replace path). Operator opt-in via `_pack_excludes.json` only.
- Cloud-side wiring of the snapshot store (local-first this sprint; revisit with the agent repo split per `project_agent_repo_split`).
- Re-running extraction to *fix* banks the audit finds wrong — Sprint 008 measures + flags; corrections are a follow-on once the error rate is known.
- Migrating the 123 static-no-template banks to templates (durability lever) — separate track, see Sprint 007 deferred #1.

## ADRs to draft this sprint

- **ADR-015 — source-snapshot substrate**: content-addressed store, retention, gitignore policy, `safe-write-exempt` rationale (Phase 1).
- **ADR-016 — confidence scoring & tiered publication**: signal inputs, `verified|needs_review` tiering, `BIRD_EMIT_CONFIDENCE` rollout (Phase 5).

## Authoring rules

- Design docs in `../design/` BEFORE implementation per phase. (`feedback_sdlc_process`, `feedback_sdlc_persistence`.)
- Implementation reports in `../implementation/` AFTER the work, dated `YYYY-MM-DD`, linking back to design.
- Mid-phase design changes require explicit operator approval + dated revision. (`feedback_design_changes`.)
- No `Co-Authored-By: Claude` in commits. (`feedback_no_coauthor`.)
- Nothing in `pack/quality-gate-accepts.json` without explicit operator approval; the Sprint 005 Phase D2 signing CLI enforces this. (`feedback_no_fake_approvals`.)
- Never overwrite real scraped artifacts in `output/latest/`; snapshot store writes a separate tree. (`feedback_preserve_scraped_artifacts`.)

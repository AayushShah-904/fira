# Sprint 010 Phase 0 — slab restoration via git-checkout

**Date:** 2026-06-07
**Outcome:** ✅ Pack restored above 2026-05-28 baseline (8,369 → 9,052 slabs, +8.2 %).

---

## What the audit found

The Sprint 010 plan scoped Phase 0 to "the 18 partial_silent banks" identified in the cohort-outcome doc. A pre-flight audit comparing `output/latest/*_rates.json` git-HEAD content against the post-cohort working-tree content revealed the regression was wider:

| Metric | Value |
|---|---|
| Tracked rate files scanned | 658 |
| Sum of slabs at HEAD | 8,677 |
| Sum of slabs in working tree (post-cohort pull) | 6,544 |
| Net delta | **−2,133 slabs** |
| Files regressed (WT < HEAD) | **232** |
| Files genuinely fresh (WT > HEAD) | 64 |
| Files unchanged | 362 |

The 18 partial_silent banks accounted for most of the *headline* slab loss (Axis −162, Bandhan −109, BoB, ICICI, etc.) but the wider 232-file set includes co-ops, DCCBs, IBU GIFTs, and a long tail of small regressions across the cohort.

**Key decision:** restore *every* file where WT slab count is strictly less than HEAD slab count, instead of just the 18 partial_silent banks. This:
- Doesn't touch the 64 genuinely-fresh files (those represent real new extractions the cohort produced).
- Doesn't touch the 362 unchanged files.
- Recovers the full 2,133-slab regression, not just the partial_silent subset.

Same spirit as Path A in the plan — "restore known-good state from git" — but applied per-file rather than per-named-bank.

## The script

`scripts/restore/restore-regressed-rate-files.js` — idempotent, supports `--dry-run`. Walks all tracked `output/latest/*_rates.json` files, compares HEAD slab count vs WT slab count, batches `git checkout HEAD --` calls (batch size 30 due to Windows command-line length limit), and deletes any stale `*.partial_silent.json` marker sidecars in `output/latest/` (otherwise pack-builder would still skip the restored variants).

Re-runnable: a second invocation finds 0 files needing restoration.

## Execution log

```
Tracked rate files scanned: 658
Current sums — HEAD 8677 / WT 6544 (net -2133)
Files to restore (WT < HEAD): 232
Total slabs to recover:       2595

  restored batch 1..30 ... batch 8..232 (232 files total)
Deleted 28 stale partial_silent.json marker(s).

(re-verify) Tracked rate files scanned: 658
Current sums — HEAD 8677 / WT 9139 (net +462)
Files to restore (WT < HEAD): 0
```

The `net +462` after restoration represents the 64 genuinely-fresh files contributing slabs above HEAD's level — these are intentional refresh wins from the cohort that we kept.

## Pack rebuild — final counts vs baseline

| Metric | 2026-05-28 baseline | Post-cohort (pre-restore) | **Post-restore (today)** | Δ vs baseline |
|---|---:|---:|---:|---:|
| `banks_total` | 517 | 577 | **577** | **+60** |
| `banks_with_regular_fd` | 410 | 320 | **430** | **+20** |
| `banks_with_any_variant` | 428 | 341 | **448** | **+20** |
| `banks_with_nri` | 59 | 58 | (rebuilt) | ≈ baseline |
| `banks_with_gift` | 18 | 16 | (rebuilt) | ≈ baseline |
| **`total_slabs`** | **8,369** | 6,390 | **9,052** | **+683 (+8.2 %)** |

Pack-builder log post-restore:
> `Banks: 577 | regular FD: 430 | any variant: 448 | slabs: 9052`

**Exit-criterion #1 of Sprint 010 (restored pack ≥ baseline on `total_slabs` and `banks_with_any_variant`) is met.**

## What this does NOT do

- No code in `lib/`, `run-discovery.js`, or the agent runtime changed. This is a data restore only — the *underlying* cause of the regression (partial_silent on multi-tab pages, zero-slab on certain co-ops) is still in the code path and will reproduce if a fresh cohort runs unchanged.
- The pre-publish coverage gate (Phase 1) would have caught this regression and prevented the bad pack from publishing. Phase 0 fixes the data; Phase 1 fixes the policy. Both are needed.
- The `cloud_capability` registry + splitter integration (Phases 2 + 3) makes the next cohort *route* the 19 known-incapable banks to local instead of letting cloud re-fail them. Phase 0 alone doesn't prevent recurrence.

## Files

- `scripts/restore/restore-regressed-rate-files.js` (new) — the restore tool
- `output/latest/*_rates.json` — 232 files updated to HEAD content
- `output/latest/*.partial_silent.json` — 28 stale markers deleted
- `pack/dist/rates-pack.json`, `pack/dist/rates-pack.schema.json`, `pack/dist/README.md` — rebuilt

Working-tree state after this phase: clean for tracked rate files (they all match HEAD), 28 untracked markers removed, pack rebuilt to a state with strictly more slabs than the 2026-05-28 baseline.

# Phase 0 — Mine existing data (handoff)

**Status:** Starting 2026-05-24.
**Parent plan:** `./sprint-005-scope.md`

## Why Phase 0

Phase 0 is the data-archaeology pass that grounds every later phase in observed reality, not assumptions. The repo already carries 633 bank extractions, 8,277 pack slabs, ~10 sprint retros, and concrete BLOCK findings on 99 banks. Skipping Phase 0 means guessing at clusters and re-discovering known failure modes; running Phase 0 first means Phases A–E are work, not exploration.

## Inputs (existing artifacts — do not modify)

| Input | Path | Used by |
|---|---|---|
| 633 bank extractions | `output/latest/<bank>_{config,rates}.json` | 0.1, 0.4, 0.5 |
| Batch results per cohort | `output/latest/_batch_results_*.json` | 0.2 |
| Current published pack | `pack/dist/rates-pack.json` | 0.2, 0.4, 0.5 |
| Quality gate findings | latest BLOCK report from `pack/dist/` | 0.2, 0.4 |
| Sprint 003 retro + impl reports | `sdlc/sprints/sprint-003/` | 0.2 |
| Sprint 004 retro + impl reports | `sdlc/sprints/sprint-004/{implementation,plan}/*.md` | 0.2 |
| Bank registry | `data/bank-domains.json` (1015 entries) | 0.1, 0.4 |
| Existing utility code | `lib/`, `scripts/utils/`, `scripts/` | 0.3 |

## Outputs (everything new lands under tmp/ or scripts/analysis/ or tests/golden-html/)

| Output | Produced by | Consumed by |
|---|---|---|
| `tmp/analysis/clusters.json` + `clusters.md` | 0.1 | Phase A1 template list, Phase E migration order |
| `tmp/analysis/failures.md` | 0.2 | Phase B escalation rungs, Phase C extractor priorities |
| `scripts/analysis/code-inventory.md` | 0.3 | Phase F delete list, Phase A-D lift map |
| `tests/golden-html/<bank>.{html,expected.json}` × 50 | 0.4 | Phase D3 regression tests |
| `tests/golden-html/regression-cases/<bank>.{html,diff.json}` × 23 | 0.4 | Phase C extractor authoring (must fix the regression) |
| `tmp/baseline-pre-reset/` | 0.5 | Phase E per-bank parity check |

## Sub-steps

### 0.1 Cluster existing 633 extractions
Script: `scripts/analysis/cluster-existing-configs.js`
- Walk `output/latest/*_config.json` + `_rates.json` pairs.
- For each, compute a draft structural signature: framework hint (from `scraper_type` + URL extension), header-vector from rate-table column headers (if config records them), slab-row-count bucket from `rates.rate_slabs.length`.
- Bucket by signature. Emit clusters ≥3 banks with: cluster size, representative bank, expected extractor module name, average slab count.
- **Hypothesis check:** plan asserts 30-35 distinct templates. If actual ≪ 30, win — extractor work shrinks. If actual ≫ 35, the architecture assumption is shaky and we revisit before Phase A.

### 0.2 Failure inventory
Script: `scripts/analysis/failure-inventory.js`
- Parse `_batch_results_*.json` for failed banks per cohort.
- Parse the most recent pack quality-gate report for regressions/anomalies.
- Cross-reference with sprint-004 retro categories (FCNR cell-loss, IBU timeout, JS wait, WAF block, wrong table picked, stale URL, senior rate absence).
- Emit `tmp/analysis/failures.md`: per failure class, affected banks + which Phase B/C component owns the fix + which manifest signal will catch it.

### 0.3 Code inventory
Hand-written: `scripts/analysis/code-inventory.md`
- Grep + read pass through `lib/` and `scripts/utils/`.
- Categorize every module: **lift verbatim** / **lift with fixes** / **replace** / **delete after stub period**.
- Pin source paths and key line numbers so the Phase A–F implementations don't need to re-discover.

### 0.4 Harvest golden baselines
Script: `scripts/analysis/harvest-goldens.js`
- Top 50 banks by current `rate_slabs.length` from `pack/dist/rates-pack.json` that are NOT in the regression list.
- For each: copy current `<bank>_rates.json` → `tests/golden-html/<bank>.expected.json`, fetch live HTML → `tests/golden-html/<bank>.html`.
- For regression-list banks (the 23): capture into `tests/golden-html/regression-cases/<bank>.html` with the pack-vs-baseline diff in `<bank>.diff.json`. The future Phase C extractor must, when re-run against this fixture, produce slab values matching the **pre-regression** baseline.

### 0.5 Baseline snapshot
Script: `scripts/analysis/baseline-snapshot.js`
- Copy `output/latest/` (whole dir) + `pack/dist/rates-pack.json` to `tmp/baseline-pre-reset/`.
- This is the ground truth that every Phase E per-bank promotion compares against (±1 slab and ±5bps on shared tenures before promotion).

## Stop condition

If 0.1 reveals the corpus is too fragmented (no cluster ≥3, long tail of unique pages), the template-first architecture is wrong-fit and we revisit the plan before any production code lands. Better to learn this in week 1 from real data than in week 6 from a stalled migration.

## Sub-step ordering

0.5 (baseline snapshot) runs first — it is pure copy and locks the ground truth before anything could accidentally mutate `output/latest/` (per [[feedback_preserve_scraped_artifacts]]). Then 0.1 (cluster) and 0.2 (failures) in parallel since they read disjoint inputs. Then 0.3 (code inventory) and 0.4 (golden harvest) — 0.4 needs the cluster output to pick fixture diversity intelligently. Implementation reports written after each sub-step completes.

## Implementation reports

One file per sub-step, dated:
- `../implementation/phase-0-baseline-snapshot-2026-05-24.md`
- `../implementation/phase-0-cluster-analysis-2026-05-24.md`
- `../implementation/phase-0-failure-inventory-2026-05-24.md`
- `../implementation/phase-0-code-inventory-2026-05-24.md`
- `../implementation/phase-0-golden-harvest-2026-05-24.md`

# Design — Phase 2: sampling correctness audit (hybrid)

**Sprint:** 008 · **Phase:** 2 · **Status:** design → implementation
**Depends on:** Phase 1 snapshots. **Answers:** "how much can I trust the data?" — a measured per-method error rate.

## Approach

`scripts/audit/sample-correctness-audit.js`. Stratify by `bank_type × extraction_method_class` (template / tier2 / static), draw a stratified random sample of (bank,variant) units (seedable), and for a few **focus slabs** per unit verify the claimed general rate against the Phase-1 **snapshot** (not a live re-fetch). Hybrid verification: an LLM judges each focus slab; a human adjudicates only the CONTRADICT cases.

### Strata & sampling
- `extraction_method_class`: `template` (registry has template/template_fcnr/template_gift), `tier2` (registry `tier2{}` or curated `extraction_method` or rate file `discovery_metadata.run_method==='tier-2'`), else `static`.
- `bank_type` from `output/latest/<slug>_config.json`.
- Stratified random, default `--n 20` units/stratum, `--seed` (recorded → reproducible) via mulberry32.
- Focus slabs per unit: key tenures near 1y/2y/3y/5y + 2 random, capped ~6 (bounds tokens).

### Verification (hybrid)
- `--judge llm` (default): for each unit, read the snapshot (`getSnapshotAtScrapedAt(bank,variant,scraped_at)` → exact bytes; falls back to latest), `readTextForLlm`, and ask the LLM to return per focus slab `CONFIRM | CONTRADICT(actual) | NOT_FOUND` as JSON. Uses `lib/azure-openai-client.js` (gpt-4.1-mini via `AZURE_OPENAI_DEPLOYMENT_MINI`). Injectable `_judge` for tests.
- Human worklist: every CONTRADICT is written to `output/audit/<ts>/worklist.md` with the snapshot blob path; the operator fills a verdict; `--ingest <worklist>` folds adjudications into a final report.
- `post_hoc` snapshots are labeled — a CONTRADICT there may be page-drift, not an extraction bug; counted separately.

### Output (`output/audit/<run-ts>/`)
- `records.json` — per-slab verdicts keyed to stratum + snapshot sha + post_hoc.
- `report.md` + `summary.json` — per-stratum **error rate = CONTRADICT/(CONFIRM+CONTRADICT)** with a **Wilson 95% CI**, NOT_FOUND rate, sample size, and extrapolated likely-wrong-slab count. `summary.json` feeds Phase 5.
- `worklist.md` — human adjudication queue (CONTRADICT only).

## Tests (`tests/audit/sample-correctness-audit.test.js`)
Pure functions: stratifier bucketing, deterministic seeded sample, Wilson CI math, `pickFocusSlabs`, `parseJudgeResponse`, `summarize`. LLM mocked via injected `_judge`. No live network.

## Out of scope
- Correcting flagged banks (measure only). Re-extraction is a follow-on once the rate is known.

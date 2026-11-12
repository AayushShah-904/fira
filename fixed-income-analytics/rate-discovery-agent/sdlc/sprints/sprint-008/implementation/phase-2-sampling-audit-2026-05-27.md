# Implementation — Phase 2: sampling correctness audit (2026-05-27)

Design: `../design/sampling-audit.md`. Status: **code complete + live-validated; full measurement run kicked off.**

## What shipped

- **`scripts/audit/sample-correctness-audit.js`** (new) — stratified random sampling audit:
  - Strata = `bank_type × extraction_method_class` (template / tier2 / static). `bank_type` from `<slug>_config.json`; class from registry + rate-file `discovery_metadata`.
  - Seeded sample (mulberry32, `--seed`), `--n` units/stratum (default 20), Fisher–Yates per stratum.
  - Focus slabs per unit = key tenures (1y/2y/3y/5y) + random top-up, capped 6.
  - **Hybrid verification:** LLM judges each focus slab against the Phase-1 **snapshot** (`getSnapshotAtScrapedAt` → exact bytes, `readTextForLlm`), returning `CONFIRM | CONTRADICT(actual) | NOT_FOUND`; the judge is injectable (`--judge none` stub for offline). gpt-4.1-mini via `AZURE_OPENAI_DEPLOYMENT_MINI`.
  - Human worklist of CONTRADICT cases → `--ingest <worklist>` folds operator verdicts into the final report.
  - Output `output/audit/<ts>/`: `records.json`, `summary.json` (feeds Phase 5), `report.md` (per-stratum **error rate = CONTRADICT/(CONFIRM+CONTRADICT)** with **Wilson 95% CI**, NOT_FOUND, post_hoc CONTRADICTs), `worklist.md`.
- **`tests/audit/sample-correctness-audit.test.js`** (new) — 10 tests over the pure functions: deterministic RNG, Wilson math + clamping, slug/variant split, extraction classification, focus-slab coverage, seeded stratified sampling, JSON-envelope stripping, judge-response mapping, summarize (NOT_FOUND excluded from denominator, post_hoc tallied).
- **`.gitignore`** — `output/audit/` + the backfill log (per-run, regenerated).

## Phase-1 backfill result (prerequisite)

`backfill-snapshots.js` (concurrency 8) over 592 variants: **522 captured** (64 blob-dedups), **70 failed** (JS-render scaffolding / WAF / TLS on some `.bank.in`), 0 orphans. The store now covers 522 variants — enough for a representative audit.

## Verified

- `node --test tests/audit/sample-correctness-audit.test.js` → **10/10**.
- Live smoke `--n 1 --max-units 3 --judge llm` (dotenv creds): judged 13 slabs, 0 CONTRADICT → 0.0% [0–22.8%], report written. Path works end-to-end (snapshot → LLM judge → Wilson CI → report).
- Full stratification dry-run: 594 units across 35 strata.

## Measurement run

Kicked off `--n 5` over all 35 strata (~133 units) to produce the first real per-method error number. Result lands in `output/audit/<ts>/report.md`; the headline + per-stratum CIs will be recorded here and in the sprint status memory when it completes. CONTRADICTs route to `worklist.md` for operator adjudication (the hybrid step).

## Notes

- NOT_FOUND is excluded from the error-rate denominator — it signals snapshot/extraction misalignment (e.g. a `post_hoc` page that drifted, or text the judge couldn't locate), not a confirmed wrong rate.
- CONTRADICTs on `post_hoc` snapshots are counted separately; they may be page-drift rather than extraction bugs, and the worklist flags them for the operator.

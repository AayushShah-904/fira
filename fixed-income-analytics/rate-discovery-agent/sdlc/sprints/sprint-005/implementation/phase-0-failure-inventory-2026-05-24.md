# Phase 0.2 — Failure inventory

**Date:** 2026-05-24
**Handoff:** `../plan/phase-0-data-mining-handoff.md`
**Script:** `scripts/analysis/failure-inventory.js`
**Outputs:** `tmp/analysis/failures.{json,md}`

## Headline

| Class | Banks | Findings | Owner under reset |
|---|---:|---:|---|
| A — Pack regressions (slab count dropped vs prior) | 33 | 35 | Phase C extractor + Phase D golden tests |
| B — Rate anomalies (invariant violations) | 25 | 75 | Phase A column_map + Phase C traceability |
| C — Cohort-run failures (agent threw/timed-out) | **0** | 0 | Phase B retry escalation |
| D — Cluster-driven failure modes (≥3 banks) | 67 | 14 clusters | (varies by cluster) |

Pack verdict: **BLOCK** (744 total findings).

## Surprise finding

**Class C is zero.** Across all 14 cohort runs in the captured baseline, no bank threw a runtime exception or rate-limit failure. The orchestrator is good at completing-without-erroring — but that's misleading: the **same banks that "completed successfully" produced zero-slab rates files** that show up under Class A as 100% regressions.

This is the single most important observation for the Phase D observability design: **today, a successful run that produced no data is indistinguishable from a successful run that produced real data**, unless you look at the rates file content. The new per-bank manifest must surface this explicitly — the `fallback_engaged` and `rows_kept` fields turn this silent failure into a loud one.

## Class A — Pack regressions (33 banks)

**Variant breakdown:** `regular=18, nre=5, fcnr=5, gift=2, nro=1, unknown=4`

Examples of the catastrophic-drop pattern:
- `bank-of-india-ibu / regular`: 8 → 0 (100% drop) → IBU cluster failure
- `kotak-mahindra-bank-limited / regular`: 18 → 0 (100% drop) → wrong-table-pick on Kotak's multi-table FD page
- `indusind-bank-ibu / gift`: 24 → 0 (100% drop) → IBU PDF extraction broke
- `hdfc-bank-ibu / gift`: 35 → 8 (-77%) → multi-currency PDF column mapping
- `barclays-bank-plc / regular`: 26 → 5 (-81%) → WAF challenge or table-picker error
- `bhatinda-central-cccb / regular`: 12 → 1 (-92%) → co-op .bank.in JS-render wait
- `bandhan-bank-limited / fcnr`: 24 → 19 (-21%) → FCNR currency-matrix cell loss

A regression-list item is, in almost every case, a **column-mapping bug or fetch-layer regression on a specific template**. Phase C extractors with golden HTML fixtures (Phase D3) make these structurally impossible: when the extractor for HDFC-IBU is added to the template registry, a golden test against the captured HTML snapshot will fail if column-mapping drifts, blocking the PR.

## Class B — Rate anomalies (25 banks, 75 findings)

**Check breakdown:** `senior_below_general=46, super_senior_below_senior=24, anomalous_gain=5`

`senior_below_general` violates the Indian FD invariant that senior citizens always earn ≥ general rate. When the gap is ≥30bps, it's flagged. Two real patterns drive this:

1. **Column-mapping inversion** — the extractor mistook the "special deposit" column for the senior column. Sample: `bandhan-bank-limited` shows `general:6.5, senior:1.0` (a 550bps inversion) across many slabs. That "1.0" is almost certainly the minimum-deposit-in-lakhs column being misread as a rate column.
2. **Senior column genuinely absent for short tenures** — some co-op banks publish senior rates only for tenures ≥3yr. The parser fills 0 or empty for shorter tenures and then the invariant fires. Sample: `ajara-urban-co-op` shows 50-125bps gaps clustered in the short-tenure rows.

Both patterns are fixed by Phase A's `column_map` per template (explicit declaration of which column means what) and the Phase C traceability assertion (every emitted slab must cite a source row that contains the rate it claims).

## Class C — Cohort runtime failures (0 banks)

Empty. This vindicates the architectural observation that **deterministic completion ≠ correct data**. The Phase D manifest closes this gap.

## Class D — Cluster-driven failure modes (from Phase 0.1)

14 failure clusters cover 67 of 129 zero-slab banks (52%). Three of them collectively unblock ~31 banks:

| Cluster (size) | Diagnosis | Owner |
|---|---|---|
| `DCCB/html_js` (7) | JS-rendered .bank.in DCCB portal, Playwright wait too short | Phase B `fetch_html` `waitForFunction` default |
| `NSUCB/html_js` (7) | Same for NSUCB on .com | Same |
| `NSUCB/unknown` (7) | Discovery never assigned scraper_type → fetch never attempted | Phase A dispatcher: default unknown → html_static, attempt fetch, re-classify |
| `DCCB/unknown` (5+3=8) | Same dispatcher bail-early | Same |
| `IBU/manual` (5+4=9) | Foreign-bank GIFT units behind login or in login-gated PDFs | Phase E stop condition → manual curation |
| `RRB/html_js` (3) | Regional rural bank JS-rendered | Phase B same fix as DCCB/html_js |
| `FB/html_js` (3) | Foreign banks (ANZ, KEB Hana, Woori) — likely WAF block behind the JS | Phase B `challenge_detect` → stealth rung |

## Cross-cutting observations

1. **Regressions and anomalies are mostly the same problem with different symptoms.** A column-mapping bug shows up as a regression (cells dropped → fewer slabs) AND as an anomaly (senior_below_general when senior column actually carries another product). Phase C extractor authoring with strict `column_map` closes both at once. **Don't double-count effort estimating these two classes** — they merge.

2. **The "unknown scraper_type" failure cluster (~31 banks)** is a dispatcher bug, not a discovery failure. The agent gives up before fetching when `scraper_type` is null. The Phase A dispatcher must default to `html_static` for unknown, attempt the fetch, and re-classify based on what the response looks like. This is the cheapest, highest-leverage Phase A code change in the entire sprint.

3. **JS-rendered .bank.in pages cluster (~20 banks)** — single Phase B fix: replace today's `waitForFunction: domcontentloaded` (effectively immediate) with `waitForFunction: () => document.querySelectorAll("table").length > 0 && /%/.test(document.body.innerText)` and a per-bank timeout override. This alone moves ~20 banks from BLOCK to PASS.

4. **IBU/manual cluster (~9 banks)** is structurally hard — login-gated PDFs. Phase E should accept this as a manual-curation stop condition rather than fight it. Operator curates `data/manual-rates/<bank>.json`, signed via the Phase D `bin/approve-accept.js` CLI.

5. **WAF-blocked foreign banks** (Amex, Bank of Nova Scotia, Barclays, Fino, ANZ, KEB Hana, Woori, Societe Generale) — most respond to `--stealth` chromium; the rest go to manual. Phase B `challenge_detect.js` makes this routing automatic instead of operator-triggered per bank.

## Feeds into

| Output | Consumed by |
|---|---|
| Class A regressions list (33 banks) | Phase 0.4 golden-harvest priority list (every regression bank becomes a `tests/golden-html/regression-cases/<bank>.html` fixture; Phase C extractor must produce pre-regression slab values against this fixture) |
| Class D cluster diagnoses | Phase B retry-escalation defaults (e.g., `html_js + .bank.in → use the table-wait waitForFunction`); Phase A dispatcher unknown-scraper-type handling |
| Class B anomaly samples (bandhan, ajara, krishna-dccb) | Phase C `column_map` design — these banks become the test cases that prove column-mapping correctness |

## Open follow-ups

- Phase 0.4 must include all 33 regression banks in `tests/golden-html/regression-cases/` so Phase C extractor authoring is regression-gated, not just slab-count-gated.
- Phase D manifest schema must include `extraction_method_drift` (when a bank flips between automatic and llm_fallback runs) — the silent-success-with-no-data pattern is the single biggest trust gap in the current pipeline.
- The 23 historical regression count from the original SDLC notes is **35 in the current baseline** (regression count grew between the SDLC note and the snapshot); update plan-level numbers when adjusting cohort scope.

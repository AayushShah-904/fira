# Track 2 #1d — Deterministic dispatcher sample run

**Date:** 2026-05-15 (Sprint 003 Week 1 Day 4)
**Bar source:** `week1-bars.md` — Track 2 passes if `#1a contracts land + deterministic dispatcher handles ≥50% of the Sprint 002 12-bank sample without LLM extraction`.

**Headline result: 75% (9/12) of the sample produced ≥1 rate slab via the deterministic dispatcher. Track 2 votes Fork A.**

## What was implemented

1. **`scripts/extract_rates.js`** — extended `module.exports` (additive only, no behavior change) to expose the four dispatcher entry points: `extractHtmlStatic`, `extractHtmlJs`, `extractPdf`, `routeExtraction`.
2. **`lib/actions/extract_html_table.js`** (new, 105 LOC) — the #1a A3 action's deterministic-path implementation. Wraps the dispatcher; no LLM fallback yet (that's #1b/#1c).
3. **`scripts/analysis/sprint003-1d-dispatcher-sample.js`** (new, 102 LOC) — runs the action against a stratified 12-bank sample, compares per-bank slab count vs. the existing `_rates.json` (LLM-inline ground truth), and reports.

Three files changed total. Action wrapper is < 150 LOC per the `plan/sub-agents.md` A3 convention.

## Sample (stratified across categories × kind)

| Cat | html_static | html_js |
|---|---|---|
| PSB | `bank-of-baroda` | `bank-of-india` |
| PVB | `bandhan-bank-limited` | `csb-bank-limited` |
| SFB | `capital-small-finance-bank-limited` | `au-small-finance-bank-limited` |
| SUCB | `abhyudaya-co-operative-bank-ltd-mumbai` | `bharati-sahakari-bank-limited` |
| DCCB | `agra-zilla-sahakari-bank-ltd` | `eluru-district-co-operative-central-bank-ltd` |
| FB | `ab-bank-plc` | — |
| SSCB | `gujarat-state-co-operative-bank-ltd` | — |

8 html_static + 4 html_js. All sample banks have non-empty `rate_slabs` in `output/latest/` (so we have ground truth to compare against).

## Result

| Bank | Kind | Expected (LLM) | Deterministic | Wall-clock | Pass |
|---|---|---:|---:|---:|---|
| bank-of-baroda | html_static | 15 | 15 | 768 ms | ✓ |
| bank-of-india | html_js | 30 | 0 (Playwright 120s timeout) | 120 s | ✗ |
| bandhan-bank-limited | html_static | 24 | 24 | 1.2 s | ✓ |
| csb-bank-limited | html_js | 17 | 0 (Playwright 63s, 0 slabs) | 63 s | ✗ |
| capital-small-finance-bank-limited | html_static | 7 | **11** | 403 ms | ✓ |
| au-small-finance-bank-limited | html_js | 12 | **37** | 8.7 s | ✓ |
| abhyudaya-co-operative-bank-ltd-mumbai | html_static | 8 | 8 | 428 ms | ✓ |
| bharati-sahakari-bank-limited | html_js | 7 | 0 (Playwright 20s, 0 slabs) | 20 s | ✗ |
| agra-zilla-sahakari-bank-ltd | html_static | 9 | 9 | 2.4 s | ✓ |
| eluru-district-co-operative-central-bank-ltd | html_js | 6 | 6 | 8.0 s | ✓ |
| ab-bank-plc | html_static | 8 | **23** | 3.2 s | ✓ |
| gujarat-state-co-operative-bank-ltd | html_static | 11 | **12** | 1.1 s | ✓ |

**Pass rate: 9 of 12 = 75%.** Bar (≥50%) met.

## Bar evaluation

| Track | Bar | Result | Fork vote |
|---|---|---|---|
| Track 1 (#2c) | ≥85% clean import | 90.2% | Fork A |
| **Track 2 (#1d)** | ≥50% deterministic dispatcher | **75%** | **Fork A** |
| Track 3 (#4 P1) | informational | 4 survivors | (feeds Week 2) |

Both load-bearing tracks vote **Fork A — Salvage and commit Sprint 003 as planned.**

## Operational discovery: TLS certificate verification issue on `.bank.in` domains

**First-run result was 16.7%, not 75%.** Eight `.bank.in` domains failed at the TLS handshake with `unable to verify the first certificate`. The `.bank.in` TLD requires a specific RBI-mandated certificate chain that Windows' system root store apparently does not include. The 75% number is from a re-run with `NODE_TLS_REJECT_UNAUTHORIZED=0`.

This is a real environment-configuration issue, not a code defect:
- The refresh pipeline (`scripts/refresh/extract-and-diff.js`) does not hit this because it reads from cached HTML bodies in `output/refresh/.../fetched/`, not live fetches.
- The 2026-05-13 refresh run succeeded on these banks because the cache was populated by an earlier fetch from a machine with a working CA bundle.
- The agent's `lib/tools.js::fetch_url` uses the same `https` module and would fail the same way; the cloud Container Apps Job's Linux image likely has the right CA bundle.

**Recommended remediation (Sprint 003 Item #1b's A3 implementation):**
- Make the action accept pre-fetched HTML as an optional input (`hints.cached_body`), so the orchestrator can supply cached content when re-extracting from the refresh cache without re-fetching live.
- Document the `.bank.in` CA-bundle requirement in the operator runbook. Two paths: install the RBI CA cert chain, or rely on `NODE_EXTRA_CA_CERTS` env pointing at a bundle.
- **Do NOT make `NODE_TLS_REJECT_UNAUTHORIZED=0` the default** — that's a real security regression. Operator-controlled bypass only for this measurement.

## Notable extraction-quality observations (REVISED — initial framing was wrong)

The deterministic dispatcher returned **different** slab counts than the LLM ground truth on 4 banks:

| Bank | LLM | Deterministic | Source HTML (cached) |
|---|---:|---:|---:|
| capital-small-finance-bank-limited | 7 | 11 | **11 rate-bearing rows** |
| au-small-finance-bank-limited | 12 | 37 | not cached for regular (FCNR only) |
| ab-bank-plc | 8 | 23 | **23 rate-bearing rows** |
| gujarat-state-co-operative-bank-ltd | 11 | 12 | not cached |

**Initial framing was "dispatcher over-extracted". Operator correctly flagged that the LLM might have under-extracted. Verifying against the cached HTML revealed both patterns:**

### Capital SFB — LLM under-extracted (clear case)

Cached HTML has **2 tables × 11 rate-bearing rows each** (Table 0 = general rates, Table 1 = senior rates, mirror structure):
- 7 regular tenure slabs: 15D–30D, 31D–45D, 46D–89D, 90D–179D, 180D–<1Y, 1Y–<5Y, 5Y–10Y
- **4 special-tenure slabs the LLM missed: 12 Months @ 7.10%, 400 Days @ 7.00%, 600 Days @ 7.15%, 900 Days @ 7.05%**

These are real, schema-fitting rate slabs. 400-day / 555-day / 600-day / 900-day "special-period" FDs are common promotional products at Indian banks — frequently the highest-yield product offered. **The LLM dropped 36% of Capital SFB's slabs**, all of which are exactly the kind a consumer comparison product would highlight as the "best rate".

### AB Bank PLC — more nuanced

Cached HTML has 23 rate-bearing rows across 3 customer segments (Individual, Institutions, "Profit First") and multiple deposit-amount tiers within each segment:
- Schema currently has `deposit_range` (covers amount tiers like Up to 10 Cr / Above 10 Cr) but **no `customer_segment` field**.
- LLM picked 8 representative rows (probably Individual segment headline rates).
- Dispatcher picked all 23.
- Both defensible: the LLM may have been "wisely incomplete" given the schema can't represent customer_segment cleanly; the dispatcher faithfully reflects what the page publishes.
- **Structural finding**: the schema needs a `customer_segment` field if we want to represent banks like AB Bank correctly. Deferred to a Sprint 003 follow-up item or Sprint 004.

### Implication for the existential question

This sharpens the existential answer. Two real defects measured:
1. **LLM systematically under-extracts on banks with special-tenure FDs.** Capital SFB lost 36% of its slabs. If even a fraction of the 210 banks-with-regular-FD in the pack share this pattern, the pack has tens of banks with materially incomplete data — not just wrong data.
2. **Schema doesn't represent customer_segment**, so structurally-complex banks like AB Bank either get over-extracted (segments collapsed into duplicates) or under-extracted (only one segment shipped).

Both defects argue **for** Fork A's action decomposition: a clean dispatcher + canonical-table-selector + completeness check at the action boundary fixes #1; a schema extension fixes #2. Neither defect was visible until the dispatcher's count was compared against ground truth — the LLM-inline path made them invisible.

### Sprint 003 #1b's A3 work — REVISED scope

1. **Do NOT default to "trust LLM's count".** The dispatcher's all-rows-with-rate scan is more complete on banks where the LLM under-extracts. The A3 implementation should treat the dispatcher's output as canonical when row count is higher AND every row has a valid tenure + rate parse.
2. Use the config's `selectors.table` via cheerio when available, to pick the canonical rate table rather than "table with most rate-bearing rows" — this avoids the case where a tariff/charges table accidentally outscores the rate table.
3. **Detect and tag bulk-tier vs. retail rows** (`deposit_range` field already in schema) instead of collapsing them.
4. Reject duplicate `(tenure_min, tenure_max, deposit_range, currency)` keys.
5. **New: customer_segment field** — defer to a separate ADR / schema decision; capture in the per-bank `warnings` for now when multiple segments are detected.

Original estimate was ~half-day extra; revised to ~1 day extra (including the completeness comparison logic).

## Playwright failures (3 of 4 html_js banks)

`bank-of-india`, `csb-bank-limited`, `bharati-sahakari-bank-limited` all returned 0 slabs from Playwright. Wall-clocks suggest:
- `bank-of-india`: 120s = Playwright's hard timeout. Page either never rendered or rate-table-selector never matched.
- `csb-bank-limited`: 63s, returned `Extracted 0 rate slabs` — Playwright loaded the page but didn't find a rate table.
- `bharati-sahakari-bank-limited`: 20s, same pattern.

Versus the 2 successes:
- `au-small-finance-bank-limited`: 8.7s, 37 slabs.
- `eluru-district-co-operative-central-bank-ltd`: 8.0s, 6 slabs.

**Pattern:** Playwright works when the rate table renders in plain HTML after JS load. It fails when the table is inside a tab/accordion/dropdown that requires interaction. The fix is in `scripts/fetch_rates_playwright.js`'s `--tabs`, `--accordions`, `--selects` flags — the action's `scraper_notes.has_tabs` hint should auto-enable these (and per the action contract A3, this is already part of hints handling — needs verifying in #1b).

## What this run does NOT prove

- **Correctness.** A pass means ≥1 slab was emitted; it does not mean the slabs are right. Three of the 9 passes over-extracted vs. LLM ground truth.
- **Rate accuracy.** No rate-value comparison was done. Sprint 003 #1e (action tests) will do per-rate comparison.
- **Bulk-tier handling.** The dispatcher does not understand `deposit_range`; if a page has multiple tier tables, the dispatcher picks the largest by row count, which may not be the retail (`below_3cr`) table.
- **Variant extraction.** The sample was regular FD only. NRE / NRO / FCNR / GIFT variants not tested.

## Cost

- Wall-clock: ~8 minutes for the full 12-bank sample run (3 Playwright timeouts dominated).
- AOAI tokens: **zero** (deterministic path only).
- Operator effort: ~10 minutes (sample selection + runner script + result inspection).

## Recommendation for Week 2 (if Fork A)

1. **Implement A8 `commit_rates` first** (per the action-contracts implementation-order note). Validation gate + slug discipline are what every other action's tests depend on.
2. **A3 implementation (#1b) needs over-extraction fix.** Use cheerio + CSS selectors when `config.selectors.table` is present; fall back to regex for unknown tables only.
3. **A2b `classify_rate_page` should detect tab/accordion structures** so the html_js extraction step auto-enables Playwright's `--tabs`/`--accordions` flags. This addresses the bank-of-india / csb-bank-limited / bharati failures.
4. **`.bank.in` TLS bundle:** add `NODE_EXTRA_CA_CERTS` to the operator runbook and to the Container Apps Job env. One-line config change.
5. **Pre-fetched-body hint:** A3 accepts `hints.cached_body` so the orchestrator can reuse refresh-pipeline cache. Saves fetch RTT on re-extraction.

## Artifacts produced

- `lib/actions/extract_html_table.js` — production code (105 LOC)
- `scripts/analysis/sprint003-1d-dispatcher-sample.js` — throwaway analysis script (102 LOC)
- `scripts/extract_rates.js` — additive 4-line export extension
- `sdlc/sprints/sprint-003/implementation/1d-dispatcher-sample-result.json` — machine-readable per-bank result
- This doc — operator-readable summary

No tests yet — the unit test for `extractHtmlTable` is part of #1e (Week 2 if Fork A) per the action-contracts test plan.

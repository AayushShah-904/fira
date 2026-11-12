# Sprint 003 Task #4 — dispatcher vs LLM extraction gap (measurement, not verdict)

**Run:** 2026-05-15T20:02:34.644Z
**Method:** ran `lib/actions/extract_html_table` (deterministic dispatcher, A3 v2) against every `output/refresh/2026-05-13T17-29-11/fetched/<bank>__<variant>.html` cached body and compared the slab count to the LLM-emitted count in `output/latest/`.
**Sample:** 232 bank-variant pairs across regular/nre/nro/fcnr/gift.

**Framing:** this measurement identifies *improvement targets* for both the dispatcher and the LLM harness, not a verdict on which extractor is "better". Both components are in our control and improvable. Categories below are buckets of work, not labels of winners and losers.

## Headline

| Category | Pairs | What this is and what to do about it |
|---|---:|---|
| equal | 11 | LLM and dispatcher agree on count. Baseline — no improvement signal here. |
| dispatcher_more | 7 | Dispatcher > LLM. Either LLM under-extracted (LLM-harness improvement target — e.g., missed special-tenure slabs) OR dispatcher picked up segment duplicates (dispatcher improvement target — needs canonical-table selector). |
| llm_more | 87 | LLM > dispatcher. Either LLM caught rows the regex missed (dispatcher improvement target) OR LLM over-extracted from non-rate rows (LLM-harness improvement target). Per-bank inspection routes the case. |
| llm_only | 104 | LLM extracted slabs; dispatcher returned 0. **Dispatcher improvement target** — usually column-mapping mismatch, multi-table page where the regex picker missed the rate table, or selector-aware picking needed. |
| both_empty | 23 | Both produced zero slabs. Often PDF/image pages or extraction-failed pages. Improvement: PDF/Vision path (A4/A5) or rate-page rediscovery. |

**Total dispatcher-extra slabs across `dispatcher_more`:** 28
**Total LLM-extra slabs across `llm_more`:** 759

Both totals are mixed: each direction holds a blend of "the other extractor missed real rows" and "this extractor picked up noise". Per-bank inspection of the top N of each is what disambiguates.

## Top 25 banks where dispatcher returned MORE slabs than LLM (potential under-extraction)

| Bank | Variant | Type | LLM | Dispatcher | Δ |
|---|---|---|---:|---:|---:|
| `rbl-bank-limited` | nre | - | 4 | 10 | +6 |
| `city-union-bank-limited` | nre | - | 5 | 10 | +5 |
| `capital-small-finance-bank-limited` | nre | - | 2 | 6 | +4 |
| `capital-small-finance-bank-limited` | nro | - | 7 | 11 | +4 |
| `capital-small-finance-bank-limited` | regular | - | 7 | 11 | +4 |
| `rbl-bank-limited` | nro | - | 6 | 10 | +4 |
| `state-bank-of-india` | nre | - | 4 | 5 | +1 |

## Top 25 banks where LLM returned MORE slabs than dispatcher

| Bank | Variant | Type | LLM | Dispatcher | Δ |
|---|---|---|---:|---:|---:|
| `hsbc-bank-ibu` | regular | - | 36 | 1 | -35 |
| `hong-kong-and-shanghai-banking-corporation-limited-hsbc` | regular | - | 26 | 1 | -25 |
| `emirates-nbd-bank-pjsc` | nro | - | 23 | 2 | -21 |
| `emirates-nbd-bank-pjsc` | regular | - | 23 | 2 | -21 |
| `bandhan-bank-limited` | nre | - | 24 | 6 | -18 |
| `bandhan-bank-limited` | nro | - | 24 | 6 | -18 |
| `bandhan-bank-limited` | regular | - | 24 | 6 | -18 |
| `axis-bank-limited` | regular | - | 18 | 1 | -17 |
| `kotak-mahindra-bank-limited` | regular | - | 18 | 1 | -17 |
| `punjab-sind-bank` | nre | - | 22 | 5 | -17 |
| `deutsche-bank-ag` | nro | - | 18 | 4 | -14 |
| `deutsche-bank-ag` | regular | - | 18 | 4 | -14 |
| `union-bank-of-india` | nro | - | 18 | 4 | -14 |
| `union-bank-of-india` | regular | - | 18 | 4 | -14 |
| `state-bank-of-india-ibu` | regular | - | 14 | 1 | -13 |
| `surat-peoples-co-operative-bank-ltd` | regular | - | 14 | 1 | -13 |
| `dbs-bank-india-limited` | nro | - | 26 | 14 | -12 |
| `dbs-bank-india-limited` | regular | - | 26 | 14 | -12 |
| `hoogly-district-central-co-operative-bank-ltd` | regular | - | 13 | 1 | -12 |
| `sbpp-co-operative-bank-ltd-killa-pardi` | regular | - | 13 | 1 | -12 |
| `guna-district-central-co-operative-bank-ltd` | regular | - | 12 | 1 | -11 |
| `idbi-bank-limited` | nro | - | 15 | 4 | -11 |
| `the-himachal-pradesh-state-co-operative-bank-ltd` | regular | - | 12 | 1 | -11 |
| `andhra-pradesh-mahesh-co-op-urban-bank-ltd` | regular | - | 11 | 1 | -10 |
| `cuddapah-district-co-operative-central-bank-ltd` | regular | - | 11 | 1 | -10 |

## Banks where the dispatcher returned ZERO (LLM had slabs)

| Bank | Variant | Type | LLM count | Notes |
|---|---|---|---:|---|
| `rbl-bank-ibu` | gift | - | 60 | rejected_or_zero |
| `uco-bank` | fcnr | - | 45 | rejected_or_zero |
| `bharat-co-operative-bank-mumbai-ltd` | regular | - | 40 | rejected_or_zero |
| `indian-bank` | fcnr | - | 40 | rejected_or_zero |
| `rbl-bank-limited` | fcnr | - | 40 | rejected_or_zero |
| `hsbc-bank-ibu` | gift | - | 36 | rejected_or_zero |
| `karnataka-bank-limited` | fcnr | - | 36 | rejected_or_zero |
| `state-bank-of-india` | fcnr | - | 36 | rejected_or_zero |
| `bank-of-baroda` | fcnr | - | 35 | rejected_or_zero |
| `city-union-bank-limited` | fcnr | - | 33 | rejected_or_zero |
| `south-indian-bank-limited` | fcnr | - | 33 | rejected_or_zero |
| `csb-bank-limited` | fcnr | - | 30 | rejected_or_zero |
| `karur-vysya-bank-limited` | fcnr | - | 30 | rejected_or_zero |
| `punjab-national-bank` | fcnr | - | 30 | rejected_or_zero |
| `the-khamgaon-urban-co-operative-bank-ltd-khamgaon` | regular | - | 30 | rejected_or_zero |
| `indusind-bank-limited` | fcnr | - | 27 | rejected_or_zero |
| `idbi-bank-limited` | fcnr | - | 26 | rejected_or_zero |
| `canara-bank` | fcnr | - | 25 | rejected_or_zero |
| `natwest-markets-plc` | fcnr | - | 25 | rejected_or_zero |
| `bandhan-bank-limited` | fcnr | - | 24 | rejected_or_zero |
| `indusind-bank-ibu` | gift | - | 24 | rejected_or_zero |
| `punjab-sind-bank` | fcnr | - | 24 | rejected_or_zero |
| `hong-kong-and-shanghai-banking-corporation-limited-hsbc` | fcnr | - | 23 | rejected_or_zero |
| `equitas-small-finance-bank-limited` | regular | - | 22 | rejected_or_zero |
| `jalgaon-janata-sahakari-bank-ltd` | regular | - | 22 | rejected_or_zero |

## Caveats

1. **Dispatcher_more does NOT prove under-extraction**: the dispatcher's naive "pick-all-rate-bearing-rows" heuristic produces over-extraction on banks with multiple customer segments (AB Bank style) or mirror tables (general+senior shown as separate tables). Capital SFB-style cases (LLM missed 4 special-tenure rows) are mixed in here with structural-duplicate cases.
2. **LLM_more does NOT prove the dispatcher is broken**: the LLM may have caught rows in tables the regex parser failed on, OR transcribed PDF content into HTML responses, OR captured operator-curated manual rates.
3. **The scope this run can establish**: how many banks have non-zero diff (the universe of candidates needing per-bank inspection). The Capital SFB case (slabs 7 vs 11) shows up here; so does AB Bank (8 vs 23). Both need different fixes — the former is a real LLM miss to plug in A3, the latter is a schema gap.
4. **Banks not in this run**: any bank whose body was not cached on 2026-05-13 (97 unreachable + 65 extraction-failed + banks not in the cohort) cannot be measured here; under-extraction scope on those is unknown.

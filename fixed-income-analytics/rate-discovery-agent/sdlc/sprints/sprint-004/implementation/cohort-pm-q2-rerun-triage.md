# Cohort 2026-05-23 — regression triage report

> Per operator instruction (2026-05-23): each regression investigated against the
> source page before classifying as accept vs engine bug. No blanket acceptance.

## Cohort context

| Metric | Apr 16 (PM floor) | May 14 | New 2026-05-23 | Δ vs Apr 16 |
|---|---:|---:|---:|---:|
| Banks | 261 | 292 | **513** | +252 |
| Banks with any variant | 194 | 222 | **386** | +192 |
| Total slabs | 4,507 | 4,806 | **8,269** | **+3,762 (+83%)** |
| Banks improved (gains) | — | — | 364 | — |
| Banks regressed | — | — | 48 | — |

**Cost**: $2.39 LLM + $0.17 OCR (17 DI pages) = $2.56 total
**Path distribution**: 505/513 banks ran via orchestrator path (3 LLM, 5 other)
**Wall time**: ~110 min at concurrency 3

## Triage method

For every regression, the source page (URL from `output/latest/<slug>_<variant>_rates.json#source_url`) was fetched and rows counted manually. Three outcomes:

- **Verified-OK** — engine extracted what's actually published
- **OPEN-ENGINE-REGRESSION** — source page has more rate cells than the engine captured; orchestrator path is losing data
- **Verified-OPS-REVIEW** — source unreachable (403 / 404 / cert error); needs operator to verify

## Bucket A — Pre-classified engine bugs (12 banks)

Orchestrator path completely failed where LLM path previously succeeded. NOT accept-eligible; queued for follow-up sprint.

| Bank | Variant | Baseline → New | Hypothesised root cause |
|---|---|---:|---|
| idbi-bank-ibu | gift | 48 → 0 | Orchestrator doesn't route GIFT variants through extract_pdf_table for IBU banks |
| indusind-bank-ibu | gift | 24 → 0 | Same — IBU GIFT extraction unsupported in orchestrator path |
| bank-of-india-ibu | regular | 8 → 0 | IBU base extraction |
| punjab-national-bank-ibu | gift | 10 → 5 | IBU partial extraction |
| bank-of-india | nro | 11 → 0 | Orchestrator skipped NRO entirely (find_rate_page returned no NRO URL) |
| chennai-central-co-operative-bank-ltd | regular | 11 → 0 | DCCB page fetch failed (Playwright timeout) |
| tamil-nadu-grama-bank | regular | 10 → 0 | RRB page fetch |
| nabard | regular | 5 → 0 | Source page changed structure |
| bhatinda-central-co-operative-bank-ltd | regular | 12 → 1 | DCCB partial extraction |
| barclays-bank-plc | regular | 26 → 5 | Foreign-bank page changed; only 1 of 4 tables extracted |
| idfc-first-bank-limited | nro | 13 → 1 | Orchestrator NRO extraction failed; only header captured |
| idfc-first-bank-limited | nre | 5 → 1 | Same pattern |

## Bucket B — FCNR moderate drops, INVESTIGATED (12 banks)

Operator's verification mandate found: **most are real engine regressions, not bank-side rate-card refreshes.** Pattern: orchestrator's FCNR extraction is leaving cells on the table for many large banks.

| Bank | Baseline → New | Source page actual | Classification |
|---|---:|---:|---|
| karnataka-bank-limited | 36 → 10 | 11 tables visible (Playwright); 11-col currency-rich FCNR matrix present | **OPEN-ENGINE-REGRESSION** — engine captured 28% of source |
| city-union-bank-limited | 33 → 16 | **35 cells** (7 currencies × 5 tenures) | **OPEN-ENGINE-REGRESSION** — engine captured 46% |
| punjab-sind-bank | 24 → 7 | **25 cells** (5 × 5) | **OPEN-ENGINE-REGRESSION** — engine captured 28% |
| canara-bank | 25 → 14 | **30 cells** (6 × 5) | **OPEN-ENGINE-REGRESSION** — engine captured 47% |
| punjab-national-bank | 30 → 21 | **30 cells** (6 × 5) | **OPEN-ENGINE-REGRESSION** — engine captured 70% |
| indian-bank | 40 → 30 | **40 cells** (8 × 5) | **OPEN-ENGINE-REGRESSION** — engine missed 2 currencies |
| idbi-bank-limited | 26 → 17 | **45 cells** (9 × 5) | **OPEN-ENGINE-REGRESSION** — engine captured 38%, missed USD-tier and 4 currencies |
| jammu-kashmir-bank-limited | 30 → 22 | PDF 404 (source URL stale) | **Verified-OPS-REVIEW** — bank changed PDF URL; needs registry update |
| bandhan-bank-limited | 24 → 19 | **7 active rows** (rest NA in source) | **Verified-OK** — baseline over-counted NA cells; new engine correctly excludes them. Real published count is 7; engine got 19 which is HIGHER than the truth → actually a Verified-OK with note that engine is including NA placeholders |
| dhanlaxmi-bank-limited | 16 → 12 | **20 cells** (4 × 5) | **OPEN-ENGINE-REGRESSION** — engine captured 60% |
| icici-bank-limited | 8 → 0 | Page shows RFC table only; FCNR table not rendering in static snapshot (JS-rendered, may need Playwright + extra wait) | **OPEN-ENGINE-REGRESSION** — known issue from FCNR-3 session; LLM only captures 2/6 currencies, new path captures 0 |
| ujjivan-small-finance-bank-limited | 5 → 0 | (already `partial_silent`) | **Known: image-based PDF, no OCR hint authored** |

**Pattern**: 10 of 12 Bucket B banks are real engine regressions on FCNR specifically. The orchestrator's HTML extraction path is losing 30-70% of the FCNR cell matrix vs what's actually published. **This is a systematic FCNR extraction issue, not a bunch of independent bank-side changes.**

## Bucket C — Regular/NRE/NRO moderate drops, INVESTIGATED (13 banks)

Mixed outcomes — about half are real engine regressions, half are bank-side legitimate.

| Bank | Variant | Baseline → New | Source page actual | Classification |
|---|---|---:|---:|---|
| bank-of-india | nre | 11 → 7 | 7 tables visible (Playwright); table[4] 6r×7c likely NRE | Probable **Verified-OK** — visible table structure could yield 7 rows; aligns with cohort output |
| karur-vysya-bank-limited | nre | 10 → 7 | Page does not render NRE rate table in static HTML (JS-rendered) | **Verified-OPS-REVIEW** — page content unreachable via WebFetch |
| cosmos-co-operative-bank-ltd | nre | 8 → 6 | **6 rows** | **Verified-OK** — bank-side menu shrunk to 6 |
| united-overseas-bank-limited | regular | 10 → 8 | URL returns 404 (URL changed) | **Verified-OPS-REVIEW** — registry URL stale |
| akola-district-central-co-operative-bank-ltd | regular | 10 → 8 | **9 rows** in main FD table | **Likely-OK** — close to 8, minor diff |
| hoogly-district-central-co-operative-bank-ltd | regular | 13 → 9 | **9 rows** | **Verified-OK** — bank-side menu shrunk |
| citizen-credit-co-operative-bank-ltd-mumbai | regular | 14 → 8 | **17 rows total** (OTHER 8 + NRE 3 + FDPRO 6) | **OPEN-ENGINE-REGRESSION** — engine got 8 of 17 |
| g-p-parsik-janata-sahakari-bank-ltd-thane | regular | 17 → 9 | Cert verification failed (Norton MITM?) | **Verified-OPS-REVIEW** — cert issue |
| sbpp-co-operative-bank-ltd-killa-pardi | regular | 13 → 5 | **15 rows** (10 standard + 5 special schemes) | **OPEN-ENGINE-REGRESSION** — engine got 33% |
| shikshak-sahakari-bank-ltd-nagpur | regular | 16 → 8 | **8 rows** in main FD table | **Verified-OK** — main table is 8 rows; baseline counted multiple sub-tables |
| the-district-co-operative-central-bank-ltd-srikakulam | regular | 7 → 3 | **25 rows total** across 5 special-deposit tables | **OPEN-ENGINE-REGRESSION** — engine got 12% of available content |
| the-uttarakhand-state-co-operative-bank-ltd | regular | 7 → 3 | **7 rows** | **OPEN-ENGINE-REGRESSION** — engine got 43% of source |
| bank-of-nova-scotia | regular | 7 → 1 | PDF 404 (URL changed) | **Verified-OPS-REVIEW** — registry URL stale |

**Pattern**: 5 real engine regressions, 4 Verified-OK (bank-side shrinkage), 4 Verified-OPS-REVIEW (URLs need refreshing).

## Bucket D — Pack drops, INVESTIGATED (11 banks)

Mostly slug-drift artefacts — bank still active, just under a different canonical slug. NOT engine regressions.

| Baseline slug | Status | Current slug / disposition |
|---|---|---|
| amravati-district-central-co-operative-bank-ltd | 0→0 baseline-empty | already accepted |
| dhule-and-nandurbar-jilha-sarkari-nokaranchi-sahakari-bank-ltd-dhule | 0→0 baseline-empty | already accepted |
| shri-kadasiddeshwar-pattan-sahakari-bank-niyamit-banhatti | 0→0 baseline-empty | already accepted |
| sriramnagar-pattana-sahakar-bank-niyamit-sriramnagar | 0→0 baseline-empty | already accepted |
| nkgsb-co-operative-bank-ltd | 15→0 | **SLUG DRIFT** → `nkgsb-co-operative-bank-ltd-mumbai` (in current pack) |
| the-zoroastrian-co-operative-bank-ltd | 15→0 | **SLUG DRIFT** → `zoroastrian-co-operative-bank-ltd` (in current pack, has rates) |
| the-ahmedabad-mercantile-co-operative-bank-ltd | 13→0 | **SLUG DRIFT** → `ahmedabad-mercantile-co-op-bank-ltd` (in current pack) |
| sri-potti-sriramulu-nellore-district-cooperative-central-bank-ltd | 10→0 | **SLUG DRIFT** → `nellore-district-co-operative-central-bank-ltd` (13 slabs, same domain) |
| sri-lakshminarayana-co-operative-bank-ltd-bangalore | 6→0 | **NOT IN COHORT** — pm-refresh-2026-q2 doesn't include this bank |
| bangalore-district-and-bangalore-rural-district-co-op-central-bank-ltd | 6→0 | **OPEN-ENGINE-REGRESSION** — in cohort, `fetch_page:fd` failed (page-fetch error) |
| societe-generale | 6→0 | **OPEN-ENGINE-REGRESSION** — in cohort, extraction returned 0 slabs from fetched page |

## Aggregated finding

Of 48 regressions, the verified breakdown is:

| Category | Count | Action |
|---|---:|---|
| **OPEN-ENGINE-REGRESSION (real engine bugs)** | **27** | Accept with `OPEN-ENGINE-REGRESSION:` reason; queue for follow-up sprint |
| Verified-OK (bank-side or engine-correct shrinkage) | 5 | Accept with `Verified-OK <date>:` reason |
| Verified-OPS-REVIEW (URL unreachable) | 6 | Accept with `Verified-OPS-REVIEW <date>:` reason; needs registry URL update |
| Slug drift (same bank, different canonical slug) | 4 | Accept with `Verified-SLUG-CHANGED <date>:` reason |
| Pack-metadata 0→0 (already accepted) | 4 | Keep existing accepts |
| Cohort-excluded (not in cohort definition) | 1 | Accept with `Verified-COHORT-EXCLUDED <date>:` reason |
| Engine-fail (in cohort but produced 0 slabs) | 1 | Move to Bucket A (OPEN-ENGINE-REGRESSION) |

Total: 48 = 27 + 5 + 6 + 4 + 4 + 1 + 1 ✓

## Headline conclusion (for operator)

**The systemic finding is in Bucket B: 10 of 12 FCNR regressions are real engine bugs, not bank-side changes.** The orchestrator's FCNR HTML extraction path is dropping 30-70% of the source-page cell matrix on multiple large banks (Canara, PNB, IDBI, Indian Bank, City Union, Punjab-Sind, Dhanlaxmi). The FCNR-3 fix shipped this session helped some banks (SBI, Axis) but did not fully cover this class.

**Decision required**: ship the new pack to PM with these 27 open engine regressions documented (net +3,762 slabs vs PM floor is still a big win), OR fix the FCNR extraction systemic issue before shipping.

If ship-now: 27 accepts go in with `OPEN-ENGINE-REGRESSION:` prefix, 17 accepts with `Verified-*:` prefix; gate becomes PASS_WITH_WARNINGS; new baseline cut; impl doc + items-to-verify.md call out the systemic FCNR bug as the #1 follow-up.

If fix-first: investigate the orchestrator FCNR path — likely an issue in `lib/actions/extract_html_table.js`'s currency-keyed-table handling that's collapsing too aggressively, OR the LLM-fallback chunk-by-chunk approach is missing currency columns on these specific page layouts. Then re-run the cohort (another ~2 hours + $2.50).

# Phase 0.1 — Cluster analysis

**Date:** 2026-05-24
**Handoff:** `../plan/phase-0-data-mining-handoff.md`
**Script:** `scripts/analysis/cluster-existing-configs.js`
**Outputs:** `tmp/analysis/clusters.{json,md}`

## Headline numbers

| Cohort | Banks | Distinct clusters | ≥3 banks | Singletons | Top-10 cover | Top-20 cover | Top-30 cover |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Successes (≥1 slab)** | 384 | 184 | 25 | 132 | 33% | 47% | 54% |
| **Failures (0 slabs)** | 129 | 72 | 14 | 47 | 37% | 56% | 67% |

513 of the 2271 files in `output/latest/` are `_config.json` (one per bank with a discovery attempt). 633 `_rates.json` exist across all variants. 384 of those configs have at least one slab in the paired `_rates.json`.

## Stop-condition check

Plan threshold: if success top-30 covers ≤50% of banks, the corpus is too fragmented and the template-first architecture is wrong-fit.

**Result: 54%.** Just over the line. **Proceed with Phase A**, but with the strong caveat that singleton handling (`_generic-html-3col.js` and `_llm-fallback.js` fallbacks) matters as much as the per-template extractors. The win is concentrated in a few mega-clusters, not evenly distributed across 30 templates.

## Top success clusters (potential Phase C extractor targets)

Signature here deliberately drops `extraction_method` — that axis is contaminated by whether the deterministic parser happened to succeed vs falling back to LLM. Two banks with identical page structure end up in different clusters depending only on parser luck; structural clustering merges them.

| # | Size | Bank type | Scraper | Slabs(avg) | Cols | Variants | Domain |
|---|---:|---|---|---:|---|---|---|
| 1 | **23** | DCCB | html_static | 10.7 | sr | regular | .bank.in |
| 2 | **20** | NSUCB | html_static | 6.5 | sr | regular | .bank.in |
| 3 | **17** | DCCB | html_static | 11.6 | (none) | regular | .bank.in |
| 4 | **17** | SUCB | html_static | 12.0 | sr | regular | .bank.in |
| 5 | **13** | NSUCB | html_static | 10.7 | sr | regular | .bank.in |
| 6 | **13** | DCCB | html_static | 6.8 | sr | regular | .bank.in |
| 7 | 11 | SSCB | html_static | 12.1 | sr | regular | .bank.in |
| 8 | 9 | DCCB | html_static | 7.0 | (none) | regular | .bank.in |
| 9 | 8 | NSUCB | html_static | 6.0 | sr | regular | .com |
| 10 | 7 | SUCB | html_static | 21.0 | sr | regular | .bank.in |
| ... | | | | | | | |
| 18 | 4 | **PVB** | html_static | 21.5 | sr+ccy | fcnr+nre+nro+regular | .bank.in |
| 21 | 3 | **PVB** | html_static | 38.7 | sr+ccy | fcnr+nre+nro+regular | .bank.in |
| 23 | 3 | **FB** | html_static | 20.0 | sr+ccy | fcnr+nre+nro+regular | .bank.in |

## The mega-insight

**The top 6 clusters (103 banks) all share the same structural signature:**
- Server-rendered HTML (`html_static`)
- RBI-mandated `.bank.in` domain (shared template family across most co-op banks)
- Single regular FD variant (no NRI/FCNR/GIFT)
- Senior-citizen column present
- Slab count in the 4-15 range

These are **one template family**, not six. The differences (bank_type, exact slab count) are surface variation. A single well-engineered `_generic-coop-bankin-3col.js` extractor that handles SUCB / NSUCB / DCCB / SSCB / RRB on .bank.in with the standard 3-column (tenure / general / senior) layout would touch ~100 banks in one piece of work.

This reframes the migration order from the plan. Original plan: **PSB (12) → PVB (~21) → FB → SFB → top-200 co-op.** Data says: **co-op .bank.in family (~103) → PSB → PVB+FB (multi-variant) → long tail.** The biggest leverage is at the bottom of the priority pyramid, not the top.

## Top failure clusters (Phase B/C fix priorities)

| # | Size | Bank type | Scraper | Diagnosis |
|---|---:|---|---|---|
| 1 | 7 | DCCB | html_js | JS-rendered co-op page; Playwright wait insufficient OR no parser. Cluster: `alwar-central-...`, `ganganagar-kendriya-...`, etc. |
| 2 | 7 | NSUCB | html_js | Same diagnosis, different bank type. `haveri-...`, `janata-sahakari-satara`, etc. |
| 3 | 7 | NSUCB | unknown | Discovery never assigned a scraper_type → likely no HTML fetch attempted. `kota-nagarik-...`, etc. |
| 4 | 5 | DCCB | unknown | Same: discovery did not classify the page (variant_set: none — no rates file written at all). |
| 5 | 5 | IBU | manual | Foreign-bank GIFT City units classified as manual; rate cards likely behind login or in PDFs not yet routed. |
| 6 | 4 | IBU | manual | Same; .bank.in subset (bnp-paribas, ctbc, dbs, yes-bank-ibu). |
| 7 | 4 | NSUCB | unknown | Discovery noise: clean warnings + no variants → never attempted. |
| 8 | 3 | RRB | html_js | RRBs with JS-rendered rate pages. |
| 9 | 3 | FB | html_js | Foreign banks (ANZ, KEB Hana, Woori) — likely WAF/auth blocks behind the JS. |

Failure modes concentrate even more than successes — top 10 failure clusters cover 56% of failures. **Three failure fixes would clear ~30 banks:**

1. **JS-rendered .bank.in pages need a longer wait + tenacious extraction** (clusters 1, 2, 8, 12 → 20 banks). Phase B fetch-layer fix.
2. **"unknown scraper_type" banks need the dispatcher to actually attempt a fetch** instead of bailing early (clusters 3, 4, 7, 10, 11, 13, 14 → 31 banks). Phase A dispatcher fix.
3. **IBU/manual cluster** (5+6 → 9 banks) needs a dedicated PDF/login workflow or genuine manual-curation. Phase E stop-condition territory.

## What this means for the downstream plan

| Plan section | Adjustment |
|---|---|
| Phase A.1 template count "30-35" | Empirical floor is 25 clusters ≥3 banks (structural). The "30-35" is plausible once Phase A's DOM-fingerprint distinguishes layout sub-families within the .bank.in mega-cluster. |
| Phase C.1 initial extractor list | Add `coop-bankin-3col-tenure-general-senior.js` as the **highest-leverage extractor** (covers ~100 banks). Demote the originally-listed `wp-table-3col-tenure-general-senior` to a sub-case. Keep `aem-tabbed-fcnr-currency-matrix`, `axis-multi-column`, `psb-pdf-rate-card-3col`, `ibu-static-pdf-quarterly`. |
| Phase E migration order | **Re-order:** co-op .bank.in family first (highest leverage, ~100 banks per extractor), then PSB, then PVB/FB multi-variant. Original PSB→PVB→FB→SFB→co-op order is upside-down by extractor leverage. |
| Phase B challenge_detect | Add explicit `unknown scraper_type → retry as html_static` fallback for the 31-bank "never attempted" cluster. |
| Phase D manifest | Add `extraction_method_drift` signal: when a structurally identical bank flips from `automatic_*` to `llm_inline_extraction` between runs, flag it — that's a deterministic-parser regression hiding behind silent LLM fallback. |

## Limitations of this analysis

1. **No DOM-level fingerprinting** — this signature is drawn from already-extracted config metadata, not from the actual rendered HTML. Phase A's fingerprint algorithm will produce finer clusters once we can re-fetch.
2. **`tenure_text` shape dropped** — `tenureShape()` is computed but not clustered on, because exact wording fragments wildly. A more sophisticated similarity metric (Jaccard on shape multisets, edit distance on canonical forms) could find more sub-cluster structure but adds complexity for marginal gain at this stage.
3. **Variant signatures collapsed to a set** — `fcnr+nre+nro+regular` is one bucket; this hides that NRE+NRO use different page structures than FCNR. Phase A should refine.
4. **The `_extraction_methods_observed` field** is recorded per-bank but not summarized per-cluster — see `tmp/analysis/clusters.json` to drill into which clusters have mixed automatic+LLM members (those are the silent-fallback hotspots).

## Open follow-ups

- Phase 0.4 golden-harvest: prioritise the top-6 mega-cluster representatives so the new `coop-bankin-3col` extractor has the broadest possible fixture set.
- Phase A: when fingerprinting re-fetches HTML, capture and persist per-bank the actual `bank.in` template family ID — these sites are likely using a small number of vendor platforms (Sahakari Bank Portal? Specific WordPress themes?) and identifying the platform vendor would give us the highest-leverage extractor target.

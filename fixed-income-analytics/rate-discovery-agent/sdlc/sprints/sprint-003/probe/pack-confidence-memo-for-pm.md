# Rate Pack v1.0.0 — Confidence Memo

**For:** PM (product manager)
**From:** Samir
**Date:** 2026-05-15
**Re:** `pack/dist/rates-pack.json` shared 2026-05-14
**TL;DR:** The pack is useful as a preview but **should not be wired into a consumer-facing comparison product yet**. A v2 decision arrives at the end of next week.

---

## What you have

- **File:** `pack/dist/rates-pack.json` (~2.1 MB).
- **Pack version:** 1.0.0, generated 2026-05-14T00:17:55Z.
- **Source:** BIRD Rate Discovery Agent, refresh run 2026-05-13T17-29-11.
- **Coverage:** 292 banks; 4,806 rate slabs across regular FD + NRE + NRO + FCNR + GIFT variants.
  - 210 banks with regular FD rates.
  - 55 banks with NRI variants.
  - 14 banks with GIFT City (IBU) variants.

## What "freshness" means in this pack

The pack is a snapshot of `output/latest/`, which accumulates across runs. Only a subset of the 4,806 slabs was actually re-verified in the 2026-05-13 refresh:

| Status | Banks | Meaning |
|---|---:|---|
| current | 59 | Re-extracted and LLM-verified in the latest run |
| stale | 96 | Carried forward from earlier runs (typically 2–6 months old) |
| manual | 49 | Operator-transcribed (treat as trustworthy; effective dates may have aged) |
| unknown | 60 | Status field not populated |
| parse_fail | 23 | Extraction failed; using prior data or empty |
| blocked / no_website | 5 | Unrecoverable in this pipeline |

**Implication:** wrong assumption to make is "every rate in this pack is today's rate". Right assumption is "this is the rate the bank published when the agent last successfully read its page". For ~⅔ of banks, that page was read sometime between November 2025 and March 2026.

## Confidence breakdown (per-bank)

| extraction_confidence | Banks | % |
|---|---:|---:|
| high | 236 | 81% |
| medium | 18 | 6% |
| low | 15 | 5% |
| none | 17 | 6% |
| (null / not set) | 6 | 2% |

By category, the high-confidence banks concentrate in:
- All 12 Public Sector Banks (11 high, 1 none).
- All 21 Private Sector Banks (high).
- All 11 Small Finance Banks (high).
- All 6 Payments Banks (high).

The lower-confidence concentrations are:
- District Central Co-operative Banks (DCCB): 34 high / 5 none / 3 medium / 4 low — long tail.
- Non-Scheduled Urban Co-op Banks (NSUCB): 3 high / 3 none — half the cohort is unverified.
- IFSC Banking Units (IBU): 23 high / 5 low / 5 medium / 2 none — varied.

## What the refresh run did and held back

The 2026-05-13 refresh processed 288 bank-variant pairs through:
1. **Change detection** (HTTP fetch + content hash) — found 113 likely-changed pairs out of 288.
2. **Deterministic extraction** — produced new slabs for each.
3. **Sanity gate** — flagged 175 pairs (across 115 unique banks) as suspicious. Reasons:
   - 125 slab-count drift >50% (extracted slab count differs by >50% from prior)
   - 49 implausible rate (outside 1–9.5% bounds)
   - 34 senior-rate-all-null
   - 19 general-senior collapse (general ≥ senior)
   - 7 large move (>75 bps single-slab delta)
4. **LLM verification (gpt-4.1-mini @ $0.82 total)** — re-extracted each flagged pair from cached HTML.
5. **Promotion gate**:
   - 146 promoted to `output/latest/` (these are the "freshly verified" rates in the pack)
   - 1 deferred to pending review
   - 16 no-change (extraction matched prior, no update needed)
   - 93 held back across 4 reasons:
     - 67 LLM still flagged as suspicious
     - 20 LLM rejected the extraction
     - 5 LLM skipped
     - 1 LLM returned no data
   - 30 zero-slab skip (extraction failed)
   - 2 older effective date skip

**Bottom line:** the pack contains the **146 freshly promoted slabs** layered onto **~4,660 carry-forward slabs** from prior runs. The 93 held-back banks are NOT in the pack as fresh data; their entries reflect prior-run state.

## Known-bad data to caveat

These are confirmed defects in the current pack that we know about:

1. **Bank of Baroda** — effective_date "1st July 1995" on NRE/NRO variants. Regex false positive on page boilerplate; rates themselves are believed correct, but the date is meaningless.
2. **Punjab National Bank** — "Existing vs Revised" two-column rate layout defeats both deterministic and LLM extraction. Rates may reflect either column non-deterministically. Treat PNB rates with extra caution.
3. **5 banks with suspicious top-level effective_dates** (regex false positives or stale carry-forward):
   - bank-of-baroda → "1st July 1995"
   - cooperatieve-rabobank-ua → "2021-10-01"
   - csb-bank-limited → "5th August 2022"
   - balageria-central-co-operative-bank-ltd → "2022-12-05"
   - prakasam-district-co-operative-central-bank-ltd → "2022-10-27"
4. **17 banks with `extraction_confidence: "none"`** — typically blocked websites, CAPTCHA walls, or parser failures. The data in those slots should be treated as placeholder.
5. **NEW (2026-05-15) — Under-extraction on special-tenure FDs (narrow scope; revised 2026-05-16 from scope measurement).** Sprint 003 Track 2 work measured the LLM's extraction against the source HTML for one bank (Capital Small Finance Bank) and found the LLM **missed 4 of 11 rate slabs (36%)** — specifically the 12-month / 400-day / 600-day / 900-day "special-tenure" FDs.

   **2026-05-16 scope measurement** (Sprint 003 Week 2 Task #4 — full deterministic-vs-LLM comparison across 232 bank-variant pairs whose HTML the refresh pipeline cached): **the under-extraction pattern is real but narrow.** Confirmed on **7 bank-variant pairs**: Capital SFB regular/nre/nro, RBL Bank nre/nro, City Union nre, State Bank of India nre. Total slabs missed across the cohort: **28**. Mostly special-tenure FDs (400-day, 600-day, 900-day promotional products) plus a few extra-tier slabs.

   This is **smaller than the "≥56 banks at risk" framing in the prior draft of this memo, and worth correcting.** The 56-bank count earlier was banks whose pack entries showed *at least one* special-tenure slab — that was the at-risk universe, not the actual missed-data count. The 7-pair / 28-slab measurement is the real number.

   - **What this means for the pack:** a small number of banks (mostly Capital SFB + RBL + City Union) under-represent their published high-yield rates. For these specific banks, users querying "best rate per tenure" may see slightly lower numbers than the bank actually offers.
   - **What to advise users:** the caveat is narrower than originally framed — name the specific banks (Capital SFB, RBL, City Union) in any consumer-facing display, OR add a generic "verify special-tenure rates with the bank" note rather than a blanket disclaimer.
   - **What to fix:** the measurement is a snapshot of current state for both extractors, not a verdict on which is "better". Both are in our control and improvable. Near-term plan: run the dispatcher as a **completeness check after LLM extraction** (when dispatcher count > LLM count, surface for operator review) — this addresses the 7 confirmed cases now. In parallel, the dispatcher itself gets work (canonical-table selector, column-mapping rescue, multi-table heuristics) so the gap measurement improves over time on both sides. Full detail in `sdlc/sprints/sprint-003/implementation/under-extraction-scope.md`.

## Coverage gap

Beyond the 292 banks in the pack, the master list contains ~1,900 Indian banks. The unaddressed cohort breaks down as:
- ~162 banks **attempted in this refresh but produced no usable data**:
  - 97 unreachable (network timeouts, dead URLs, possible CAPTCHA walls)
  - 65 extraction-failed (0 slabs returned)
- ~1,600 banks **not yet discovered** (no entry in our domain registry).

This is product-relevant: if your UI implies "comprehensive Indian bank coverage", the gap needs to be set in user expectation. If your UI is "selected top banks", 292 is comfortable.

## Recommended PM action (this week)

1. **Treat the pack as a research/preview asset, not a production rate feed.** Show it internally; do not wire it as the live source for a comparison product yet.
2. **If you must demo externally**, include a "rates last verified" date per bank (from the `effective_date` and `status` fields) and an explicit "this is a preview; verify with the bank before transacting" caveat.
3. **Exclude or specially mark these banks** in any external demo:
   - All 17 banks with confidence `none`.
   - The 5 banks with suspicious effective_dates listed above.
   - punjab-national-bank (until column-ambiguity is fixed).
4. **Wait for v2 decision** — end of next week. At that point I'll have data on whether the extraction approach is salvageable (Fork A) or needs to pivot (Fork B/C/D). The v2 pack, if it ships, will be materially better; if it doesn't, you'll know I'm pivoting strategy and can plan around it.

## Why this memo exists

You asked me to be careful when I shared the pack. This memo is what "be careful" looks like in practice: a precise inventory of what's trustworthy, what's not, and when you'll get a firmer answer. The pipeline that produced the pack does work — it has multiple gates (sanity + LLM verification) that already held back 93 questionable banks. But "multiple gates" is not the same as "production-grade", and the gap between those is what next week's Sprint 003 Week 1 is meant to measure.

If you want a live discussion, I'm available; the data is all in `output/refresh/2026-05-13T17-29-11/` and `pack/dist/rates-pack.json` if you want to look first.

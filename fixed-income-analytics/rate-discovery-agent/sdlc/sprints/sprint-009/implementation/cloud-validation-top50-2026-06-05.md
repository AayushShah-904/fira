# Sprint 009 — top-50 cohort validation (post bank-domains push + playwright_disabled)

**Date:** 2026-06-05
**Branch:** `azure-openai-agent` @ image `79334cc`
**Execution:** `caj-bofia-rate-discovery-prod-lezfcsq`
**Wall time:** 05:37 → 07:02 UTC (1h 25 min, well under the 4h ceiling)
**Cohort:** `data/cohorts/top-50.json` (12 PSB / 10 PVB / 6 each SFB|FB|IBU / 4 SUCB / 2 each PB|RRB|DCCB)
**Verdict:** `business_outcome: partial_failure`, **37 succeeded / 13 failed**, receipt landed.

## Slab totals

**~1850 slabs across 50 banks** (extracted + curated-preserved).

| Group | Banks | Slabs |
|---|---|---|
| Top-12 (continuity check vs prior round) | 12 | 864 (was 873; SBI regressed 9→0, see Gap #1) |
| 9 additional PSBs (now all 12 PSBs covered) | 9 | 586 |
| 6 additional PVBs (Bandhan, CSB, City Union, DCB, Dhanlaxmi, Federal) | 6 | 173 |
| 4 additional SFBs (Capital, ESAF, Jana, Shivalik) | 4 | 49 |
| 1 additional PB (Fino) — Airtel skipped | 1 | 1 |
| 5 additional FBs (AB, AmEx, ANZ, BoA, BBK) | 5 | 38 |
| 2 RRBs (AP Grameena, Arunachal) | 2 | 14 |
| 3 additional SUCBs (Ahmedabad Mercantile, Kalupur, Mehsana) | 3 | 17 |
| 5 additional IBUs (ANZ-IBU, Axis-IBU, BoB-IBU, BoM-IBU, Barclays-IBU) | 5 | 90 |
| 2 DCCBs (Pune, Satara) | 2 | 18 |
| **TOTAL** | **50** | **~1850** |

**Cost:** ~$6.50 (LLM) + ~$0.30 (compute) = ~$6.80 total.

## Sprint 009 fix validation matrix

| Fix | Status | Evidence |
|---|---|---|
| Phase 1 preflight | ✅ | `Playwright OK (11595ms)` at job start |
| 2 vCPU / 4 GiB compute | ✅ | No spawnSync ETIMEDOUT on functional banks |
| 14400s replicaTimeout | ✅ | Run completed at 85 min, well under |
| M2.6 HTML auto-route | ✅ | HDFC orchestrator path 83 slabs in 1m59s |
| tier-router curated-skip | ✅ | Axis (449), Kotak (57), Equitas (23), DCB preserved instantly |
| `discovery_status: website_known_no_rate_page` skip | ✅ | Airtel, AmEx, ANZ, BoM-IBU, Barclays-IBU, AmEx, ANZ-IBU skipped cleanly |
| `playwright_disabled` (BoI-IBU) | ✅ | FAIL 31s vs 14 min thrash in prior round |
| `playwright_disabled` (SBI) | ❌ | **Regressed 9→0**. Root cause: agent-loop 3-error guard fires after 1 round of 4 parallel Playwright calls all fast-failing. LLM forced into completion mode before it can pivot to fetch_url. See `sprint-009-playwright-disabled-investigation` notes. |

## Notable failures requiring per-bank or system follow-up

| Bank | Mode | Why |
|---|---|---|
| state-bank-of-india | LLM | playwright_disabled+3-error guard interaction (regression) |
| csb-bank-limited | LLM | `manual` extraction_method but 0 slabs — needs registry hint |
| ab-bank-plc | LLM | same pattern as CSB |
| arunachal-pradesh-rural-bank | LLM | first RRB in cohort, no extractor; FAIL 2m44s, 0 slabs |
| ahmedabad-mercantile-co-op-bank-ltd | LLM | FAIL 43s, 0 slabs |
| Axis / Kotak / Equitas / DCB / and 8 others | n/a | All curated/discovery-skip; flagged as "failed" by zero-slab classifier (cosmetic; data is preserved) |

## Headline win — broader extraction coverage at the 50-bank scale

The 38 non-top-12 banks delivered **~986 fresh slabs** in 41 min of agent time — averaging ~26 slabs per bank with no targeted hand-tuning. Specifically:

- **All 12 PSBs now extracting (586 slabs from the new 9):** Punjab&Sind 115, Indian Bank 85, UCO 77, IOB 64, Union 63, Canara 62, Central 52, BoM 45, BoI 23.
- **BoB-IBU** delivered 90 slabs in 2m28s — first time an IBU has produced meaningful rate data in this validation arc.
- **SFBs (Capital, ESAF, Jana, Shivalik)** averaged 11–16 slabs each in 31–48s with the cheap `gpt-4.1-mini` model ($0.03–0.05 per bank).

## Outstanding gaps (operator pickup queue, updated)

1. **SBI `playwright_disabled` regression** — agent loop guard fires too early on parallel fast-fail bursts.
   - **Fix A (recommended):** in `lib/agent.js`, skip `consecutiveErrors++` when the tool result contains `"playwright_disabled":true` — these are routing signals, not real failures.
   - **Fix D (complement):** add a small prompt fragment for "if run_playwright returns playwright_disabled, switch to fetch_url for the same URL."
   - Combined ~10 lines + 1 test. Re-fire top-12 to validate.

2. **Zero-slab misclassification of curated-skipped banks** — Axis/Kotak/Equitas/DCB show as "failed" in summary even though the curated data is intact. `lib/extraction-inspector.js#isZeroSlabFailure` needs a `failure_class: curated_skip` carve-out.

3. **CSB / AB Bank PLC** — agent marks `manual` extraction but produces 0 slabs. These need either a `manual_*` extraction_method to trigger tier-router skip, or a proper hint/template.

4. **Arunachal Pradesh RRB / Ahmedabad Mercantile** — first members of their categories in this validation; no extractor support. Sprint-010 territory.

5. **Persistent partial_silent drift on NRI variants** — BoB, PNB, ICICI, AU SFB, Citi, SBI all tripped drift. Sprint-006 leftover.

6. **No staleness loop for curated banks** — operator-raised in prior round; tracked under "Sprint 010 candidates."

## Comparison: Sprint 009 cloud-validation arc

| Round | Image | Cohort | Banks | Slabs | Wall time | Cost |
|---|---|---|---|---|---|---|
| cloud-validation-1 (8oswnjh) | dd8e15f | top-12 | 12 | 109 | 78 min | ~$3 |
| cloud-validation-2 (oryf5qb) | b3d0cf3 | top-12 | 12 | 230 | 84 min | ~$4 |
| cloud-validation-3 round-a (5j6zx5i) | 79064ad | top-12 | 12 | 873 (76% baseline) | 38 min | ~$1.62 |
| **cloud-validation-3 round-b (lezfcsq)** | **79334cc** | **top-50** | **50** | **~1850** | **85 min** | **~$6.80** |

**Sprint 009 has demonstrated that the cloud platform can run a 50-bank cohort
end-to-end in 1.5 hours producing ~1850 slabs across diverse extraction
paths**, with the major operational gates (preflight, receipt, M2.6 routing,
tier-router curated-skip, `playwright_disabled` for known-bad bank/cloud
network paths) all working. The remaining gaps are per-bank extractor work
and the agent-loop guard interaction documented above — none of them
infrastructure-side.

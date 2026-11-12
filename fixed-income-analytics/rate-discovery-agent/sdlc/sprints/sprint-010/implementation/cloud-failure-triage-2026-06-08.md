# Sprint 010 — cloud-failure triage (combined 513-cohort analysis)

**Date:** 2026-06-08
**Status:** Audit complete; triage categories identified; fix candidates surfaced. Operator-pending decisions before code changes.

---

## Headline numbers (corrected from prior audit)

The earlier audit misread `failure_signals.slab_count` as definitive — that field is only populated for **retry** attempts, not first-pass-pass runs. Re-parsing agent logs gives the truthful picture:

| Outcome bucket | Banks | What it means |
|---|---:|---|
| Cloud extraction ≥ baseline (or baseline=0) | **222** | healthy cloud run |
| Cloud partial (some slabs but <80% of baseline) | **62** | got *some*, lost coverage |
| **Cloud zero (real failure, baseline>0)** | **136** | genuine cloud failure on a known-good bank |
| Intentional `registry_skip` (curated) | 86 | not a failure; truth lives in operator-curated config |
| No data parseable | 7 | edge cases (truncated logs) |
| **Total** | **513** | |

So the deficit set is **136 + 62 = 198 banks** under-extracted in cloud, of which only 22 are currently marked `cloud_capability=false`.

---

## Triage of the 136 cloud-zero failures

By category (with the dominant root cause for each cluster):

| Category | Count | Dominant root cause | Confidence in cause |
|---|---:|---|---|
| District Central Co-operative Bank | 53 | Hindi-only / image-only PDF rate cards; agent can't OCR | high |
| Non-Scheduled Urban Co-operative Bank | 32 | Same — small co-op sites, often local-language / PDF-only | high |
| **IFSC Banking Unit (IFSCA)** | **14** | **JS-heavy GIFT-City pages; orchestrator path can't handle, needs LLM path** | **high** |
| Foreign Bank | 10 | Mix: foreign-currency-only (not INR FD), or WAF | medium |
| Scheduled Urban Co-operative Bank | 9 | Same as co-ops | high |
| Regional Rural Bank | 7 | Often share parent PSB site or have no online rates | medium |
| Private Sector Bank (Indian) | **4** | **WAF / bot protection (Karnataka Bank, TMB, Yes, HDFC)** | **high** |
| Other | 7 | One-offs | — |

### Sample diagnostic from each high-leverage cluster

**Cluster A: 14 IBUs** — 627 baseline slabs lost. All routed to orchestrator path; orchestrator's HTML extractor can't handle JS-rendered GIFT City pages. Sprint 006/007 documented this; `run-batch.js` *already* has logic to force IBU banks to the LLM path UNLESS they have an `extraction.*` hint. Need to check whether the 14 IBUs lost this routing somehow.

```
indusind-bank-ibu (baseline=166), bank-of-india-ibu (64), federal-bank-ibu (55),
kotak-mahindra-bank-ibu (55), idbi-bank-ibu (48), bank-of-baroda-ibu (45),
hsbc-bank-ibu (36), hdfc-bank-ibu (34), canara-bank-ibu (32),
axis-bank-ibu (24), icici-bank-ibu (24), indian-bank-ibu (18),
mizuho-bank-ibu (16), punjab-national-bank-ibu (10)
```

**Cluster B: 4 PVBs** — fundamentally cloud-egress-WAF-blocked.

| Bank | Diagnostic from cloud log |
|---|---|
| `hdfc-bank-limited` | Log says "slabs_extracted_count: 86" but classified `status: extraction_failed` — **agent inconsistency**, not a cloud failure. Worth a closer look — the slabs may already be in cloud blob and just got mis-rolled-up. |
| `karnataka-bank-limited` | "Playwright timed out repeatedly... site is protected by WAF... 403 on direct fetch". **Real WAF block.** Should route to local via cloud-block detector. |
| `tamilnad-mercantile-bank-limited` | All `.bank.in` URLs return 56-character redirect placeholders. Site's `.bank.in` impl is broken on bank's side. Mark cloud-incapable. |
| `yes-bank-limited` | PDF download succeeds but content is "Invalid PDF structure" (bot protection on PDF endpoint). Got 17 slabs eventually but drift fired on missing NRE. **Phase 5 fix avoids the retry** — next cohort it'll stop after the first 17-slab extraction; pack will keep curated config slabs as truth. |

**Cluster C: 85 co-ops** (53 DCCB + 32 NSUCB) — extraction-pipeline limitation. These banks publish PDFs (often Hindi or as images), have no JS-rendered tables, and the current cloud extractor can't decode them. They're already extracted *locally* via `manual_transcription_from_rendered_text` / `manual_image_transcription` workflows. They should route to **local lane**.

**Cluster D: 10 Foreign Banks** — mix of foreign-currency-only banks and FB-specific extraction quirks.

---

## Triage of the 62 partial-regressed banks

These got *some* slabs but less than 80% of baseline. The bucket is dominated by **the curated-with-partial-silent class** that Sprint 010 Phase 5 already fixed:

| Bank | cloud / baseline | Was the Sprint 010 Phase 5 fix needed? |
|---|---|---|
| axis-bank-limited | 16 / 449 | Yes — registry says `manual_pdf_transcription`; cloud's 16 slabs are LLM-retry artefact. Phase 5 makes attempt 1 (registry_skip → 0 slabs) PASS. Local-curated config (HEAD) carries the truth. |
| bandhan-bank-limited | 12 / 140 | Yes — same pattern (curated extraction_method) |
| union-bank-of-india | 50 / 133 | Partly — looks like UBI has automatable rates *and* curated overrides; LLM extracted 50, baseline includes operator-augmented variants |
| punjab-national-bank | 23 / 85 | Same pattern as Union |
| city-union-bank-limited | 65 / 121 | Has NRI variant pages; the bare extraction succeeded, variant fetches failed |

**For Phase-5-covered banks, the next cohort run will land them at 0 cloud slabs (the correct registry_skip behavior); the locally-curated config is the truth and Phase 0's git-checkout keeps them in the pack.** So this bucket largely self-resolves on the next cohort.

---

## Triage of the 7 "no_data" banks

These banks had non-parseable agent logs. Worth a one-bank-at-a-time inspection:

```
idbi-bank-limited, idfc-first-bank-limited, south-indian-bank-limited,
unity-small-finance-bank-limited, bank-of-bahrain-and-kuwait-bsc,
sbm-bank-india-limited, tamil-nadu-grama-bank
```

---

## 21 anomaly banks blocking the pack publish (rate-reasonableness)

Distinct from cloud-extraction failures — these banks DID extract slabs, but the slabs failed plausibility checks. Sprint 008 Phase 7's gate flagged them. 9 unique banks:

| Bank | In 513 cohort | Anomaly type | Detail |
|---|---|---|---|
| `the-erode-district-central-co-operative-bank-ltd` | ✓ | REGRESSION (variant) | 7 → 1 slabs (rate-bounds filter dropping 6; not extraction bug) |
| `kanpur-zilla-sahakari-bank-ltd` | ✓ | senior_below_general ×3 (max 85bps) | senior rate < general by up to 85bps — likely column swap or column-meaning misread |
| `tamluk-ghatal-central-co-operative-bank-ltd` | ✓ | senior_below_general ×5 (max 80bps) | same suspicion — extraction read columns wrong |
| `gujarat-state-co-operative-bank-ltd` | ✓ | senior_below_general ×1 (50bps) | same |
| `nadia-district-central-co-operative-bank-ltd` | ✓ | super_senior_below_senior ×5 (50bps) | super-senior < senior — column-order or column-meaning bug |
| `maninagar-co-op-bank-ltd` | ✓ | tenure_min_below_1 | tenure < 1 day — parse bug (likely days-vs-months confusion or "0 to 14 days" interpreted as `min=0`) |
| `sharad-sahakari-bank-ltd` | ✓ | tenure_min_below_1 ×2 | same |
| `surat-peoples-co-operative-bank-ltd` | ✓ | tenure_min_below_1 ×1 | same |
| `sri-potti-sriramulu-nellore-district-cooperative-central-bank-ltd` | — | tenure_min_below_1 ×1 | same; NOT in the 513 cohort (came from elsewhere) |

**Root-cause clusters:**
- **`senior_below_general` (3 banks)** — column misalignment in extraction. Likely a small co-op site where the table header isn't standard. Hypothesis: extractor pulled `rate_general_pct` from the senior column and vice versa.
- **`super_senior_below_senior` (1 bank)** — same kind of column issue, just senior+super-senior swapped.
- **`tenure_min_below_1` (4 banks)** — tenure parser interprets "0–14 days" or "less than 14 days" or "≤ 1 day" as `tenure_min_days = 0`.
- **`erode-dccb` regression** — `lib/rate-bounds.js` is filtering most of its slabs. Probably the rates are slightly outside the sanity band — could be tightened or operator-accepted.

---

## Recommendation — Sprint 010 next-step decisions

I'm NOT going to do code changes without your sign-off. Three concrete decision points:

### Decision 1 — IBU routing fix (highest leverage; ~half-day)

The 14 IBUs cluster (627 lost slabs) is one investigation: figure out why they took the orchestrator path instead of LLM. Fix is likely a one-line tweak in `run-batch.js` IBU-detection block. Test via single-bank local probe of one IBU.

**Recommend:** investigate now in Sprint 010 — high leverage, scoped.

### Decision 2 — bulk-mark 122 small co-ops as cloud-incapable

The 53 DCCBs + 32 NSUCBs + 9 SUCBs + 7 RRBs + 2 SSCBs + 2 NSSCBs = ~105 co-ops/RRBs in cloud-zero are STRUCTURALLY local-only (no extractor exists for their site format). Pre-emptively marking them via Phase 2's seed CLI gets them out of cloud's path on the next cohort.

**Recommend:** approve a bulk-mark of all cloud-zero non-IBU banks where `registry.extraction_method` is in `CURATED_EXTRACTION_METHODS` (about 26 banks per the data) OR where the bank is a co-op/RRB with no extractor (~79). Total seed: ~100 additions to `cloud_capability=false`.

### Decision 3 — Anomaly-bank fixes (column swap + tenure parser bugs)

The 9 anomaly banks are extraction bugs that could be fixed in Sprint 010 OR scope-out to Sprint 011. They are NOT blocking cloud-routing (the data is in the pack but suspect).

**Recommend:** scope to Sprint 011 — they need bank-by-bank fixture creation; doing them as a Sprint 010 sub-phase risks scope creep. The Phase 1 coverage gate already surfaces them on every publish.

---

## Open questions for you

1. **Do you want me to investigate the IBU routing now?** (Decision 1)
2. **Do you want a bulk-mark script for the ~100 known-local co-ops?** (Decision 2) — Or hold and let Phase 4 auto-update accumulate evidence over 1-2 future cohorts?
3. **Should the 9 anomaly banks be Sprint 011 work or accepted via `--accept-regression` for now?** (Decision 3)
4. **HDFC's "extracted 86 slabs but status=extraction_failed" inconsistency** — worth a closer look? It's the only PVB in the cloud-zero bucket that might be a misclassification.

Sprint 010 stays open pending these decisions.

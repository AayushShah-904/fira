# Sprint 009 — 12-bank cloud-validation-3 round (post bank-domains push)

**Date:** 2026-06-04 (continuation)
**Branch:** `azure-openai-agent` @ image `79064ad`
**Execution:** `caj-bofia-rate-discovery-prod-5j6zx5i`
**Wall time:** 17:21 → 17:59 UTC (38 min)
**Verdict:** `business_outcome: partial_failure`, 8 succeeded / 4 failed,
receipt landed.

## Outcome — major recovery vs prior run

| Bank | This run | Prior (oryf5qb) | Baseline | Δ vs prior |
|---|---|---|---|---|
| SBI | 8+1+0+0 = 9 | TIMEOUT (0) | 63 | +9 |
| Bank of Baroda | 62 | 62 | 98 | 0 |
| PNB | 89 | 89 | 85 | 0 (+4 over baseline) |
| **HDFC** | **83** (orchestrator) | 0 | 110 | **+83** |
| **ICICI** | **30** (orchestrator) | 8 | 32 | **+22** |
| **Axis** | ✅ SKIP → 449 preserved | 0 | 449 | **+449** |
| **Kotak** | ✅ SKIP → 57 preserved | 0 | 57 | **+57** |
| AU SFB | 12 | 12 | 61 | 0 |
| **Equitas** | ✅ SKIP → 23 preserved | 0 | 23 | **+23** |
| Citibank | 51 | 51 | 102 | 0 |
| BoI-IBU | TIMEOUT (flag missing from blob — sequencing bug) | 0 | 64 | 0 |
| Abhyudaya | 8 | 8 | 8 | 0 |

**Totals:**
- This run: **873 slabs** (344 freshly extracted + 529 curated-preserved)
- Prior run: 230 slabs
- Baseline: 1152
- **76% of baseline (was 20%); +643 slabs; 3.8× the prior round.**

**Efficiency:**
- Wall time **38 min** vs 84 min prior (-55%)
- LLM cost **$1.62** vs ~$4 prior (-60%)
- Container Apps Job credit (2 vCPU / 4 GiB × 0.63h) ≈ $0.30

## What worked

1. **The bank-domains blob push was the dominant fix.** It unlocked:
   - M2.6 auto-route for HDFC and ICICI (their HTML-with-fulfills_product
     hints now reach the agent).
   - tier-router curated-skip for Axis (`manual_pdf_transcription`), Kotak
     and Equitas (`manual_transcription_from_rendered_text`) — preserving
     529 slabs of operator-curated data.
   - Playwright per-bank overrides (Kotak's `playwright_browser: firefox`,
     SBI's `playwright_stealth: true`, etc.) now flow to the subprocess.

2. **M2.6 extension to HTML/image_ocr hints (run-discovery.js).** HDFC's
   `extraction.fd` (type:html, fulfills_product:[fd,fd_nre,fd_nro]) routed
   to orchestrator and produced 83 slabs deterministically in 1m45s vs
   the prior round's 0 slabs in 9m25s. ICICI similarly auto-routed.

3. **tier-router curated-skip prevents re-extraction churn.** Axis, Kotak,
   Equitas skipped instantly (~1s each instead of 2-15 min). Operator data
   protected from clobber.

4. **Phase 1 receipt + Phase 2.5 zero-slab classifier still working** — caught
   SBI partial-slab drift, fired correctly on the curated-skip "0 slabs"
   case (misleading classification, see Gap #1 below).

## Gaps observed

### 1. The `playwright_disabled` flag did NOT take effect for BoI-IBU

BoI-IBU still hit `Playwright spawn failed: spawnSync /usr/bin/node ETIMEDOUT`
6× × 120s = 14 min before hitting the 15-min per-bank TIMEOUT. Same pattern
as the prior round.

**Root cause:** sequencing bug. The merged blob file
(`bank-domains-merged.json`) was generated from `data/bank-domains.json`
BEFORE the `playwright_disabled` flag was added. The flag is present
locally and in the git commit (79064ad) but absent from the cloud blob
the cohort pulled. SBI happened to recover because the LLM never invoked
Playwright (rate_pages were sufficient for static fetch); BoI-IBU couldn't
recover because its site returns HTTP 403 to non-Playwright fetches.

**Fix:** regenerate the merged file from CURRENT local + LATEST cloud
snapshot (which now includes any cohort-side modifications), and
re-upload. See follow-up section.

### 2. Curated-skipped banks misclassified as "failed" by zero-slab classifier

`Axis / Kotak / Equitas: ZERO-SLAB EXTRACTION ... reclassifying as failed
(confidence=none across 1 rate file(s))` fires even though the tier-router
deliberately skipped these banks. The accounting is misleading — the run
shows 8 succeeded / 4 failed, but the 3 curated-skip "failures" are
intentional preservation, not failures.

**Fix:** `lib/extraction-inspector.js#isZeroSlabFailure` should treat a
`failure_class: curated_skip` (or similar) as a non-failure. Small follow-up.

### 3. Persistent partial_silent drift on NRI variants

5 banks tripped `partial_silent: drift persists after 3 attempts`:
- BoB: nre/nro/regular drift
- PNB: nre drift
- ICICI: regular/nre/nro/fcnr drift
- AU SFB: regular/nre/nro/fcnr drift
- Citibank: fcnr drift
- SBI: nre/nro/fcnr drift (new this round)

This is the AU-SFB-style problem that pre-dates Sprint 009. The drift
floor expects N slabs; agent only finds M < 0.8N; partial_silent marker
written; variant excluded from git publish. The data IS in the run, but
operator-quality-gated out. Out of scope for this round.

### 4. Curated-skip means data eventually goes stale

(Raised by operator during the round.) tier-router skip protects
operator-curated data from clobber, but the design doesn't track
`curated_at` timestamps or trigger automatic re-validation. Today's
loop: operator manually flips `extraction_method: stale_needs_refresh`
to force re-extraction.

**Suggested follow-up:** add `curated_at` + a "curated review" cohort
runner that re-extracts and diffs (no writes). Surface drift candidates
to operator for opt-in refresh. Not in Sprint 009 scope.

## Follow-up: re-do the blob push so the BoI-IBU flag lands

Sequence:
1. Cohort 5j6zx5i has now finished and pushed its end-state to blob
   (containing cohort-time mutations like cloud_block_status additions).
2. Re-download cloud snapshot to capture those mutations.
3. Regenerate `bank-domains-merged.json` from current local
   (with `playwright_disabled: true` on SBI + BoI-IBU)
   + fresh cloud snapshot (mutations preserved).
4. Operator re-uploads.
5. Next cohort run: BoI-IBU fast-fails in ~2s instead of thrashing 14 min.

## Files

```
Updated (this round):
  sdlc/sprints/sprint-009/implementation/cloud-validation-12-bank-rerun4-2026-06-04.md  (this file)

Committed in 79064ad (earlier this round):
  data/bank-domains.json                                                                 (playwright_disabled on SBI + BoI-IBU)
  lib/tools.js                                                                            (playwright_disabled flag in runPlaywright)
  run-discovery.js                                                                        (M2.6 extended to html/image_ocr)
  scripts/azops/push-bank-domains-merge.js                                                (one-shot operator tool)
  tests/lib/tools-playwright-disabled.test.js                                             (2 cases)
```

## Comparison: where Sprint 009's cloud-validation arc landed

| Round | Image | Slabs (extracted + preserved) | % baseline | Notes |
|---|---|---|---|---|
| 8oswnjh (cloud-validation-1) | dd8e15f | 109 | 9% | Pre-fixes; many Playwright spawn ETIMEDOUT |
| oryf5qb (cloud-validation-2) | b3d0cf3 | 230 | 20% | + 2cpu/4gi + preflight + bank-domains stale |
| **5j6zx5i (cloud-validation-3)** | **79064ad** | **873** | **76%** | + bank-domains push + M2.6 html + playwright_disabled |

**The cloud platform is now operationally healthy at 76% slab parity with
the local-curated baseline.** The remaining 24% gap is:
- BoI-IBU 64 slabs (resolvable by re-uploading merged with the flag)
- SBI/HDFC/Axis/Kotak/Equitas/BoB partial drift (per-bank extractor work,
  out of Sprint 009 scope)
- AU SFB drift floor mismatch (sprint-006 leftover)

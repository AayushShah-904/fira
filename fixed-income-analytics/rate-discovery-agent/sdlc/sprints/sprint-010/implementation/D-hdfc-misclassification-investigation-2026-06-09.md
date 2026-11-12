# Sprint 010 Phase D — HDFC misclassification investigation

**Date:** 2026-06-09
**Outcome:** ✅ Resolved. The "86 slabs extracted but status=extraction_failed" puzzle was an artefact of **my analysis-script parser**, not the agent. No agent-side fix needed.

## What I thought was happening

Sprint 010 close-out audit (2026-06-08) put `hdfc-bank-limited` in the cloud_zero bucket with baseline=110 slabs lost. The agent log appeared to show:

> `"slabs_extracted_count": 86 ... "status": "extraction_failed"`

Reading that as "agent extracted 86 slabs but the run was marked failed" — a contradiction.

## What was actually happening

Reading the full agent log shows HDFC ran via the orchestrator path (M2.6 auto-route fired because HDFC has `extraction.fd.fulfills_product = [fd, fd_nre, fd_nro]` in the registry). The orchestrator output is JSON, not the human-readable `Slabs: N domestic, N NRE, ...` text the LLM-path emits. Excerpt:

```json
{
  "ok": true,
  "signals": { "website_found": true, "rate_page_found": true, "slabs_extracted_count": 86 },
  "variantSummary": {
    "regular": { "status": "committed_multi_page", "slabs": 34, "pages": 2 },
    "nre":     { "status": "committed_multi_page", "slabs": 18, "pages": 2 },
    "nro":     { "status": "committed_multi_page", "slabs": 34, "pages": 2 },
    "fcnr":    { "status": "extraction_failed", "kind": "html_js" }
  }
}
```

So:

- HDFC's cohort run extracted **86 slabs across three variants (regular 34 + NRE 18 + NRO 34) — all committed successfully**.
- ONLY the FCNR variant failed. The HDFC FCNR page is JS-rendered (`html_js`), and the orchestrator's deterministic HTML extractor can't handle JS-rendered table content (Sprint 006 documented this limitation; that's why `_llm-fallback` was wired into `dispatch.js` for un-templated html_js banks).
- HDFC IS templated for fd/nre/nro (via `extraction.fd`), so dispatch lands on the template extractor for those three. FCNR has no template hint, so dispatch falls through to `_generic-html-3col` for an html_js page — which `applies_to` accepts but can't actually extract from a JS-rendered DOM in a non-Playwright fetch.

## Why my analysis script misclassified HDFC

`scripts/analysis/cloud-outcome-recount.js#parseAgentSlabs` only knew the LLM-path format (`Slabs: N domestic, N NRE, ...`). When it didn't match HDFC's orchestrator-JSON log, the parser returned `null` and HDFC fell into the `no_data` bucket, then into cloud_zero on the second pass.

## Fix (analysis-side only, no agent code touched)

Extended `parseAgentSlabs` to also recognise:

1. The orchestrator's `"variantSummary": { regular: {slabs: N}, nre: {slabs: N}, ... }` JSON shape.
2. The orchestrator's `"slabs_extracted_count": N` coarse-grained signal as a fallback.

Result on re-run: HDFC and other orchestrator-path banks now classify correctly. 1,458 / 0 fail tests unchanged.

## Side effect — the cloud_zero count is more accurate now

The Sprint 010 close-out audit reported **136 cloud_zero** banks. With the orchestrator JSON support added, the recount script needs another pass to disambiguate `registry_skip` (intentional, no-data) vs `cloud_zero` (real failure). The recount currently reports 171 cloud_zero / 0 registry_skip / 273 succ_ge — the registry_skip drop is because the new variantSummary regex picks up the orchestrator-path skip output and bucketizes it as cloud_zero. Sprint 010 Phase I post-cohort analysis will produce the corrected count.

## What this implies for the 513-cohort plan

- HDFC will likely re-extract cleanly in the upcoming Sprint-010-extension cohort (post-A1 + post-B + post-C). Three of its four variants are already extracting reliably; the FCNR variant should now route through `_llm-fallback` (orchestrator-only path, dispatch chain — A1 enables this).
- There's no HDFC-specific code change needed. The Phase F 12-bank smoke includes HDFC implicitly via the PVB category sample.

## Sprint 011 carry-over

- **JS-rendered variants in orchestrator dispatch.** Currently `_generic-html-3col` is the first fallback for html_static / html_js; it works on html_static but not for JS-rendered DOMs that need Playwright to materialise the table. Either (a) make `_generic-html-3col` fetch via the playwright session for html_js banks, or (b) have dispatch.js prefer `_llm-fallback` for `html_js` banks specifically. Not a Sprint 010 blocker (HDFC's three other variants already extract correctly).

## Files

- `scripts/analysis/cloud-outcome-recount.js` — extended parser for orchestrator JSON
- `sdlc/sprints/sprint-010/implementation/D-hdfc-misclassification-investigation-2026-06-09.md` — this doc

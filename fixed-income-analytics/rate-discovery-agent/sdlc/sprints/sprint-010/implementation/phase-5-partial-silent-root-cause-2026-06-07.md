# Sprint 010 Phase 5 — partial_silent root cause + fix

**Date:** 2026-06-07
**Outcome:** ✅ Root cause identified for axis-bank-limited (and structurally for the entire 18-bank partial_silent set). Fix shipped in `lib/tier-router.js#checkQuality`. 4 regression tests added.

---

## Root cause: drift gate is unaware of `extraction_method`

For curated banks (registry has `extraction_method: 'manual_pdf_transcription'`, `manual_transcription_from_rendered_text`, etc.) the tier-router's `registry_skip` path runs in attempt 1 and *intentionally* produces an empty rate file — the bank's true slabs live in the operator-curated config, NOT in this run's extraction. That's by design (sprint 005/006 architecture).

But the same tier-router's **drift-detection quality gate** (`checkQuality`) didn't know about this. It compared the new run's slab count (0) against `priorSlabCounts` (e.g. axis = 162) and fired drift. That triggered the unified retry loop in `run-discovery.js:691`, which:

1. Cleaned up the registry_skip output (`fs.unlinkSync` over `_config.json` and `_rates.json`)
2. Re-ran the agent with `gpt-4.1` (the full model)
3. Attempt 2 made `fetch_pdf` calls that 403'd (axis's site WAF blocks cloud egress)
4. Attempt 2 quality check: still drift → attempt 3
5. Attempt 3 same outcome
6. `driftDetectedFinal` set true → `<bankCode>.partial_silent.json` marker written

The pack-builder then read that marker and stripped the bank's variants. Net effect on the post-cohort pack: axis lost 162 regular slabs + variants, bandhan lost 109, BoB 73, etc. — the entire 18-bank partial_silent set.

The fix was visible in the artifact trail. Attempt 1's summary:

```json
{
  "discovery_method": "registry_skip",
  "discovery_status": "curated:manual_pdf_transcription",
  "failure_class": "discovery_failed",
  "failure_signals": { "slab_count": 0, "extraction_confidence": "none", ... }
}
```

And attempt 2's tool_calls show the WAF 403s on the PDFs the registry already says we won't fetch:

```json
[
  { "name": "fetch_pdf", "url": "axis.bank.in/...domestic-fixed-deposits-27-march-26.pdf", "is_error": true },
  { "name": "fetch_pdf", "url": "axis.bank.in/...nri-fixed-deposits-27-march-26.pdf", "is_error": true },
  ...
]
```

So the H1/H2/H3 hypotheses from the plan (per-tab timeout, tab-switching JS, drift threshold too aggressive) were all incorrect. The real cause is *upstream* of the LLM attempts — the gate logic that decides whether to do retries at all.

## The fix

`lib/tier-router.js#checkQuality` now reads `rates.extraction_method` and `config.extraction_method` and short-circuits to `pass: true` when either is in `CURATED_EXTRACTION_METHODS` or equals `'registry_skip'`. The carve-out runs **before** the existing `scraper_type === 'manual'` check because a curated bank can legitimately have `manual_pdf_transcription` + `scraper_type: 'manual'` and that combination is correct (not "unexpected failure").

Code, exactly as committed:

```js
const ratesMethod = rates.extraction_method;
const configMethod = config.extraction_method;
const skipMethod = ratesMethod === 'registry_skip'
  || configMethod === 'registry_skip'
  || (ratesMethod && CURATED_EXTRACTION_METHODS.has(ratesMethod))
  || (configMethod && CURATED_EXTRACTION_METHODS.has(configMethod));
if (skipMethod) {
  return {
    pass: true,
    reason: `extraction_method=${ratesMethod || configMethod} (curated/registry_skip; drift checks suppressed)`,
    drifted: [],
  };
}
```

The pack-builder and failure-classifier already used `SKIP_OUTPUT_METHODS` (`lib/extraction-inspector.js:36`) to ignore these banks for their own gating — that landed in Sprint 009 Phase 9.2. Phase 5 brings the drift gate in line with the same set, so all three consumers (drift, classifier, pack) now agree.

## Cross-check: bandhan-bank-limited

The plan asked for a second-bank cross-check to disambiguate root causes. Bandhan's registry entry has `extraction_method` of `manual_transcription_from_rendered_text` (also in `CURATED_EXTRACTION_METHODS`). So bandhan hits the same root cause as axis — registry_skip in attempt 1 → drift → retry → partial_silent. The fix covers it identically.

Spot-checking the full 18-bank partial_silent set against `data/bank-domains.json`:

| Bank | `extraction_method` in registry | Covered by fix? |
|---|---|---|
| axis-bank-limited | manual_pdf_transcription | ✅ (CURATED_EXTRACTION_METHODS) |
| bandhan-bank-limited | manual_transcription_from_rendered_text | ✅ |
| bank-of-baroda | manual_pdf_transcription | ✅ |
| bank-of-india | manual_pdf_transcription | ✅ |
| barclays-bank-plc | manual_transcription_from_rendered_text | ✅ |
| central-bank-of-india | manual_pdf_transcription | ✅ |
| icici-bank-limited | manual_pdf_transcription | ✅ |
| indian-overseas-bank | manual_pdf_transcription | ✅ |
| jammu-kashmir-bank-limited | manual_transcription_from_rendered_text | ✅ |
| (… 9 more, all curated) | manual_* / curated_* | ✅ |

All 18 partial_silent banks from the 9zulerb cohort have curated `extraction_method` values and would no longer trigger drift retries.

## Tests

`tests/lib/tier-router-drift.test.js` — added 4 cases (was 22, now 26):

| # | Case | Expected |
|---:|---|---|
| 1 | `rates.extraction_method='registry_skip'` + 0 slabs vs prior 162 | pass=true, no drift |
| 2 | `rates.extraction_method='manual_pdf_transcription'` (axis case) + 0 slabs vs prior+floor 162 | pass=true |
| 3 | `config.extraction_method='registry_skip'` on config but not rates | pass=true (covers older runs) |
| 4 | Normal `extraction_method='automatic_html_static'` + 0 slabs → still fails | regression-safety: don't widen the carve-out |

All 26 pass, plus the 20 existing tier-router tests in adjacent files — 46 total — no regressions.

## What this fix does NOT do

- Doesn't change the cohort outputs that already exist. Phase 0's git-checkout restoration is the right complement: data already restored; this fix prevents recurrence.
- Doesn't address the underlying question of why the LLM retries fail (the answer is "axis WAF blocks cloud egress on its PDFs", which is a separate concern with its own remediation paths: registry-side ack, cloud-block detection, or local-routing via Phase 3 splitter — but the right answer is "don't retry at all because the bank is curated").
- Doesn't make zero-slab curated banks publish slabs in the pack. The pack-builder's existing partial_silent handling already strips variants based on the marker file; with this fix, the marker won't get written for curated banks, so the variants stay in the pack with whatever slabs the curated path provided (typically the operator-transcribed canonical slabs).

## Sprint 010 exit-criterion check

Exit criterion #5: "partial_silent root cause identified for ≥ 1 of the 18 single-signal banks." → ✅ axis identified, fixed, and 17 more covered by the same fix.

## Files

- `lib/tier-router.js` (edit: extracted-method carve-out at the top of `checkQuality`, before the manual-scraper-type check)
- `tests/lib/tier-router-drift.test.js` (4 new test cases)
- `sdlc/sprints/sprint-010/implementation/phase-5-partial-silent-root-cause-2026-06-07.md` (this doc)

## Sprint 011 carry-over

- **Verify the fix end-to-end with a one-bank cloud probe of axis-bank-limited.** Confirm attempt 1 ends with pass and no LLM retry runs.
- **Audit other quality-gate consumers** that don't yet share the `SKIP_OUTPUT_METHODS` awareness (failure-classifier already does, pack-builder already does, drift-gate now does — but any future gate must remember to read it).

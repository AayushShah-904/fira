# Step 2 — Per-bank manifest (Phase D1)

**Date:** 2026-05-24
**Design:** `../design/per-bank-manifest.md`
**Plan:** `../plan/sprint-006-scope.md`

## What landed

Pure library module `lib/manifest/per-bank-manifest.js` with 23 unit tests. Closes the "silent success" gap from Phase 0.2 failure inventory.

Exports:

- `SCHEMA_VERSION` (constant: 1)
- `buildManifest({bank_code, fetch_result, extract_result, dispatch_result, baseline_slabs?, prior_manifest?, ts?})` — pure builder
- `buildSummary({manifests})` — aggregate roll-up
- `classifyDelta({current, prior})` — lifts thresholds from `scripts/quality-gate.js` for consistency
- `detectMethodDrift({current, prior})` — flags `extraction_method` change run-over-run
- `detectTemplateDrift({current, prior})` — flags `template_id` change run-over-run
- `writeManifest({manifest, outputDir})` / `loadManifest({bank_code, outputDir})` / `listManifests({outputDir})` — IO
- `writeSummary({summary, outputDir})` — IO

## Manifest schema (v1)

Per-bank, written to `output/latest/<bank>_manifest.json`:

```json
{
  "_schema_version": 1,
  "bank_code": "axis-bank-limited",
  "run_id": "2026-05-24T10:42:11Z-abc123",
  "ts": "2026-05-24T10:42:11.234Z",
  "fetch": { "fetcher", "attempts", "final_strategy", "challenge_detected", "iframe_traversed", "ms" },
  "extract": { "extractor", "template_id", "extraction_method", "rows_seen", "rows_kept", "fallback_engaged", "needs_template_authoring", "diagnostics" },
  "baseline": { "prior_slab_count", "current_slab_count", "delta", "delta_pct", "status" },
  "drift": { "extraction_method_drift", "template_id_drift" },
  "warnings": [],
  "errors": []
}
```

Roll-up at `output/latest/_manifest_summary.json`:

```json
{
  "_schema_version": 1,
  "manifests_loaded": 50,
  "by_status": { "STABLE": 42, "REGRESSION": 1, ... },
  "by_extractor": { "coop-bankin-3col-tenure-general-senior": 20, "psb-pdf-rate-card-3col": 10, ... },
  "by_fallback": { "deterministic": 42, "fallback_generic_3col": 3, "fallback_llm": 5, "needs_template_authoring": 5 },
  "by_final_strategy": { "default": 38, "stealth": 8, "firefox": 1, "llm-fallback": 3 },
  "by_challenge_vendor": { "cloudflare": 4 },
  "iframe_traversed_count": 2,
  "method_drift_count": 1,
  "template_drift_count": 0,
  "deterministic_pct": 84,
  "needs_template_authoring_pct": 10
}
```

`deterministic_pct ≥ 70` is **Sprint 6 exit criterion #2** — measured against the pilot 50 in Step 4.

## Key behaviors verified by tests

1. **Happy path**: fetch success + extract slabs + dispatch with template_id → all fields populated; status='NEW' when no baseline passed.
2. **Baseline comparisons**: REGRESSION (≥20% drop), WARN (5-20% drop), STABLE (±5%), GAIN (≥5% gain), ANOMALY_GAIN (≥500% gain). Lifts directly from `scripts/quality-gate.js` thresholds.
3. **Needs-template-authoring signal**: when dispatch.resolution === 'fallback-llm' OR dispatch.needs_template_authoring === true → manifest reflects it AND warnings array includes an actionable message for the operator.
4. **LLM-fallback detection**: extract warnings containing `'llm_fallback'` → `fallback_engaged: 'llm'`. This is the explicit-LLM-route surface.
5. **Silent-drop detection**: `rows_seen > 0 && rows_kept === 0` → warning surfaces the per-row drops (uses `diagnostics.rows_dropped_reasons`).
6. **fetch_html vs fetch_pdf shape detection**: distinguishes the two return shapes; records `fetcher: 'fetch_pdf'` and the DocIntel fallback_reason when present.
7. **Drift detection**: same extraction_method/template_id → null drift; flipped → object with from/to + actionable reason.
8. **Summary aggregation**: across N manifests, counts by status / extractor / fallback / final_strategy / challenge_vendor; computes `deterministic_pct`.

## Verification

```
$ node --test tests/lib/manifest/per-bank-manifest.test.js   → 23 pass
$ npm test                                                   → 1016 pass / 0 fail / 51 skip (+23 from this commit)
$ node scripts/check-write-discipline.js                     → clean
```

## Open follow-ups

- **Wire manifest emit into `run-discovery.js`** — Step 4 migration. The manifest module is self-contained; integration is a single call site after each per-bank extraction.
- **Per-variant manifests** — current design is one-manifest-per-bank covering all variants. If per-variant data becomes useful (FCNR + NRE in same bank), split in Sprint 7.
- **Cloud blob upload** — Sprint 7 will mirror `_manifest_summary.json` to blob alongside `rates-pack.json`.

Step 2 closes. Next: **Step 3a — design + split `lib/actions/extract_html_table.js` (1,870 LOC).**

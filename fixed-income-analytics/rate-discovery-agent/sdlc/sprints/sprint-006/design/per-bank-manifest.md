# Step 2 — Per-bank manifest (Phase D1)

**Sprint:** 006
**Step:** 2
**Status:** Design — to be implemented in Step 2 commit.

## Context

Sprint 5 Phase 0.2 failure inventory identified the single biggest observability gap: **Class C (cohort-runtime failures) is zero**. The orchestrator is good at completing-without-erroring even when extraction yields nothing. Today, a "successful run that produced no data" is indistinguishable from a "successful run that produced real data" unless you read the rates file by hand.

Step 2 / Phase D1 emits a per-bank manifest after every run that surfaces:
- Which fetcher attempted what, with how many retry rungs
- Which extractor fired (template_id) — including `fallback_engaged: 'llm'` when the LLM fallback engaged
- `needs_template_authoring: true` when no template_id matched, signaling the operator to run `scripts/author-template.js`
- `rows_seen` vs `rows_kept` — exposing when an extractor saw rows but dropped them all
- `extraction_method_drift` — when a bank flips between automatic and llm_fallback across consecutive runs, flag it
- Baseline delta vs `tmp/baseline-pre-reset/<bank>_rates.json` so regressions are visible per-run

A roll-up summary at `output/latest/_manifest_summary.json` gives operators an at-a-glance dashboard between runs: deterministic vs LLM %, per-template counts, escalation-rung histogram.

## Goals

1. `lib/manifest/per-bank-manifest.js` — pure module with `buildManifest`, `writeManifest`, `loadManifest`, `buildSummary`, `writeSummary`, `detectMethodDrift`.
2. Manifest emitted to `output/latest/<bank>_manifest.json` per Phase D1 schema.
3. Roll-up summary at `output/latest/_manifest_summary.json` aggregated across all manifests.
4. `extraction_method_drift` detection that compares current run vs the prior manifest (if present).
5. The module is self-contained (no orchestrator wiring in Step 2 — that lands in Step 4 migration).

## Non-goals (out of scope for Step 2)

- Wiring the manifest emit into `run-discovery.js` runtime — Step 4 (migration) wires it when the new fetch + dispatcher path is exercised on the pilot 50.
- Cloud-side blob upload of manifests — Sprint 7.
- Manifest schema versioning beyond `_schema_version: 1` — Sprint 7 if a breaking change is needed.
- Per-variant manifests (one manifest per bank covers all variants for now) — could split in Sprint 7 if useful.

## Files created

- `lib/manifest/per-bank-manifest.js` — main module
- `tests/lib/manifest/per-bank-manifest.test.js` — unit tests

No production code modified in this step.

## Manifest schema

```jsonc
{
  "_schema_version": 1,
  "bank_code": "axis-bank-limited",
  "run_id": "2026-05-24T10:42:11Z-abc123",
  "ts": "2026-05-24T10:42:11.234Z",

  "fetch": {
    "fetcher":             "fetch_html" | "fetch_pdf" | "legacy" | null,
    "attempts":            [{ rung, browser, outcome, status_code?, ms, error?, challenge? }],
    "final_strategy":      "default" | "stealth" | "firefox" | "llm-fallback" | "pdfjs" | "doc_intelligence" | null,
    "challenge_detected":  { vendor, signal } | null,
    "iframe_traversed":    boolean,
    "ms":                  number
  },

  "extract": {
    "extractor":                  "<template_id or null>",
    "template_id":                "<from bank-domains.json or null>",
    "extraction_method":          "<runtime-tagged method>",
    "rows_seen":                  number,
    "rows_kept":                  number,
    "fallback_engaged":           "llm" | "generic-3col" | null,
    "needs_template_authoring":   boolean,
    "diagnostics":                { rows_dropped_reasons, header_row_text, table_used_index, ... }
  },

  "baseline": {
    "prior_slab_count":   number | null,    // from tmp/baseline-pre-reset/<bank>_rates.json
    "current_slab_count": number,
    "delta":              number,           // current - prior
    "delta_pct":          number | null,    // null if prior=0
    "status":             "STABLE" | "GAIN" | "WARN" | "REGRESSION" | "ANOMALY_GAIN" | "NEW"
  },

  "drift": {
    "extraction_method_drift": null | { from, to, reason },  // present when method changed vs prior manifest
    "template_id_drift":       null | { from, to, reason }   // present when template_id changed
  },

  "warnings": ["..."],
  "errors":   ["..."]
}
```

## Roll-up summary schema

```jsonc
{
  "_schema_version": 1,
  "generated_at": "2026-05-24T...",
  "manifests_loaded": 50,
  "by_status": { "STABLE": 42, "GAIN": 5, "REGRESSION": 1, "ANOMALY_GAIN": 0, "NEW": 2 },
  "by_extractor": { "coop-bankin-3col-tenure-general-senior": 20, "psb-pdf-rate-card-3col": 10, ... },
  "by_fallback": {
    "deterministic":         42,
    "fallback_generic_3col": 3,
    "fallback_llm":          5,
    "needs_template_authoring": 5
  },
  "by_final_strategy": { "default": 38, "stealth": 8, "firefox": 1, "llm-fallback": 3 },
  "by_challenge_vendor": { "cloudflare": 4, "akamai": 1 },
  "iframe_traversed_count": 2,
  "method_drift_count": 1,
  "template_drift_count": 0,
  "deterministic_pct": 84,     // (deterministic + fallback_generic_3col) / total
  "needs_template_authoring_pct": 10
}
```

The exit criterion for Step 2 wires into Sprint 6 exit criterion #2: `deterministic_pct > 70` after Step 4 pilot migration.

## API contract

```js
// pure builders
function buildManifest({
  bank_code,         // required
  run_id,            // optional; auto-generated if absent
  fetch_result,      // shape from lib/fetch/fetch_html.js OR lib/fetch/fetch_pdf.js
  extract_result,    // shape from lib/extractors/<id>.js → { slabs, warnings, diagnostics }
  dispatch_result,   // optional; shape from lib/extractors/dispatch.js → { template_id, resolution, needs_template_authoring }
  baseline_slabs,    // optional; baseline slab array for delta calc
  prior_manifest,    // optional; prior run's manifest for drift detection
  ts                 // optional ISO timestamp; defaults to now
}) → manifest

function buildSummary({ manifests }) → summary

function detectMethodDrift({ current, prior }) → null | { from, to, reason }

// IO
function writeManifest({ manifest, outputDir }) → string // path written
function loadManifest({ bank_code, outputDir }) → manifest | null
function listManifests({ outputDir }) → string[] // bank codes with manifests
function writeSummary({ summary, outputDir }) → string

// helpers
function classifyDelta({ current, prior }) → { status, delta, delta_pct }
```

## classifyDelta thresholds

Lifts from `scripts/quality-gate.js` for consistency:
- `prior === 0 && current === 0` → STABLE
- `prior === 0 && current > 0` → NEW
- `delta_pct <= -0.20` → REGRESSION
- `-0.20 < delta_pct <= -0.05` → WARN
- `-0.05 < delta_pct < 0.05` → STABLE
- `0.05 <= delta_pct < 2.0` → GAIN
- `delta_pct >= 5.0` → ANOMALY_GAIN

(The pack quality-gate uses the same thresholds for its findings; the manifest just records the per-bank classification for at-a-glance review.)

## Verification

### Unit tests (≥18 tests)

- `buildManifest` happy path: fetch success + extract slabs + dispatch with template_id → all fields populated
- `buildManifest` with `dispatch.needs_template_authoring=true` → manifest reflects it; warnings include hint
- `buildManifest` with `extract.warnings` including 'llm_fallback' → `extract.fallback_engaged` becomes `'llm'`
- `buildManifest` with no fetch (PDF skip / DocIntel path) → `fetch.fetcher` records correctly
- `classifyDelta` matrix: REGRESSION, WARN, STABLE, GAIN, ANOMALY_GAIN, NEW
- `detectMethodDrift`: same method → null; flipped method → returns from/to
- `buildSummary` aggregates correctly across N manifests (test with synthetic set of 5)
- `writeManifest`/`loadManifest` round-trip — write then load returns the same object
- `listManifests` walks the directory correctly, ignores non-manifest files
- `writeSummary` writes valid JSON

### Integration smoke (Step 4)

When Step 4 wires the manifest emit into the runtime, the smoke is: run the pilot 50, inspect `_manifest_summary.json`, assert `deterministic_pct ≥ 70`.

## Risks

1. **The manifest schema may need to evolve.** Adding fields is non-breaking; removing or renaming bumps `_schema_version`. Sprint 7 will revisit if needed.
2. **`tmp/baseline-pre-reset/` lookup adds I/O to every manifest build.** Mitigated: caller passes `baseline_slabs` if it has them cached; otherwise the module reads the file lazily and skips if missing.
3. **Method drift detection requires prior-run state.** First-ever run for a bank has `drift: { extraction_method_drift: null }` — no false positive. Step 4 verifies this with a synthetic prior-manifest fixture.

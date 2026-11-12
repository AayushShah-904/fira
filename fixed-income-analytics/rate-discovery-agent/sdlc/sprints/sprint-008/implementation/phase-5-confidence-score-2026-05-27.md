# Implementation — Phase 5: composite confidence score + tiered publication (2026-05-27)

Design/ADR: `../../decisions/ADR-016-confidence-scoring-tiered-publication.md`. Status: **complete.**

## What shipped

- **`lib/confidence/score.js`** (new) — `computeVariantConfidence(signals)` → `{ score 0–100, tier: verified|needs_review, contributors }`. Pure function. `verified` requires no structural anomaly, not stale, and FULL cross-check OR (no cross-check + measured error < 10%), score ≥ 70. Absent signals penalized as "unknown", never treated as good.
- **`scripts/confidence/build-confidence.js`** (new) — computes per-variant signals (Phase-3 structural via `runStructuralChecks` + peer stats, freshness, extraction method, plus the latest Phase-4 cross-check + Phase-2 audit error-rates when present) and writes `output/latest/_confidence/<bank>__<variant>.json`.
- **`pack/build-pack.js`** — `confidenceFor(slug, variant)` loads the sidecars; `buildVariant` attaches `confidence_score`/`confidence_tier`/`confidence_signals` **only when `BIRD_EMIT_CONFIDENCE` is set**. `buildSchema` extended with the three optional fields. build-pack stays LLM-free (reads precomputed sidecars).
- **`tests/confidence/score.test.js`** (new) — 8 tests: verified/needs_review boundaries, structural-anomaly veto, stale veto, cross-check DISAGREE, measured-error gating, clamping, absent-signal penalty.

## Schema additions (the answer to "what fields are added")

Per variant (`banks[].products.fd.<variant>`), all **optional**, emitted only under `BIRD_EMIT_CONFIDENCE`:
- `confidence_score` — integer 0–100.
- `confidence_tier` — `verified | needs_review`.
- `confidence_signals` — object: structural blocking/warnings, cross-check agreement, stale, extraction method, measured error rate.

Default published pack is byte-unchanged. Nothing added per-slab.

## Verified

- `node --test tests/confidence/score.test.js` → **8/8**.
- `build-confidence.js` wrote **594 sidecars: 492 verified / 102 needs_review** (used the Phase-2 audit error-rates; cross-check not yet run).
- `BIRD_EMIT_CONFIDENCE=1 npm run build-pack` → 584 variants carry confidence (**484 verified / 100 needs_review**); default `npm run build-pack` emits none (opt-in confirmed). Stale banks correctly land `needs_review` even at score ≥ 70 (e.g. agra-zilla, eff 2023-02 → score 80, tier needs_review).
- Full suite `npm test` → 1181 pass / 1 known-fail (playwright) / 44 skip.

## Deferred

- Surface a `needs_review` INFO count in `quality-gate.js` — cosmetic; the tier is already in the pack and `build-confidence` reports the split. Follow-on.
- Re-run `build-confidence.js` after the Phase-4 cross-check populates agreement, so `verified` is backed by the independent second read (not just low measured error + clean structure).

# ADR-016: Composite confidence score & tiered publication

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Combine the Sprint-008 correctness signals into a per-variant `confidence_score` (0–100) + `confidence_tier` (`verified` / `needs_review`), surfaced in the pack **behind `BIRD_EMIT_CONFIDENCE`** (default off). Scoring is a pure function; `build-pack.js` reads precomputed sidecars and stays LLM-free. |
| Decided by | Samir Joshi (auto-mode authorization, 2026-05-27) |
| Date | 2026-05-27 |
| Sprint | 008 (Phase 5) |
| Related | ADR-015 (snapshots), Phase 2 audit, Phase 3 structural checks, Phase 4 cross-check |

## Context

The program now produces several independent correctness signals — structural checks (Phase 3), a measured per-stratum error rate (Phase 2), and independent cross-check agreement (Phase 4) — plus existing freshness/method provenance. The PM needs ONE actionable answer per variant ("can I trust this?"), not five raw signals. And the operator's trust must be expressible to the downstream consumer without pretending uniform correctness.

## Decision

`lib/confidence/score.js#computeVariantConfidence(signals)` → `{ score, tier, contributors }`:

- Start at 100; subtract for: structural anomaly (−40) / warning (−10); cross-check PARTIAL (−10) / DISAGREE (−35) / LLM_NO_DATA (−20) / absent (−5); static method (−10); stale (−15); half-weighted measured error rate. Clamp 0–100.
- `tier = verified` requires **no structural anomaly, not stale, and either FULL cross-check OR (no cross-check + measured error < 10%)**, and score ≥ 70. Else `needs_review`.
- Absent signals are treated as *unknown* (small penalty), never as *good* — confidence must be earned.

`scripts/confidence/build-confidence.js` computes the signals per variant (structural via Phase 3, freshness, method, plus the latest cross-check + audit summaries when present) and writes `output/latest/_confidence/<bank>__<variant>.json`. `pack/build-pack.js#buildVariant` attaches `confidence_score`/`confidence_tier`/`confidence_signals` from those sidecars **only when `BIRD_EMIT_CONFIDENCE` is set** — so the build stays LLM-free and the default published pack is byte-compatible with prior builds.

### Why opt-in (`BIRD_EMIT_CONFIDENCE`)

The pack is delivered to an external PM. Surfacing a confidence tier is a contract change; it should ship only once the operator trusts the numbers (after the Phase-2/4 signals are populated and reviewed). Default-off lets the fields be validated internally first, then turned on deliberately. (Same soft-rollout discipline as other deploy-time config.)

## Consequences

**Positive.** One field the PM can filter on (`verified` vs `needs_review`); the program's separate signals collapse into an actionable tier; honest about what isn't yet verified. First run: 484 verified / 100 needs_review across 584 variants.

**Costs.** Sidecars must be rebuilt (`build-confidence.js`) before a confidence-emitting pack build; a stale sidecar would carry stale signals. Mitigated by running it as a pre-build step when `BIRD_EMIT_CONFIDENCE` is intended.

**Neutral.** Cross-check agreement is the strongest positive signal but is absent until `cross-check-all.js` is run; until then `verified` leans on low measured error + clean structure + freshness.

## Verification

`tests/confidence/score.test.js` (8 tests): tier logic, clamping, signal weighting, opt-in. `BIRD_EMIT_CONFIDENCE=1 npm run build-pack` emits the fields on 584 variants; default build emits none. Schema (`buildSchema`) extended with the three optional fields.

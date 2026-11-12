# Sprint 010 Phase 1 — pre-publish slab-coverage gate

**Date:** 2026-06-07
**Outcome:** ✅ Gate shipped; publish refuses to upload without a passing or operator-overridden verdict.

---

## What ships

`pack/quality-gate.js` is a standalone script that runs *after* `pack/build-pack.js` and *before* `pack/publish.js`. It reads the rebuilt pack at `pack/dist/rates-pack.json`, compares it against an immutable floor baseline (default `logs/sprint-009/baseline-pack-2026-05-28.json`), and either lets the publish proceed or blocks it.

Two checks:

1. **Global slab drop > 10 %** vs the floor → block. Catches whole-class regressions (the partial_silent storm of Sprint 009).
2. **Any HIGH-confidence bank loses > 50 % of its slabs** → block. Catches surgical regressions on top banks (Axis, BoB, ICICI) where even a small global drop hides a catastrophic per-bank one. "HIGH confidence" is taken from the *floor baseline*, not the current pack, so a bank dropping from high-confidence to zero still triggers.

A bank's confidence = `bank.confidence` (the max across variants — computed by `pack/build-pack.js`).

The gate writes `pack/dist/QUALITY-GATE.json` (machine-readable) and appends a section to `pack/dist/REPORT.md` (human-readable). `pack/publish.js` is wired to read `QUALITY-GATE.json` and refuse to upload unless `effective_pass: true`.

Operator override: `node pack/quality-gate.js --accept-regression "<reason>"`. Records the reason in `QUALITY-GATE.json#operator_override` and sets `effective_pass: true`. The audit trail survives publish.

## Why a separate script (not inlined into build-pack.js)

Three reasons:

1. **Single responsibility.** `build-pack.js` is a transform — input directory of per-bank artifacts → one output pack. The gate is policy. Mixing them makes `build-pack.js` harder to test and harder to reason about.
2. **Operator override needs an audit trail.** Inlining the gate would couple "this pack was built" with "this pack was approved." Keeping them split means `QUALITY-GATE.json` is its own committable artifact.
3. **The build is already used for other things** (the bulk-author flow, snapshot diffs). Forcing it through a gate every time is wrong; only the publish path should be gated.

## Wire-up in publish.js

```js
const gatePath = path.join(DIST_DIR, "QUALITY-GATE.json");
if (!fs.existsSync(gatePath)) {
  throw new Error("pack/dist/QUALITY-GATE.json missing — run 'node pack/quality-gate.js' before publish");
}
const gateVerdict = JSON.parse(fs.readFileSync(gatePath, "utf-8"));
if (!gateVerdict.effective_pass) {
  throw new Error(`quality gate did NOT pass (reasons: ${gateVerdict.block_reasons.join(", ")})`);
}
```

Absence of `QUALITY-GATE.json` is treated as a hard block, not a default-pass. This is intentional: if the operator skips the gate, that's a procedural error we want surfaced loudly.

## Tests

`tests/pack/quality-gate.test.js` — 6 cases via `spawnSync` (the gate's `process.exit` would kill the test runner if required in-process):

| # | Case | Expected |
|---:|---|---|
| 1 | current pack ≈ baseline | exit 0, `pass: true` |
| 2 | global slab drop 30 % | exit 1, `block_reasons: ['global_slab_drop']` |
| 3 | axis loses 60 %, others healthy → global drop within threshold | exit 1, `block_reasons: ['high_confidence_bank_regression']`, axis listed |
| 4 | medium-confidence bank loses 80 % (not gated) | exit 0 |
| 5 | gate blocks, `--accept-regression "axis re-extraction known"` | exit 0, `pass: false`, `effective_pass: true`, `operator_override` recorded |
| 6 | `rates-pack.json` missing | exit 2, stderr `/missing/i` |

All 6 pass. The existing 12 pack tests (`build-pack.test.js`, `build-pack-variant-scoped.test.js`) also pass — no regressions.

Tests use the same temp-dir fixture pattern as `tests/pack/build-pack.test.js` (`makeFixture()` + a synthetic-pack `writePack()` helper that mirrors the real pack's counts/banks shape).

## Verification against the live pack

Running the gate against `pack/dist/rates-pack.json` post-Phase-0:

```
[quality-gate] BLOCK — reasons: high_confidence_bank_regression
[quality-gate]   1 HIGH-confidence bank(s) regressed > 50 %:
[quality-gate]     the-erode-district-central-co-operative-bank-ltd: 7 → 1 (-85.7 %)
[quality-gate] override with --accept-regression "<reason>" if intentional.
```

That regression is real and pre-existing — `the-erode-district-central-co-operative-bank-ltd` lost 6 of 7 baseline slabs to `lib/rate-bounds.js`'s sanity filter during the May-28 → June-7 window (build-pack log on the live pack reports the drop). The gate is correctly flagging it.

The operator's path forward for *this* publish (if needed): `node pack/quality-gate.js --accept-regression "erode DCCB rate-bounds filter — known issue, deferred to Sprint 010 Phase 5/6"`. Or, address the underlying bank in a Phase 5/6 investigation before publishing.

Sprint 010 Phase 1 exit criterion (gate blocks a synthetic > 10 % regression in tests) is met. Phase 1 also incidentally surfaced one real regression the operator now sees explicitly instead of silently.

## Configuration

Both thresholds live in `pack/quality-gate.js`:

```js
const GLOBAL_SLAB_DROP_THRESHOLD = 0.10;
const HIGH_CONFIDENCE_BANK_SLAB_DROP_THRESHOLD = 0.50;
```

Env-var overrides for tests + non-prod runs:

- `BIRD_DIST_DIR` — point gate at a different `dist/` (used by tests)
- `BIRD_QUALITY_GATE_BASELINE` — point gate at a different floor (used by tests)

## What this does NOT do

- The gate does not compare against the *previous publish* (only against the immutable floor). A separate "publish drift" check could be added later if needed — for now, the floor is enough to catch the Sprint-009 class of regression.
- The gate does not validate per-bank schema, only slab counts. Schema validation lives elsewhere (`pack/dist/rates-pack.schema.json`).
- The gate does not auto-update the floor on a clean publish. The floor is intentionally a Sprint-009 close-out artifact and changes only when the operator promotes a new floor.

## Files

- `pack/quality-gate.js` (new) — the gate
- `pack/publish.js` (edit) — gate-check precondition added
- `tests/pack/quality-gate.test.js` (new) — 6 tests
- `sdlc/sprints/sprint-010/implementation/phase-1-coverage-gate-2026-06-07.md` (this doc)

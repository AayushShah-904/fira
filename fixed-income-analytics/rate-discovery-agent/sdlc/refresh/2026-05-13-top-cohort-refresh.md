# Cohort refresh — 2026-05-13

**Operator-driven refresh of all banks for which we already have rate data.**
Out-of-sprint operational work, kicked off because the PM needs updated rates for
the top-cohort banks. Runs locally (no cloud loop touched).

## Scope locked with user (2026-05-13)

- **Cohort:** every bank with at least one `*_rates.json` in `output/latest/`.
  Today that is 286 unique slugs across `regular`, `nre`, `nro`, `fcnr`, `gift`
  variants (62 NRE + 48 NRO + 49 FCNR + 18 GIFT + ~286 regular).
- **Refresh window:** any change vs the stored copy. No time bound.
- **Products in scope:** domestic FD + NRE + NRO + FCNR + GIFT.
- **Promote semantics:** sidecar `_rates.refresh.json` → diff → atomic rename to
  `_rates.json` via `lib/safe-write.js`. Existing curated values are protected
  by the safe-write curated-overwrite check (ADR-012).
- **Code location:** `scripts/refresh/`.
- **No cloud.** Operator triggers locally. Cloud-loop recovery is a separate
  Sprint 003 track.

## Output layout

```
output/refresh/<run-ts>/
  cohort.json                  # phase 1
  fetched/<slug>__<variant>.{html,pdf}  # phase 2 — body cache (one fetch per URL)
  _change_signals.json         # phase 2 — per-bank/variant signal table
  extracted/<slug>__<variant>_rates.json   # phase 3 — candidate (sidecar)
  diffs/<slug>__<variant>.diff.json        # phase 3 — slab-level diff
  _extract_summary.json        # phase 3 — extraction outcome stats
  _promote_plan.json           # phase 3 — dry-run plan (from promote.js)
  _promoted.json               # phase 3 — promote results (after --apply)
  report.txt                   # phase 4 — long-form, GFM markdown content
  summary.txt                  # phase 4 — URL-free at-a-glance summary
  report.json                  # phase 4 — machine-readable for pack
```

**Why `report.txt` not `report.md`:** Norton's `MD:HttpRequest-inf[Susp]`
heuristic quarantines `.md` files with high URL density. Content is GFM
markdown either way; rename to `.md` locally if your viewer needs the extension.

`<run-ts>` is `YYYY-MM-DDTHH-MM-SS`. `output/refresh/latest` symlinks (or copies
on Windows) the most recent run dir for convenience.

## Signal hierarchy (Phase 2)

Cheapest first; first definitive signal wins.

1. **HTTP `Last-Modified` / `ETag`** — HEAD request. Strong for static, weak for
   JS-rendered (CMS regenerates headers on every request).
2. **`effective_date` regex** on fetched body — most authoritative when present.
   Compare against stored `effective_date`. If newer → `likely_changed`.
3. **Normalized content hash** — strip whitespace, script tags, comments; SHA-256
   the rest. Compare against stored hash.
4. **PDF byte-hash + filename date** — for `scraper_type=pdf`.
5. **Playwright table hash** — Tier-2 fallback. Slow; only when 1–3 inconclusive.

Output classifications:
- `unchanged` — signals match prior.
- `likely_changed` — at least one signal differs.
- `unreachable` — fetch failed (network, 4xx, 5xx).
- `signals_missing` — no prior signals stored yet (first refresh run for this
  bank). Treated as `likely_changed` so we always extract once.

Per-bank signals stored in `data/refresh-signals.json` (keyed by slug+variant)
so subsequent runs can compare cheaply.

## Phase 3 — extract, diff, promote

For each `likely_changed` (and `signals_missing`):

1. **Deterministic first.** Invoke `scripts/extract_rates.js` with the stored
   `scraper_type` + `source_url`. Writes sidecar `<slug>_<variant>_rates.refresh.json`.
2. **LLM fallback.** If deterministic yields zero slabs or
   `extraction_confidence: "low"`, invoke the agent in single-bank mode against
   the known URL (skip discovery). One LLM call per bank.
3. **Diff** sidecar vs current `_rates.json` at slab level:
   ```
   { slabs_added: [...], slabs_removed: [...], slabs_changed: [
       { tenure_text, currency?, old_rate, new_rate, delta_bps }
   ] }
   ```
4. **Promote** via `safeWriteArtifact({ kind: 'rates', source: 'agent' })`.
   Sidecar is removed on successful promote. If safe-write defers to
   `<slug>_rates.pending.json` because the existing was operator-curated, the
   diff is still recorded — operator triages via `scripts/resolve-pending.js`
   (Sprint 003 #3 if/when it lands).

## Report (Phase 4)

`report.md` sections:

- **Summary** — banks checked, updated, unchanged, unreachable, extraction-failed.
- **Updates by bank** — grouped by `bank_type` (PSB → PVB → SFB → FB → SUCB → …).
  Each row: bank, variant, old effective_date → new, slab diff inline.
- **Movers** — biggest general-rate moves up/down across the cohort; most-repriced
  tenures; FCNR currency moves.
- **Stale** — banks whose source rate page hasn't changed in > 90 days.
- **Unreachable / failed** — explicit list with reason. These are the followups.

`report.json` carries the same data in a flat shape for `pack/build-pack.js` to
consume on the next pack rebuild.

## Cost / time envelope

- Phase 1: <1 minute (file walk).
- Phase 2: ~10 minutes for 286 banks × up to 5 variants (~600 HTTP requests with
  concurrency 8). Playwright fallback adds ~5s per Tier-2 bank.
- Phase 3: deterministic ~free; LLM fallback ~10–30 banks × $0.02–0.04 = under $2.
- Phase 4: seconds.

Total expected cost: under $2 in AOAI, ~30 minutes wall-clock.

## What is NOT in scope here

- New-bank discovery (handled by the regular agent invocation).
- Cloud-loop fixes (Sprint 003 Track 0 candidate per cloud-state-handoff retro).
- `packages/scraper/` validation (Sprint 003 #2).
- Pending-resolution UI (Sprint 003 #3).

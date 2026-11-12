# Track 1 (#2a) — packages/scraper pipeline audit

**Date:** 2026-05-15 (Sprint 003 Week 1 Day 2)
**Inputs read:** `packages/scraper/src/` end-to-end (1,629 LOC total)
**Purpose:** Map what packages/scraper expects from agent output, what its 7-layer validation actually catches, and where drift between agent contract and scraper contract is plausible. This audit informs the Track 1 import run (#2c) and the Week 1 fork decision.

## Architecture map (single-pass)

CLI entry points (`packages/scraper/src/cli/`):
- `import.ts` (33 LOC) — calls `runImport(outputDir)` from `import-discovery.ts`. Walks all `*_config.json` files under the given directory.
- `validate.ts` (69 LOC) — single-file validator: reads a `_rates.json`, runs `validateImport()`, prints flag list, exits non-zero if any critical flag.
- `detect.ts` (32 LOC) — change-detection over rate-page URLs (HTTP fetch + content hash).
- `pipeline.ts` (141 LOC) — orchestrator: runs detect → import → staleness audit in sequence. Bound to `agentOutputDir = rate-discovery-agent/output` relative to monorepo root.

Core import (`packages/scraper/src/import/import-discovery.ts`, 648 LOC):
- `runImport(input)` — entry. Accepts either a directory or a single `_config.json` path.
- `importConfig(db, configPath, stats)` (line 243) — per-bank flow. Matches bank in DB, updates `banks` table fields, then imports rates from `_rates.json` + 4 variant files.
- `importRates(db, ratesPath, bankId, ...)` (line 294) — per-product flow. Loads slabs, runs `validateImport()` (layers 1–5), persists flags, applies rate versioning if passed.

Validators (`packages/scraper/src/validators/`):
- `index.ts` — exposes `validateImport()` which runs layers 1–5 and returns `{passed, flags, criticalCount, warningCount, infoCount}`. `passed = criticalCount === 0`.
- `format.ts` (92 LOC), `range.ts` (128 LOC), `delta.ts` (95 LOC), `monotonicity.ts` (49 LOC), `completeness.ts` (75 LOC) — layers 1–5.
- `staleness.ts` (58 LOC) — layer 7. **Runs separately** via `pipeline.ts:57-118`, not during import.

## Schema contract — what scraper expects from agent

From `import-discovery.ts:19-73`:

**Config file (`<slug>_config.json`):**
- Required: `bank_code` (line 21), `bank_name` (line 22).
- Optional: `bank_type`, `category`, `website`, `scraper_type`, `rate_page_urls.{fd,savings,rd}`, `selectors`, `column_mapping`, `tenure_parser`, `expected_slab_count`, `rate_multiplier`, `senior_citizen_premium`, `deposit_insurance`, `update_frequency`, `notes`, `scraper_notes`, `discovery_metadata.{confidence,discovered_at,discovery_method}`.
- Defaults merged from `CONFIG_DEFAULTS` (line 83): `tenure_parser="standard_indian"`, `rate_multiplier=1.0`, `senior_citizen_premium="same_table"`, `deposit_insurance=true`, `update_frequency="monthly"`.

**Rates file (`<slug>_rates.json` + variant suffixes):**
- `bank_code` (line 46) — must match config.
- `product_type` — defaults to `"FD"` (import-discovery.ts:307).
- `variant` — defaults to `"regular"` (line 308); valid: `regular`, `nre`, `nro`, `fcnr`, `gift`.
- `effective_date` — defaults to today's date if missing (line 310). **Important:** scraper does not validate effective_date format; an invalid value like "1st July 1995" lands as-is.
- `source_url`, `scraped_at`, `extraction_confidence` — optional metadata; not validated.
- `rate_slabs[]` — required; each slab has `tenure_text`, optional `tenure_min_days`, `tenure_max_days`, required-numeric `rate_general_pct`, optional `rate_senior_pct`, `rate_super_senior_pct`, `compounding_freq`, `min_deposit`, `max_deposit`, `currency` (for fcnr/gift).
- `special_schemes[]`, `warnings[]`, `errors[]` — accepted but not consumed by validation.

**Variant suffixes scanned** (line 76): `_nre_rates.json`, `_nro_rates.json`, `_fcnr_rates.json`, `_gift_rates.json`. Matches the agent's CLAUDE.md output convention exactly.

## Bank matching contract

Two-step lookup in `importConfig()` (line 249):
1. `findBankByCode(db, bankCode)` — exact match on `banks.code` column.
2. Fallback: `findBankByName(db, config.bank_name)` — slugify the name, match `banks.code`.

If neither matches, the bank is logged as `SKIP <bankCode>: no matching bank for "<bank_name>"` and added to `stats.unmatched` (line 252). **The bank is not auto-created.** The DB must already have a row in `banks` with a matching `code` (slug).

**Slugify algorithm in scraper** (line 115-122):
```js
text.toLowerCase().trim()
  .replace(/[^\w\s-]/g, "")
  .replace(/[\s_]+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "");
```

**Slugify algorithm in agent** (`scripts/utils/slugify.js:8-16`) — same five steps. Confirmed identical per memory `project_slug_consistency.md`. **No drift expected.**

**Risk:** the agent has historically emitted bank_codes with product-suffix artifacts (`*_current`, `*_dds`, `*_rd` — Sprint 002 #6 "slug ghosts"). The slug-guard at `lib/slug-guard.js:84-142` corrects these post-hoc. Track 1 should verify the current `output/latest/` has clean slugs; if not, expect ~30 banks to fail matching with `SKIP`.

## 7-layer validation — what blocks, what warns

`validateImport()` (validators/index.ts:48-89) runs layers 1–5 and returns critical/warning/info counts. **Only critical flags block import; warning and info flags are recorded but the import proceeds.**

| Layer | Source | Critical (blocks import) | Warning | Info |
|---|---|---|---|---|
| 1 Format | `format.ts:9-92` | rate_general_pct missing/non-numeric; tenure_text missing; tenure_min/max < 0; min > max | tenure_text unparseable to days; senior rate < general rate | — |
| 2 Range | `range.ts:33-128` | rate < 0 OR rate > max+2 (regular: max ~9.5, so critical only if rate > 11.5 or < 0) | rate outside [min, max] but within max+2; senior outside [min, max+1]; super-senior outside [min, max+1.5] | senior/super-senior present on fcnr/gift variant |
| 3 Delta | `delta.ts:33-95` | delta > 2× threshold (regular: >100bps; SFB/NBFC/LAB: >150bps) on matched tenure slab | delta > 1× threshold (50bps / 75bps); senior delta > threshold (warning only) | — |
| 4 Monotonicity | `monotonicity.ts:8-49` | **never** (line 47: "Monotonicity flags are always warnings/info, never block import") | rate inversion drop > 0.5% | rate inversion drop ≤ 0.5% |
| 5 Completeness | `completeness.ts:10-75` | zero slabs extracted | actual < expected_slab_count × 0.8; actual < previous_slab_count × 0.8 | actual > expected_slab_count × 1.2 |
| 7 Staleness | `staleness.ts:11-58` (separate schedule) | days since scrape ≥ 60 | days since scrape ≥ 30 | — |

**Variant-specific rate ranges** (range.ts:14-23):
- `nre`, `nro`: 2.0–9.5%
- `fcnr`, `gift`: 0.5–8.0%
- regular: uses `PRODUCT_TYPES[productType].rateRange` from `@bird/shared` (not read in this audit — Track 1 #2c should confirm the exact range).

**Delta thresholds** (delta.ts:8-12):
- Default: 50 bps (warning), 100 bps (critical).
- SFB / NBFC / LAB: 75 bps (warning), 150 bps (critical).

## Where critical flags would actually fire (predicted)

Based on the 2026-05-13 refresh artifacts (`output/refresh/2026-05-13T17-29-11/_suspicious.json`):

| Suspicious flag from agent's sanity gate | Will it trigger a scraper critical? |
|---|---|
| IMPLAUSIBLE_RATE (49 cases) — rate outside 1.0–9.5% | Possibly. Critical only if rate > 11.5 or < 0. Agent's sanity gate is stricter than scraper's L2 → most "implausible" rates pass scraper as warning, not critical. |
| SLAB_COUNT_DRIFT (125 cases) — actual slabs differ from prior by >50% | L5 warning (count drop) or info (count rise). **Never critical** unless count drops to zero. |
| ALL_SR_NULL (34 cases) — all senior rates null | L1 has no rule for "senior all null" — passes. |
| GEN_SR_COLLAPSE (19 cases) — senior < general | L1 warning ("senior rate < general rate"); not critical. |
| LARGE_MOVE (7 cases) — single-slab delta > 75 bps | L3 warning (50/75 bps) or critical (>100/150 bps) — depends on bank type. |

**Implication.** The agent's sanity gate is more conservative than the scraper's import gate. **Most agent-flagged "suspicious" cases will NOT block import.** That's by design — the scraper trusts upstream extraction more than it self-checks; the agent's LLM-verify gate already held back 93 banks before they reached `output/latest/`.

The flip side: if the scraper's L2 range bounds are loose (regular max ~9.5%, critical at >11.5%), an out-of-band rate like AB Bank's "12%" entries (seen in `_suspicious.json` first sample) will land as warning + import. The DB will contain those rows; users querying the API will see them.

## Predicted Track 1 (#2c) outcome

Running `packages/scraper/cli/import.ts rate-discovery-agent/output/` against current state:

**Expected pass categories (clean import, zero critical flags):**
- All ~210 banks with regular FD rates whose `rate_general_pct` values fall in [0, max+2] of their product range. This is the vast majority — most Indian FD rates sit 3–8%.
- Same for NRE/NRO/FCNR/GIFT variants within their wider ranges.

**Expected critical-flag cases:**
- Zero-slab files (~30 banks from the `zero_slab_skip` count in `_promoted.json`). L5 critical = blocks import. These would be reported as "0 slabs, validation failed".
- Any bank with `rate_general_pct: null` in slabs. L1 critical.
- Any bank with `min_days > max_days` (e.g., from a tenure-parse bug). L1 critical.

**Expected SKIP cases (no DB match):**
- Slug-ghost banks with `_current`, `_dds`, `_rd` suffixes — if any survive in `output/latest/`. Slug-guard should have cleaned these but Track 1 must verify.
- New banks the agent discovered that aren't in the seeded `banks` table (1,958 banks seeded at Phase 0, per `git log` for parent monorepo). Unlikely to be many.

**Expected behavior on PNB Existing-vs-Revised case:**
- PNB's wrong-column extraction produces rate values that are still in-range (5–7%). L2 passes. L3 might trigger a delta warning vs. prior if the wrong-column rates differ from prior-correct rates by >50 bps. **No blocking critical.**
- The data lands in the DB with a delta warning. The downstream API serves wrong rates. The 7-layer net does NOT catch this class.

**Expected behavior on BoB "1st July 1995" effective_date:**
- `effective_date` is not validated. The string "1st July 1995" lands in `rate_slabs.effective_from` as-is (or causes a date-parse error elsewhere in DB write — needs Track 1 to confirm).
- This is an A2 deferred item; the scraper does not catch it.

## Bar interpretation

Per `week1-bars.md`:
- **≥85% clean import** = Fork A. Highly plausible given the lenient bounds and the fact that the agent's upstream gates already filtered the worst cases.
- **50–84%** = Fork B. Would happen if many banks fail bank-matching (slug drift) or if a structural bug (negative tenure, missing rate_general_pct) hit a non-trivial subset.
- **<50%** = Fork C investigation. Most likely cause would be bank-matching failure (DB doesn't have rows for the agent's slugs) — fixable, not a real product failure.

**A high "clean import" rate is not the same as "rates are correct".** It says the rates land in the DB without structural rejection. It does NOT say PNB's column-mapping is right, BoB's effective_date is right, or that the long-tail bank has rates that match its website. Track 1's bar is about *plumbing*; correctness is Track 2 + Sprint 003 Item #1's domain.

## Drift risks (high-priority for Track 1 run)

1. **`@bird/shared` PRODUCT_TYPES rate ranges** — not read in this audit. Track 1 should confirm `PRODUCT_TYPES.FD.rateRange` value. If max < 9.5%, more banks will trip L2 warnings.
2. **Tenure-text parser** (`parseTenureText` from `@bird/shared`) — not audited here. Some agent-emitted `tenure_text` values are bank-specific (e.g., "12 months 1 day < 13 months" from Bandhan, "888 days" from J&K Bank); if the parser rejects them, L1 warning fires.
3. **DB seeded state** — packages/api seeded 1,958 banks at Phase 0 (`c5f097b`). If banks have been renamed since, slug-match fails. Track 1 should pull a list of agent-emitted bank_codes that are NOT in `banks.code` and inspect.
4. **`rate_slabs.currency` for fcnr/gift** — scraper expects per-slab `currency`. The agent's CLAUDE.md mandates this, but earlier runs may have variant files without it. L1 has no critical rule, but downstream queries will be wrong if currency is missing.
5. **Pre-existing `banks` row updates** — `importConfig` updates `website_url`, `rate_page_url`, `scraper_status`, `discovery_status`, `deposit_insurance`. If the seeded values were curated, this overwrites them silently. Track 1 should snapshot the DB before the import run so the diff is recoverable.

## Recommended Track 1 (#2c) procedure

1. Create a fresh SQLite DB from `packages/api/`'s migrations (no `.db` file currently exists in the repo).
2. Run `seed-admin.ts` to populate the banks table (1,958 banks per Phase 0 commit).
3. Snapshot DB state to a fixture (so we can re-run cleanly).
4. Run `npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/latest/`.
5. Capture stdout + a SQL query of `scrapeFlags` grouped by `severity, flag_type` for the post-run state.
6. Run `npx tsx packages/scraper/src/cli/pipeline.ts --step staleness` to also exercise L7.
7. Produce `sdlc/sprints/sprint-003/implementation/scraper-pipeline-run-2026-05-15.md` with: bank counts (matched / unmatched / clean / warned / failed), flag distribution by layer + severity, and a sampled list of 5–10 representative failures per category.
8. Compare against the `week1-bars.md` bar (≥85% clean).

## Items deferred from this audit (do not re-discover)

- `@bird/shared` PRODUCT_TYPES exact rate ranges per product type — read in #2c.
- `parseTenureText` behavior on edge cases — read in #2c if L1 warnings cluster on tenure parsing.
- DB schema migrations + `packages/api/src/migrations/` content — Track 1 #2c bootstrap.
- `change-detector/index.ts` — L7's input source. Out of scope for import audit; relevant if Fork A revisits the cloud loop.
- `crawlers/` and `parsers/` directories in packages/scraper/src/ — not read; these appear to be inputs to the change detector, not the import path.
- `db.ts` schema (`schema.banks`, `schema.rateSlabs`, `schema.scrapeRuns`, `schema.scrapeFlags`) — referenced but not audited end-to-end. Sufficient that the import does what it says; precise field types not load-bearing for the bar measurement.

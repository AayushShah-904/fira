# Track 1 #2c — packages/scraper import run

**Date:** 2026-05-15 (Sprint 003 Week 1 Day 4)
**Procedure source:** `scraper-pipeline-audit.md` (Day 2 audit) — followed.
**Bar source:** `week1-bars.md` — ≥85% clean import for Fork A; 50–84% for Fork B; <50% for Fork C investigation.

**Headline result: 90.2% clean import — Track 1 votes Fork A.**

## Procedure executed

1. Wiped the parent BIRD repo's `packages/api/.wrangler/` directory to remove any prior partial DB state.
2. `npm run db:setup -w @bird/api` from BIRD root — applied 4 migrations and ran `seed.sql`. **2,002 banks seeded** across 15 categories.
3. `npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/latest/` — ran the scraper's import CLI against current agent output. Log captured at `/tmp/scraper-import-2026-05-15.log` (733 lines).
4. Drilled into the DB (`packages/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c887...sqlite`) to count flags by severity and identify which banks failed.

## Headline numbers

| Metric | Count | % of considered |
|---|---:|---:|
| Banks considered (input `*_config.json` files) | 286 | 100% |
| Imported (bank record updated) | 266 | 93.0% |
| Unmatched (slug not in seeded DB) | 19 | 6.6% |
| JSON parse error | 1 | 0.3% |
| **Clean imports (zero critical flags)** | **258** | **90.2%** |
| Imports with ≥1 critical flag | 8 | 2.8% |
| Imports with rate_slabs in DB (≥1 slab) | 199 | 69.6% |
| Imports without rate_slabs (zero-slab outputs) | 67 | 23.4% |
| **Rate slabs imported** | **4,189** | — |
| Total validation flags | 1,687 | — |
| Banks (seeded total in DB) | 2,002 | — |

## Bar evaluation

- **≥85% clean import → Fork A.** Result: **90.2%** clean. Track 1 votes **Fork A**.
- Combined with Track 2 (when it runs) and Track 3 (already complete — 4 framework survivors), this is one of two signals for the Week 1 fork decision.

## Validation flags by severity

| Severity | Count | Notes |
|---|---:|---|
| critical | 67 | Concentrated in 8 banks |
| warning | 1,067 | Non-blocking; metadata only |
| info | 553 | Non-blocking; monotonicity nudges, range advisories |

## Validation flags by type × severity

| Flag type | Critical | Warning | Info |
|---|---:|---:|---:|
| format | 55 | 593 | 0 |
| range | 4 | 279 | 50 |
| delta | 8 | 8 | 0 |
| monotonicity | 0 | 122 | 452 |
| completeness | 0 | 65 | 51 |

**Most flags are warnings, not blocking** — exactly as `scraper-pipeline-audit.md` predicted ("the scraper trusts upstream extraction more than it self-checks; warning class dominates").

## The 8 banks with critical flags (concentrated, not widespread)

| Bank | Critical type | Count | Sample |
|---|---|---:|---|
| `ab-bank-plc` | range | 4 | `rate_general_pct 12% outside expected range [2.5%, 9.5%] (variant: regular)` |
| `axis-bank-ibu` | delta | 3 | `rate changed by 105 bps (threshold: 50 bps)` |
| `cooperatieve-rabobank-ua` | format | 1 | `tenure_min_days > tenure_max_days` |
| `idbi-bank-ibu` | format | 48 | `rate_general_pct is missing or non-numeric` |
| `indusind-bank-limited` | format | 3 | `rate_general_pct is missing or non-numeric` |
| `punjab-national-bank-ibu` | delta | 5 | `rate changed by 205 bps (threshold: 50 bps)` |
| `punjab-sind-bank` | format | 1 | `tenure_min_days > tenure_max_days` (min=133955, max=730 — tenure parser bug) |
| `south-indian-bank-limited` | format | 2 | `rate_general_pct is missing or non-numeric` |

**Patterns:**
- **AB Bank's 12% rate:** the scraper catches what the agent's sanity gate had already flagged in `_suspicious.json` (49 IMPLAUSIBLE_RATE entries). Double-gate redundancy working.
- **IBU banks dominate the format/critical category** (idbi-bank-ibu alone: 48 flags). Suggests an IBU-specific extraction shape mismatch — likely missing `rate_general_pct` because IBU slabs are per-currency with `rate_general_pct` named differently or split across currency columns. Specific to investigate when implementing A3's per-currency support (Q5 contract).
- **Tenure parser bug:** `cooperatieve-rabobank-ua` and `punjab-sind-bank` produce `tenure_min_days > tenure_max_days`. Likely a `parseTenureText` edge case on unusual tenure strings. Punjab Sind: min=133955 days (=367 years), max=730 days — clear bug.
- **Delta criticals on IBU banks** (axis-bank-ibu, punjab-national-bank-ibu): rates moved 100+ bps. Plausible for foreign-currency IBU rates which are more volatile, but worth manual spot-check.

## 19 unmatched banks (slug not in seeded DB)

Breakdown:
- **11 IBU banks with `– IBU` suffix mismatch** — e.g., `australia-and-new-zealand-banking-group-limited-ibu` agent slug vs. `Australia and New Zealand Banking Group Limited – IBU` DB name. The slugifier strips ` – ` but the agent's slug encodes the difference differently. The seed contains `– IBU` (em-dash) which slugifies oddly. Fixable by either: (a) re-seed with consistent slugs; (b) make the scraper's findBankByName robust to em-dash variants; (c) operator-curate the agent's bank-domains entries to match the seed.
- **5 NSUCB-class cooperative banks** not in seed — agent discovered them, scraper's seed doesn't list them. Examples: `nkgsb-co-operative-bank-ltd`, `the-ahmedabad-mercantile-co-operative-bank-ltd`, `the-zoroastrian-co-operative-bank-ltd`.
- **3 DCCB-class banks** similarly missing — `dhule-and-nandurbar-jilha-sarkari-nokaranchi-sahakari-bank-ltd-dhule`, `shri-kadasiddeshwar-pattan-sahakari-bank-niyamit-banhatti`, `sri-lakshminarayana-co-operative-bank-ltd-bangalore`, `sri-potti-sriramulu-nellore-district-cooperative-central-bank-ltd`, `sriramnagar-pattana-sahakar-bank-niyamit-sriramnagar`.

**Action:** seed expansion (D2 deferred discovery debt) AND slug-canonicalization for IBU em-dash. Both are Sprint 003 implementation items, not Week 1 blockers.

## 1 error

```
C:\sw\BharatOmni\UFA\BIRD\rate-discovery-agent\output\latest\bank-of-india-ibu_config.json:
Bad control character in string literal in JSON at position 4600 (line 31 column 36)
```

This is the same class of issue `cloud-state-handoff-2026-05-13.md` line 45 names — the agent occasionally writes a JSON file with a control character (likely a tab or newline in a string field). Already deferred to Sprint 003 Item #1c (slug discipline + JSON sanitization at the action boundary, per Q12).

## 67 banks imported without rate_slabs (zero-slab outputs)

This matches `_promoted.json::skip_reasons.zero_slab_skip: 30` plus other extraction-failed outputs. Examples in DB:
- 3 Payments Banks (India Post, Jio, NSDL) — don't offer FD-shape products
- ~10 IBU banks
- ~5 RRBs marked `manual_only`/`not_found`
- ~20 DCCBs marked `partial`/`discovered` — extraction unsuccessful but bank record updated
- ~20 SUCBs / state co-op banks — same pattern
- A few foreign banks (BNP Paribas, JP Morgan, Kookmin Bank, Mashreq) — listed but no rates extracted

These banks **are not failures of the pipeline** — they imported cleanly, just with empty slab arrays. The scraper records them as `active, partial` (3) or `manual_only, not_found` (17) or `manual_only, partial` (7).

## Status breakdown (post-import)

| scraper_status / discovery_status | Banks |
|---|---:|
| active / discovered | 216 |
| manual_only / discovered | 21 |
| manual_only / not_found | 17 |
| manual_only / partial | 7 |
| active / partial | 3 |
| active / not_found | 2 |

## What this test does and does not prove

**Does prove (plumbing works):**
- The agent's `output/latest/` JSON shape is structurally compatible with packages/scraper's import.
- The scraper's 7-layer validation catches obvious quality issues (out-of-range rates, malformed tenures, missing rate fields, large deltas) at the critical-severity level.
- Most agent output (90.2%) lands in the DB without manual fix.
- The scraper handles FCNR/GIFT per-currency variants correctly — confirmed by import of UCO Bank's FCNR (45 slabs), Union Bank FCNR (35 slabs), Ujjivan FCNR (5 slabs), etc.

**Does NOT prove (correctness gap, by design):**
- PNB Existing-vs-Revised wrong-column extractions would pass validation — rates are still in [2.5%, 9.5%] range, just from the wrong column. The scraper's L2 doesn't catch domain-correctness errors.
- BoB "1st July 1995" effective_date — not validated by the scraper.
- The 67 zero-slab banks: scraper accepts them as `partial`/`not_found` — that's not wrong, but it doesn't tell us why extraction failed.

The audit's prediction (line "the scraper's import gate is plumbing; correctness is Track 2 + Sprint 003 Item #1's domain") holds.

## Recommendations for Track 1 follow-up (Week 2 if Fork A or B)

1. **Investigate the 48 idbi-bank-ibu format/critical flags** — likely a per-currency rate-field name mismatch. Cross-check the agent's `_rates.json` shape for IBU vs. what the scraper's `RawSlab` expects (specifically `rate_general_pct` field name when currency varies).
2. **Fix the tenure parser** for Rabobank-style and Punjab Sind-style tenure strings (`parseTenureText` in `@bird/shared`). Add unit tests for the failing strings.
3. **Slug-canonicalize IBU em-dash banks** — either re-seed or make `findBankByName` em-dash-aware. 11 IBU banks blocked on this alone.
4. **Expand the seed** to include the ~8 cooperative banks the agent discovered but seed lacks (D2 deferred discovery debt — partial closure).
5. **Sanitize JSON output** at the agent's commit boundary — close the control-character bug class. Maps to Sprint 003 Item #1c (orchestrator + action contracts already specify slug + structure validation; extend to JSON sanitization).

## Cost (per-run economics)

- Wall-clock: ~6 seconds for the full import of 286 banks.
- Operator effort: ~5 minutes (DB bootstrap + run + analysis). No LLM calls.
- AOAI tokens: zero (scraper is fully deterministic).

**Implication for the cadence dimension** (from `re-think-plan.md`): if the rate-extraction pipeline's wall-clock for 1,900 banks scales linearly from the 2026-05-13 refresh (~25 min for 286 banks → ~3 hours for 1,900), the import step adds negligibly (~40 seconds) to that. The pipeline is **import-cheap, extraction-expensive**. Optimization should focus on extraction, not import.

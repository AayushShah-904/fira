# Sprint 011 — Scope (draft, opens 2026-06-11)

**Sprint:** 011
**Branch:** `azure-openai-agent` (continue) — operator may rebrand
**Opens:** 2026-06-11
**Predecessor:** Sprint 010 closed 2026-06-11 — see `sdlc/sprints/sprint-010/retrospection/retro.md` for the full close-out (original + Extension 1 + Extension 2).

## Why Sprint 011

Sprint 010 closed with a publishable pack (9,202 slabs, gate PASS, PM zip delivered) and a confirmed safe-write structural protection at cohort scale (41 destructive overwrites blocked during the `550ptm4` 513-bank run). But several structural gaps remain — most importantly the "clean-but-significant-drop" class of regressions that the existing safe-write rules don't catch.

Sprint 011 has three buckets:

1. **Structural safe-write completion** — close the R3 "clean-but-fewer" gap.
2. **Quality-of-data backlog** — items the chooser surfaced or that the PM brief flagged (HDFC FCNR refresh, currency normalization, pack carrying `extraction_method`).
3. **Cloud reliability carryovers** — Sprint 010 Phase 7 watchdog (deferred), Sprint 010 Extension 1's pre-flight-crash 49-bank cluster, post-cohort D4 profile drain verification.

## Inherited backlog (priority order)

Items 1–17 below are the consolidated list from the Sprint 010 retro's three "candidate backlog" sections (original Phases 0–8, Extension 1 Phases A1–I, Extension 2 Phases J–K). Numbering is preserved for traceability.

### Tier 1 — close the structural gaps (commit to this sprint)

| # | Item | Source | Why now |
|---:|---|---|---|
| 18 | **Agent must extract ALL configured variants — no early-stop after first PDF** | 2026-06-15 FCNR refresh session | Blocks every NRI/FCNR refresh for multi-PDF banks (Axis, HDFC, ICICI, SBI patterns). See § "Item 18 — Agent variant coverage" below. |
| 19 | **Per-table variant classification + footnote capture in `extract_via_ocr`** | 2026-06-15 Axis FCNR session | Single PDFs that bundle FCNR / RFC Term / RFC Savings (Axis pattern, expected on HDFC + several others) tag all slabs with one variant and drop regulatory footnotes. See § "Item 19 — Per-table variant + footnote" below. |
| 20 | **Cohort builder must use UNION of (pack-with-variant) ∪ (bank-domains-has-URL), not pack alone** | 2026-06-16 Yes Bank gap | PM caught us claiming 41-of-44 FCNR coverage while silently excluding 13 FCNR-publishing banks. Highest credibility-cost item. See § "Item 20 — Cohort builder UNION rule" below. |
| 21 | **Per-bank dedup + effective-date sanitisation on LLM-extracted FCNR files** | 2026-06-16 audit findings | BoB FCNR has effective_date "1st July 1995" (LLM mis-parse) + 5 duplicate slabs. IDFC First has 6 duplicate slabs. Deutsche under-extracted (3 slabs total). See § "Item 21 — LLM extraction QC" below. |
| 12 | "Clean-but-significant-drop" rule for safe-write | Extension 2 | Covers R3 class structurally — 36 banks / 421 slabs of loss observed in `550ptm4`. Highest leverage. |
| 1 | End-to-end smoke of Phase 5 fix (single-bank cloud run of `axis-bank-limited`) | Original retro | Closes the partial_silent loop; no real-cloud confirmation yet. |
| 2 | Out-of-process cohort watchdog (Sprint 010 Phase 7, deferred) | Original retro | Backup for in-process watchdog when event loop freezes. ARM-managed timer Function. |

### Tier 2 — quality-of-data backlog (commit if budget)

| # | Item | Source | Notes |
|---:|---|---|---|
| 13 | Pack denormalization preserves `extraction_method` | Extension 2 | Two-line fix in `pack/build-pack.js` + schema update. Removes the `stale_needs_refresh` fallback in the per-variant chooser. |
| 14 | Currency code normalization in pack ("EURO" → "EUR", "YEN" → "JPY") | Extension 2 | Apply at pack-build time, not just CSV view. ~10 banks affected. |
| 15 | Per-variant chooser as a published utility | Extension 2 | Generalize `scripts/recovery/best-per-variant-2026-06-11.js` → `scripts/recovery/best-per-variant.js`; add regression test for "don't trade slab count for freshness" guardrail. |
| 16 | HDFC FCNR refresh | Extension 2 | One-bank targeted scrape: `node run-discovery.js hdfc-bank-limited --variant fcnr --keep-attempts`. Currently 73d old, unknown confidence. |
| 3 | Erode DCCB rate-bounds investigation | Original retro | Surfaces in quality-gate every publish; either bounds too tight or anomalous rates. |

### Tier 3 — cloud reliability (commit if budget)

| # | Item | Source | Notes |
|---:|---|---|---|
| 9 | Pre-flight crash root cause (49 banks) | Extension 1 | Cluster spans IBUs (8), NSUCBs (15), DCCBs (8), FBs (5), RRBs (4). Original Phase 6 fixed one slice (banswara/barmer/bank #315). |
| 10 | The 30 long-failure banks (>5min, template ran but extracted 0) | Extension 1 | Diff against the 372 successes by `template_id`. Likely partial_silent cousins. |
| 11 | IBU pre-flight crash specifically | Extension 1 | Curated `registry_skip` paths interact badly with orchestrator pre-flight. |
| 4 | banswara/barmer cloud crash root cause | Original retro | Currently route-around via Phase 6 mark. |
| 5 | `run-discovery.js` bare-invocation hardening (`bank_type` required error) | Original retro | Partially closed by Extension 1 A2 (`'UNKNOWN'` sentinel); verify A2 fully covers it. |
| 6 | Consumption-profile freeze hunt | Original retro | Sprint 009 hypothesis: kernel resource exhaustion. Run 500-bank cohort on Consumption with telemetry + Phase 7 watchdog as backup. |
| 17 | Cloud-write-time safe-write | Extension 2 | Decision required: hydrate blob state into container before each bank, or keep safe-write at pull boundary? |

### Tier 4 — housekeeping (optional)

| # | Item | Source | Notes |
|---:|---|---|---|
| 7 | Receipt-blob colon-path migration | Original retro | Quality-of-life; downloads silently fail without quoting. |
| 8 | `lib/manifest/per-bank-manifest.js` wire-up | Original retro | Carryover from Sprint 006 Step 4 / Sprint 009 retro item 8. |

## Sprint 010 close — items carried at handover

These were deliberately left open at Sprint 010 close (operator-acknowledged, not forgotten):

- **A.** Commit + push Extension 2 working tree. The recovery scripts, chooser script, implementation docs, and pack zip exist in the working tree but were not committed before Sprint 010 close. Operator may want this as the first Sprint 011 commit, or a Sprint 010 tail commit. **Recommend: first Sprint 011 commit** (groups with item 15 — generalizing the chooser into a published utility).
- **B.** D4 profile drain verification. `f46b802` re-added `d4-jobs` to fire `550ptm4`; the post-cohort revert step (Phase H equivalent) needs verification via `az containerapp env workloadProfile list`. **Recommend: pre-Tier-1 housekeeping in Sprint 011.**

## Recommended Tier 1 sprint exit criteria

| # | Criterion |
|---:|---|
| 1 | Extension 2 work committed + pushed (item A above) |
| 2 | D4 profile drain verified (item B above) |
| 3 | "Clean-but-significant-drop" safe-write rule shipped with tests; would have blocked ≥30 of the 36 R3 banks from `550ptm4` retroactively |
| 4 | Axis single-bank cloud smoke passes through orchestrator with no partial_silent marker written |
| 5 | Cohort watchdog Function deployed to non-prod RG; kills a paused job within 30 min |
| 6 | Sprint retro committed |

## What's explicitly NOT in Sprint 011

- No new 500+ bank cohort run unless watchdog + clean-but-drop rule both land.
- No D4 profile re-add (`550ptm4` was a one-shot; cohort runs default to Consumption).
- No pack schema breaking change (Tier 2 item 13 adds `extraction_method` — additive only).
- No PM-facing re-publish unless operator requests one (current zip at `pack/rates-pack-2026-06-11.zip` is the standing deliverable).

---

## Item 18 — Agent variant coverage (full problem statement)

**Surfaced:** 2026-06-15 FCNR refresh session. PM reported industry-wide FCNR rate changes effective 2026-06-13; we attempted to refresh the 44 FCNR-publishing banks. The agent could not refresh Axis Bank FCNR despite three separate invocations.

### Problem

For banks that publish FD / NRE / NRO / FCNR rates in **separate URLs** (typical pattern for PSBs, large PVBs, and foreign banks — Axis, HDFC, ICICI, SBI all do this), the LLM-driven `run-discovery.js` control loop **stops after the first PDF or page that returns slabs**. Other configured `rate_pages.fd_*` keys are silently skipped.

Concrete evidence from 2026-06-15:

| Bank | Invocation | Outcome | Variants extracted |
|---|---|---|---|
| `axis-bank-limited` | `node run-discovery.js "Axis Bank Limited" --rates-only` (×2, after fixing the 5 stale PDF dates in bank-domains.json) | OK, exit 0 | Domestic FD only (110 slabs). NRE, NRO, FCNR pages never visited. |
| `axis-bank-limited` | `node run-discovery.js "Axis Bank Limited" --expand-nri` (the mode named "NRI Expansion") | OK, exit 0 | Same — only domestic FD. |
| Direct extractor (control) | `node scripts/recovery/axis-fcnr-direct-2026-06-15.js` — calls `extractViaOcr({url, variant:'fcnr'})` from `lib/actions/extract_via_ocr.js` directly | OK, no LLM in the loop | **71 fresh FCNR slabs** across USD/GBP/EUR/AUD/CAD/JPY |

The agent has the exact same tool (`extract_via_ocr`) registered. The prompt (`prompts/expand-nri.md` line "Fetch and extract rates from ALL known rate pages: Domestic FD page, NRE page (if found), …") explicitly asks for full coverage. The data (`fd_pdf_fcnr` URL) is correct in bank-domains.json. The LLM still terminates after the first PDF returns slabs because there's no enforced post-check that compares "variants attempted" against "variants configured."

### Why this is Tier 1 (not Tier 2/3)

- Every NRI / FCNR refresh today is blocked for multi-PDF banks unless we run a per-bank direct-extractor workaround.
- The 2026-06-15 cohort produced fresh FCNR for ~3 of ~17 completed banks (~18% hit rate) directly because of this; for the other 14, FCNR either wasn't returned or fell back to prior-pack data.
- Adjacent Tier 1 item (12, clean-but-significant-drop rule) doesn't help — that gates *destructive overwrites*, not *missed variant visits*.
- The HDFC FCNR refresh (Tier 2 item 16) almost certainly has the same problem.

### Suggested fix — pick one or stage in order

**(a) Deterministic post-LLM coverage loop (preferred, ~1 day):**
After the LLM agent in `run-discovery.js` finishes its conversation, before result collection, compute the set of `expected_variants` from the bank's `rate_pages` config (`fd`, `fd_nre`, `fd_nro`, `fd_fcnr`, etc.) and intersect with what the LLM actually wrote files for. For each missing variant whose URL is a PDF or known-shape image, invoke the deterministic `extract_via_ocr({url, variant})` action directly and safe-write the result. This makes the LLM responsible for the *discovery* path it's good at, and a deterministic loop responsible for the *coverage* requirement.

Files: `run-discovery.js` around line 686 (post-LLM, pre-collectResults), `lib/actions/extract_via_ocr.js` (already exists), `lib/safe-write.js` (already exists).

**(b) Prompt-side post-check (~half day):**
Before the agent finalizes, inject a tool result that lists "you have NRE configured at `<url>`, FCNR at `<url>` — write a rates file for each before declaring done." Cheaper to implement but relies on LLM compliance; will degrade on different model versions.

**(c) Per-variant CLI flag (~half day):**
`node run-discovery.js <bank> --variant fcnr --keep-attempts` — operator-driven targeted refresh that bypasses the multi-variant decision entirely. Useful as a fallback even if (a) ships. Hooks the same `extract_via_ocr` path.

Recommended: (a) + (c). (a) fixes the systemic gap; (c) gives operators a clean recovery path during the migration.

### Test plan

1. Regression: run `--rates-only` against axis-bank-limited. Expect rates files for `regular`, `nre`, `nro`, `fcnr` — all FRESH today.
2. Regression: run `--rates-only` against hdfc-bank-limited and icici-bank-limited (separate-URL multi-PDF banks).
3. Negative: run against a single-page-multi-variant bank (e.g., bank-of-baroda where all variants land on one page). The deterministic loop should be a no-op for variants the LLM already wrote.
4. Determinism: run twice with identical inputs; second run's per-variant calls should be idempotent (safe-write detects no change).

### Workaround in use today

`scripts/recovery/axis-fcnr-direct-2026-06-15.js` — Axis-FCNR-specific one-shot. Until item 18 ships, similar per-bank scripts will be needed for any FCNR refresh on a multi-PDF bank.

---

## Item 19 — Per-table variant + footnote (full problem statement)

**Surfaced:** 2026-06-15 Axis FCNR session, immediately downstream of item 18.

### Problem

`lib/actions/extract_via_ocr.js#extractViaOcr({url, variant})` takes a single `variant` (e.g., `'fcnr'`) and applies it uniformly to every table found in the PDF via `tableToSlabs(tables[i], variant)`. The function has no per-table classification.

Concrete evidence — the Axis Jun-13 PDF `fcnr-rfc-deposits-13-june-26.pdf` bundles three sections on a single page:

| Table | Section | Slabs extracted | Should-be variant | Actually tagged |
|---|---|---:|---|---|
| 1 | FCNR (B) — 6 currencies including JPY, tenure ≥ 1 year | 35 | `fcnr` | ✅ `fcnr` |
| 2 | RFC Term — 5 currencies excluding JPY, tenure 30d to 5y | 36 | `rfc_term` (new variant — not currently in pack schema) | ❌ `fcnr` (wrong) |
| 3 | RFC Savings — no tenure dimension | 0 (filtered out — no rows) | `rfc_savings` | n/a |

Result: 71 slabs written to `axis-bank-limited_fcnr_rates.json` of which **36 are not actually FCNR**. The "FCNR refresh" effectively contaminated the FCNR pack with RFC Term rates.

The same PDF also carries a regulatory footnote at the bottom:

> *"In accordance with the applicable RBI regulatory guidelines, FCNR (B) deposits opened or renewed on maturity during the period from 8th June 2026 to 30th September 2026, with a minimum contractual tenor of three years and a maximum tenor of five years, shall be subject to a mandatory lock-in period of one year from the date of opening or renewal, as the case may be."*

In the FCNR table itself, 3-5 year tenures carry a `#` marker linking to this footnote. The extractor pulls the `#` into `tenure_text` (e.g. `"3 years < 4 years#"`) but the footnote text itself is discarded — it lives in `analyzeResult.paragraphs` outside the table cells. Downstream consumers (the rate pack, the PM brief) lose the regulatory context entirely.

Same pattern is expected on HDFC, ICICI, SBI and most banks that publish FCNR — multi-section single-page rate sheets are the norm, not the exception.

### Suggested fix

**(a) Per-table variant classification via DI Layout `paragraphs` (preferred):**
In `tableToSlabs` (or in `extractViaOcr` before the loop), for each table:
1. Find the nearest preceding paragraph using the table's `boundingRegions` y-coordinate. DI Layout returns `paragraphs[].boundingRegions[].polygon` for spatial matching.
2. Pattern-match heading text against a variant-keyword map:
   - `/FCNR\s*\(?B\)?/i` → `fcnr`
   - `/RFC\s*Term/i` → `rfc_term`
   - `/RFC\s*Savings/i` → `rfc_savings`
   - `/Domestic|Regular/i` → `regular`
   - `/NRE/i` → `nre`
   - `/NRO/i` → `nro`
3. If heading match found, override the input `variant`. If not found, fall back to the input variant.
4. **Heuristic fallback** for unlabelled tables: examine row-0 currency set: presence of JPY ⇒ FCNR; lack of JPY in a currency-bearing table ⇒ RFC Term; no currency column at all ⇒ Savings.

**(b) Footnote capture (couples with `#` markers):**
After table extraction, scan `analyzeResult.paragraphs` for paragraphs that:
- Are spatially below the last table (y-coord greater than max table y)
- Match `/^[#*†]/` OR `/lock-in|RBI|regulatory|note:/i`

Attach these as a new `regulatory_constraints` field on the rate file, scoped per-variant. For slabs whose `tenure_text` contains the matching marker (`#`, `*`, etc.), also stamp the slab with `lock_in_2026_jun_sep: true` (or generalised `regulatory_flag_keys`) so downstream renderers can show the indicator.

**(c) Pack schema decision (separate, gates downstream display):**
Decide whether to add `rfc_term` / `rfc_savings` as new variants alongside `regular`/`nre`/`nro`/`fcnr`/`gift`. The PM hasn't asked for RFC products yet; for now item 19 should at minimum **stop tagging them as FCNR**. Either:
- Drop RFC Term / Savings slabs entirely (filter at extractor level, log count for visibility), OR
- Write them to `_rfc_term_rates.json` / `_rfc_savings_rates.json` files that the pack builder ignores until the schema decision lands.

Recommended: (a) + (b) ship together; (c) — start by dropping with a log line; expand variant set later if PM asks.

### Test plan

1. **Axis Jun-13 PDF golden:** add the file as a golden input. After fix, extractor returns exactly 35 FCNR slabs + 36 RFC Term slabs + 0 Savings slabs. The FCNR file gets the regulatory_constraints text; the 21 affected slabs (3y-5y, `#` marker) carry the flag.
2. **HDFC FCNR PDF:** run extractor; verify per-variant counts match the rendered PDF's section row counts; verify footnote(s) are captured.
3. **Single-section PDF regression:** run against a PDF that genuinely has only FCNR (no RFC). Variant assignment must remain `fcnr`; no spurious RFC files written.

### Workaround in use today

`scripts/recovery/axis-fcnr-purify-2026-06-15.js` — post-filters the extractor output for Axis specifically (drops non-JPY tenures, attaches the footnote text). Until item 19 ships, this pattern would have to be re-applied per bank — fragile and easy to miss.

---

## Item 20 — Cohort builder UNION rule (full problem statement)

**Surfaced:** 2026-06-16 — PM noticed Yes Bank missing from the FCNR pack delivered 2026-06-15. Operator review surfaced 13 banks in the same class.

### Problem

`scripts/cohort/build-fcnr-2026-06-11.js` picked the refresh cohort by reading `pack/dist/rates-pack.json` and selecting banks where `b.products.fd.fcnr.slabs.length > 0`. This is the set of banks where the **pack currently has FCNR data**, NOT the set of banks that **publish FCNR**.

The two sets diverge for any bank where the FCNR variant has never been successfully extracted into the pack. For Yes Bank specifically: `data/bank-domains.json#yes-bank-limited.rate_pages.fd_fcnr = "/pdf?name=nri_interest_rates_pdf.pdf"` was configured all along, but extraction never landed slabs in pack (Akamai bot block + the agent's variant-coverage bug). Our filter then dropped it silently.

The cohort-construction audit found **13 banks** in this class: yes-bank-limited, bank-of-india, bank-of-ceylon, cooperatieve-rabobank-ua, dcb-bank-limited, equitas-small-finance-bank-limited, keb-hana-bank, kookmin-bank, nainital-bank-limited, nonghyup-bank, pt-bank-maybank-indonesia-tbk, shinhan-bank, united-overseas-bank-limited. Each has a non-null `fd_fcnr` URL in bank-domains AND is in the canonical 513-bank `pm-refresh-2026-q2` cohort.

### Suggested fix

**Replace the single-source filter** in any cohort builder targeting a variant with the UNION:

```js
const inPack = new Set(pack.banks
  .filter(b => b.products?.fd?.[variant]?.slabs?.length > 0)
  .map(b => b.bank_code));
const inDomains = new Set(Object.entries(domains)
  .filter(([_, d]) => d.rate_pages && d.rate_pages[`fd_${variant === 'regular' ? '' : variant}`])
  .map(([bc, _]) => bc));
const cohortBanks = new Set([...inPack, ...inDomains]);
```

Plus an explicit AUDIT step at cohort-build time:

```js
const gap = [...inDomains].filter(bc => !inPack.has(bc));
if (gap.length > 0) {
  console.warn(`[cohort-audit] ${gap.length} banks publish ${variant} per bank-domains but have no pack data:`);
  gap.forEach(bc => console.warn(`  - ${bc}`));
}
```

The warn loop is the operator-visible signal that catches this exact class of miss. Should also be added to `pack/quality-gate.js` as a soft gate (warn, don't block) once the union-rule lands.

### Test plan

1. Synthetic: pack with 5 FCNR banks, bank-domains with 7 fd_fcnr entries — cohort = 7, gap warn lists the 2 extras.
2. Run against 2026-06-16 state — expect 44 + 13 = 57 banks in the corrected cohort.

### Workaround in use today

`scripts/cohort/build-fcnr-2026-06-11.js` will be re-built using the union rule before any future FCNR refresh. Tonight's 2026-06-15 PM delivery is being patched bank-by-bank for the 13 missed entries (Yes Bank first, then the foreign-bank cluster on operator triage).

---

## Item 21 — LLM extraction QC (dedup + effective-date sanitisation)

**Surfaced:** 2026-06-16 audit of the 41 "claimed fresh" FCNR banks.

### Problem

LLM-path (`extraction_method: llm_inline_extraction`) extractions occasionally produce:

- **Duplicate slabs**: same `(tenure_text, currency, deposit_range, scheme_subtype)` written twice with the same rate. Observed:
  - `bank-of-baroda` — 5 duplicates (reported 41 slabs, actual 36 unique). Pattern: 5-Year tier emitted twice for GBP/EUR/CAD/AUD.
  - `idfc-first-bank-limited` — 6 duplicates (reported 18, actual 12). Same `1 Yr < 15 Months|USD` repeated.
- **Garbage effective_date strings**: `bank-of-baroda#effective_date = "1st July 1995"`. The LLM grabbed the FCNR(B) product-introduction date from page legalese rather than the rate-effective date. Slabs themselves are fine; only metadata is wrong.
- **Under-extraction**: `deutsche-bank-ag` returned only 3 FCNR slabs (~2 unique after dedup) when the bank typically publishes 5-15. The agent likely hit the LLM context-length truncation that we saw on canara-bank during the cohort run.

### Suggested fix

Run a deterministic post-LLM QC pass inside `lib/safe-write.js` (or a layer above it) on `kind: 'rates'` writes when `extraction_method === 'llm_inline_extraction'`:

1. **Dedup by composite key** `(tenure_text|currency|deposit_range|scheme_subtype)`. First wins.
2. **Effective-date sanitisation**: parse the field; reject if year < (current_year - 2) AND no ISO format match — emit warning, store as `null`. Allow operator-provided dates via `manual_data_entry` extraction_method to bypass.
3. **Slab-count vs prior**: if scrape produces < 50% of prior slab count for HIGH-confidence banks, flag as `quality_warning: 'under_extraction_suspected'`. Don't block (safe-write Rule 2 already covers destructive overwrite); just surface for operator review.

### Test plan

Use today's BoB and IDFC First files as fixtures:
- BoB: 41-slab input → 36-slab output after dedup; `effective_date = null` after sanitisation.
- IDFC First: 18-slab input → 12-slab output after dedup; effective date unchanged.

### Workaround in use today

Manual cleanup script for tonight's PM delivery (write a tiny patch script that dedupes BoB + IDFC and nulls BoB's garbage effective_date, run once, then rebuild the PM zip).

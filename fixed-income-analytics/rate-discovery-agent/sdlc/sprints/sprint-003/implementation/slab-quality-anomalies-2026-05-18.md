# Slab-quality anomalies — next iteration scope (2026-05-18)

After the tenure-parse + dedup fix (`3ccfa4e`), the 5-bank smoke produced 265 trustworthy slabs (153 → 265, +73 %). Reviewing all slabs per-row surfaced four classes of remaining quality issue. Each is a generic pattern that will recur across the 200/1800-bank target set, not a per-bank quirk.

## Smoke baseline (`output/runs/smoke-tenure-fix/`)

| Bank | Variant | Slabs | Parsed | Unparsed | Status |
|---|---|---:|---:|---:|---|
| Abhyudaya | regular | 8 | 8 | 0 | clean |
| AU SFB | regular | 20 | 20 | 0 | dup tenures with different rates |
| AU SFB | nre | 20 | 20 | 0 | same dup pattern |
| AU SFB | nro | 20 | 20 | 0 | same dup pattern |
| BOI-IBU | gift | 112 | 112 | 0 | **duplicate slabs with two `deposit_range` label formats** |
| HDFC | regular | 19 | 5 | **14** | tenure parser doesn't handle `<` / `<=` comparators |
| SBI | regular | 10 | 8 | 2 | 2 bulk-tier rows with bare tenure |
| SBI | nre | 7 | 5 | 2 | **rows 6-7 are deposit-amount tiers, not FD slabs** |
| SBI | nro | 13 | 6 | 7 | **row 11 = penalty rule; rows 12-13 = deposit-amount tiers** |
| SBI | fcnr | 36 | 36 | 0 | clean 6 tenures × 6 currencies |

## The four anomalies

### A1 — Inconsistent `deposit_range` label format collapses dedup

**Symptom (BOI-IBU 112 slabs).** Same underlying data appears 4 times across the page's two deposit tiers, but the LLM emits the deposit_range value with two conventions across different chunks:
- 32 rows with `deposit_range: null` (below 1 Mn tier, unlabeled)
- 32 rows with `deposit_range: "above 1.00 Mn"` (with spaces)
- 24 rows with `deposit_range: "below_1.00_Mn"` (snake_case)
- 24 rows with `deposit_range: "above_1.00_Mn"` (snake_case)

The dedup key includes `deposit_range` as-is, so `"above 1.00 Mn"` ≠ `"above_1.00_Mn"` and both survive. True BOI page has 64 unique slabs (4 currencies × 8 tenures × 2 tiers); we ship 112 because of label drift.

**Generality.** Multi-tier banks (large SFBs, PSBs with bulk deposit tables) all hit this when extracted via per-chunk LLM. The fix is bank-agnostic.

**Fix (target: ~15 lines).** Add `normaliseDepositRange(text)` helper in `extract_html_table.js` that maps the LLM's free-text label into a canonical snake_case token from CLAUDE.md's deposit-range list (`below_3cr`, `3cr_to_5cr`, `5cr_to_25cr`, `25cr_to_100cr`, `above_100cr`, `below_15l`, `15l_to_1cr`, `1cr_to_10cr`, `above_10cr`). Apply before dedup. Unknown labels pass through with a `deposit_range_normalised` warning so we can iterate on the canonical list.

### A2 — Non-FD rows leak into NRE/NRO output

**Symptom (SBI NRE/NRO).** Both files include rows like:
- `tenure_text: "Up to Rs.5.00 lacs"`, `rate_general_pct: 0.5`
- `tenure_text: "Above Rs.5.00 lacs but below Rs.1 Crore"`, `rate_general_pct: 1.0`
- `tenure_text: "Premature withdrawal"`, `rate_general_pct: 7`

These are deposit-amount tier indicators or penalty rules — not FD slabs. The 0.5 / 1.0 / 7 % rates are not interest rates at all (0.5 / 1.0 are savings-rate-like; 7 is a penalty cap).

**Generality.** Every PSB / large PVB page mixes domestic FD rates with savings, penalty, and bulk-tier footnotes. The existing `non_fd_filter` (commit `ad4ce65`) handles the FCNR/GIFT version of this; it needs to extend to all variants.

**Fix (target: ~20 lines).** Promote `non_fd_filter` from FCNR-only to all variants. Catch when `tenure_text` matches any of: `^up to Rs`, `^above Rs`, `below Rs\.?\s*\d`, `premature withdrawal`, `penalty`, `min(imum)? deposit`, `maximum amount`. Also catch when `rate_general_pct < 1.0` for non-FCNR variants (FD rates rarely dip below 2 %; savings can be 0.5 %; sub-1 % is almost certainly not FD).

### A3 — Tenure parser misses `<` / `<=` comparators

**Symptom (HDFC).** 14 of 19 HDFC domestic FD rows are unparsed because they use:
- `9 months 1 day to < 1 Year`
- `1 Year to < 15 months`
- `90 days <= 6 months`
- `6 months 1 day <=9 months`
- `2 Years 11 Months 1 day <= 3 Year`
- `2 Years 11 Months (35 months)` (parenthetical alt-form)

Slabs survive dedup thanks to text-fallback, but downstream sort/lookup by day bounds is broken.

**Generality.** HDFC's convention is shared by ICICI, Axis, several PSBs. The `< N units` / `<= N units` upper bound is the most common variant we don't parse.

**Fix (target: ~30 lines in `parseTenure`).** Extend the range regex's separator and upper-bound qualifier to accept `<`, `<=`, `< `, `<= `. Treat `< N units` as `maxDays = N*factor - 1`, same as the existing "less than" wording. Add separate regex for `< N units` / `<= N units` as a bare upper-bound expression. Strip parenthetical commentary (e.g., `"(35 months)"`, `"(AMRIT VRISHTI)"`) before the regex pass — these are descriptive labels, not part of the bound.

### A4 — Multi-tier tables with no tier labels (deferred)

**Symptom (AU SFB).** AU publishes 3 deposit-amount tiers (< ₹3 Cr, ₹3–5 Cr, ≥ ₹5 Cr) stacked on one page. The cheerio extractor finds 20 rows but emits them all with `deposit_range: null` — only the tenure text differs. Same tenures repeat at different rates per tier (rows 5–12 vs 16–20).

**Generality.** Common across SFBs and large PVBs with bulk deposit tables.

**Why deferred.** Fix requires reliable detection of tier-section headers within the cheerio chunking (currently the chunker captures preceding headings but doesn't propagate them as per-table tier hints). This is invasive — affects chunk schema, dedup key composition, and slab tagging. Track as a Sprint-004 candidate with a dedicated design pass; don't fold into the A1/A2/A3 commit.

## Scope of this iteration

Ship **A1 + A2 + A3 in a single commit**. Each is a < 30-line localised change with new unit tests. None of them touch the LLM contract, chunking, or post-validation paths. Together they reduce BOI-IBU 112 → ~64, recover SBI NRE/NRO from 7/13 to 5/9 clean slabs, and bring HDFC's parsed-bounds count from 5/19 to ≥ 17/19.

A4 stays deferred — a known Sprint-004 line item.

## Files to modify

| File | Change |
|---|---|
| `lib/actions/extract_html_table.js` | New `normaliseDepositRange` helper; call it before `dedupSlabs`. Extend the existing non-FD filter to all variants. |
| `scripts/utils/parse-tenure.js` | Extend range regex to accept `<` / `<=` separator + qualifier; add `< N unit` / `<= N unit` upper-bound-only pattern; strip parentheticals before parse. |
| `tests/scripts/parse-tenure.test.js` | Add 6 fixtures for HDFC-style phrasings (`9 months 1 day to < 1 Year`, `90 days <= 6 months`, etc.). |
| `tests/lib/actions/extract_html_table.test.js` | One test for normaliseDepositRange; one for non_fd filter on NRE input; one for the BOI-style label-drift dedup. |

## Verification

1. **Tests**: `SKIP_PLAYWRIGHT_TESTS=1 npm test` — expect ≥ 472 pass, 0 fail.
2. **5-bank smoke**: re-run HDFC + SBI + BOI-IBU + AU SFB + Abhyudaya. Expected slabs:
   - BOI-IBU: ~64 (down from 112; dedup wins)
   - HDFC: ≥ 17 parsed bounds (up from 5)
   - SBI NRE: ≤ 5 (down from 7; non-FD rows dropped)
   - SBI NRO: ≤ 9 (down from 13; non-FD rows dropped)
   - SBI regular / fcnr / AU SFB / Abhyudaya: unchanged
3. **Anomaly check**: regenerate the per-slab tables (`scripts/analysis/dump-slabs.js` or inline node command) and confirm:
   - No two slabs differ only by deposit_range label format
   - No NRE/NRO slab has `tenure_text` starting with `Up to Rs` / `Above Rs` / `Premature`
   - HDFC `tenure_min_days` is non-null for at least 17 of its rows

## Stop conditions

- If the BOI dedup result drops below 60, we lost real rows somewhere — investigate the normalisation table before merging.
- If HDFC's `<=` rows pick up parser hits but the day bounds look wrong (e.g., `<= 6 months` parsed as 0 → 180), revisit the comparator semantics.
- If non_fd filter false-positives on a legitimate edge case in another bank's smoke (e.g., a rate row that happens to be below 1 %), narrow the rate threshold.

## Out of scope (capture for later)

- A4 multi-tier section-header propagation — Sprint-004.
- Tenure-text sanitisation for downstream display (Abhyudaya's `"(new slab)"` suffix) — not blocking correctness.
- Effective-date format normalisation across banks — not blocking; downstream import normalises.

# Tenure-parse + dedup-fallback fix (2026-05-18)

Supersedes the speculative diagnosis in `hdfc-regression-2026-05-18.md` — confirmed root cause with evidence; designed two generic fixes that benefit every bank with the same phrasing family, not HDFC alone.

## Context

HDFC's 71 → 2 slab drop after the prompt-improvement commits (`debb627`) looked HDFC-specific but isn't. The 19-slab cheerio result is correct; the loss happens at the final `dedupSlabs` step because most slabs end up with `tenure_min_days = null` and collapse into one bucket.

Concrete diagnosis from `output/runs/smoke-p4c2/hdfc-bank-limited_rates.json`:

- Warnings show `cheerio_picker: chose table[0] (19 slabs)` — extraction worked.
- Only 2 of the 19 ended up in the file. Both have parseable tenure phrasings; the unparseable ones collapsed to a single dedup bucket.
- Root cause confirmed by direct test of `scripts/utils/parse-tenure.js`: of 9 common bank phrasings, 5 fail:

  | Phrasing | parseTenure result |
  |---|---|
  | `"7 - 14 days"` | null |
  | `"7-14 days"` | null |
  | `"15 Mos to 1 Yr"` | null |
  | `"1 Yr"` | null |
  | `"above 5 years"` | null |
  | `"21 months to 2 years"` | OK |
  | `"1 year and above"` | OK |
  | `"7 days"` | OK |
  | `"46 days to less than 1 year"` | OK |

These five formats are common across the 200-bank top tier (AU SFB's `"1 Yr"` was already observed in the strategy doc; HDFC's hyphen-separated ranges hit multiple PSBs and PVBs; `"Mos"`/`"Yrs"` abbreviations are typical of co-op bank rate cards). Fixing them once benefits every bank that uses any of these formats. No HDFC-specific selectors, no per-bank workarounds.

The deeper issue surfaced by HDFC: even when `parseTenure` fails, `dedupSlabs` shouldn't collapse two rows that *clearly* differ in `tenure_text`. Currently the dedup key is `(tenure_min, tenure_max, currency, deposit_range)`, so `(null, null, null, 'below_3cr')` matches every unparseable row. A second fix — fall back to `tenure_text` as the dedup discriminator when bounds are null — protects future banks against any unparseable phrasings that slip through.

Outcome: HDFC recovers (expected ≥ 15 slabs), and every bank with the same family of tenure formats benefits without code change per bank.

## The two fixes

### Fix 1 — Expand `parseTenure` (`scripts/utils/parse-tenure.js`)

| Pattern | Example | Approach |
|---|---|---|
| Hyphen range, unit only on second number | `"7 - 14 days"` / `"7-14 days"` | New regex: `^(\d+)\s*[-–—]\s*(\d+)\s*(days?\|weeks?\|months?\|years?)$` — units apply to both numbers. |
| Abbreviated unit forms | `"1 Yr"`, `"6 Mos"`, `"2 Wks"`, `"5 Hrs"` | Extend `TENURE_UNIT_DAYS` with abbreviations (`yr`, `yrs`, `mo`, `mos`, `wk`, `wks`) and broaden the unit character class in all three patterns. |
| Mixed abbreviated range | `"15 Mos to 1 Yr"` | Reuses existing range regex once units are broadened — no new regex needed. |
| `"above N years"` without explicit upper bound | `"above 5 years"`, `"above 2 yrs"` | Treat as `{minDays: N+1, maxDays: 3650}` — same convention as `"X and above"`. New regex: `^above\s+(\d+)\s*(<unit-class>)$`. |
| Bare single value with abbreviation | `"1 Yr"`, `"888 d"` | Existing single-value regex covers this once units broaden. |

Side effects: nothing — `parseTenure` is pure and returns `null` on unrecognised input. Adding patterns only converts nulls into hits.

### Fix 2 — Make `dedupSlabs` resilient (`lib/actions/extract_html_table.js`)

Change the dedup key (around line 935) so that when both `tenure_min_days` and `tenure_max_days` are `null`, a normalised `tenure_text` is the discriminator:

```js
const tenureKey = s.tenure_min_days == null && s.tenure_max_days == null
  ? `t:${String(s.tenure_text || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
  : `n:${s.tenure_min_days ?? ''}:${s.tenure_max_days ?? ''}`;
const key = JSON.stringify([tenureKey, s.currency ?? null, s.deposit_range ?? null]);
```

The `t:`/`n:` prefix prevents cross-collision between "text-keyed" and "bounds-keyed" buckets. Two rows with identical `tenure_text` AND both unparseable still dedup to one (correct: they really are duplicates).

## Files to modify

| File | Change |
|---|---|
| `scripts/utils/parse-tenure.js` | Broaden `TENURE_UNIT_DAYS`; add hyphen-range + bare-above regexes; expand the unit character class in existing patterns. |
| `lib/actions/extract_html_table.js` | Rewrite the dedup key in `dedupSlabs`. |
| `tests/utils/parse-tenure.test.js` (new or extended) | 12 fixtures: 9 from the smoke probe + 3 obvious negatives. |
| `tests/lib/actions/extract_html_table.test.js` | One test: two slabs with different `tenure_text` and null bounds → both survive dedup. |

## What this deliberately does NOT change

- Cheerio scoring / table picking — HDFC's table picking was correct (19 rows, the right table).
- The LLM prompt — anti-fabrication guarantees stay.
- Post-validation — slabs that pass the LLM gates still do.
- Path A / Path B routing — `pathAUsed` flag stays.
- HDFC's `bank-domains.json` — no per-bank selectors or overrides.

The fixes are intentionally narrow because every line of bank-specific config is a maintenance tax that scales linearly with the 200/1800 bank counts.

## Verification

1. **Unit tests** — `SKIP_PLAYWRIGHT_TESTS=1 npm test` must stay at ≥ 442 pass / 0 fail. New tests add ~13.
2. **HDFC smoke** — expect ≥ 15 committed slabs (was 2). All slabs must have either non-null `tenure_min_days` OR a distinct `tenure_text`.
3. **Regression sanity** — re-smoke SBI / AU SFB / Abhyudaya / BOI-IBU. Each must produce ≥ the previous post-fix count (59, 24, 5, 64). The new dedup logic is strictly more permissive.
4. **Generality probe** — smoke 10 additional banks chosen to surface affected phrasings across categories: Axis, ICICI, Equitas SFB, Ujjivan SFB, Saraswat, Cosmos, PNB, Citibank, Andhra Pragathi GB, Federal IBU. Report `output/runs/smoke-tenure-fix-broad/REPORT.md` with slab counts and any new unparseable phrasings.
5. **Cost** — per-bank costs in summary.json should be unchanged (no new LLM calls).

## Stop condition

If the 10-bank probe surfaces ≥ 3 additional unparseable phrasings, add them in the same commit and re-probe. If a different failure class surfaces (e.g., column-mapping mismatch, multi-deposit-tier confusion), capture as a separate follow-up; do not block this commit.

## Out of scope (future work)

- HDFC LLM `errors[]` chunks 3–5 reported placeholder reasons (`"why"`) — the LLM under-explained what's wrong. Prompt tweak to require concrete error reasons is worth doing but doesn't affect correctness.
- "Raw cheerio-only" mode that bypasses dedup entirely — would mean different banks ship different shapes of data. Skip.

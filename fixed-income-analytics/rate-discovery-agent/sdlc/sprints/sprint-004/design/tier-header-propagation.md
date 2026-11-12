# A4 design — tier-header propagation for stacked deposit tables

## Context

Sprint 3's anomaly catalog (`../../sprint-003/implementation/slab-quality-anomalies-2026-05-18.md` §A4) deferred this fix because it was invasive enough to require a dedicated design pass. The pattern:

AU Small Finance Bank publishes three deposit-amount tiers (e.g., `< ₹3 Cr`, `₹3 Cr to < ₹5 Cr`, `≥ ₹5 Cr`) stacked on one page — three separate `<table>` elements, each preceded by a `<h3>` or similar that names its tier. Cheerio's `extractTableChunks` already captures the heading via `buildTableContext`, but `extract_html_table` discards the captured context for `deposit_range` purposes — it just feeds the heading text into the LLM prompt for general disambiguation. The LLM then sees three tables with the SAME column structure and the SAME tenure rows, and either:

1. Emits all rows with `deposit_range: null` (current actual behaviour: three identical 20-row tables merge into 20 dedup'd rows even though there are 60 distinct slabs).
2. Emits inconsistent free-text deposit_range labels per chunk (A1's pre-fix behaviour, now neutralised by `normaliseDepositRange` — but only when the LLM bothers to label).

Same pattern recurs on:
- Large PSB pages that publish retail (`< 3 Cr`) and bulk (`3-5 Cr`, `5-25 Cr`, `25-100 Cr`, `> 100 Cr`) tables stacked.
- IBU pages with `< 1 Mn` and `> 1 Mn` deposit tier tables (BOI-IBU we already handled because both tables happen to have unique data, but the layout is the same shape).
- Some PVB pages with "Domestic FD" and "Bulk Deposit" sections each carrying their own table.

We need: each chunk's `contextHtml` carries the **tier label that immediately precedes its table**, and the orchestrator forwards that as a per-chunk `deposit_range_hint` to the LLM, which uses it as the value of `deposit_range` for every slab in that chunk.

Outcome: the same tenure (`1 year`) extracts as three slabs `(1 year, 6.50%, below_3cr)`, `(1 year, 6.75%, 3cr_to_5cr)`, `(1 year, 7.00%, above_5cr)` — distinct in the dedup keyspace because `deposit_range` now varies, and each slab is correctly labelled.

## Design

### Change 1 — `buildTableContext` reports the immediate-preceding heading separately

Today `buildTableContext` walks preceding siblings and concatenates everything that looks like a heading or W.E.F. banner into a single newline-joined string. For A4 we need the **single closest** heading/section identifier — the one whose text most likely names this table's tier — to be machine-extractable.

Add a structured return:

```js
function buildTableContext($, $table, lookbackChars) {
  return {
    text: '<existing newline-joined heading + WEF blob>',
    nearest_heading_text: '<single closest <h1..h6>/caption/strong/b text within ~300 chars upstream, trimmed, lowercased>',
    nearest_heading_tag: '<h3|caption|strong|...>',
  };
}
```

Or — backwards-compatible — leave the existing `string` return and add a sibling export `extractTableTierLabel($table, lookbackChars)` that's called separately. The latter avoids breaking anything else that consumes `contextHtml` today.

Choose the second form. Reasons: smaller diff to existing callers, easier to feature-flag.

### Change 2 — `extractTableChunks` adds `tier_hint`

```js
out.push({
  index: idx++,
  tableHtml,
  contextHtml,
  signals,
  score,
  tier_hint: extractTableTierLabel($t, contextLookbackChars),  // NEW — string|null
});
```

`tier_hint` is the lowercased nearest-heading text trimmed to 200 chars. Null when no heading-like sibling exists within the lookback window.

### Change 3 — `extract_html_table.js` passes `tier_hint` to the LLM as `deposit_range_hint`

When the LLM extractor builds the per-chunk user message, add a line right after the existing variant guidance:

```
Deposit tier hint (from the heading immediately preceding this table):
"deposits below 3 cr"
```

And add to the prompt's HARD RULES:

> If a deposit-tier hint is provided in the chunk preface, every slab emitted from that chunk MUST set `deposit_range` to the canonical form of that hint. The system normalises after the fact — emit the verbatim heading text and the runtime will canonicalise via normaliseDepositRange.

This way the LLM doesn't have to know the canonical token list — it just has to copy the heading verbatim, and `normaliseDepositRange` (A1) handles the rest.

### Change 4 — Post-validation widens to use `tier_hint`

`validateSlabAgainstChunk` today checks that the slab's rate digit string and source row text appear in the chunk. Add: if the slab has a non-null `deposit_range`, the runtime tolerates it; if it has `deposit_range: null` but the chunk had a `tier_hint`, the runtime **fills it in** from the tier_hint instead of rejecting the slab. This protects against the LLM forgetting to label even when the hint was provided.

```js
function validateSlabAgainstChunk(slab, chunkText, chunk) {
  // existing rate-digit + source_row_text checks ...

  // NEW: backfill deposit_range from tier_hint when LLM missed it
  if (!slab.deposit_range && chunk.tier_hint) {
    slab.deposit_range = chunk.tier_hint;  // normaliseDepositRange later canonicalises
  }
  return { ok: true };
}
```

### Change 5 — Feature-flag the whole flow

Per the scope doc risk mitigation:

> AU SFB tier-header fix breaks already-passing banks — add tier-aware logic behind a feature flag (`RDA_TIER_AWARE_DEDUP=1` default off until 50-bank smoke confirms no regression).

Gate the `tier_hint` emission AND the deposit_range backfill on `process.env.RDA_TIER_AWARE_DEDUP === '1'`. Default off through the 12-bank rung (which is all DCCBs and shouldn't have stacked tier tables anyway), flip on for the 50-bank rung where AU + large PSBs surface.

## Files to modify

| File | Change |
|---|---|
| `lib/actions/_cheerio_tables.js` | New `extractTableTierLabel($table, lookbackChars)` export. `extractTableChunks` adds `tier_hint` to each chunk (gated on RDA_TIER_AWARE_DEDUP). |
| `lib/actions/extract_html_table.js` | Per-chunk LLM prompt gets the tier hint line; `validateSlabAgainstChunk` backfills `deposit_range` from chunk.tier_hint when slab lacks it. Both gated on the flag. |
| `tests/lib/actions/_cheerio_tables.test.js` | 4 new tests: tier label captured from immediately-preceding h3; tier label null when no heading; multi-table page each chunk gets its own tier_hint; flag-off path returns no tier_hint. |
| `tests/lib/actions/extract_html_table.test.js` | 2 new tests: deposit_range backfill from tier_hint; deposit_range backfill is a no-op when slab already has a value. |
| (optional) `data/bank-domains.json` AU SFB entry | If after testing we still need bank-specific assistance for AU's exact heading text, document the option but do NOT add the override — generic fix preferred. |

## Functions to reuse (no reinvention)

- `cheerio.load(html)` already used by `extractTableChunks`. `extractTableTierLabel` reuses the same `$` instance via parameter pass-through.
- `normaliseDepositRange` (A1, `lib/actions/extract_html_table.js`) — the LLM emits verbatim tier text; this canonicalises to snake_case before dedup. Already in place.
- `validateSlabAgainstChunk` — extend with one block, don't replace.
- `dedupSlabs` — needs zero changes. The new behaviour gives different rows different `deposit_range` values, which the existing key construction already handles.

## Verification

1. **Unit tests** — `SKIP_PLAYWRIGHT_TESTS=1 npm test` stays green; new tests in `_cheerio_tables.test.js` and `extract_html_table.test.js` add ~6 cases.

2. **Flag-off regression** — Run the 5-bank smoke with `RDA_TIER_AWARE_DEDUP` unset. Every per-bank slab count should equal the post-A1+A2+A3 baseline (175 slabs total across the 5 banks).

3. **Flag-on smoke on AU SFB** — Run AU SFB alone with `RDA_TIER_AWARE_DEDUP=1`:

   ```bash
   RDA_TIER_AWARE_DEDUP=1 node run-discovery.js "AU Small Finance Bank Limited" "Small Finance Bank" \
     --path orchestrator --output-dir output/runs/au-a4
   ```

   Expected: `au-small-finance-bank-limited_rates.json` contains the same tenures across 2-3 `deposit_range` values (`below_3cr`, `3cr_to_5cr`, `above_5cr` or whatever AU uses).

4. **Rung 2 (12-bank top-12 local smoke)** — Run with flag off first across the 12 top-priority banks (`data/cohorts/top-12.json`). Of these, AU SFB is the most likely A4 beneficiary; large-PSB bulk-tier pages (SBI / BoB / PNB) may also surface tier-stacked layouts. Then run with flag on; compare slab counts to the flag-off result.

5. **Rung 3 (12-bank top-12 cloud smoke)** — Same cohort via `scripts/azops/start-cohort.js --cohort top-12 --env prod`. Flag on. Per-bank blob upload (Track B / B2) verified by `az storage blob list`.

## Out of scope

- Auto-discovering deposit tiers WITHOUT a preceding heading (e.g., the table itself is row 1 = "Deposits below ₹3 Cr" header row, no `<h3>`). Captured as a possible A5 if the 50-bank smoke surfaces it. Not in A4.
- Backfilling `deposit_range` from cohort metadata or `data/bank-domains.json` configuration — bank-specific overrides remain undesirable per Sprint 3 L16.
- Surfacing tier_hint into the deterministic cheerio path. Path A (cached_body, cheerio direct) doesn't have a `deposit_range` column today; LLM path is the only place tier hints are applied. If a Path A bank surfaces with tier confusion we'll capture it then.

## Stop conditions

- If rung 2 (12-bank local) shows a regression vs Sprint 2/3 baseline with `RDA_TIER_AWARE_DEDUP=1`, flip the flag off and ship A4 as a no-op so the 12-bank cloud rung still validates Track B. A4 then becomes a follow-up itself.
- If the flag-on AU SFB single-bank smoke produces fewer total slabs than the flag-off run (i.e., the new path drops legitimate slabs), revisit the backfill logic before continuing to the 12-bank rung.

---

## Status update — Orch-1 (sprint-004 2026-05-21)

A4 shipped the LLM-path side of the tier-header story: `extractTableTierLabel` + chunk `tier_hint` backfill in `validateSlabAgainstChunk`, both gated behind `RDA_TIER_AWARE_DEDUP` (default off, pending 50-bank rung).

**Orch-1 took the orchestrator's deterministic Path A the rest of the way**, without an env flag:

- Multi-table accumulator in `lib/actions/extract_html_table.js` keeps every rate-bearing table (was: single-winner pick by slab count) — design doc at [`./orch1-multi-table-extraction.md`](./orch1-multi-table-extraction.md)
- New pure helper `lib/actions/_cheerio_heading_range.js` maps heading text → `deposit_range` enum value (the A4 spec, generalized; reuses `extractTableTierLabel` for capture)
- New pure helper `lib/actions/_cheerio_section_context.js` extends A4's "single heading capture" into a full section-context object (`section_heading` + `nearest_heading_text` + `effective_date_text` + `notes`) and interprets section notes into variant-fulfillment and rule-override fields (senior-exclusion, minimum-tenor)
- Each rate-bearing table now emits a page entry tagged with `deposit_range` derived from (1) closest preceding heading, (2) `<caption>`, or (3) the table's header-row cells — covers the case A4 explicitly deferred ("the table itself is row 1 = deposit range header, no `<h3>`")
- Implementation notes: [`../implementation/engine-fixes-orch1.md`](../implementation/engine-fixes-orch1.md)

A4's tier_hint LLM-path backfill stays as-is — Orch-1 closed the Path A side, but the LLM-path is the legacy route and stays unchanged. The flag is preserved for any operator who still needs to validate the A4 path against an LLM-driven extraction.

**What this means for the 50-bank rung**: still needed for A4's LLM-path flag, but Orch-1 has already moved the orchestrator path to deterministic multi-table extraction. Banks routed through `--path orchestrator` no longer need the env flag — they get the same outcome via Orch-1's Path A directly.

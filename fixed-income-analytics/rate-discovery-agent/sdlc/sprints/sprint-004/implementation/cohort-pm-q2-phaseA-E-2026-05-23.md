# Implementation — cohort #3 Phase A-E fixes (2026-05-23)

> Follow-up to `cohort-pm-q2-fixes-2026-05-23.md`. Phases A through E from
> `~/.claude/plans/structured-cooking-sloth.md` shipped in this session.
> Test suite: 854 pass / 1 skip / 0 fail. Pack: 516 banks / 8277 slabs
> (cohort #3 was 8428; cleaner data post-filters).

## Phase A — `write_file` const-reassignment bug (15 min)

**Root cause**: `lib/tools.js:379` declared `let resolved` (was `const`) so the
variant-naming guardrail's reassignment at line 462 (`resolved = correctedPath`)
no longer throws `"Assignment to constant variable"`. Bug introduced in
`e357f48` last session — silently swallowed every variant-suffix-redirected
write. IDBI-IBU 48-slab extraction across 3 attempts had been lost to this.

**Change**: `const` → `let` at line 379; rewrote the misleading
`eslint-disable no-param-reassign` comment.

**Regression guard**: `tests/lib/tools-write-file.test.js` new case
`"variant-naming guardrail redirects fcnr/gift/nre/nro payload to suffixed filename (no const-reassignment crash)"`.

**Verification (Phase F per-bank)**: `idbi-bank-ibu_gift_rates.json` now
populated with 48 slabs (USD 36, EUR 12). Baseline was 0; back to baseline.

## Phase B — pack-builder rate-bound filter (30 min)

**Approach**: new `lib/rate-bounds.js` exports `PACK_FILTER_BOUNDS`,
`boundsForVariant`, `isRateInBounds`, `isSlabRateInBounds`. Loose sanity
band by design: `regular/nre/nro: [0.1, 15]`, `fcnr/gift: [0.0, 12]`.
Wider than `scripts/utils/validation-constants.js#VARIANT_RATE_RANGES` —
those are the tight band for warnings; this is the loose band for drops.

`pack/build-pack.js#buildVariant` now filters slabs through
`isSlabRateInBounds` and tracks per-(slug, variant) drop counts in a
module-scoped `filterDropCounts` Map. The drop telemetry surfaces at the
end of each `buildPack()` run.

**Verification**: 59 slabs dropped across 18 banks on first run. Examples
worth flagging: state-bank-of-india NRE had a "Premature withdrawal"
footnote leak with `rate_general_pct = 12017.5`; lonavla / mahamantralaya
/ doha-bank / sbpp / karnataka-state-coop each had multiple
digit-concatenation garbage values. Anomaly count 304 → 210 (-94) on
April-16 gate.

**Test suite**: new `tests/lib/rate-bounds.test.js` (8 cases).

## Phase C1 — Kotak picker noise + below-floor reject + dedup (1 hr)

**Approach**: new `filterInvalidSlabs(slabs, variant)` in
`scripts/utils/validate-rates.js`. Returns
`{ filteredSlabs, droppedBelowFloor, droppedAboveCeiling, droppedDuplicate, droppedTenureOutOfBand }`.

Drop rules:
- Below `VARIANT_BOUNDS[v].min`: drop (Kotak emitted 0.5-1% noise; floor is 1.5%).
- Above ceiling: KEPT (already warned by `validateSlabs`; truly impossible values caught by Phase B loose band).
- Duplicate by `(tenure_text, general, senior, currency)`: drop one (Kotak emitted 2 identical pairs per variant).
- (Phase C3 addition — see below.)

`lib/actions/commit_rates.js` calls `filterInvalidSlabs` before
`validateSlabs` and assigns the filtered list back to `payload.rate_slabs`
when anything was dropped, so the canonical `_rates.json` never contains
the noise. Warning logged: `commit_rates slab_filter bank=... dropped_*=N`.

**Verification (Phase F)**: Kotak regular/NRE/NRO all dropped to 0 slabs
(the 5 garbage slabs in cohort #3 each fell below the 1.5% floor) — pack
no longer ships Kotak FD garbage. **Side note**: Kotak FCNR now extracts
31 slabs (was 0). The picker still mis-targets the Kotak FD landing page
for INR variants; CSS selector hint deferred — Phase B/C1 filters keep
garbage out until a picker fix lands.

## Phase C2 — multi-currency PDF prompt addendum (15 min)

**Change**: `lib/prompts/fragments.js` (`STEP_EXTRACT_RATES`) now ends
with a "Multi-currency tables (FCNR / GIFT / IBU)" section. Calls out
Pattern A (currency rows) vs Pattern B (currency columns), the
1-currency-or-many heuristic, and a worked HDFC-IBU example (cohort #3,
2026-05-23) so future runs emit every currency column as separate slabs.

**Verification**: HDFC-IBU still 8 USD-only slabs in Phase F run. The
prompt change did not crack this LLM extraction on the May-23 retry —
follow-up needed. Options:
- Tighten prompt further with an explicit "minimum currency count" check.
- Add a per-bank `extraction.fd_pdf_gift` hint with column overrides.
- Force Azure DI Layout via `image_ocr` route for hdfc-bank-ibu PDF.

## Phase C3 — variant-tenure filter for FCNR/GIFT (combined with C1)

**Approach**: extended `filterInvalidSlabs` with a `droppedTenureOutOfBand`
count. For FCNR/GIFT variants, drops slabs whose tenure range falls
entirely outside the RBI-mandated 365–1825 day window. (Boundary-
spanning slabs are warned by `validateSlabs` but kept.)

This is the deterministic alternative to the section-boundary guard
proposed in the plan for `_cheerio_tables.js#readTableRows`. The
in-cheerio guard is invasive and the symptom is well-defined; the filter
is cleaner.

**Verification**: ICICI FCNR cohort #3 emitted 17 slabs (5 real + 12
short-tenor Call Deposit rows pulled in by Fix #5's rowspan expansion).
Phase F re-run produced 11 FCNR slabs — the 12 sub-365d rows would have
dropped via the tenure filter; the residual 11 looks healthier but
larger than baseline (8). Needs a manual spot-check on the source page
to confirm no surplus. Note: ICICI's `partial_silent.json` marker is
**stale** (created 2026-05-22) and still excludes all ICICI variants
from the pack. The marker needs operator clearance — guarded by the
auto-mode classifier as a destructive action.

## Phase E — extract-time rate validation (~30 min)

**Change**: `scripts/extract_rates.js#looksLikeBadMapping` threshold
tightened from `>30` to `>15` (matches Phase B's INR ceiling). Cohort
triage showed real digit-concatenation garbage included borderline
values like 18.5 / 24 / 37 that the old `>30` cutoff let through, so
`detectColumns` (the fallback heuristic) never fired and column-
misalignment shipped silently.

The wider story (extract_html_table.js post-extraction filter) is
ALREADY achieved via Phase C1's `commit_rates.js` filter call — that
runs on every variant before write. No additional `extract_html_table.js`
change was needed.

## Phase F — per-bank verification (~30 min wall)

**Stage 1 run**: `node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv --banks <23-slug-list> --concurrency 3 --path orchestrator`.
Direct slug-list mode failed (no category resolution → `bank_type=null`
→ orchestrator throw). CSV mode with `--banks` filter worked.

**Results**: 22 succeeded / 1 failed (kookmin-bank, 0 slabs — known
defer-class FB).

**Per-bank deltas (vs April-16 baseline) — banks in Phase F set**:

| bank | result | vs baseline | note |
|---|---|---|---|
| idbi-bank-ibu gift | 48 (USD 36 + EUR 12) | 48 | Phase A fix recovered the full extraction |
| kotak-mahindra-bank-limited fcnr | 31 | 0 | new — picker found multi-ccy FCNR table on retry |
| kotak regular/NRE/NRO | 0 / 0 / 0 | 18/7/0 | Phase C1 filter dropped the 0.5-1% garbage; picker still wrong for INR |
| icici fcnr | 11 (in _rates.json) | 8 | pack excludes due to stale partial_silent |
| pnb regular/NRE/NRO | 21/13/21 | 30/21/21 | FCNR still missing (Option B deferred) |
| canara regular/NRE/NRO | 14/23/23 | 14/0/12 | NRE/NRO meaningful gains |
| hdfc-bank-ibu gift | 8 (USD only) | 34 | Phase C2 prompt did not crack this LLM extraction |
| city-union NRE | 6 | 0 | new |
| punjab-sind NRE/NRO | 22/30 | 0/0 | new |
| dhanlaxmi regular/NRE/NRO | 12/7/12 | 12/0/12 | NRE recovered |
| karnataka-bank-ltd regular/NRE | 10/17 | 10/0 | NRE recovered |
| jammu-kashmir regular | 40 | 12 | gain (3x) |
| doha-bank-qpsc regular/NRE/NRO | 18/7/14 | — | new bank populated |
| rbl-bank-ibu gift | 60 | 0 | new |
| 9 anomaly-cluster banks | various | minor | most produced clean data; Phase B/C1 filters worked downstream |

## Pack + gate state

| | April-16 baseline | post-Phase A-E |
|---|---|---|
| banks | 259 | 516 |
| slabs | 4482 | 8277 |
| regressions | — | 27 (24 blocking, 3 accepted) |
| anomalies | — | 210 |
| Verdict | — | BLOCK |

Net: **+257 banks, +3795 slabs, 27 regressions** (most unexplained
regressions are in banks NOT included in the Phase F set, primarily
foreign banks with html_js issues — already in the deferred list).

## Open items for the next session

1. **ICICI partial_silent marker** at `output/latest/icici-bank-limited.partial_silent.json` (created 2026-05-22) — needs operator clearance to let ICICI's fresh Phase F data into the pack. Will add ~11 FCNR slabs + the other variants.
2. **HDFC-IBU prompt-only fix did not stick** — try per-bank registry hint (`extraction.fd_pdf_gift` block) OR force `image_ocr` route via `extract_via_ocr.js`.
3. **PNB FCNR Option B** — Phase D deferred per user. PNB stays at 21 USD-only.
4. **Banks NOT in Phase F set with regressions** — BoB FCNR 35→25, UCO FCNR 45→7, Indian Bank FCNR 40→30, the-karnataka-state-co-op-apex 7→2, shikshak-sahakari 16→8, g-p-parsik-janata 17→10. None were in scope; need a follow-up Phase F-stage-1b run.
5. **The 99 "above-ceiling" warnings** are by design (Phase C1 keeps these slabs but flags them). Could be tightened later if operator wants them filtered.

## Out of scope (still deferred)

- Phase D screenshot+OCR for PNB-class FCNR (~3-4hr + Azure provisioning).
- TMB LLM truncation.
- BoI / IOB / Union / Federal / Yes / IndusInd html_js fast-fails (network/WAF).

## Commit strategy

Suggested commit split (per the original plan):
- `fix(sprint-004): write_file const-reassignment bug in variant guardrail` (Phase A)
- `feat(sprint-004): pack-builder rate-bound filter + lib/rate-bounds.js` (Phase B)
- `fix(sprint-004): commit_rates slab filter — below-floor + dedup + FCNR/GIFT tenure invariant` (Phase C1+C3)
- `prompt(sprint-004): multi-currency PDF emphasis for FCNR/GIFT extraction` (Phase C2)
- `fix(sprint-004): tighten looksLikeBadMapping threshold to >15` (Phase E)
- `chore: drop test-prefixed dupe of scripts/analysis/docintel-smoke.js` (test-runner conflict fix)
- `sdlc(sprint-004): cohort-pm-q2-phaseA-E implementation report` (this doc)

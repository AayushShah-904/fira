# Handoff — pm-q2 cohort re-run, pre-cohort-#3 (2026-05-23)

> Session pause point. Cohort #2 was halted mid-run (71 of 513 banks complete)
> after operator called out that we deferred too many fixes. Resume from here.

## Decision in effect

Cohort #3 will be run only AFTER the deferred fixes ship. Cohort #2 was a sunk-cost
mistake of running before adequately fixing the engine.

## What's committed (state at this handoff)

Branch: `azure-openai-agent`. Recent commits (newest first):

| Commit | Description |
|---|---|
| `e357f48` | Fix #1c (currency-count-ranked FCNR picker, col 0+1 scan) + write_file variant-naming guardrail + IBU LLM routing |
| `3e79b05` | Fix #1+#2: variant-aware FCNR table picker + reject-not-default in tagCurrencyForeignVariant |
| `8719af0` | Phase 2c smoke outcome + Bug A (run-batch --path) + Bug B (exit-code) writeup |
| `915cf7a` | Bug B fix: orchestrator path exits 0 on success (was always 1) |
| `49624cc` | Bug A fix: run-batch --path flag now forwarded to run-discovery |
| `d6a8a4c` | Phase 0-2b: pre-flight design + IDBI Orch-2 + ICICI FCNR prompt + OCR cost telemetry + cleanup helper |

Test suite: 827 pass / 1 skip / 0 fail.

## What's uncommitted (working tree at this handoff)

- `data/bank-domains.json` — registry mutations from cohort #2's partial run (71 banks of newly discovered domains). Legitimate state; commit when ready.
- `output/latest/` — partial cohort #2 output; do NOT delete (operator principle: don't mess with prior-run data).

## Deferred fixes (must land BEFORE cohort #3)

Total estimate: 5-6 hours engineering. Each closes specific regressions surfaced in cohort #1.

### Fix #5 — PNB-style FCNR tables (mashed cells + currency in non-0/1 columns)
**Affects**: PNB, Canara, IDBI, City Union, Punjab-Sind, Dhanlaxmi, Karnataka (7 banks)
**Effort**: 2-3 hours
**Why current fixes don't help**: cohort #1 showed PNB's FCNR table has the structure:
- Row 0 = title "FCNR Deposit w.e.f. ..."
- Row 1 = tenure headers ("1 yrs < 2 yrs" etc)
- Row 2 = sub-headers ("S.No." | "Currency" | "Existing" | "Revised" ...)
- Rows 3+ = data with currency code in column 1 (after S.No. in col 0)
- Cheerio also mashes cells weirdly (colCount=1, rowCount=9 reported) due to nested spans
**Root cause investigation needed**:
1. Why does cheerio see colCount=1 when there are clearly multiple columns? Likely nested `<table>` or rowspan/colspan handling. May need custom cell normalisation.
2. The Fix #1c "scan col 0+1" extension I added scans the FIRST two columns of normalised rows, but if cheerio collapses everything to col 0 those approaches won't help.
**Strategy options**:
- Option A: Improve cheerio row-parsing in `_cheerio_tables.js` to handle nested cells + rowspan/colspan correctly
- Option B: Add a Playwright + screenshot + Azure DI Layout pipeline (extract these pages as images)
- Option C: Per-bank LLM prompt tuning (each affected bank gets a specific extraction hint)
**Recommended path**: Option A is the most general. Look at `lib/actions/_cheerio_tables.js#parseHtmlTables` and check `<td>` cell extraction; ensure colspan/rowspan are expanded before row.length is computed.
**Verification**: re-run PNB, Canara, IDBI, City Union, Punjab-Sind, Dhanlaxmi, Karnataka individually. Expect each to produce a `_fcnr_rates.json` with 25-45 slabs across 5-9 currencies (matches what's actually published on the source pages — counts verified during triage and documented in `cohort-pm-q2-regression-analysis.md` §Bucket B).

### Fix #6 — IDFC-First Orch-2 HTML hint
**Affects**: idfc-first-bank-limited (NRE 5→1, NRO 13→1)
**Effort**: 15 minutes
**Strategy**: Author `extraction.fd_nri_combined = { type: "html", fulfills_product: ["fd_nre", "fd_nro"] }` block in `data/bank-domains.json` — same trick as HDFC. Confirm by checking https://idfcfirst.bank.in/nri-banking/nri-fixed-deposit/ has both variants on one page.
**Verification**: re-run idfc-first-bank-limited individually; expect NRE + NRO files to populate from the combined URL.

### Fix #7 — Registry URL refresh for 3 banks
**Affects**: chennai-central-co-operative-bank-ltd (regular 11→0), tamil-nadu-grama-bank (regular 10→0), nabard (regular 5→0)
**Effort**: 30 minutes total
**Strategy**: For each: verify the current `rate_pages.fd` URL in `data/bank-domains.json` against the bank's actual website. If changed, update. If page exists but page-fetch fails, investigate WAF/cert/timeout class.
**Verification**: per-bank re-run.

### Fix #8 — Small-table scoring tweak (special-scheme tables)
**Affects**: citizen-credit-co-operative-bank-ltd-mumbai (regular 14→8), sbpp-co-operative-bank-ltd-killa-pardi (13→5), the-district-co-operative-central-bank-ltd-srikakulam (7→3), the-uttarakhand-state-co-operative-bank-ltd (7→3) — and likely more (4 banks confirmed, more suspected)
**Effort**: 1-2 hours
**Strategy**: In `lib/actions/_cheerio_tables.js#extractScoredTables`, lower the rate-row threshold for tables with 4-10 rows. These tables represent special-scheme deposits (400-day URP, NAVATHI 900-day, MIS, etc.) that should be emitted as separate slabs but are currently being filtered out by the noisy-table threshold.
**Risk**: May regress other banks where small noisy tables get incorrectly included. Mitigate with 5-bank regression smoke (axis, hdfc, sbi, kotak, icici control banks) before cohort #3.
**Verification**: re-run the 4 confirmed Bucket C2 banks; spot-check 5 control banks for no regression.

### Fix #9 — Slug-alias registry layer (Bucket D2 hygiene)
**Affects**: nkgsb-co-operative-bank-ltd ↔ nkgsb-co-operative-bank-ltd-mumbai; the-zoroastrian ↔ zoroastrian; the-ahmedabad-mercantile ↔ ahmedabad-mercantile-co-op; sri-potti-sriramulu-nellore ↔ nellore-district-co-operative-central-bank-ltd (4 banks)
**Effort**: 30 minutes
**Strategy**: Add an `aliases: [...]` field to `data/bank-domains.json` entries. Pack-builder reads aliases when matching against baselines. The pack-builder's slug → file lookup checks the canonical slug first, then aliases.
**Verification**: rebuild pack; pack-quality-gate's "bank dropped from pack" findings for these 4 banks should clear.

## Deferred-but-OK-to-skip (lower priority)

- **TMB LLM truncation** — Cheerio path tuning OR LLM max_tokens bump. Tamilnad Mercantile has been at 0 slabs for weeks; not regressing.
- **Yes Bank / Federal Bank / IndusInd infrastructure blocks** — network/WAF, not engine
- **DI managed-identity migration** — key-based fine for now

## Recommended fix order for next session

1. **Fix #6 IDFC-First Orch-2 hint** (15 min) — fastest win
2. **Fix #7 URL refresh** (30 min) — 3 quick registry updates
3. **Fix #9 slug-alias** (30 min) — pack-builder hygiene
4. **Fix #8 small-table scoring** (1-2 hr) — needs careful regression check
5. **Fix #5 mashed-cell FCNR** (2-3 hr) — the big one; PNB-class FCNR recovery

After all 5: run cohort #3 as the actual ship candidate.

## Re-running cohort #3 (after fixes)

```bash
# Verify all tests pass first
node --test --test-force-exit                # → expect 830+ pass / 1 skip / 0 fail

# Output dir snapshot/cleanup (optional; per operator principle don't delete prior data)
node scripts/cleanup-output-latest.js --snapshot pre-pm-q2-cohort-2026-05-23-v3 --write

# Cohort run
node run-batch.js --cohort pm-refresh-2026-q2 --concurrency 3 --path orchestrator
# ETA: ~3-4 hours. Cost: ~$2.50.

# After cohort:
node pack/build-pack.js
node scripts/run-dual-gate.js                # April-16 floor + May-14 efficacy verdicts
```

## Key SDLC docs (already on disk)

- `sdlc/sprints/sprint-004/design/cohort-pm-q2-pre-flight.md` — pre-flight design
- `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-pre-flight.md` — pre-flight implementation outcome
- `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-rerun-triage.md` — cohort #1 regression inventory
- `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-regression-analysis.md` — root-cause + strategy per bucket
- `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-handoff-2026-05-23.md` — **this doc**

## Quality-gate accepts

`pack/quality-gate-accepts.json` has 10 pre-seeded accepts from before cohort #2.
These should be reviewed after cohort #3 — the analysis in `cohort-pm-q2-regression-analysis.md` §"Aggregated finding" classified all 48 cohort #1 regressions into Verified-OK / Verified-OPS-REVIEW / Verified-SLUG-CHANGED / OPEN-ENGINE-REGRESSION buckets. The fixes above address most of OPEN-ENGINE-REGRESSION; remaining genuine "accepts" go in the file with the canonical `reason` prefixes.

## Operator principles confirmed in this session

1. **Don't delete prior-run data**. Each cohort's output stays as-is; new runs replace files where extraction succeeds, prior data persists where extraction rejects.
2. **A pack reflects the current run's data**, not patched-together cross-cohort state.
3. **Investigate regressions before accepting them.** No blanket-accept for "rate-card refresh" — verify against the actual published page first.
4. **SDLC docs always maintained**, including error analysis (root cause per bug, not just success summary).

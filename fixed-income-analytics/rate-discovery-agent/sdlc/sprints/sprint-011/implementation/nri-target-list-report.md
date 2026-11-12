# Sprint-011 Track A / A5 — NRI Target List (per-bank missing-variant matrix)

**Date:** 2026-07-06
**Script:** `scripts/analysis/nri-target-list.js` (re-runnable, pure local analysis — no network, no LLM)
**Artifact:** `data/cohorts/nri-target-list-2026-07-06.json`
**Inputs:** `pack/dist/rates-pack.json` (generated 2026-06-11), `data/bank-domains.json`, `data/Indian_Banks_Comprehensive_List_RBI.csv`

Purpose: RBI's FCNR concession window ends 2026-09-30. This is the measured target list for the NRI cohort run — per bank, per variant (NRE / NRO / FCNR; GIFT for IBUs): what we have, how fresh it is, and what the registry says is reachable.

## 1. Cohort

121 banks: **12 PSB + 21 PVB + 44 FB + 7 SFB + 37 IBU**.

- PSB/PVB/FB/IBU taken in full from the RBI CSV. All 125 candidate CSV rows joined cleanly to both pack and registry (0 unmatched); SFB filter then removed 4.
- SFBs admitted only if docs-large (AU, Equitas, Ujjivan per `docs/agent/discovery-workflow.md`) **or** showing a measured NRI signal (pack slabs or registry NRI URL): AU, Capital, Equitas, ESAF, Jana, Ujjivan, Utkarsh. Excluded (no NRI signal): Shivalik, Slice, Suryoday, Unity.

## 2. Headline per-variant verdicts

Verdict rules: **OK** = slabs + effective date ≥ 2026-06-01; **STALE_OR_UNDATED** = slabs but older/unparseable/absent date; **MISSING_EXTRACTION** = registry knows a URL but pack has zero slabs; **UNKNOWN_PUBLISHES** = no URL known, bank type suggests it plausibly publishes; **EXCLUDED** = registry status rules the product out (wholesale_only, no_retail_deposits, no_fd_product; foreign_currency_not_inr excludes the INR variants NRE/NRO only).

| Variant | Banks checked | OK | STALE_OR_UNDATED | MISSING_EXTRACTION | UNKNOWN_PUBLISHES | EXCLUDED |
|---|---|---|---|---|---|---|
| NRE  | 84 (non-IBU) | 4 | 46 (27 stale-dated / 19 undated) | 8 | 19 | 7 |
| NRO  | 84 (non-IBU) | 3 | 42 (27 / 15) | 9 | 23 | 7 |
| FCNR | 84 (non-IBU) | 5 | 36 (33 / 3) | 12 | 26 | 5 |
| GIFT | 37 (IBU)     | 0 | 18 (14 / 4) | 0 | 4 | 15 |

The dominant state is not "missing" but **stale-or-undated**: we hold slabs for most PSBs/PVBs, but almost nothing carries an effective date on or after 2026-06-01 (the pack itself was built 2026-06-11). Only 12 variant-cells across the whole cohort are fresh-OK.

## 3. Measured AD-Category-I FCNR universe

**79 banks** — non-IBU cohort banks whose FCNR verdict is not EXCLUDED (84 minus 5 wholesale-only/no-retail FBs). This lands inside the estimated ~80–90 AD-I range and is now a measured number, not an estimate.

- With FCNR slabs in the pack today: **41 of 79** (pack-wide FCNR is 44 banks; the other 3 are outside this cohort — co-op/RRB extractions).
- Fresh-OK FCNR: **5 of 79**.
- The FCNR gap by cause: 36 stale/undated, 12 missing-extraction (URL known, nothing extracted), 26 unknown.

## 4. Per-bank-type breakdown

| Type | Banks | NRE (OK/St/Mx/Un/Ex) | NRO | FCNR | GIFT |
|---|---|---|---|---|---|
| PSB | 12 | 2/10/0/0/0 | 1/9/0/2/0 | 1/10/1/0/0 | — |
| PVB | 21 | 2/18/1/0/0 | 2/16/2/1/0 | 3/15/3/0/0 | — |
| FB  | 44 | 0/12/7/18/7 | 0/11/7/19/7 | 1/8/7/23/5 | — |
| SFB | 7  | 0/6/0/1/0 | 0/6/0/1/0 | 0/3/1/3/0 | — |
| IBU | 37 | — | — | — | 0/18/0/4/15 |

(St = stale/undated, Mx = missing-extraction, Un = unknown, Ex = excluded.)

Reading:

- **PSB asymmetry confirmed**: 12 NRE / 10 NRO / 11 FCNR banks with slabs. NRO gaps: `bank-of-maharashtra`, `central-bank-of-india` (no NRO URL known). FCNR gap: `bank-of-india` (URL known, extraction missing).
- **Foreign banks are the biggest FCNR hole, confirmed**: only 9/44 FBs hold FCNR slabs, 1 fresh. 23 FBs have no known FCNR URL at all — including retail-relevant names like `standard-chartered-bank` (all three variants UNKNOWN — no NRI URLs in the registry despite being the largest retail FB in India). 12 FBs are wholesale/no-retail (excluded or partially excluded); the remaining unknowns need discovery, not just re-extraction.
- **IBUs**: 15/37 are wholesale_only (excluded — measured, from registry status). Of the 22 plausibly retail IBUs, 18 have GIFT slabs (all pre-cutoff or undated) and 4 have nothing known (`ctbc-bank-co-ltd-ibu`, `qatar-national-bank-qpsc-ibu`, `sumitomo-mitsui-banking-corporation-ibu`, `yes-bank-ibu`).

## 5. Priority refresh list

**61 banks** = all T1 banks with any non-OK, non-excluded variant (**22**: all 12 PSBs + 10 major PVBs — every single T1 bank has at least one non-OK NRI variant) + all FBs likewise (**39**). Full ranked list in the artifact (`priority_refresh`). Top of the list (T1, most variants in deficit first):

| # | Bank | Type | Deficit |
|---|---|---|---|
| 1 | bank-of-baroda | PSB | nre, nro, fcnr stale |
| 2 | bank-of-india | PSB | nre, nro stale; **fcnr missing-extraction** |
| 3 | bank-of-maharashtra | PSB | nre, fcnr stale; nro unknown |
| 4 | canara-bank | PSB | nre, nro, fcnr stale |
| 5 | central-bank-of-india | PSB | nre, fcnr stale; nro unknown |
| 6 | punjab-sind-bank | PSB | nre, nro, fcnr stale |
| 7 | state-bank-of-india | PSB | nre, nro, fcnr stale |
| 8 | uco-bank | PSB | nre, nro, fcnr stale |
| 9 | union-bank-of-india | PSB | nre, nro, fcnr stale |
| 10 | indian-overseas-bank | PSB | nro, fcnr stale |

(11–22: punjab-national-bank, indian-bank, then PVBs axis, hdfc, idfc-first, indusind, kotak (nro missing-extraction), rbl, yes (fcnr missing-extraction), bandhan, federal (nro unknown), icici.)

Highest-yield FB re-extraction targets (URL already known, zero slabs): bank-of-ceylon, kookmin-bank, nonghyup-bank, united-overseas-bank-limited, woori-bank, pt-bank-maybank-indonesia-tbk, cooperatieve-rabobank-ua, sbm-bank-india-limited, shinhan-bank (fcnr).

## 6. Sanity checks

- **PSB count = 12** ✓ (script exits non-zero if not).
- **IBU count = 37** ✓ (matches the registry/CSV IBU category exactly).
- **CSV→pack/registry join: 0 unmatched rows** ✓.
- **NRE-without-FCNR flagged: 10 banks** — bank-of-india, dcb-bank-limited, yes-bank-limited, citibank-na, cooperatieve-rabobank-ua, mizuho-bank-ltd, shinhan-bank, capital-small-finance-bank-limited, jana-small-finance-bank-limited, utkarsh-small-finance-bank-limited. These hold NRE slabs, so they demonstrably serve NRIs, yet have no FCNR data — the tightest under-extraction signal in the matrix.

## 7. Caveats — what this matrix cannot tell us

1. **UNKNOWN_PUBLISHES is genuinely unknown.** The registry records what discovery found, not what banks offer. A bank with no NRI URL may still offer the product (Standard Chartered certainly does); we never infer offering from bank type alone — UNKNOWN is the honest verdict, and resolving it requires discovery runs, not this analysis.
2. **STALE_OR_UNDATED ≠ wrong.** An effective date of, say, 15-Dec-2025 may still be the bank's currently published rate. The verdict means "not verified since 2026-06-01", i.e. needs re-verification before the 2026-09-30 window — not that the numbers are bad.
3. **Pack snapshot is 2026-06-11.** Anything scraped after the last pack build is invisible here; re-run the script after the next pack build.
4. **Exclusions inherit registry quality.** wholesale_only / no_retail_deposits flags were set during past discovery; FBs never successfully discovered may be misfiled as UNKNOWN when they are actually wholesale-only (or vice versa). 15/37 IBU exclusions rest entirely on these flags.
5. **`fd_nri_combined` is credited to NRE and NRO but not FCNR** (only an explicit `fulfills_product: ["fd_fcnr"]` extraction hint counts) — conservative, may slightly overstate FCNR "unknown".
6. **Effective-date parsing is best-effort** across the observed format zoo (ISO, dd.mm.yyyy, "18th April 2026", "16-Dec-25", …); unparseable dates are treated as undated and the raw string is preserved in the artifact.
7. **Large-SFB membership is a judgment rule** (docs list + measured signal). The four excluded SFBs can be re-admitted by edit if evidence appears.

## 8. Re-run

```bash
node scripts/analysis/nri-target-list.js            # writes data/cohorts/nri-target-list-2026-07-06.json
node scripts/analysis/nri-target-list.js --as-of 2026-07-20   # dated re-run after next pack build
```

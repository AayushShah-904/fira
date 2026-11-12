# Sprint 009 close-out — cloud-incapable candidate list (Sprint 010 input)

**Date:** 2026-06-06
**Script:** `scripts/analysis/sprint-009-cloud-incapable-candidates.js`
**Output:** `data/sprint-009-cloud-incapable-candidates.json`
**Status:** *candidate list* — every entry needs validation before Sprint 010 flips it to `cloud_capability=false` in the registry.

---

## Why this exists

`lib/cohort/splitter.js` (Sprint 009 Phase 4) can already split a cohort into `cloud` vs `local` lanes, but its only signal today is `cloud_block_status` (WAF blocks). The 9zulerb cohort surfaced a second failure mode the splitter is blind to: banks where the cloud-side agent runs to completion but yields zero or materially fewer slabs than the May-28 baseline. Sprint 010 will wire a `cloud_capability` field next to `cloud_block_status` so the splitter can route these to the local lane. This file is the input to that work.

---

## What the script does

Unions three independent signals from this cohort's outputs:

| Signal | Source | Banks |
|---|---|---:|
| `batch_failure` | `logs/sprint-009/batch-9zulerb.json` — `status: failed` rows | 16 |
| `partial_silent_fingerprint` | `output/latest/<bank>.partial_silent.json` sidecar files | 28 |
| `regressed_to_zero_slabs` | banks present in baseline pack with > 0 slabs whose current pack slab count is 0 | 107 |

Dedupe by `bank_code`, sort by signal-count descending, write `data/sprint-009-cloud-incapable-candidates.json`.

---

## Output summary

| Bucket | Count | Read as |
|---|---:|---|
| **Total candidates** | 132 | union of all three signals |
| With `batch_failure` only | 16 | this cohort's hard fails |
| With `partial_silent` only | 28 | top banks where cohort gave up on a variant |
| With `regressed_to_zero` only | 107 | baseline had slabs, current has none |
| **With ≥ 2 signals** | **19** | high-confidence cloud-incapable — Sprint 010 priority 1 |
| With all 3 signals | 0 | — |

The single-signal-only buckets need a probe before being flipped (a one-shot local re-run); the **19 multi-signal banks are the priority-1 actionable set**.

---

## Priority-1 list — 19 multi-signal banks

These have at least two independent failure signals from this cohort, so they're the safest first batch to declare cloud-incapable.

| Bank | Signals |
|---|---|
| `au-small-finance-bank-limited` | partial_silent + regressed_to_zero |
| `icici-bank-limited` | partial_silent + regressed_to_zero |
| `kakinada-co-operative-central-bank-ltd` | partial_silent + regressed_to_zero |
| `krishna-district-co-operative-central-bank-ltd` | partial_silent + regressed_to_zero |
| `the-junagadh-jilla-sahakari-bank-ltd` | partial_silent + regressed_to_zero |
| `chikmagalur-district-central-co-operative-bank-ltd-dcc-bank-building` | batch_failure + regressed_to_zero |
| `cuttack-central-co-operative-bank-ltd` | batch_failure + regressed_to_zero |
| `jilla-sahakari-kendriya-bank-maryadit-ujjain` | batch_failure + regressed_to_zero |
| `meerut-district-co-operative-bank-ltd` | batch_failure + regressed_to_zero |
| `nizamabad-district-co-operative-central-bank-ltd` | batch_failure + regressed_to_zero |
| `panipat-central-co-operative-bank-ltd` | batch_failure + regressed_to_zero |
| `rander-peoples-co-op-bank-ltd` | batch_failure + regressed_to_zero |
| `rayat-sevak-co-op-bank-ltd-satara` | batch_failure + regressed_to_zero |
| `samata-sahakari-bank-ltd-mumbai` | batch_failure + regressed_to_zero |
| `saraspur-nagarik-co-op-bank-limited` | batch_failure + regressed_to_zero |
| `shri-shiddheshwar-co-operative-bank-ltd-bijapur` | batch_failure + regressed_to_zero |
| `tiruchirapalli-city-co-op-bank-ltd` | batch_failure + regressed_to_zero |
| `varanasi-district-central-co-operative-bank-ltd` | batch_failure + regressed_to_zero |
| `wai-urban-coop-bank-ltd` | batch_failure + regressed_to_zero |

ICICI and AU SFB are the only non-co-op banks in this set. The remaining 17 are small co-ops / DCCBs — the same category where the local extractor has historically outperformed cloud.

---

## Single-signal `partial_silent` set — 23 banks

These succeed in cloud (`status: success` in batch_results) but the cohort emitted a `partial_silent` fingerprint, so the pack-builder stripped some variants. Most are PSB / PVB / FB / SFB — the same banks driving the 627-slab loss in the PVB category and 256-slab loss in PSB:

`bandhan-bank-limited, bank-of-america, bank-of-baroda, bank-of-china-limited, bank-of-india, bank-of-maharashtra, barclays-bank-plc, bnp-paribas, central-bank-of-india, citibank-na, federal-bank-limited, first-abu-dhabi-bank-pjsc, indian-overseas-bank, industrial-and-commercial-bank-of-china-limited, jammu-kashmir-bank-limited, mashreqbank-psc, mizuho-bank-ltd, punjab-national-bank, shinhan-bank, uco-bank, ujjivan-small-finance-bank-limited, union-bank-of-india, yes-bank-limited`

These are NOT urgent cloud-incapable candidates — they still extract *something* in cloud. Sprint 010 priority 2 is to investigate why the cohort emitted `partial_silent` on multi-tab pages so we can recover the variants in cloud rather than route to local.

---

## What this list is *not*

- Not a final answer — every candidate needs a local-run probe to confirm. The `regressed_to_zero` signal can have false positives (a single bad cohort run isn't proof of permanent incapacity).
- Not wired into the splitter — `lib/cohort/splitter.js` doesn't read this file. Sprint 010 task: add a `cloud_capability` field to `bank-domains.json` and extend the splitter to read it.
- Not a probe schedule — there's no decay / re-evaluation rule yet. The WAF-block registry has one (30-day stale); the capability registry will need a parallel rule.

---

## Sprint 010 plan to consume this

1. **Local-run probe of the 19 priority-1 banks** (single-bank smoke runs, local profile). Confirm they extract cleanly locally; if any still fail, that's a fundamentally broken extractor, not a routing problem.
2. **For confirmed cloud-incapable banks, set `bank-domains.json` `cloud_capability: false`** with reason + first_observed.
3. **Extend `splitter.js#decide`** to route `cloud_capability=false` to the local lane.
4. **Wire the auto-update path** — `run-batch.js` post-bank hook updates `cloud_capability` based on actual outcomes, analogous to how Phase 3's `registry-updater.js` updates `cloud_block_status`.
5. **Document decay rule** — when does a `cloud_capability=false` bank get re-probed? Suggested: 60 days, parallel to the WAF window but longer because capability changes more slowly than WAF policy.

---

## Files

- `scripts/analysis/sprint-009-cloud-incapable-candidates.js` — the generator (re-runnable)
- `data/sprint-009-cloud-incapable-candidates.json` — the candidate list (132 entries)
- `logs/sprint-009/baseline-pack-2026-05-28.json` — pre-cohort pack snapshot used for the regression check
- `pack/dist/rates-pack.json` — post-cohort pack used for the regression check

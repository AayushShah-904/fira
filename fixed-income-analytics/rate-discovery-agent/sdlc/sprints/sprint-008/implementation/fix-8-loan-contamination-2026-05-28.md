# Fix — loan-contaminated FD ladders + bulk-tier handling (2026-05-28)

The remaining INR rates >9.5% in the pack, re-extracted via Tier-2:

| Bank | Was | Now | Root cause |
|---|---|---|---|
| deogiri-nagari-sahakari (SUCB) | 12 slabs incl. 14.5% "For Professionals", 13.5% "Salary" | 7 FD slabs (4.25–7.5%) | extraction mixed the **loan/advances** table into FD |
| udupi-co-operative-town (NSUCB) | 12 slabs incl. 14% "2 wheelers", 13% "Maximum Period 5 years" | 5 FD slabs (4–8%) | mixed **vehicle-loan** rows (+ RD) into FD |
| model-co-operative-urban (NSUCB) | 9.5% shown as headline | retail 8.5% + bulk 9.5% **tagged** `deposit_range` | 9.5% was a real **bulk (≥₹10L)** rate, just untagged — not an error |

All three confirmed against the banks' own sources; loan rows excluded; every value source-traceable.

## bucketRate refinement (lib/checks/rate-reasonableness.js)
model-coop exposed that `bucketRate` took the **max** covering rate, which would still pick a bulk tier over retail. Now it **prefers the retail tier** (deposit_range null / `below_*`), falling back to bulk only when no retail tier exists — so peer/repo comparisons use the retail rate. `isBulkRange()` helper + 2 tests added.

## Result
- No bank ships a `regular` rate >9.5% anymore (was deogiri 14.5 / udupi 14).
- Blocking `rate_reasonableness_outlier`: model-coop cleared (retail 8.5 used). 
- `node --test tests/checks/rate-reasonableness.test.js` 11/11; `npm test` green.

## Newly surfaced (operator's call — NOT auto-tuned)
**dcb-bank-limited** PVB 1y **8%** now flags (peer+repo). This is a *real* DCB rate (DCB is a higher-paying PVB); it exceeds the PVB band ceiling (repo 5.25 + 2.5 = 7.75). Options: bump PVB `high` spread 2.5→3.0 (ceiling 8.25) in `data/macro-rates.json` (operator re-approve), or accept dcb as a review item. Left for the operator — not re-editing the approved macro file unilaterally.

## Still open (separate)
AB Bank / Sonali India-branch INR sourcing (optional); bob-ibu tenure granularity; thanjavur gate sign-accept.

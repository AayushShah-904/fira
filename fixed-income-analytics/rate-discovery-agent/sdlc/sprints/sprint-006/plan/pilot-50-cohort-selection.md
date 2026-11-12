# Pilot 50 cohort selection (Phase E target)

**Sprint 006 Phase E.** Operator approved 2026-05-24 the "50-bank mixed pilot across bank types" approach over the binary "co-op-only" or "PSB-only" alternatives.

The 50 picks below are PROVISIONAL — final composition is locked when `scripts/author-template.js` runs against each candidate and confirms the fetch + fingerprint succeed. Banks that fail (404, WAF, unparseable structure) are swapped from the alternates list.

## Composition

| Bank type | Count | Template(s) | Selection rationale |
|---|---:|---|---|
| Co-op `.bank.in` (DCCB+SUCB+NSUCB) | 15 | `coop-bankin-3col-tenure-general-senior` (✅ shipped Sprint 5) | 5 from each sub-type. Highest-leverage cluster from Phase 0.1 (top 6 clusters = 103 banks). Proves the existing extractor at scale. |
| PSB | 10 | `psb-pdf-rate-card-3col` (NEW) | High visibility on every PM dashboard. Skips BoI / PSBank (Sprint 5 regressions). |
| PVB | 10 | `pvb-multi-variant` (NEW) | Multi-variant (NRE+NRO+FCNR) — proves variant routing. |
| FB non-WAF | 8 | `fb-multi-variant` (NEW) | Foreign banks without WAF block. Skips Amex / Barclays / Nova Scotia. |
| SSCB / RRB | 5 | `coop-bankin-3col-tenure-general-senior` (reuse) | Proves cross-bank-type template reuse — same extractor as the 15 co-ops. |
| IBU | 2 | `ibu-static-pdf-quarterly` (NEW) | Skips BoI-IBU / IndusInd-IBU (100% Sprint 5 failures). |

**Total:** 50 banks across 6 bank types, exercising 1 shipped extractor + 4 new ones + the dispatcher fallback path.

## Explicit picks

### Co-op `.bank.in` — 15 banks (using `coop-bankin-3col-tenure-general-senior`)

**DCCB (5):**
1. `cuddapah-district-co-operative-central-bank-ltd` (Sprint-5 Phase-0.1 cluster #1 rep)
2. `kakinada-co-operative-central-bank-ltd`
3. `bagalkot-central-co-operative-bank-ltd`
4. `solapur-district-central-co-operative-bank-ltd`
5. `meerut-district-co-operative-bank-ltd`

**SUCB (5):**
6. `apna-sahakari-bank-ltd` (Sprint-5 cluster #4 rep)
7. `goa-urban-co-operative-bank-limited`
8. `kalyan-janata-sahakari-bank-ltd-kalyan`
9. `rajkot-nagrik-sahakari-bank-ltd`
10. `surat-peoples-co-operative-bank-ltd`

**NSUCB (5):**
11. `ahmednagar-shahar-sahakari-bank-ltd-ahmednagar` (Sprint-5 cluster #3 rep)
12. `ajara-urban-co-operative-bank-ltd` (Sprint-5 cluster #8 rep)
13. `eluru-co-operative-urban-bank-ltd`
14. `bagalkot-urban-co-operative-bank-ltd-bagalkot`
15. `bhuj-commercial-co-op-bank-ltd`

### PSB — 10 banks (using `psb-pdf-rate-card-3col` NEW)

16. `state-bank-of-india`
17. `bank-of-baroda`
18. `punjab-national-bank`
19. `canara-bank`
20. `union-bank-of-india`
21. `indian-overseas-bank`
22. `central-bank-of-india`
23. `idbi-bank-limited`
24. `indian-bank`
25. `uco-bank`

(Skipped: `bank-of-india` — Sprint 5 regressions on NRE/NRO; `punjab-sind-bank` — small + lower priority.)

### PVB — 10 banks (using `pvb-multi-variant` NEW)

26. `hdfc-bank-limited`
27. `icici-bank-limited`
28. `axis-bank-limited` (Sprint-5 Phase-0.4 #1 by slab count — 324 slabs!)
29. `kotak-mahindra-bank-limited` (Sprint-5 had `regular` regression 18→0 — Phase 6 should fix)
30. `indusind-bank-limited`
31. `yes-bank-limited`
32. `federal-bank-limited`
33. `rbl-bank-limited`
34. `idfc-first-bank-limited`
35. `bandhan-bank-limited` (Sprint-5 had FCNR regression + senior-below-general anomalies — Phase 6 fix target)

### FB non-WAF — 8 banks (using `fb-multi-variant` NEW)

36. `dbs-bank-india-limited`
37. `citibank-na`
38. `sbm-bank-india-limited`
39. `emirates-nbd-bank-pjsc`
40. `mufg-bank-ltd`
41. `bank-of-bahrain-and-kuwait-bsc`
42. `standard-chartered-bank`
43. `hsbc-bank-india`

(Skipped WAF cluster: `american-express-banking-corp`, `bank-of-nova-scotia`, `barclays-bank-plc`, `fino-payments-bank-limited`.)

### SSCB / RRB — 5 banks (using `coop-bankin-3col-tenure-general-senior` reuse)

44. `the-andhra-pradesh-state-co-operative-bank-ltd` (SSCB; Sprint-5 noted 3 noise rows — pre-empt accept)
45. `the-himachal-pradesh-state-co-operative-bank-ltd` (SSCB)
46. `the-west-bengal-state-co-operative-bank-ltd` (SSCB)
47. `arunachal-pradesh-rural-bank` (RRB)
48. `karnataka-grameena-bank` (RRB)

### IBU — 2 banks (using `ibu-static-pdf-quarterly` NEW)

49. `hdfc-bank-ibu`
50. `idbi-bank-ibu`

(Skipped: `bank-of-india-ibu`, `indusind-bank-ibu` — both 100% Sprint-5 failures, need vendor-specific PDF research; deferred to Sprint 7.)

## Alternates (swap-in candidates if a pilot pick fails)

| Slot to fill | Alternate |
|---|---|
| Any DCCB | `howrah-district-central-co-operative-bank-ltd` |
| Any SUCB | `g-p-parsik-janata-sahakari-bank-ltd-thane` |
| Any NSUCB | `mahanagar-co-operative-urban-bank-ltd` |
| Any PSB | (none — 10 is the universe; if one fails, defer that bank to Sprint 7) |
| Any PVB | (none in scope — all 10 are top-tier) |
| Any FB | `keb-hana-bank` or `industrial-bank-of-korea` (Sprint-5 noted these as html_js with no rates; would also stress-test the new fetch path) |
| Any SSCB/RRB | `the-meghalaya-co-operative-apex-bank-ltd`, `puducherry-grama-bank` |
| Any IBU | (none — only HDFC-IBU and IDBI-IBU are recoverable in Sprint 6 scope) |

## Pre-emptive accepts (Phase E migration runbook)

Banks where the new extractor will produce a deliberately SMALLER slab count than the legacy production data (because the legacy captured noise rows). The operator signs an accept BEFORE the pack run so the WARN doesn't BLOCK:

| Bank | Variant | Reason for controlled cleanup |
|---|---|---|
| `the-andhra-pradesh-state-co-operative-bank-ltd` | regular | New extractor drops 3 null-tenure rows (`Period of Deposit`, `Above 1 year & upto 5 years` section divider, `Add. Int. for Senior Citizens` note). Source: Sprint-5 Phase C finding #2. |
| (TBD via parity check) | (TBD) | Banks discovered to have similar cleanups during Step 4 migration. Add accepts to this table as they surface. |

## Parity-check tolerance

Per `tmp/baseline-pre-reset/<bank>_rates.json` comparison:
- **Slab count:** ±1 slab (allows for `tenure_cap_days` adjustments + noise-row drops up to 1)
- **Key rates (1y, 3y, 5y):** ±5 basis points
- **Tenure ranges (1y, 3y, 5y):** must overlap at the reference day

Any bank failing parity is HELD from promotion until the extractor is fixed OR the deviation is explicitly accepted via `bin/approve-accept.js`. No silent promotions.

## Migration order within Sprint 6

1. **First wave (10 banks):** 5 co-op + 2 PSB + 2 PVB + 1 SSCB. Smallest blast radius; proves the wiring end-to-end. Run pack quality-gate after.
2. **Second wave (20 banks):** add remaining 10 co-op + 5 PSB + 5 PVB. Run pack quality-gate after.
3. **Third wave (20 banks):** add 3 PSB + 3 PVB + 8 FB + 4 RRB + 2 IBU. Run pack quality-gate after.

Each wave is a separate commit. The operator can pause migration between waves to inspect manifest + quality-gate output before continuing.

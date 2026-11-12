# gold-11-nri-banks cohort (2026-07-08)

PM's 11 "gold standard" NRI banks where we want very high quality, accurate, fresh data
across **all NRI variants: NRE / NRO / FCNR / GIFT**. This cohort is the repeatable test
vehicle for iterating on those 11 — parents paired with their GIFT-City IBU entities.

**18 entries = 11 parents + 7 IBUs.**

## Parent ↔ IBU map

| Parent | IBU entity (GIFT) | Notes |
| --- | --- | --- |
| yes-bank-limited | yes-bank-ibu | IBU exists but **GIFT empty** — needs first scrape; parent **crashes in cloud** |
| axis-bank-limited | axis-bank-ibu | GIFT stale (USD-only, 88d); parent FCNR is gold |
| au-small-finance-bank-limited | — (SFB, no IBU) | **Cloudflare-blocked**; NRE/NRO review-pending |
| icici-bank-limited | icici-bank-ibu | thin FCNR (bank's own page); GIFT 8-ccy but 45d |
| rbl-bank-limited | rbl-bank-ibu | GIFT 84sl but **undated** |
| idfc-first-bank-limited | idfc-first-bank-ibu | GIFT eff 6 months old |
| canara-bank | canara-bank-ibu | **WAF-blocked** (both); FCNR eff a year stale |
| indian-overseas-bank | ⚠ MISSING from registry | IOB runs a GIFT IBU in reality — needs discovery + registry entry (see below) |
| bank-of-maharashtra | bank-of-maharashtra-ibu | IBU exists but **GIFT empty** — needs first scrape |
| saraswat-co-operative-bank-ltd | — (co-op, no IBU) | GIFT genuinely N/A |
| cosmos-co-operative-bank-ltd | — (co-op, no IBU) | GIFT genuinely N/A |

## Not in this cohort (by design)

- **indian-overseas-bank-ibu** — no registry entry exists yet. Adding it needs a discovery
  pass (find IOB's GIFT-City IBU rate page). Tracked as a follow-up; add to this cohort
  once the registry entry lands.
- **AU SFB / Saraswat / Cosmos IBUs** — these institutions do not operate GIFT-City units,
  so GIFT is not applicable. Set that expectation with the PM.

## Cloud reachability (affects how we refresh)

- **Cloud-runnable:** axis, icici, rbl, idfc, indian-overseas, bank-of-maharashtra (+ their IBUs).
- **Blocked → need local residential-IP scrape or extractor fix:** yes-bank (crash),
  canara + canara-ibu (WAF), au-small-finance (Cloudflare).

## Usage

```
# cloud (reachable subset will succeed; blocked ones fail — expected)
node scripts/azops/start-cohort-run.js --cohort gold-11-nri-banks --env prod --expand-nri

# local (for the blocked banks / iteration)
node run-batch.js --cohort gold-11-nri-banks --expand-nri
```

Use `--expand-nri` (not `--rates-only`) so NRE/NRO/FCNR/GIFT variants are all attempted.

# Decision sheet — blob-shrink review (20 cases, 2026-07-08)

Mark each **DECISION** as `KEEP BLOB` or `RESTORE LOCAL`. Recommendation is a starting point — verify against the paired `local/` and `blob/` files (and the live `source_url` where in doubt), don't rubber-stamp. When done, commit this file; then apply RESTOREs with the az command in REVIEW-GUIDE.md.

> **Already resolved (do not re-review):** 7 of these were **auto-restored to blob on
> 2026-07-08** because they were *also* blocking the PM pack's quality gate (unambiguous
> clobbers where local held the full baseline ladder). Local was uploaded over blob via
> `restore-banks-to-blob.js`. **DECISION = RESTORE LOCAL (done)** for:
> `hdfc-bank-ibu_gift`, `kotak-mahindra-bank-ibu_gift`, `idfc-first-bank-ibu_gift`,
> `slice-small-finance-bank-limited`, `the-bihar-state-co-operative-bank-ltd`,
> `sberbank`, `mahamantralaya-allied-offices-coop-bank-ltd`.
> The remaining ~13 (incl. the ambiguous canara ×2 where blob is *larger*) still need your call.

## NRI-relevant (13) — these affect the PM's NRE/NRO/FCNR/GIFT pack

| # | file | variant | local sl | blob sl | which is newer | recommendation | **DECISION** |
|---|------|---------|---------:|--------:|----------------|----------------|--------------|
| 1 | `au-small-finance-bank-limited_nre_rates.json` | NRE | 29 | 8 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 2 | `au-small-finance-bank-limited_nro_rates.json` | NRO | 39 | 12 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 3 | `bandhan-bank-limited_nro_rates.json` | NRO | 42 | 12 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 4 | `canara-bank_nro_rates.json` | NRO | 14 | 37 | local | REVIEW — ambiguous (WAF, no re-scrape) | _____ |
| 5 | `canara-bank_fcnr_rates.json` | FCNR | 30 | 68 | local | REVIEW — ambiguous (WAF, no re-scrape) | _____ |
| 6 | `citibank-na_nro_rates.json` | NRO | 34 | 1 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 7 | `hdfc-bank-ibu_gift_rates.json` | GIFT | 34 | 3 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 8 | `idfc-first-bank-ibu_gift_rates.json` | GIFT | 22 | 6 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 9 | `indusind-bank-ibu_gift_rates.json` | GIFT | 166 | 72 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 10 | `karnataka-bank-limited_nro_rates.json` | NRO | 25 | 10 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 11 | `kotak-mahindra-bank-ibu_gift_rates.json` | GIFT | 55 | 7 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 12 | `mizuho-bank-ltd_nre_rates.json` | NRE | 22 | 1 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 13 | `punjab-national-bank-ibu_gift_rates.json` | GIFT | 10 | 2 | blob | RESTORE LOCAL — clobber suspect | _____ |

## Domestic-only (7) — not in the NRI pack, lower priority

| # | file | variant | local sl | blob sl | which is newer | recommendation | **DECISION** |
|---|------|---------|---------:|--------:|----------------|----------------|--------------|
| 1 | `au-small-finance-bank-limited_rates.json` | domestic | 39 | 12 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 2 | `axis-bank-limited_rates.json` | domestic | 54 | 2 | blob | RESTORE LOCAL — PDF/manual vs HTML teaser (high conf) | _____ |
| 3 | `barclays-bank-plc_rates.json` | domestic | 26 | 5 | blob | RESTORE LOCAL — PDF/manual vs HTML teaser (high conf) | _____ |
| 4 | `mahamantralaya-allied-offices-coop-bank-ltd_rates.json` | domestic | 20 | 7 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 5 | `sberbank_rates.json` | domestic | 10 | 4 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 6 | `slice-small-finance-bank-limited_rates.json` | domestic | 37 | 10 | blob | RESTORE LOCAL — clobber suspect | _____ |
| 7 | `the-bihar-state-co-operative-bank-ltd_rates.json` | domestic | 27 | 10 | blob | RESTORE LOCAL — clobber suspect | _____ |

## Notes

- `local sl` / `blob sl` = slab counts. Full per-case detail (currencies, tenors, rate range, scraped_at, source_url, extraction_method) is in `comparison.json`.
- The two canara cases are the only `local newer` rows: local is the newer scrape but *smaller*; blob is older but larger and was flagged in the sprint-007 multi-table over-extraction analysis (may double-count). Genuine judgment call.

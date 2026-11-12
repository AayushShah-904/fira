# Gold-11 NRI QA session — results (2026-07-08)

Autonomous local run+test pass to improve quality/quantity of the PM's 11
gold-standard NRI banks (+IBUs), all variants incl GIFT. Used research + Opus
investigation agents; safe-write protected every curated ladder throughout.

## Durable deliverables (committed)

**Registry URL fixes** (`data/bank-domains.json`):
| Bank | Fix | Result (fresh) |
| --- | --- | --- |
| IOB | bare→`www` subdomain (bare 404s) | NRE 0→9, NRO 14→30, domestic fresh |
| Yes Bank | real PDF asset URL (was JS/param stub) | **FCNR 0→27 net-new**, NRE fresh 23 |
| Axis | rolled dated PDF 13-jun→07-jul | NRE/NRO now extract (fresh 19/52) |
| Canara-ibu | portal migrated → `ifscgift.canarabank.bank.in` | GIFT 0→16 fresh, correct source |
| BoM-ibu | wrong URL + `manual` scraper + stale "not launched" flag | GIFT 0→1 (partial) |

**Code fix** (`lib/actions/extract_html_table.js`, +test): per-chunk error scoping
in the currency-variant LLM path — a fees/charges chunk's "no rates" error was
globally discarding good FCNR/GIFT slabs from *other* chunks. RBL-ibu 0→18 fresh
(curated 84 preserved). Suite 1619/0/44, golden-HTML green. General fix, though
only RBL hit that exact pattern this round.

**Tooling** (reusable): `scripts/analysis/url-health-probe.js` (fetch health),
`scripts/analysis/designate-nri-quality.js` (writes `nri_quality_status`),
`data/cohorts/gold-11-nri-banks.json`, `gold-fix-targets.json`.

## Net effect on the cohort

- **All URL-drift resolved** — `nri_quality_status` now has an EMPTY manual-fetch
  bucket. Every gold bank fetches. Remaining issues are all parse-quality.
- Biggest wins: IOB (NRO doubled + refreshed), Yes (gained an FCNR ladder it never
  published to us), Canara-ibu GIFT (from the correct migrated portal).

## Honest caveats / still-open (all logged as tasks)

- **RBL fix is RBL-specific in effect** — re-running the other GIFT IBUs did NOT
  lift them; they have distinct causes (below). Reported, not oversold.
- **ICICI-ibu GIFT** (#24) — JSON-API-backed, no DOM table; needs interception extractor.
- **Axis NRI tiers** (#25) — fresh 19/52 under-extracts the amount-tiered PDF vs
  stored 72/162; safe-write keeps the fuller data.
- **Yes eff=2019-07-05** (#26) — verify PDF is current before treating as gold; NRO
  didn't split from the PDF.
- **Canara parent / AU** — JS render + Cloudflare; still 0. Need headful/stealth
  fetch or manual capture (the infra-vs-manual fork).
- **Axis PDF href-discovery** (#23) — durable fix for weekly PDF rolls.
- **Systemic `www` audit** (#27) — 3/11 hit the bare-domain 404; likely fleet-wide.

## Provenance note

The `output/latest` rate changes from these LOCAL runs are validation artifacts,
NOT pack-authoritative (per the cloud-as-source-of-truth principle). The committed
**registry + code fixes** let a future CLOUD gold run reproduce these improvements
into blob → pack legitimately. Not committing the local rate data.

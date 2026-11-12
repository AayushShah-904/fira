# Gold-11 NRI worklist (2026-07-08)

Local QA pass of the PM's 11 gold-standard banks (+IBUs), all NRI variants
(NRE/NRO/FCNR/GIFT). Designations are persisted per entity in
`data/bank-domains.json` under `nri_quality_status` (fetch / parse / action per
variant). This doc is the human-actionable worklist derived from that pass.

Method: URL-health probe (fetch) + fresh local `--rates-only` extraction (parse),
from a residential IP. Safe-write protected all stored data — nothing was lost;
`fresh=0` means the auto-pipeline produced nothing this run, not that data
disappeared.

## ✅ Confirmed gold (fetch + parse both working — cite with confidence)

| Bank | Variants working (fresh slabs) |
| --- | --- |
| **RBL** (parent) | NRE 19, NRO 27, FCNR 30 — all fresh |
| **IDFC First** (parent) | NRE 7, NRO 13, FCNR 12 — all fresh |
| **ICICI** (parent) | NRE 6, NRO 9 (FCNR see parse-help) |
| **Bank of Maharashtra** | NRE 6, FCNR 21 |
| **Axis** | FCNR 38 (with RBI lock-in flags) |

## 🖐 MANUAL FETCH — a human must obtain the page/PDF (auto-fetch fails)

| Bank · variant | Why | Action |
| --- | --- | --- |
| **Indian Overseas** · NRE, NRO, FCNR | All 3 registry URLs return **404** — IOB restructured its site | Find IOB's current NRI/FCNR rate pages, update `rate_pages` |
| **Yes Bank** · NRE, NRO, FCNR | URLs return 200 but **no rate content** (JS-rendered / PDF-behind-`?name=` param) | Obtain the real rate PDF/page; may need a direct PDF link |
| **yes-bank-ibu** · GIFT | **No GIFT URL** in registry | Find Yes Bank's GIFT-City IBU rate page, add to registry |
| **Axis** · NRE, NRO | The stored 72/162 ladders came from the **NRI PDF, which has rolled** (`nri-fixed-deposits-13-june-26.pdf` → 404). The registry's `fd_nre`/`fd_nro` point at a *blog* page, not a rate source | Point NRE/NRO at the current NRI PDF (rolls on each revision — consider a stable URL or PDF-discovery) |

## 🔧 MANUAL PARSE HELP — page is live, extractor yields ~0 (needs extractor work)

| Bank · variant | Detail | Likely cause |
| --- | --- | --- |
| **RBL-ibu** · GIFT | live, fresh **0** vs stored 84 | JS-rendered GIFT table |
| **ICICI-ibu** · GIFT | live, fresh **0** vs stored 24 | JS-rendered GIFT table |
| **Canara-ibu** · GIFT | live, fresh **0** vs stored 32 | JS page |
| **BoM-ibu** · GIFT | live, fresh **0**, no stored | JS page |
| **Axis-ibu** · GIFT | **partial** — fresh 7 vs stored 24 | PDF partially parsed |
| **IDFC-ibu** · GIFT | **partial** — fresh 6 vs stored 22 | PDF partially parsed |
| **Canara** · NRE/NRO/FCNR | live, fresh **0** vs stored 36/37/68 | JS-rendered rate table (agent can't parse; WAF-free locally but page is JS) |
| **AU Small Finance** · NRE/NRO/FCNR | live to a plain fetch, fresh **0** | Cloudflare challenge defeats the agent's Playwright even locally |
| **ICICI** · FCNR | fresh 5 vs stored 13 | thin/partial extraction — verify |
| **BoM / Saraswat / Cosmos** · NRO | no data (fresh 0, no stored) | likely NRO not offered, or published on the shared FD page — confirm |
| **Saraswat / Cosmos** · NRE, FCNR | fresh 0 (rates-only produced domestic only) | co-op variants not wired to a dedicated URL — verify stored data's source |

## Notes

- **Canara & AU are cloud-WAF-blocked AND resist the local agent** (JS/Cloudflare).
  Their stored ladders are good; refreshing them needs either a headful/stealth
  fetch or manual capture. `cloud_block_status` already records the cloud side.
- **GIFT extraction is the single biggest gap** — 6 of 7 IBUs fail or partial. The
  GIFT-City IBU tables (JS-rendered, varied layouts) are the priority extractor
  investment for this cohort.
- Re-run this pass after fixes with:
  `node scripts/analysis/designate-nri-quality.js --cohort gold-11-nri-banks --runs <runlog> --apply`

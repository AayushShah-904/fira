# Sprint 011 — prioritized open backlog (updated 2026-07-09)

Consolidated from the task tracker. P0 = do next / highest leverage. Task IDs in brackets.

**Resolved 2026-07-09 (extractor pipeline):**
- **[30] GIFT tenure floor 365→7d** — DONE. Domestic-FCNR 1-year min was dropping valid
  offshore GIFT-IBU short-tenor slabs. RBL-ibu 18→63. General fix; fcnr unchanged. Committed.
- **[31] classify_rate_page JS mislabel** — investigated → **no change** (classifier already
  correct; Canara's 0-slab is downstream parsing, folded into [29]).

## P0 — highest leverage

| # | Item | Why now |
| --- | --- | --- |
| **[28]** | **Deploy image + cloud gold run** | The gold-11 registry+code fixes are committed but only take effect in a NEW image. A cloud gold run promotes them into blob→pack (cloud = source of truth). **Blocked on:** operator-gated deploy + colleague's cloud-trigger testing (shared prod job — don't collide). |
| **[27]** | **Systemic `www` audit** | 3 of the gold-11 (IOB, Axis, Yes) failed because the registry stores bare `.bank.in` but sites now require `www`. Almost certainly affects many more banks fleet-wide, silently. Sweep the whole registry, detect bare→www 404/redirect, normalize or make the fetcher retry with `www`. Likely recovers many banks for low effort. |

## P1 — finish the gold cohort (parse-quality)

| # | Item | Detail |
| --- | --- | --- |
| **[24]** | ICICI-ibu GIFT JSON extractor | Rates come from a JSON XHR (`giftcity-fd-interest-rate.json`), no DOM table. Needs `--intercept` capture → JSON→slabs (or vision fallback). Recovers 24. |
| **[25]** | Axis NRI amount-tier extraction | Fresh 19/52 under-extracts the amount-tiered PDF vs stored 72/162. Decide retail-only vs all-tiers, fix parse. safe-write protects the fuller data meanwhile. |
| **[26]** | Verify Yes NRI PDF is current | Parsed eff=2019-07-05 is suspicious; confirm the asset is a current card, not a stale archive. Also fix NRO-not-split. Don't cite Yes NRE/FCNR as gold until verified. |
| **[29]** | Canara parent + AU SFB (JS/Cloudflare) | Both return 0 even locally (Canara JS render, AU Cloudflare challenge). Needs headful/stealth fetch or manual capture — the infra-vs-manual fork. Stored ladders protected. |
| **[23]** | Axis PDF href-discovery (durable) | Axis rolls dated PDF filenames ~weekly; hard-coded URLs break. Scrape `…/fd-interest-rates` raw HTML for current `.pdf` hrefs each run. Generalizes F2. |

## P2 — cloud infra / hygiene

| # | Item | Detail |
| --- | --- | --- |
| **[16]** | Republish-only cloud mode | `pull → build → gate → publish`, skip bank loop AND the redundant output/latest push-back (the race that clobbered slice). Makes cloud republish cheap + safe. |
| **[14]** | d4-jobs minimumCount 0 validation | Stop idle D4 billing; validate scale-from-zero. Parked for a separate agent. |
| **[17]** | `collected_via: cloud\|local` provenance flag | Per-record provenance for the labeled-fallback policy. |
| **[19]** | Fallback-staleness worklist | Flag `cloud_capability=false` banks aging past N days so they don't rot. |
| **[18]** | Fix slice-sfb / indian-bank-ibu cloud extractors | zero_slab / crash_pre_flight — currently on local fallback. |

## Where things live
- Task tracker: IDs above (use TaskList / TaskGet).
- Gold-11 QA results: `sdlc/sprints/sprint-011/implementation/gold-11-qa-session-2026-07-08.md`
- Gold-11 fetch/parse worklist: `sdlc/sprints/sprint-011/review/gold-11-nri-worklist-2026-07-08.md`
- Designations: `data/bank-domains.json` → per-entity `nri_quality_status`
- Colleague review pack (20 blob-shrink cases): `sdlc/sprints/sprint-011/review/blob-shrink-2026-07-08/`

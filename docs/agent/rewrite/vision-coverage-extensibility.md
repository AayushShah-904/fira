# Vision & Coverage Extensibility — toward a Fixed Income Analytics platform

> Status: **Proposal / forward-looking.** This document frames the bank-deposit Rate Discovery Agent
> (v2) as **phase 1** of a broader **Fixed Income Analytics (FIRA)** platform, and fixes the design
> stance that lets future bond/instrument coverage slot in without a core rewrite.
> Companion docs: [`functional-spec.md`](./functional-spec.md),
> [`evaluation-spec.md`](./evaluation-spec.md), [`design.md`](./design.md), [`README.md`](./README.md).

## 1. The wider vision

This system lives under BharatOmni / **UFA — Unified Fixed Income Analytics** (the project formerly
"FIRA" was renamed **FIRA** on 2026-05-05). Bank deposits are the *first* asset class we cover, chosen
because retail deposit rates are high-value, comparatively tractable to scrape, and underserved by
transparent comparison tools. The product intent, however, is a **fixed income analytics platform** —
helping users discover, compare, and analyse yields across the Indian fixed income universe.

The natural expansion is **bonds of various types**. The v2 rewrite must therefore be designed so the
deposit work is not a dead-end silo: the same discovery → snapshot → extract → evaluate → publish
machinery should host additional instrument classes over time.

## 2. Envisioned instrument coverage

Each line below is a future **`instrument_type`**. Only the first is implemented now.

| Instrument class | `instrument_type` (proposed) | Status |
|---|---|---|
| Bank deposits (FD / RD / savings; + NRE/NRO/FCNR/GIFT variants) | `deposit` | **Implemented (v2)** |
| Government securities (dated G-Secs) | `gsec` | Future |
| Treasury bills | `tbill` | Future |
| State Development Loans | `sdl` | Future |
| Corporate bonds / NCDs | `corporate_bond` | Future |
| PSU & tax-free bonds | `psu_bond` | Future |
| Sovereign Gold Bonds | `sgb` | Future |
| Small savings (PPF / NSC / post-office) | `small_savings` | Candidate |
| Money-market (CDs / CPs) | `money_market` | Candidate |

This list is directional, not a commitment. It exists to pressure-test the abstraction: any model we
adopt for deposits must plausibly stretch to *yields on rated, ISIN-identified, market-traded
securities*, not just *rates on a bank's website table*.

## 3. The hybrid stance (locked decision)

> **Generalize the contracts and architecture vocabulary now; implement only the deposit instrument.**

Concretely:
- **Now:** introduce an `instrument_type` discriminator across the data contracts and pipeline;
  key extractor dispatch, the checks registry, and the registry schema by instrument; version the
  schemas. Build a generic, instrument-agnostic core (discovery loop, snapshot store, pipeline stages,
  pack/gate, confidence, signed accepts, human adjudication).
- **Not now (YAGNI guardrail):** do **not** build bond extractors, bond-specific checks, bond data
  connectors, or an ISIN registry until a dedicated bond sprint. We do not yet know enough about
  bond-specific needs to design those well; building them against zero real bond requirements would
  be speculative generality. The abstraction is validated against the *second* real instrument, not
  invented ahead of it.

This deliberately sits between "deposit-shaped code with a note saying bonds-go-here" (too little —
forces a later refactor of the core contracts) and "fully build the generic abstraction up front"
(too much — risks the wrong abstraction). It accommodates bonds without pretending to have built them.

## 4. What is shared vs instrument-specific

**Shared, instrument-agnostic core** (designed once, reused by every instrument):
- Issuer / source **discovery** loop (find the authoritative source for an issuer's data).
- **Snapshot-first** capture — immutable, content-addressed source bytes; every observation references
  its snapshot.
- The **pipeline**: fetch → snapshot → classify → extract → per-observation validate → structural /
  reasonableness checks → write → pack → cross-check → audit → golden → confidence → gate → publish.
- **Governance**: operator-only signed accepts (fail-closed, agent-immune), confidence scoring +
  tiers, the human-adjudication rule (LLM judges over-flag), macro-metadata approval.

**Instrument-specific** (registered per `instrument_type`):
- The **observation schema** — what one data point is. Deposits: a rate slab (tenure band × tier ×
  optional currency → general/senior/super rates). Bonds: a yield observation (ISIN → coupon, price,
  yield, maturity, rating).
- The **structural & reasonableness checks** — deposits use `classifyTableType`,
  `ladderPlausibility`, `seniorPremiumPeerOutlier`, `fcnrCurrencySanity`, peer/repo/history rate
  anchors. Bonds would use rating-band sanity, yield-curve fit, credit-spread plausibility, etc.
- The **identity key** — deposits: `bank_code`. Bonds: `ISIN`.
- The **data sources** — deposits: the bank's own website (HTML/PDF/image). Bonds: exchanges, market
  data, depositories, RBI Retail Direct.

## 5. How bonds differ from deposits (why the model must flex)

| Dimension | Deposits (now) | Bonds (future) — implication |
|---|---|---|
| Identity | `bank_code` (slug of issuer) | `ISIN` per security; one issuer → many instruments. Registry must scale to many instruments per issuer. |
| Core metric | A single rate (%) per slab | Coupon **and** price **and** yield (YTM); they interrelate. Observation schema is richer. |
| Credit dimension | None (deposits insured/uniform) | Credit **rating** (AAA…D) is first-class; checks must reason about it. |
| Source | Issuer's own website (scrape) | Secondary-market data (NSE/BSE, depositories, RBI Retail Direct, market vendors) — often **API**, not scraping. |
| Time model | Tenure band (min/max days) | Specific **maturity date**; remaining tenure is computed. |
| Senior tiers | senior / super-senior premium | N/A. |
| Reasonableness anchors | repo band, peer median, own history | **yield curve**, **credit spread** vs benchmark, repo — the *pattern* (multi-reference anchors) generalizes, the *anchors* differ. |
| Cadence | Monthly refresh | Potentially **intraday / daily** — the pipeline must not assume monthly. |

The reusable insight: the **evaluation philosophy** (snapshot-first, layered defence, multi-reference
plausibility, human adjudication, signed governance) transfers directly. The **concrete checks and
schema** do not — hence the per-instrument registration seam.

## 6. Roadmap

1. **Phase 1 — deposits (this rewrite).** Ship the deposit instrument on the generic core, with
   instrument-aware contracts in place but only deposit logic implemented.
2. **Phase 2 — first bond instrument (e.g. `gsec` or `sgb`).** Build the first bond module against
   real requirements; *validate and correct* the abstraction (expect the seam to need adjustment —
   that is the point of waiting). Likely introduces an API-source connector and an ISIN registry.
3. **Phase 3+ — broaden** to corporate bonds / SDLs / T-bills, reusing the now-proven instrument
   plug-in shape.

## 7. Open questions (for the bond phases, not now)

- **Data-source access & licensing** — exchange / market-data APIs for bond yields may require
  commercial agreements; the scrape-the-issuer model may not transfer.
- **Identity & registry scale** — moving from ~1,900 bank_codes to potentially tens of thousands of
  ISINs changes registry storage, dedup, and refresh-scheduling assumptions.
- **Refresh cadence** — intraday/daily bond data vs monthly deposits affects the pipeline scheduler,
  snapshot volume, and the staleness model.
- **Analytics layer** — "analytics" (yield curves, spread analysis, comparisons) is downstream of
  discovery; decide where the discovery/extraction boundary ends and the analytics product begins.

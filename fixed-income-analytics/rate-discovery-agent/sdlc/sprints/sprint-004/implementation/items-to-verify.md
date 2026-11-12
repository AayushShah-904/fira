# Items to verify — PM rate-pack refresh 2026-Q2

Banks below have `partial_silent` markers from Sprint-004 collection runs
that we **deliberately have not cleared**. Each was flagged by the new
drift-gate `expectedVariants` mechanism (added 2026-05-20) because at least
one expected variant came back below floor (often 0 slabs) after 3 retries.

## Quick index (current state of "ship" decision)

| Bank | Captured slabs (dom/nre/nro/fcnr) | Class | Notes |
|---|---|---|---|
| PSB                                            |   |   |   |
| central-bank-of-india    | 15 / 6 / 0 / 25  | likely opt-out | NRO not separately published |
| bank-of-maharashtra      | 14 / 6 / 0 / 25  | likely opt-out | NRO not separately published |
| bank-of-india            | 15 / 7 / 0 / 0   | mixed | NRO not separate; FCNR likely PDF/image |
| PVB                                            |   |   |   |
| icici-bank-limited       | 2  / 3 / 3 / 0   | extract quality | FCNR JSON API path inconsistent; domestic low |
| hdfc-bank-limited        | 34 / 18 / 34 / 24 | Orch-1+Orch-2 closed dom+NRE+NRO | NRE/NRO now sourced from domestic page via HTML `fulfills_product` hint; senior null, NRE filtered to ≥1y per page note; FCNR still aggregator-sourced (separate page schema) — see [`./engine-fixes-orch2.md`](./engine-fixes-orch2.md) |
| dcb-bank-limited         | 17 / 0 / 0 / 0   | extract quality | NRI page render OK, 0 slabs |
| idfc-first-bank-limited  | 15 / 0 / 0 / 20  | extract quality | NRE/NRO miss; FCNR ok |
| jammu-kashmir-bank-limited | 13 / 0 / 0 / 0 | extract quality | All NRI miss; pages fetched |
| nainital-bank-limited    | 14 / 0 / 0 / 0   | likely no NRI | small bank, may not publish NRI |
| kotak-mahindra-bank-limited | 18 / 18 / 18 / 17 | drift-vs-floor | FCNR 17 < floor 30; stale floor likely |
| axis-bank-limited        | 0 / 0 / 0 / 0    | infra fix | fetch_pdf can't pull Axis PDFs |
| tamilnad-mercantile-bank-limited | 0 / 0 / 0 / 0 | LLM truncation (NOT OCR) | Page /pages/Deposit-Interest-Rates publishes 5 HTML tables (Domestic+NRO 20rows, Bulk 19rows, NRE 10rows, FCNR 7×6 currency-keyed). 2026-05-22: LLM extractor truncated at 19552 chars (`finish_reason=length`). Earlier "needs OCR" classification was wrong — content is HTML, not image. Fix: extend Cheerio deterministic path to handle TMB table structure, OR raise LLM max_tokens / chunk smaller. FCNR table is currency-keyed (same as Axis/HDFC) — also benefits from FCNR currency-schema work. |
| yes-bank-limited         | 0 / 0 / 0 / 0    | bot mgr | Akamai blocks all engines |
| indusind-bank-limited    | 0 / 0 / 0 / 0    | extract / JS  | JS doesn't render rate data |
| federal-bank-limited     | 0 / 0 / 0 / 0    | network block | GCLB blocks IP |


For each item, the operator must visit the bank's published rate pages,
confirm the variant is genuinely not published separately (rather than a
scrape miss), and only then either:
- clear the `partial_silent` marker + add an entry to
  `data/expected-slab-floors.json` opting that variant out, e.g.
  `"central-bank-of-india": { "nro": 0 }` — so future runs don't re-flag, OR
- if the variant IS published on a page we missed, update
  `data/bank-domains.json` with the correct URL and re-run the bank.

Until verified, these banks **ship with the partial_silent marker** and are
excluded from `pack/dist/rates-pack.json` per the existing
`pack/build-pack.js` skip rule.

---

## central-bank-of-india

**Captured 2026-05-20:** `dom=15, nre=6, nro=0, fcnr=25 [partial_silent]`

**Bank-domains note:**
> Static HTML tables. NRO rates same as domestic. Senior citizen +0.50%.
> Special schemes: 444-day, 555-day, Green 1111-day, Floating Rate. Legacy
> domain centralbankofindia.co.in redirects to .bank.in. **NRO rates not
> listed separately — likely same as domestic FD rates.**

**`fd_nro` URL in bank-domains.json:** `null`

**Verification steps:**
1. Visit https://centralbank.bank.in/ — look in the NRI / Deposits sections
   for any NRO rate page.
2. Confirm or refute the bank-domains note. If NRO is genuinely
   "same as domestic":
   - `data/expected-slab-floors.json` → add
     `"central-bank-of-india": { "nro": 0 }`
   - delete `output/latest/central-bank-of-india.partial_silent.json`
   - re-run `pack/build-pack.js` so CBI flows into the pack
3. If a separate NRO page exists, update `bank-domains.json#rate_pages.fd_nro`
   and re-run via `node run-batch.js central-bank-of-india --category "Public Sector Bank"`.

---

## bank-of-maharashtra

**Captured 2026-05-20:** `dom=14, nre=6, nro=0, fcnr=25 [partial_silent]`

**Bank-domains note:**
> Static HTML tables. NRO rates same as domestic. Senior citizen +0.50% for
> 91+ days up to Rs.5cr. Legacy domain bankofmaharashtra.in redirects to
> .bank.in. **NRO rates not listed separately — likely same as domestic FD
> rates.**

**`fd_nro` URL in bank-domains.json:** `null`

**Verification steps:** Same procedure as CBI above, with slug
`bank-of-maharashtra`.

---

## bank-of-india

**Captured 2026-05-20:** `dom=15, nre=7, nro=0, fcnr=0 [partial_silent]`

**Bank-domains note:**
> reCAPTCHA bot protection, needs Playwright stealth. **Domestic FD page
> includes NRO rates.** Legacy domain bankofindia.co.in redirects to .bank.in.

**Engine override applied:** `playwright_browser: "firefox"`,
`playwright_skip: ["selects", "tabs"]`, `playwright_timeout_ms: 120000` —
needed to bypass Cloudflare challenge on bankofindia.bank.in.

**Two separate issues to verify:**

### NRO (no separate page; data is on domestic FD page)
- The agent ran 3 attempts and never wrote `bank-of-india_nro_rates.json`
  — the drift gate flagged it on all attempts.
- Per bank-domains note, NRO rates are not published as a separate table;
  they're stated to be the same as the domestic FD rates.
- **Verification:** confirm at https://bankofindia.bank.in/interest-rate/rupee-term-deposit-rate
  that no separate NRO rate table or NRO-specific tenure structure is
  published. If confirmed:
  - `data/expected-slab-floors.json` → `"bank-of-india": { "nro": 0 }`
  - delete `output/latest/bank-of-india.partial_silent.json`

### FCNR (page exists, agent found no extractable table)
- The agent fetched https://bankofindia.bank.in/nri-rate-of-interest-fcnr-b-deposit-details
  successfully 3 times but extracted 0 slabs each attempt.
- Warning in `output/latest/bank-of-india_fcnr_rates.json`:
  *"No FCNR rate table found on the page. The FCNR page is either empty or
  rates are published as image/PDF not extractable via HTML."*
- **Verification:** open the FCNR page in a real browser. Either:
  - The rates ARE published as a PDF rate card → update
    `bank-domains.json#rate_pages.fd_fcnr` to the PDF URL and re-run.
  - The rates are an embedded image / scan → mark FCNR as manual entry
    (set floor to 0 same as NRO, OR transcribe rates manually).
  - The page genuinely has no FCNR rates published — same opt-out treatment.

---

## yes-bank-limited

**Captured 2026-05-20:** `dom=0, nre=0, nro=0, fcnr=0` after 3 attempts
× 3 override variants (default, stealth-chromium, Firefox+skip).

**Bank-domains note:** *"Akamai Bot Manager blocks all programmatic
access (fetch_url..."*

**Symptoms tried:**
1. Default agent: `fetch_pdf` on Yes Bank's NRI PDF errored; agent gave
   up in attempts 2+3 with 0 tool calls.
2. Stealth-chromium + skip[selects,tabs] + 120s: still ZERO.
3. Firefox + skip + 180s: still ZERO.

Akamai's bot manager rejects every engine + UA combo we've tried.

**Override kept in `bank-domains.json`** (Firefox + skip + 180s) for any
future runs from a different network egress, but not currently effective.

**Suggested next steps:** Residential proxy / different network, or
manual rate transcription.

---

## indusind-bank-limited

**Captured 2026-05-20:** `dom=0, nre=0, nro=0, fcnr=0` after 3 attempts
× multiple override variants.

**Bank-domains note:** *"All rates (domestic, NRE, NRO, FCNR, IBU) on
single page /in..."*

**Symptoms tried:**
1. Default agent: Playwright 120s timeout on
   `https://indusind.bank.in/in/en/personal/rates.html` (×2); fetch_url
   succeeded but no rate slabs found in raw HTML.
2. Stealth-chromium + skip[selects,tabs] + 120s: ZERO.
3. Firefox + skip + 180s: ZERO.

The page renders only via JS, the JS doesn't complete in either engine,
and the static HTML doesn't contain rate data.

**Suggested next steps:**
1. Manual inspection in a real browser — confirm rates are actually
   published on the JS-rendered version.
2. If yes, the page may need explicit "wait for selector" or interaction
   before extract — separate engineering task.

---

## federal-bank-limited

**Captured 2026-05-20:** `dom=0, nre=0, nro=0, fcnr=0` (no remedy worked)

**Symptom across 3 PVB-run attempts + 3 rerun attempts:** All
`fetch_url` calls return errors in 28–100ms. Stealth-Playwright rerun
applied (stealth + skip + 120s) — child process still TimeoutError'd.

**Root cause (probed manually 2026-05-20):**
- `curl -sI https://federal.bank.in/deposit-rate` returns **HTTP/2 403**
  regardless of User-Agent (tested default and a real Chrome UA).
- Response header `via: 1.1 google` indicates the site is behind Google
  Cloud Load Balancer with an aggressive security policy blocking
  automated traffic at the IP / network level.
- Stealth doesn't help — even a real browser fingerprint gets 403.

**Pre-emptive override in `bank-domains.json`** (kept for future runs from
a different network, doesn't currently help): `playwright_stealth: true`,
`playwright_skip: ["selects","tabs"]`, `playwright_timeout_ms: 120000`.

**Suggested next steps (engineering, not autonomous):**
1. Try the run from a **non-cloud, residential-looking IP** — GCLB
   security policies sometimes whitelist consumer ISPs.
2. Use a residential proxy service for this bank specifically.
3. If neither works, Federal Bank ships out of the pack and rates must
   be manually transcribed.

---

## icici-bank-limited

**Captured 2026-05-20:** `dom=2, nre=3, nro=3, fcnr=0` (partial_silent)

**Symptom across runs:** Domestic / NRE / NRO render via Playwright, but
the slab counts are very low (ICICI publishes ~22 domestic tenures
typically). FCNR is the consistent failure — the page hangs at 120s when
attempted via Playwright with default flags; it works only when the
agent finds the JSON API endpoint at
`/content/dam/icicibank-revamp/deposits/fcnr-calculator/fcnr-fd-interest-rate.json`,
which happens inconsistently across attempts.

**Override applied:** `playwright_skip: ["selects","tabs"]`,
`playwright_timeout_ms: 120000`. The skip prevents the dropdown crawl
loop that hangs FCNR; the trade-off is dropdown-driven amount tiers on
domestic don't get visited (which is why domestic is 2 not 22).

**Suggested next steps:** Per-bank scrape strategy hint — point the
agent directly at the FCNR JSON endpoint for ICICI; lift the
skip restriction for domestic to recover the amount tiers. Separate
engineering work.

---

## kotak-mahindra-bank-limited

**Captured 2026-05-20:** `dom=18, nre=18, nro=18, fcnr=17` (partial_silent)

**PS reason:** `slab drift on fcnr: 17 < 0.8 * 30 (floor)`. The drift gate
triggered because the FCNR floor in `expected-slab-floors.json` is 30 but
the new extraction got 17. **Data IS extracted on every variant** —
this is not a missing-NRI bank.

**Override applied:** `playwright_browser: "firefox"`,
`playwright_skip: ["selects","tabs"]`, `playwright_timeout_ms: 180000`.
Firefox cleared whatever WAF/timeout was breaking stealth-chromium on
Kotak's NRI pages.

**Verification needed:** Visit Kotak's FCNR page in a real browser and
count the actual published slabs. Two scenarios:
- The floor (30) is stale — the bank published fewer FCNR tenures /
  currencies than last year. Update `expected-slab-floors.json` and clear
  the marker.
- The extraction is missing slabs (e.g., a currency dropdown that the
  `skip[selects]` flag is suppressing). Adjust the override and rerun.

---

## axis-bank-limited

**Captured 2026-05-20:** `dom=0, nre=0, nro=0, fcnr=0` (no auto-remedy applied)

**Bank-domains note:** *"JS-rendered landing page with PDF rate cards"*

**Symptom across 3 attempts (PVB run 19:02):** Every `fetch_pdf` call against
Axis's PDF rate-card URLs returned ERR. The FCNR PDF specifically hangs at
the 60s `fetch_pdf` timeout. Domestic + NRI PDFs error in 1–4s (likely 4xx
or connection refusal).

**Likely root cause:** `fetch_pdf` doesn't pass enough request headers /
cookies to satisfy Axis's CDN, OR Axis is blocking the Node.js default UA.
Different class of problem than the page-render bot protection we hit on
SBI/BoI/HDFC.

**Suggested next steps (engineering, not autonomous):**
1. Inspect `scripts/extract_rates_pdf.mjs` to see how it downloads PDFs.
2. Add browser-like headers (User-Agent, Accept, Referer pointing to
   axis.bank.in) or route the PDF download through Playwright (browser
   context downloads PDFs natively and inherits stealth headers).
3. Re-run after the fix.

Pack-build impact: Axis ships out entirely until manually entered or the
fetch_pdf path is patched.

### Resolved 2026-05-21 (M1)

- Engineering fix landed in commit `cb0718a` (M1: `fetch_pdf` headers,
  relative redirects, two-stage timeout). See
  `sdlc/sprints/sprint-004/implementation/engine-fixes-m1.md`.
- Bank had also rotated its dated PDF filenames between April and May
  (registry held `27-march-26`; site now publishes `21-may-26`). Operator
  supplied fresh PDFs; `data/bank-domains.json` updated.
- Re-run produced **74 slabs** (18 dom + 8 NRE + 18 NRO + 30 FCNR @ 6
  currencies) — verified against operator PDFs. Cost $0.18.
- **All 74 slabs are tagged `deposit_range: below_3cr`.** They were pulled
  from the `< 3cr` PDFs only.

### Open follow-up for M2 — Axis "plus" (≥ 3 cr) deposit-range tier

Axis publishes a **second** family of PDFs per product for deposits ≥ ₹3 cr.
These are referenced in `data/bank-domains.json` already (see
`fd_pdf_domestic_plus` and `fd_pdf_nri_plus` keys) but the agent did not
fetch them during M1 because it doesn't yet know they map to a different
`deposit_range`. Result: at "1 year" tenure we have only 6.25% (< 3 cr)
shipped — the 6.60% (≥ 3 cr) rate is missing from the pack.

Same pattern likely affects other large PVBs/PSBs (HDFC, ICICI, SBI) that
publish stacked bulk-deposit tier PDFs.

**M2 action items (mandatory to address before M2 closes):**

1. Extend `data/bank-domains.json` schema with `extraction.deposit_range`
   per `rate_pages.*` key. For Axis specifically:

   ```jsonc
   "rate_pages": {
     "fd_pdf_domestic":      "/docs/.../domestic-fixed-deposits-21-may-26.pdf",
     "fd_pdf_domestic_plus": "/docs/.../domestic-fixed-deposits-plus-21-may-26.pdf",
     ...
   },
   "extraction": {
     "fd_pdf_domestic":      { "deposit_range": "below_3cr" },
     "fd_pdf_domestic_plus": { "deposit_range": "3cr_to_5cr" },
     "fd_pdf_nri":           { "deposit_range": "below_3cr" },
     "fd_pdf_nri_plus":      { "deposit_range": "3cr_to_5cr" }
   }
   ```

   (The exact bucket — `3cr_to_5cr` vs `above_3cr` — is something to
   confirm against the PDF heading text. The "plus" PDF header reads
   "Deposits of ₹3 crore and above"; closest enum is `above_100cr` or
   we extend the `deposit_ranges` enum with `3cr_and_above`.)

2. Teach `lib/orchestrator.js` (and the LLM-path prompt at
   `prompts/discover.md`) to:
   - Fetch every `rate_pages.fd_pdf_*` URL listed for a bank, not just the
     canonical `fd_pdf_domestic` / `fd_pdf_nri`.
   - Apply the `extraction.<key>.deposit_range` value to every slab parsed
     from that PDF.
   - Merge slabs from `_plus` into the same `_rates.json` (NOT a separate
     variant — same variant, different `deposit_range`).

3. Re-run Axis after M2 ships. **Acceptance**: domestic file has slabs at
   both `below_3cr` and `3cr_to_5cr` (or chosen bucket); at "1 year"
   tenure there are two rows: 6.25% and 6.60%. Same for NRI variants.

4. Audit other banks with `*_plus` or `*_bulk` entries in their
   `rate_pages` (today: HDFC, ICICI, SBI, possibly Kotak). Same fix
   benefits all of them.

**Tracking**: this open item is referenced in:
- `sdlc/sprints/sprint-004/implementation/engine-fixes-m1.md`
  §"Known limitation surfaced by M1"
- `~/.claude/plans/pivot-to-engine-failure-lovely-wombat.md` (M2 section,
  to be updated when M2 starts)
- Sprint-004 retrospective will reference this if M2 doesn't close it.

### Status update (M2.4, 2026-05-21)

PDF column hint authored in `data/bank-domains.json#axis-bank-limited.extraction.fd_pdf_domestic` covering all 3 pages (4 cols + 7 cols + 7 cols). PDF parser (`parseRateLinesWithHint`) correctly emits 72 slabs for page 1 when invoked directly via `node scripts/extract_rates_pdf.mjs <pdf> --hint <file>` — verified end-to-end.

**LLM-path limitation discovered**: when the agent invokes `fetch_pdf` and receives the parser's 72-slab output for a single page, it post-processes the slabs down to 24 (6 tenures × 4 columns) and then to 0 (gives up) before the rates file is written. Iteration on prompt wording (adding "do not dedup, write every slab") brought it from 10 → 24 but the LLM still truncates beyond ~6 tenures' worth of rows even with explicit instructions.

The truncation is not output-token capped (only 4377 tokens used on the latest re-run vs gpt-4.1's 32k output budget). It's the LLM's own judgment that the data is repetitive.

**Recommended follow-up (sprint-005)**: route multi-column PDF banks through the orchestrator path (`--path orchestrator` flag, `lib/orchestrator.js`) where the deterministic action sequence writes parser output to disk without LLM post-processing. This is the natural use case for the orchestrator that was built in sprint-003 but not yet deployed.

Until then, Axis ships with 24 domestic slabs (vs M1's 18 — small improvement but well below the ~324 cells available in the PDF). Pages 2-3 bulk tiers and the senior columns on tenures past tenure #6 are silently dropped by the LLM.

### Status update (M2.6, 2026-05-21) — superseded

M2.6 (commit `817d936`) implemented orchestrator URL preference + multi-page aggregation + multi-variant PDF support + tenure-normalizer fix. Axis went **74 → 570 slabs** (7.7×) via the orchestrator path at $0.00 AOAI cost: 324 domestic + 72 NRE + 162 NRO + 12 FCNR. Multi-column hints for `fd_pdf_domestic` (3 pages × 4/7/7 cols) and `fd_pdf_nri` (2 pages × 9 cols, `fulfills_product: ["fd_nre","fd_nro"]`) authored in `data/bank-domains.json`. **Both M2.4 + M2.5 open items above are CLOSED by M2.6.**

What remains open at Axis is the *next* set of gaps below.

### Open: Axis Plus variant — no-premature-withdrawal product family (backlog)

Recorded 2026-05-21 (after operator pointed out the schema gap during M2.6 verification).

Axis publishes a **"Plus" variant** of both domestic and NRI fixed deposits. The Plus product offers a slightly higher rate (~+0.35% at 1 year, e.g., domestic 6.25% → Plus 6.60%) in exchange for **no premature withdrawal**. The PDFs in the registry are:

- `fd_pdf_domestic`      → `domestic-fixed-deposits-21-may-26.pdf` — standard, premature withdrawal allowed (in pack via M2.6)
- `fd_pdf_domestic_plus` → `domestic-fixed-deposits-plus-21-may-26.pdf` — **no premature withdrawal** (NOT in pack, no hint authored)
- `fd_pdf_nri`           → `nri-fixed-deposits-21-may-26.pdf` — standard NRE/NRO (in pack via M2.6)
- `fd_pdf_nri_plus`      → `nri-fixed-deposits-plus-21-may-26.pdf` — **no premature withdrawal NRI** (NOT in pack, no hint authored)

**Schema gap**: the rate-slab shape currently models 3 orthogonal dimensions per slab (`tenure × deposit_range × age_tier`) plus `currency` for FCNR/GIFT. The "Plus" product introduces a **fourth orthogonal dimension** — a withdrawal-policy flag — that no existing field captures.

**Design decision pending** (operator leaning, 2026-05-21): per-slab `withdrawal_policy` field with values like `"callable"` (premature withdrawal allowed) vs `"non_callable"` (Plus / locked-in). Backward-compatible if existing slabs default to `callable` or `null`. Operator wants to think further before locking in the design.

Alternatives considered:
- Separate variants `regular_plus`, `nre_plus`, `nro_plus` (Option B) — cleaner partitioning, but doubles the variants enum and conflates "policy attribute" with "product line"
- Generic `product_subtype: standard | plus | floating | tax_saver` (Option C) — most future-proof; handles Tax-Saver FD (5-year locked, common across PSBs) and the Axis Floating-Rate product in one stroke

**When this lands**:
- Schema decision (one of A/B/C) → BIRD-side ingestion coordination
- Rate-slab schema updated in `pack/build-pack.js` + `pack/dist/rates-pack.schema.json`
- Extraction-hint schema updated to declare the dimension per PDF (e.g., `extraction.fd_pdf_domestic_plus = { type: "pdf", fulfills_product: "fd", withdrawal_policy: "non_callable", pages: [...] }`)
- Author Axis Plus hints for `fd_pdf_domestic_plus` and `fd_pdf_nri_plus`
- Re-run Axis: expected uplift ~+500 slabs (Plus PDFs mirror the standard layout — 18 tenures × 18 cols domestic, 18 tenures × 9 cols NRI)

**Audit when this lands**: HDFC, ICICI, SBI, Kotak likely have similar "Premier" / "Non-Callable" / "Special" rate cards. Same schema change benefits all of them.

### Open: Axis Floating-Rate deposits — different product family (backlog)

Recorded 2026-05-21.

Axis also publishes `fd_pdf_floating` → `domestic-floating-rate-deposits.pdf`. This is a **fundamentally different product**: the rate isn't a fixed % at all but a formula tied to a market benchmark (e.g., RBI repo + spread bps, or G-Sec yield + spread).

**Schema gap**: the rate-slab shape assumes `rate_general_pct` is a number. Floating-rate products need a different slab shape with fields like:
- `reference_index: "RBI_REPO" | "TBILL_91D" | ...`
- `spread_bps: <number>`
- `reset_frequency: "monthly" | "quarterly" | "annually"`
- `current_rate_pct: <number>` (the prevailing effective rate as of the PDF date — bank-published)
- `floor_pct` / `cap_pct` (optional)

**Design decision pending**: where to file these slabs. Options:
- Same `products.fd.floating` variant — but the slab schema differs from fixed-rate
- New product family `products.floating_fd` — cleaner separation
- Re-use `products.fd.regular` and mark via `product_subtype: "floating"` (Option C from above) — same row schema but `rate_general_pct` carries the *current effective rate*, with additional optional fields for the formula

**Confirmed product class** but no immediate plan to extract. Likely a sprint-005 or later item once the Plus schema decision lands (because the chosen approach may cascade — e.g., if Plus is solved via `product_subtype`, Floating slots into the same framework).

### Open: Axis FCNR currency-keyed columns (backlog)

Recorded 2026-05-21 (during M2.6 verification).

Axis FCNR PDF (`fcnr-rfc-deposits-02-march-26.pdf`) uses a column layout the current extraction-hint schema doesn't model:
- Columns: USD (Below 1M), USD (≥1M), GBP, EURO, AUD, CAD, JPY — **7 currency columns** (one is also amount-tiered for USD)
- Rows: 5 tenures (1<2y, 2<3y, 3<4y, 4<5y, 5y) — FCNR has fixed min 1y / max 5y per RBI rules
- Expected: 5 × 7 = ~35 rate cells

The current hint schema models `age_tier` and `deposit_range` per column but not `currency`. Today's M2.6 pack ships 12 FCNR slabs for Axis via the legacy parser (which picks ~one column reliably).

The PDF also has an RFC TERM DEPOSITS section after the FCNR-B section — same shape, different product (Resident Foreign Currency, for returning NRIs). Worth supporting eventually.

**Design**: extend the hint schema with `currency` field per column:
```jsonc
"extraction": {
  "fd_pdf_fcnr": {
    "type": "pdf",
    "fulfills_product": "fd_fcnr",
    "pages": [
      { "page": 1, "columns": [
        { "currency": "USD", "deposit_range": "below_1m_usd", "age_tier": "general" },
        { "currency": "USD", "deposit_range": "above_1m_usd",  "age_tier": "general" },
        { "currency": "GBP", "age_tier": "general" },
        { "currency": "EUR", "age_tier": "general" },
        { "currency": "AUD", "age_tier": "general" },
        { "currency": "CAD", "age_tier": "general" },
        { "currency": "JPY", "age_tier": "general" }
      ]}
    ]
  }
}
```

Parser change: `parseRateLinesWithHint` already emits `rate_general_pct` based on `age_tier`; just needs to copy `currency` onto each emitted slab.

**Audit when this lands**: every bank with multi-currency FCNR/GIFT PDFs (HDFC, SBI, BoB, IBUs).

---

### Open follow-up for M2 — Axis multi-column page 1 + bulk-tier pages 2 & 3

Discovered 2026-05-21 during M1 output verification. **Note**: an earlier
draft of this section misinterpreted the PDF as stacked age tiers (general
/ senior / super-senior on separate pages); operator clarified the actual
structure on 2026-05-21. The correct structure of
`domestic-fixed-deposits-21-may-26.pdf` is:

**Page 1 — deposits < 5 cr** (one tenure per row, 4 rate columns)

| Slab range | General < 3 cr | General 3–5 cr | Senior < 3 cr | Senior 3–5 cr |
|---|---|---|---|---|
| (18 tenure rows from 7-14 days up to 5-10 years) | … | … | … | … |

**Page 2 — deposits ≥ 5 cr, general** (one tenure per row, 7 amount-tier columns)

| Slab range | 5–25 cr | 25–50 cr | 50–100 cr | 100–200 cr | 200–500 cr | 500–1000 cr | > 1000 cr |

**Page 3 — deposits ≥ 5 cr, senior citizen** — same 7-column layout as page 2.

**Important: there is no super-senior category at Axis.** Indian PSBs
typically publish super-senior (≥80) tiers; Axis does not.

**What the M1 pack contains today** (verified against the PDF):

The current `scripts/extract_rates_pdf.mjs` regex `RATE_LINE_PATTERN`
captures at most 3 rate columns per line and slots them into
`(rate_general_pct, rate_senior_pct, rate_super_senior_pct)`. On Page 1 a
row like `7-14 days | 3 | 3 | 3.5 | 3.5` picks the first value (general
< 3 cr) as `rate_general_pct` and discards the rest. The LLM then dedup'd
across pages and shipped Page 1's first column.

**Net**: the 18 slabs in the pack ARE the genuine **general < 3 cr** column
correctly tagged `below_3cr` / `rate_general_pct`. They are accurate for
what they claim to be — just incomplete. Operator verified the values
correspond to the PDF's general < 3 cr column.

**What's missing (the M2 gaps):**

| Bucket | Slab count | Where in PDF | Schema mapping |
|---|---|---|---|
| Senior < 3 cr | 18 | Page 1, column 4 | populate `rate_senior_pct` on existing 18 slabs |
| General 3–5 cr | 18 | Page 1, column 3 | new slabs with `deposit_range: "3cr_to_5cr"`, `rate_general_pct` |
| Senior 3–5 cr | 18 | Page 1, column 5 | populate `rate_senior_pct` on the 3–5 cr slabs |
| General 5–25 cr | 18 | Page 2, column 2 | new slabs with `deposit_range: "5cr_to_25cr"` |
| Senior 5–25 cr | 18 | Page 3, column 2 | populate senior on 5–25 cr slabs |
| General 25–50 cr | 18 | Page 2, column 3 | new `deposit_range: "25cr_to_50cr"` (**new enum value**) |
| Senior 25–50 cr | 18 | Page 3, column 3 | populate senior |
| General 50–100 cr | 18 | Page 2, column 4 | new `deposit_range: "50cr_to_100cr"` (**new enum**) |
| Senior 50–100 cr | 18 | Page 3, column 4 | populate senior |
| General 100–200 cr | 18 | Page 2, column 5 | new `deposit_range: "100cr_to_200cr"` (**new enum**) |
| Senior 100–200 cr | 18 | Page 3, column 5 | populate senior |
| General 200–500 cr | 18 | Page 2, column 6 | new `deposit_range: "200cr_to_500cr"` (**new enum**) |
| Senior 200–500 cr | 18 | Page 3, column 6 | populate senior |
| General 500–1000 cr | 18 | Page 2, column 7 | new `deposit_range: "500cr_to_1000cr"` (**new enum**) |
| Senior 500–1000 cr | 18 | Page 3, column 7 | populate senior |
| General > 1000 cr | 18 | Page 2, column 8 | new `deposit_range: "above_1000cr"` (**new enum**) |
| Senior > 1000 cr | 18 | Page 3, column 8 | populate senior |

**Total missing for Axis domestic: 17 × 18 = 306 rate cells across 9
deposit_range buckets.** (Currently 18 cells of one bucket are shipped.)

**M2 action items (mandatory to address before M2 closes):**

1. **Extend the PDF parser**: the regex/structure currently caps at 3
   numeric columns per row. Need wider capture — ideally parse the PDF
   table by detecting column boundaries (x-coordinates from pdfjs) rather
   than tab-counting, so all 4 (page 1) or 7 (pages 2-3) numeric columns
   are kept.
2. **Add column-header inference**: each page has a header row naming the
   tiers (e.g., "Below ₹3 Cr", "≥ ₹3 Cr to < ₹5 Cr", "5 Cr to < 25 Cr",
   etc.). Map these to `deposit_range` enum values; emit one slab per
   `(tenure × deposit_range × age_tier)` cell.
3. **Extend the schema enum `deposit_ranges`** (in `pack/build-pack.js`
   and the rates-pack JSON schema) with the new buckets: `25cr_to_50cr`,
   `50cr_to_100cr`, `100cr_to_200cr`, `200cr_to_500cr`,
   `500cr_to_1000cr`, `above_1000cr`. Coordinate with the BIRD ingestion
   side before changing the enum.
4. **Per-bank hint in `data/bank-domains.json`**:

   ```jsonc
   "extraction": {
     "fd_pdf_domestic": {
       "pages": [
         { "page": 1, "columns": ["below_3cr", "3cr_to_5cr"], "age_columns": ["general", "senior"] },
         { "page": 2, "columns": ["5cr_to_25cr", "25cr_to_50cr", ...], "age_tier": "general" },
         { "page": 3, "columns": ["5cr_to_25cr", "25cr_to_50cr", ...], "age_tier": "senior" }
       ]
     }
   }
   ```

   (The hint is per-bank because not every bank uses the same column
   layout; Axis's structure is its own.)
5. Re-run Axis after M2 ships. **Acceptance**: domestic file has 306 slabs
   (18 tenures × 9 deposit_ranges × ~2 age tiers — minus combinations
   absent in the PDF), with `rate_general_pct` and `rate_senior_pct`
   populated correctly. `rate_super_senior_pct` stays null (Axis has no
   super-senior tier).
6. Audit other large PVBs / PSBs (HDFC, ICICI, SBI, Kotak) — they likely
   have similar multi-column / multi-page bulk-tier PDFs.

Same M2 cycle should land both of Axis's open items (this one + the
"plus" external-PDF check above — operator confirmation needed on
whether the `_plus_` files duplicate Page 2/3 of the main PDF or carry
additional data the main PDF doesn't have).

---

## tamilnad-mercantile-bank-limited

**Captured 2026-05-20:** `dom=0, nre=0, nro=0, fcnr=0` (no auto-remedy)

**Bank-domains note:** *"ASP.NET with Bootstrap 5.3.3, server-rendered HTML
with JS h..."*

**Symptom across 3 attempts:** Playwright + fetch_url against
`tmb.bank.in/pages/deposit-interest-rates` succeed but extract 0 slabs.
The agent attempted `fetch_pdf` on `tmb.bank.in/assets/images/...jpg` —
the rate card is published as a **JPEG image**, not extractable from HTML
or PDF. 5 web_search calls in attempt 1 ($0.99 + $1.13 + $0.27) trying to
find an alternative source.

**Likely root cause:** TMB embeds rates as a single image on the page.
This is genuinely outside the agent's capability without an OCR path.

**Suggested next steps:** Manual transcription of the image, OR an OCR
extraction pass added to the pipeline (separate engineering task).

---

## dcb-bank-limited

**Captured 2026-05-20:** `dom=17, nre=0, nro=0, fcnr=0` (DOM-only)

**Bank-domains note:** Not explicitly listed.

**Symptom across 3 attempts:** Playwright + fetch_url both succeeded on
`dcb.bank.in/rates/fixed-deposit-interest-rate` and the NRI page. The
agent wrote files — but the NRI files came back empty. Domestic extracted
17 slabs cleanly. Total burn: $1.04 + $0.39 + $0.55 = $1.98 across attempts.

**Likely root cause:** Extraction quality issue on DCB's NRI page —
likely a non-table rate layout (divs/cards) that the extractor's table-
heuristic doesn't recognise as rate data.

**Suggested next steps:**
1. Inspect DCB's NRI page (https://dcb.bank.in/rates/nri-interest-rates)
   manually — figure out the actual DOM structure of the rate table.
2. If it's a non-table layout, add a per-bank selector hint in
   `bank-domains.json` (e.g., `rate_selector: ".nri-rates-card"`) and
   patch the agent prompt to honor it. Separate engineering task.

---

## hdfc-bank-limited

**Captured 2026-05-20:** `dom=0, nre=0, nro=0, fcnr=0`. Single override
attempt applied (stealth + skip[selects,tabs] + 180s); see "rerun results"
section if newer data lands.

**Bank-domains note:** *"AEM/server-rendered with JS hydration, CloudFront
WAF — bloc..."*

**Symptom across 3 PVB-run attempts:** 9 successful Playwright calls
across 4 URLs (domestic, NRE, NRO, FCNR) per attempt × 3 attempts = 27
successful page renders, all returning 0 slabs. Total burn: $0.87 × 3 ≈ $2.62.

**Likely root cause:** HDFC's pages render fine (CloudFront WAF permits
headless browsers with proper Accept/UA headers) but the rate data is in
modern React components — possibly inside shadow DOM, possibly behind a
"Show Rates" interaction that needs explicit clicking. The default
Playwright table-extraction heuristic finds nothing.

**Suggested next steps:**
1. Manually navigate https://hdfc.bank.in/fixed-deposit/fd-interest-rate
   in a browser. Inspect element on a rate to determine the DOM path.
2. Add a per-bank `rate_selector` (or specific Playwright interaction
   like "click 'View Rates' button before extract") — separate
   engineering work.
3. HDFC is too high-profile to ship without; ideally fixed in the next
   sprint before the PM rate-pack delivery.

### Status update — Orch-1 (sprint-004 2026-05-21) — domestic resolved

The Orch-1 multi-table extraction (commit pending, design at
[`../design/orch1-multi-table-extraction.md`](../design/orch1-multi-table-extraction.md))
closed the domestic side of this issue. HDFC's `/fixed-deposit/fd-interest-rate`
page renders 8 `<table>` elements; 2 carry rate data (`< ₹3 Crore` and
`≥ ₹3 Crore To < ₹5 Crores`), 6 are textual content (premature-withdrawal
terms, definitions, NRI notes, etc.). The new accumulator keeps both rate
tables and labels each with the correct `deposit_range` from the header
row's text.

- **Before Orch-1**: 19 domestic slabs (only `< 3 cr` table extracted),
  no `deposit_range` tagging
- **After Orch-1**: **34 domestic slabs** (19 `below_3cr` + 15 `3cr_to_5cr`),
  senior column populated, all sourced from `hdfc.bank.in` directly
- Cost: $0.014 (one LLM-fallback call inside `extract_html_table` for
  ambiguous chunks — the rest is Cheerio Path A)

### Status update — Orch-1 — NRE / NRO / FCNR STILL aggregator-sourced (Orch-2 work)

The operator's note 2026-05-21 confirmed that HDFC's NRE and NRO rates
are identical to the domestic rates and live on the same
`/fixed-deposit/fd-interest-rate` page. Closing the NRE/NRO/FCNR
side requires extending `bank-domains.json` with an `extraction.fd`
block of `type: "html"` and `fulfills_product: ["fd", "fd_nre", "fd_nro"]`
— a direct HTML analog of M2.6's PDF mechanism. **This is scope for
Orch-2.** Until Orch-2 lands:

- `hdfc-bank-limited_nre_rates.json` — 12 slabs, sbnri.com aggregator,
  scraped 2026-03-30 (2 months stale, violates the "no aggregators"
  project rule)
- `hdfc-bank-limited_nro_rates.json` — 19 slabs, same caveat
- `hdfc-bank-limited_fcnr_rates.json` — 24 slabs, same caveat

Operator decision pending: keep the stale aggregator data while Orch-2
ships, or remove the three files now and ship HDFC with domestic-only
until the official NRE/NRO/FCNR extraction works end-to-end.

---

## idfc-first-bank-limited

**Captured 2026-05-20:** `dom=15, nre=0, nro=0, fcnr=20` (partial_silent on
NRE/NRO)

**Symptom:** 3 attempts × 9 successful Playwright calls × 4 URLs each.
Domestic + FCNR extracted cleanly. NRE and NRO files written but with 0
slabs. Total burn: $0.59 × 3 + $0.91 ≈ $2.66.

**Likely root cause:** Extraction quality issue specific to IDFC First's
NRE/NRO pages — possibly the slab structure differs from the domestic /
FCNR layout the extractor recognises.

**Suggested next steps:** Same as DCB — add per-bank selector hint.

---

## jammu-kashmir-bank-limited

**Captured 2026-05-20:** `dom=13, nre=0, nro=0, fcnr=0` (NRI fully missing)

**Symptom:** All 4 URLs (domestic + NRE + NRO + FCNR) fetched successfully
via fetch_url across 3 attempts, but NRI files came back empty. Domestic
extracted cleanly.

**Suggested next steps:** Visit JKB's NRI pages manually:
- https://jkb.bank.in/deposits/nre-fixed-deposits
- https://jkb.bank.in/deposits/nro-fixed-deposits
- https://jkb.bank.in/deposits/foreign-currency-non-resident-banks-fcnr-b

If rate data IS published on these pages: likely the same selector-hint
fix as DCB / IDFC First. If pages just talk about NRI products without
publishing rates: opt-out via expected-slab-floors.json.

---

## nainital-bank-limited

**Captured 2026-05-20:** `dom=14, nre=0, nro=0, fcnr=0`

**Symptom:** Nainital Bank is a small bank serving primarily the
Uttarakhand region. Domestic FD extracted via ASP.NET page
(`/english/interest_rate.aspx`). NRI rate pages were searched for via 5
web_search calls in attempt 2 ($3.08 burn alone!) but nothing concrete
found.

**Suggested next steps:** Verify whether Nainital Bank offers retail NRI
products at all. If yes → manual rate entry. If no → opt out via
expected-slab-floors.json for `nre`, `nro`, `fcnr` (set to 0).

---

## SSCB cohort failures (2026-05-20)

24 banks collected; 18 ✓ fully extracted, **6 ZERO** for distinct reasons.
None had an auto-remedy I could apply (failure modes are PDF-extraction
quality, HTML-without-structured-tables, or network blocks — not the
stealth/skip class). All 6 are listed here for manual verification.

| Bank | Domain | Symptom | Likely fix |
|---|---|---|---|
| the-delhi-state-co-operative-bank-ltd | `dscb.in` | 3 guessed PDF URLs all 4xx; bank may publish rates on HTML page or different PDF path | Browse `dscb.in` manually, find the correct rate page or PDF, update `bank-domains.json#rate_pages.fd` |
| the-odisha-state-co-operative-bank-ltd | `odishascb.bank.in` | `fetch_pdf` succeeded on `data/2026/Deposit Rate-06-11-2023.pdf` but extracted 0 slabs across 3 attempts | PDF parser can't read this format; manual transcription OR add OCR fallback path (separate engineering) |
| the-sikkim-state-co-operative-bank-ltd | `sisco.bank.in` | Playwright rendered `/products/deposits` cleanly (20s, 3 attempts) but 0 slabs extracted | Visit the page in a browser — confirm whether rates are actually published there. If yes: per-bank selector hint. If rates elsewhere: update `fd` URL. |
| the-telangana-state-cooperative-apex-bank-ltd | `tgcab.bank.in` | All `fetch_url` return ERR in 97-395ms across 3 attempts on multiple URLs (root, www., /deposits/fixed-deposit) | Domain may be down / blocking. Probe with `curl` from a residential IP; if still down, mark `site_unreachable` in `bank-domains.json` |
| the-tamil-nadu-state-apex-co-operative-bank-ltd | `tnsc.bank.in` | `fetch_url` ok on `/interest-rates/` and `/` across 3 attempts (one slow 30s initial); 0 slabs extracted | Pages exist but extractor finds no rate data. Likely no structured rate tables — manual inspection needed |
| the-rajasthan-state-co-operative-bank-ltd | `rscb.bank.in` | `fetch_pdf` succeeded on `Content/pdf/fdr-3141b63.pdf` across 3 attempts; 0 slabs extracted | Same PDF parser limitation as Odisha; manual transcription or OCR engineering |

**Cross-cutting observation:** Co-operative apex banks often publish
rates as image-based PDFs (scanned bank circulars) which `pdf-parse`
(text extraction) can't read. A separate Sprint task to add an OCR
fallback (Tesseract or Azure Document Intelligence) would unlock several
of these categories at once.

---

## SFB cohort failures (2026-05-20)

11 SFB banks collected; 6 ✓ fully extracted (for variants the SFB
is expected to produce — only AU/Equitas/Ujjivan are in the `LARGE_SFBS`
NRI-eligible set), 5 partial/zero.

| Bank | Captured | Symptom | Likely fix |
|---|---|---|---|
| suryoday-small-finance-bank-limited | 0 / 0 / 0 / 0 | All `fetch_url` ERR in 39-295ms across 3 attempts; Playwright succeeded once (34s) but extracted 0 slabs | Try stealth for HTTP path; manually check `suryoday.bank.in` rate page actually publishes structured rates |
| equitas-small-finance-bank-limited | 0 / 0 / 0 / 0 | LARGE SFB. Playwright OK on FD and NRI pages (each took 26s + 117s for FCNR), but `fetch_pdf` ERR on `equitas.bank.in/strapi-dev/uploads/Overall_Interest_Rates_1_f80c5a5...` across all 3 attempts | Strapi CMS PDF path is content-hashed and may rotate; locate the current PDF URL manually, update `bank-domains.json` |
| unity-small-finance-bank-limited | 0 / 0 / 0 / 0 | `fetch_pdf` ERR on `/docs/policies/website-disclosure-*.pdf`; Playwright OK on `/personal-banking/deposits/fixed-deposit` but extracted 0 slabs | Rates likely only in the inaccessible PDF disclosure; check whether HTML page has structured rates or it's all in the PDF |
| au-small-finance-bank-limited | 12 / 0 / 0 / 25 | LARGE SFB. Domestic + FCNR extracted cleanly. NRE and NRO never visited — the agent only used `/interest-rates/fixed-deposit-interest-rates` and `/interest-rates/au-fcnr`; no NRE/NRO URLs in `bank-domains.json#rate_pages` for AU | Find AU's separate NRE/NRO rate pages (likely under `/nri-banking/...`), add to `bank-domains.json`, rerun |
| ujjivan-small-finance-bank-limited | 10 / 5 / 10 / 0 | LARGE SFB. Domestic + NRE + NRO extracted via fetch_url; FCNR PDF (`ROI-for-FCNR-B-deposits...`) fetched OK each time but 0 slabs — same PDF-parser limitation as Odisha/Rajasthan SSCB | OCR fallback (cross-category eng task) or manual transcription |

**M1 re-run 2026-05-21 follow-ups for Ujjivan SFB:**
- Operator hit a likely IP-block while verifying `https://ujjivansfb.bank.in/support-interest-rates` from their main device (could only access from a second device). The bank's WAF may be flagging repeat fetches from the same egress as bot traffic. **Resolution**: operator will provide an alternate canonical FD URL for the registry. Until then, do not re-run Ujjivan from this environment.
- FCNR PDF (USD-only) returned 0 slabs at extraction (no text content) — needs operator to inspect the PDF and report whether it's an image card (M3 OCR) or a placeholder document.
- Registry currently lists only `/sites/default/files/2025-12/ROI-for-FCNR-B-deposits-USD.pdf` for FCNR. Ujjivan likely publishes separate per-currency PDFs (GBP/EUR/JPY/CAD/AUD) — the prior floor of 6 suggests the previous run found multiple currencies. Locate sibling PDFs in `/sites/default/files/2025-12/` and add to registry.
- NRO file currently lacks senior column (warning says Ujjivan has no senior premium on NRO). Operator should cross-check on a fresh browser session whether this is bank policy or extraction miss.

Cross-cutting: 2 of 5 SFB failures are the same image-PDF / Strapi-CMS-PDF
problem class. The OCR fallback engineering task would unlock 4 of these
(Equitas, Unity, Ujjivan-FCNR, Odisha, Rajasthan) at once.

---

## IFSC/IBU cohort failures (2026-05-20)

37 IBU (IFSC Banking Unit) banks collected; only 9 produced any rates
(4 ✓ clean, 5 ⚠ partial_silent). **28 of 37 returned ZERO.**

| Successful (gift slabs extracted) | Captured |
|---|---|
| bank-of-baroda-ibu | 45 |
| canara-bank-ibu | 32 |
| idbi-bank-ibu | 48 |
| state-bank-of-india-ibu | 16 |
| punjab-national-bank-ibu (PS) | 10 |
| kotak-mahindra-bank-ibu (PS) | 55 |
| rbl-bank-ibu (PS) | 60 |
| standard-chartered-bank-ibu (PS) | 8 |
| indian-bank-ibu (PS) | 7 |

**Root cause (cohort-wide):** IBU rate pages live under each parent
bank's IFSC/GIFT-City subsite, not at a predictable path on
`<bank>.bank.in`. `bank-domains.json#rate_pages.fd_gift` is `null` for all
28 zero-extract IBUs (and several are explicitly tagged
`scraper_type: "manual"`), which means the agent has to *discover* the
right URL via web_search — and for most foreign-bank IBUs (HSBC,
JPMorgan, Citi, DBS, Deutsche, BNP Paribas, Mizuho, MUFG, Standard
Chartered's-not-already-found-page, SocGen, etc.) the discovery doesn't
land on the right page within the agent's tool-call budget.

**Suggested next steps (operator + engineering):**
1. Bulk-populate `bank-domains.json#rate_pages.fd_gift` for the 28
   missing IBUs. The IBU rate page URL pattern varies per parent bank
   but most live under one of:
   - `<parent>.bank.in/gift-ifsc/` or `/ifsc-banking/`
   - The parent's `.co.in` or international domain under
     `/global-banking/india/ifsc-...`
   - A dedicated `<parent-bank>-gift.com` microsite
2. Consider also: parent-bank lookup helper — `bank-domains.json`
   already has `parent_bank_code` for several IBUs; the discovery could
   programmatically navigate from parent's homepage to the IFSC
   subsection rather than guessing URLs.
3. Many foreign-bank IBUs may have **never published rates publicly**
   (institutional product). Confirm-then-mark as `wholesale_only` skip
   status.

Cost burn for this cohort: spotty — successful IBU runs averaged $0.2-0.4
each; the 28 zeros mostly burned $0.05-0.1 each on failed discovery
attempts. Total ≈ $10.

**Decision:** No autonomous remediation for the 28 zeros — URL
population is operator work. The 5 partial_silent banks are listed in
the top-of-doc quick-index and ship under their PS markers (data IS
present, drift fired vs prior baseline).

---

## Foreign Bank cohort failures (2026-05-20)

44 Foreign Banks collected. **26 ZERO** (59%), 7 PS, 4 DOM-only, 7 ✓.

**Successful (full or near-full extraction):** Bank of Bahrain & Kuwait,
Bank of Ceylon, Deutsche Bank AG, Doha Bank, Emirates NBD, HSBC, SBM Bank
India.

**ZERO category — most are likely wholesale-only / institutional:**
ANZ, Bank of America, Amex, BoNS, Rabobank, CACIB, Citibank N.A., CTBC,
DBS Bank India, Barclays, FirstRand, IBK, JSC VTB, FAB, KEB Hana,
Kookmin, JPM, MUFG, Maybank, NongHyup, SocGen, SMBC, StanChart, UOB,
Woori, UBS. These are predominantly B2B / corporate banking arms with
no retail deposit product publicly listed.

**Suggested next steps:**
1. Categorise each of the 26 zeros as one of:
   - `wholesale_only` → mark skip status in `bank-domains.json`, exclude
     from pack permanently.
   - `retail_but_blocked` (e.g., DBS Treasures India has retail rates but
     the discovery missed the URL) → manual URL population.
2. Several of the foreign-bank IBU equivalents may share rate pages
   with their main FB entry — cross-reference with IFSC findings above.

**PS markers (data IS present, drifted vs prior floor):** AB Bank, BoC,
BNP, ICBC (91 dom!), Mashreq, Mizuho, Sonali. Verify floors are still
realistic.

**DOM-only (no NRI):** NatWest, Sberbank, Shinhan, QNB — likely no
retail NRI product in India.

Cost burn ≈ $5-10 (mostly failed discovery on the 26 zeros).

---

## Known engineering issue — IBU file naming vs drift gate

**Observation during IFSC tally:** The IBU agent writes `variant: "gift"`
slabs to `<bank>_rates.json` (the default rates file), NOT to
`<bank>_gift_rates.json`. But `lib/tier-router.js#checkQuality` uses:

```js
const variantSuffixes = { regular: "", nre: "_nre", nro: "_nro", fcnr: "_fcnr", gift: "_gift" };
```

For IBU banks, drift gate looks at `_gift_rates.json` (which doesn't
exist) → finds 0 slabs → fires drift on `gift` even when 16+ slabs are
present in `_rates.json`. This is why several IBUs (PNB-ibu,
Kotak-ibu, RBL-ibu, StanChart-ibu, Indian-Bank-ibu) carry PS markers
despite having data.

**Two possible fixes:**
1. Update IBU agent prompt to write to `<bank>_gift_rates.json` (matches
   the per-variant convention).
2. Or update drift gate to recognise IBU banks and read from
   `<bank>_rates.json` when variant=gift.

Option 1 is cleaner (file-per-variant convention). Either way it's a
separate engineering task; flagged here so the PS markers on the 5
listed IBUs aren't treated as data-quality issues.

---

## SUCB cohort failures (2026-05-20)

52 SUCBs collected; **43 ✓ fully extracted (83%)**, 9 zero.

| Bank | Symptom |
|---|---|
| ahmedabad-mercantile-co-op-bank-ltd | All fetch_url ERR fast — `amco.bank.in` blocking IP or down |
| rajkot-nagrik-sahakari-bank-ltd | fetch_url OK, 0 slabs extracted (page has no structured rate data) |
| indian-mercantile-co-operative-bank-ltd | check log; likely same class |
| janakalyan-sahakari-bank-ltd-mumbai | check log; likely same class |
| janalaxmi-co-operative-bank-ltd-nashik | check log; likely same class |
| ahmednagar-merchants-co-operative-bank-ltd-ahmednagar | check log; likely same class |
| nagpur-nagrik-sahakari-bank-ltd | `nnsbank.co.in` all fetch_url ERR (879-3014ms) — domain may be down |
| shamrao-vithal-co-operative-bank-ltd | Playwright 120s timeout on JS-heavy page; fetch_url OK but 0 slabs |
| the-akola-urban-co-operative-bank-ltd-akola | check log; likely same class |

All 9 fall into one of the known SUCB/SSCB classes already documented:
domain block, no-structured-rates, image-based PDF, or JS timeout.
None have an obvious auto-remedy not already attempted at the cohort
level. Operator follow-up per the strategies in the SSCB section above.

---

## RRB cohort failures (2026-05-20)

28 RRBs collected; **16 ✓ (57%)**, 12 zero. RRBs (Regional Rural Banks)
post-state-mergers tend to have minimal web presence — many don't
publish rates on a public site at all, or use parent-bank infrastructure.

Zero-extract banks (all need operator verification of whether rates are
published anywhere on the public web):

- arunachal-pradesh-rural-bank
- assam-gramin-bank
- chhattisgarh-gramin-bank
- himachal-pradesh-gramin-bank
- madhya-pradesh-gramin-bank
- mizoram-rural-bank
- nagaland-rural-bank
- odisha-grameen-bank
- tamil-nadu-grama-bank
- uttarakhand-gramin-bank
- tripura-gramin-bank
- uttar-pradesh-gramin-bank

**Likely outcome for RRBs:** several of these may simply not publish FD
rates online (many small RRBs operate primarily via branch-walk-in for
deposits). Mark with `rates_not_published` skip status after
verification, exclude from pack.

---

## NSSCB cohort failures (2026-05-20)

10 NSSCBs collected; **7 ✓ (70%)**, 3 zero. Same minimal-web-presence
pattern as RRBs / smaller SSCBs.

Zero-extract: the-manipur-state-co-operative-bank-ltd,
jharkhand-state-co-operative-bank-ltd,
the-jammu-and-kashmir-state-co-operative-bank-ltd. Operator follow-up
per the SSCB/RRB strategies above.

---

## DCCB cohort failures (2026-05-20)

130 DCCBs collected; **86 ✓ (66%)**, 44 zero. DCCBs (District Central
Co-op Banks) are small district-level institutions; web presence and
rate publication quality varies enormously across states.

Full zero-bank list dumped to the run dir for operator reference:
`output/runs/2026-05-20T<timestamp>_district-central-co-operative-bank/_zero_banks.txt`.

**Recommended triage approach (operator):**
1. Sort the 44 zeros by state — DCCBs in states with strong
   apex-bank infrastructure (e.g., Maharashtra, Gujarat, Karnataka) are
   more likely to have a working public rate page that the agent missed.
2. For states where many DCCBs are zero (e.g., Andhra Pradesh / Bihar /
   Punjab if pattern holds), check whether the apex bank publishes a
   common rate card that all DCCBs in the state share. If so, populate
   `bank-domains.json` for that state's DCCBs with the apex URL.
3. The remaining truly-unpublished DCCBs should be marked
   `rates_not_published` skip status — they're branch-walk-in only.

Cost burn ≈ $15-25 (130 × ~$0.10-0.20 avg).

---

## NSUCB cohort failures (2026-05-21)

132 NSUCBs collected; **76 ✓ (58%)**, 56 zero. NSUCBs are typically very
small urban co-ops; many have no public web presence at all, others
have basic websites without published rate data.

Zero list dumped to:
`output/runs/2026-05-21T0207_non-scheduled-urban-co-operative-bank/_zero_banks.txt`
(generated post-tally).

Same triage approach as DCCB / RRB:
- group by state for any shared apex-bank rate cards
- mark `rates_not_published` skip status for branch-walk-in-only banks
  after operator confirmation

---

## Financial Institution cohort (2026-05-21)

4 of 4 ZERO: National Housing Bank (NHB), EXIM Bank, NABARD, SIDBI.

**Root cause:** all four are development / refinancing banks operating
under separate statutes. They don't offer retail FD products to the
public; their deposit products are interbank/wholesale only. No public
rate cards exist.

**Suggested action:** Mark all 4 with `no_retail_deposits` skip status
in `bank-domains.json` and exclude from `pack/build-pack.js` output
permanently. They were included in the PM cohort but should not be in
a retail-pack.

---

## Operator log

Add a row when an item is verified.

| Date | Bank | Verified by | Outcome (opt-out / URL added / other) |
|------|------|-------------|----------------------------------------|
| 2026-05-21 | hdfc-bank-limited | Orch-2 (engine fix) | NRE + NRO closed via HTML `fulfills_product` hint + section-heading rule scan. NRE 18 slabs (all ≥1y, senior null), NRO 34 slabs (senior null), both sourced from `hdfc.bank.in/fixed-deposit/fd-interest-rate`. Domestic 34 (Orch-1). FCNR still aggregator-sourced (24, separate page schema — follow-up). See `engine-fixes-orch2.md`. |

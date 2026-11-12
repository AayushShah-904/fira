# Sprint 007 — Tier-1 / Tier-2 Coverage Progress

**Date:** 2026-05-25
**Goal:** Land the 500-bank cohort (`data/cohorts/pm-refresh-2026-q2.json`, 513 banks) — "most banks land well, especially the top 100 (public, private, scheduled, GIFT-IBU, etc.) without manual intervention." Reviews may be done by Claude itself.
**Branch:** `azure-openai-agent` (monorepo `fixed-income-yield-advisor`). Commits: `5f520ee → 0140055`.

---

## 1. Strategy: the two-tier model (operator-chosen)

| Tier | Engine | Role |
|------|--------|------|
| **Tier 1** | `scripts/bulk-author.js` — automated: fetch → fingerprint → LLM-propose → deterministic extract (`_generic-html-3col` / PDF extractors) → quality-gate → auto-persist PASS as a **re-runnable template** | The scalable default. Gates do the trust work; every persist is audit-tagged and revertable (`bulk-revert.js`). |
| **Tier 2** | **Claude-powered** — Claude's own fetch (Playwright `--intercept`, WebFetch, WebSearch discovery) + flexible LLM parsing, writing rate data directly | Fallback for the important banks (PSB/PVB/Scheduled/SFB/GIFT-IBU) where Tier-1's rigid table-based extraction fails. This is the original April-15 methodology. |

Key principle that emerged: **most "hard" banks were not Claude-only — they were fixable Tier-1 defects** (wrong URLs, JS not rendered, multi-table under-extraction, currency columns dropped, PDF wiring bugs). Tier-2 is reserved for the genuine residue (JS-XHR SPAs, image rate cards, non-public pages).

---

## 2. Tier-1: capabilities built / fixed this sprint

All landed in `bulk-author.js` + supporting libs, each with tests and golden/regression validation.

1. **`challenge_detect` false-positive fix** — the bare `/cloudflare/i` matched `cdnjs.cloudflare.com` in `<script src>` tags, flagging 72 legitimate bank pages as WAF-blocked. Tightened to block-page-specific markers. Recovered ~37 banks immediately.
2. **`www`-host self-heal** — registry stored many `.bank.in` URLs on the bare host, which serves a ~6.6 KB JS-redirect shell (just over the 5 KB thin-body threshold → reported as "success" with no table). On a tableless fetch, `bulk-author` now retries the host-toggled variant and **persists the corrected URL**. (federal/iob/indusind + others.)
3. **Aggressive-fetch default** — the library fetch path only expanded accordions / waited for network-idle when `template.fetch` set those flags; gap banks had none. Now templateless banks get `{expand_accordions, wait_for_network_idle, settle_window_ms:2500}` by default. (karur-vysya, yes-bank.)
4. **`--from-report` targeting** (operator directive: stop re-running the full cohort) — re-runs only the prior report's FAIL/REVIEW, skipping permanently-dead buckets (WAF, missing-URL). Shared classifier `scripts/utils/classify-verdict.js` used by both `bulk-author` and `bulk-triage`.
5. **Gate-plumbing bug fix** — `processOne` called `evaluateGates(slabs, baseline)` **without `opts.gates`**, so `--min-slabs` / `--rate-max-pct` / variant gate overrides were silently no-ops. Now threaded through.
6. **GIFT/FCNR currency cross-product** (two extractors):
   - HTML (`_generic-html-3col`): `field@deposit_range#CURRENCY` column tags, per-currency grouping/coalescing, currency-aware 0.01 rate floor. Domestic path byte-identical (no `currency` key added).
   - DocIntel PDF (`ibu-static-pdf-quarterly.extractFromDocIntel`): `detectCurrencyColumns` scans header cells for ISO codes; emits one slab per (tenure × currency). Back-compat single-`generalCol` path retained.
7. **PDF path wired into `bulk-author`** + **two bug fixes** that were silently killing it:
   - Marker mismatch: `fetch_pdf` searched `JSON_OUTPUT:` but `extract_rates_pdf.mjs` emits `=== JSON_OUTPUT ===` → the `.mjs`'s parsed `rate_slabs` were discarded.
   - Binary corruption: PDF downloaded as text (`toString('utf-8')`) not buffer → mangled bytes (citibank 166 KB → 278 KB) → pdfjs parsed 0.
   - `processPdf` now uses structured `.mjs` slabs for regular/nre/nro; gift/fcnr fallback uses them + `detectCurrencyFromSources` when the DocIntel extractor yields 0.
8. **#18 Multi-table propose** — propose now emits one extract block per *distinct FD/term-deposit* rate table (bulk/amount-tier/callable), guardrailed to exclude savings/RD/loan/MCLR/fees and NRE/NRO/FCNR-when-regular; candidate limit 6→12. Goldens **bank-of-baroda (0→26)** and **hdfc-bank-limited (0→34)** flipped FAIL→PASS (suite 3 fails → 1).
9. **`baseline_drop` → informational** — April baselines predate currency support / multi-table fixes and are stale/inflated, so a `baseline_drop` is noise. Moved from verdict-affecting `warnings` to a `notes` channel; a bank whose only signal is `baseline_drop` now PASSes. All other warnings still gate.

**Known Tier-1 limit:** gpt-4.1 (temp 0) will not split overlapping special-tenure tables (esaf/emirates stay one block even with the strengthened prompt). The reliable lever is an operator-authored `extracts[]` (same mechanism the goldens use via `tests/golden-html/<bank>.expected.extract.json`).

---

## 3. Tier-2: Claude-powered retrieval

**Architecture:** 4 parallel `general-purpose` sub-agents (SFB+PVB / SSCB / SUCB / IBU-gift), each running the full discovery loop per bank — Playwright render + `--intercept` (XHR), WebFetch, WebSearch for the correct/current URL, `extract_rates_pdf.mjs` for PDFs, vision OCR for images — then parsing rates with its own judgment. Independent files (no write race), output to a dedicated `output/tier2/` dir.

**Result: 25 of 40 retrieved (485 slabs)** that Tier-1 had scored 0 on:

| Group | Recovered | Slabs |
|-------|-----------|-------|
| SFB + PVB | 6/6 (incl. **suryoday, axis**) | 99 |
| Scheduled State Co-op | 9/11 | 92 |
| Scheduled Urban Co-op | 6/11 | 115 |
| IBU GIFT | 4/12 | 179 |

**Methods that beat the rigid pipeline:**
- **XHR-API replication** — dcb (`POST /api/api-interceptor`), icici-ibu (giftcity JSON API).
- **Div-dropdown drive** — suryoday (Gatsby; rates rendered one tenure at a time client-side).
- **Bot-wall PDF via cookie warm-up** — axis (date-rotating domestic PDF behind anti-bot).
- **Div-tables (`.satable`, not `<table>`)** — rbl-ibu.
- **Vision OCR** — tamil-nadu-apex (rates published as JPG).
- **Legacy-TLS node GET** — madhya-pradesh (`--tls-cipher-list=DEFAULT@SECLEVEL=0`; Playwright/normal GET fail).
- **Multi-currency PDF parse** — federal-ibu (dual-tenure-column, 6 currencies).
- **URL discovery via WebSearch** — many co-ops had stale/migrated domains.

**15 genuine dead-ends (no fabrication — empty `rate_slabs` + explanatory warning):**
- Image-only rate cards needing OCR: rajkot, janalaxmi (also domain-migrated).
- Bot-blocked / empty / broken sites: amanath, bombay-mercantile (403), indian-mercantile (empty template), delhi-state (no rate page), sikkim (broken SPA).
- 8 IBUs: wholesale-only / quote-on-request (barclays, bnp, deutsche, mashreq, societe-generale), not-yet-launched (bank-of-maharashtra), INR-only (smbc), 404 (canara).

### 3.1 Metadata model for Tier-2 banks

Registry entry (`data/bank-domains.json`):
- `rate_pages.fd` / `fd_gift` → the **verified working URL** (21 stale URLs corrected from Tier-2 discoveries).
- `scraper_type` → `html_js` / `pdf` / `manual` (image).
- `extraction_method` → from the **CURATED** set in `lib/extraction-methods.js` (`manual_transcription_from_rendered_text` / `manual_pdf_transcription` / `manual_image_transcription`). CURATED = **auto-overwrite-protected**: a future failing *automatic* run cannot clobber Claude-curated data.
- `tier2{ sourced_at, run_method:'tier-2', tier2_method, source_url, slab_count, hints }` — `hints` records **how to re-fetch** (API endpoint, CSS selector, dropdown-drive, OCR, TLS workaround, PDF layout).

Rate files (`output/latest/<slug>_rates.json`):
- Promoted from `output/tier2/` with `discovery_metadata{ run_method:'tier-2', discovery:'claude_fetch_llm_parse', tier2_method, extraction_method, sourced_at }`.
- **Clobber-protected:** if an existing `output/latest` file had more slabs (axis 324, dcb 47, haryana 30, equitas 23, MP 11, uttarakhand 14, bharati 9, nainital 16), it was preserved and the Tier-2 data written as `<slug>_rates.tier2.json` for review.

### 3.2 Tier-2 → Tier-1 conversions

Applying the 21 corrected URLs and re-running the deterministic pipeline **converted 5 banks to auto-refresh templates**: utkarsh, the-maharashtra-state-co-operative-bank, sangli-urban, nagpur-nagrik (regular) and mizuho-ibu (PDF). The remaining 20 stay Tier-2-curated (JS-XHR/image/odd layouts the rigid pipeline still can't read).

---

## 4. Coverage outcome (500-bank cohort, 513 banks)

| Metric | Sprint-006 handoff | End of Sprint-007 (2026-05-25) |
|--------|--------------------|--------------------------------|
| Banks with rate data (template OR Tier-2) | ~101 (47% of top-tier 217) | **170/513 (33%)** |
| — auto-refresh templates | 101 | **150** |
| — Tier-2 curated data | 0 | **20** |
| **Tier-1 priority (PSB/PVB/Scheduled/SFB/IBU)** | 59% | **130/157 (83%)** |

Tier-1 priority by category (templates + Tier-2 data):
- Public Sector: 12/12 (100%)
- Private Sector: 18/21 templated + axis/dcb/nainital Tier-2 data → effectively complete except where genuinely image/JS
- Small Finance: 8/11 templated + equitas/suryoday Tier-2
- Scheduled Urban Co-op: 41/52 + Tier-2 adds several
- Scheduled State Co-op: 13/24 + 9 Tier-2
- IBU/GIFT: 13/37 templated + federal/icici/rbl Tier-2 (Indian IBUs that publish rates are largely covered)

---

## 5. Remaining gaps — capability roadmap

The automated + Tier-2 ceiling is reached for current capabilities. The residue is capability-gated, not effort-gated:

1. **OCR pipeline** (image rate cards): rajkot, janalaxmi + any future scanned co-ops. `lib/actions/extract_via_ocr.js` exists; the TN proof shows vision OCR works — generalize it.
2. **JS-XHR generalization**: many SSCB/SUCB SPAs render rates via XHR/JSON the deterministic pipeline can't see. Tier-2 captures them per-bank; wiring `--intercept` into the bulk fetch + an XHR-JSON extractor would templatize a class of them.
3. **Operator-authored `extracts[]`** for overlapping-table banks the LLM won't split: esaf, emirates, icici-ibu (long-tenure table).
4. **Non-public IBUs** (8): wholesale-only / quote-on-request — out of scope (no public rate card exists).
5. **Co-op long tail** (DCCB 130 + NSUCB 132, ~2% covered) — deprioritized below Tier-1 per operator; `.bank.in` co-op family is the highest-leverage extractor target (~100 banks per extractor).

---

## 6. Data-integrity guarantees

- **Anti-fabrication enforced** at the gate (strict traceability): every persisted slab traces to source text. Tier-2 agents instructed to write empty `rate_slabs` + warning rather than invent numbers; 15 dead-ends honored this.
- Tier-2 data is **CURATED-method tagged** → protected from automatic-run overwrite.
- All registry writes via `safeWriteArtifact` (atomic, ADR-012); operator-curated and Tier-2 entries distinguished from `bulk-author` via `template.audit.persisted_by` / `extraction_method`.

---

## 7. Commit ledger (this sprint)

- `5f520ee` GIFT/FCNR currency extraction, www self-heal, `--from-report`
- `6dea259` city-union constrained TD template
- `e5dda09` wire PDF path into bulk-author
- `6b14b44` fix PDF path (marker + buffer) — 9 text-PDF banks
- `4a989ed` DocIntel currency-matrix — hdfc/idfc-ibu
- `d051d96` gift-PDF slab fallback + currency tagging — axis-ibu
- `5e57f2e` #18 multi-table propose + baseline informational; persist 12
- `0140055` Tier-2 Claude retrieval — 25 banks, metadata + rate files folded
- `0ccd3f7` this SDLC doc + 500-bank cohort

---

## 8. FCNR variant + multi-variant template model (#19)

**Context:** FCNR (Foreign Currency Non-Resident) deposits are foreign-currency (USD/GBP/EUR/JPY/…), offered by PSB / PVB / Foreign Banks. They became extractable via the §2.6 currency cross-product (`field@range#CURRENCY` HTML tags + DocIntel currency-matrix + the gift/fcnr gate: `rate_min 0`, no senior premium). Cohort: `data/cohorts/fcnr.json` — **63 banks** with an `fd_fcnr` / `fd_nri_combined` URL (21 PVB, 15 FB, 12 PSB, 5 SFB, 2 SUCB, 8 outside the 500-cohort; 3 PDFs).

**Data-model problem found:** `bulk-author` persists **one `template` per bank** (`registry[slug] = {...entry, template:{...block}}`). Running `--variant fcnr --force` on a bank that already had a *domestic* template would **clobber** it — and ~40 of the 63 (all PSB, most PVB/SFB) have both domestic + FCNR products.

**Design — multi-variant template persistence:**
- New helper `targetTemplateKey(entry, variant)`: routes a `gift`/`fcnr` result to `entry.template_<variant>` **only when a domestic `regular` template already exists** (`entry.template.variants.regular && !entry.template.variants[variant]`); otherwise to `entry.template`.
- Effect: gift-only IBUs and fcnr-primary foreign banks (no domestic template) keep their config in `template`; banks with both keep domestic in `template` and get `template_fcnr` / `template_gift` alongside — **no clobber**.
- The persisted block's `variants` map is set to the variant being authored (not inherited from the domestic `{regular}` map).
- `bulk-revert.js` extended to also recognise/revert `template_gift` / `template_fcnr` blocks tagged `persisted_by:'bulk-author'`.

**Runtime note (follow-up):** the runtime scraper / dispatcher currently reads only `entry.template`. Reading `template_fcnr` / `template_gift` is a separate runtime change; persisting them now captures the **validated** FCNR config non-destructively and records that FCNR extraction works, ahead of that integration.

**Result (2026-05-25, DONE — commit `d7508fd`):** `--variant fcnr --write --force` over the 63-bank cohort → **11 PASS, 14 REVIEW, 38 FAIL**. PASS: indusind (183 slabs, USD/EUR/GBP amount-bucketed), idbi (59), karnataka (42), hsbc (30), union (28), punjab-sind (25, 5-currency), au-sfb (25), doha (18), icici (14), dbs/saraswat (5 USD). **10 persisted as `template_fcnr`** alongside the domestic `template`; **doha** (FCNR-primary, no domestic) correctly stayed on `template` with `variant=fcnr`. **No-clobber verified:** sbi/hdfc/federal remained `["template"]` (regular) only; icici/indusind hold both `["template","template_fcnr"]`. 38 FAIL are expected (`no_rate_url` for co-ops without FCNR, JS/landing pages, WAF, 1 broken yes-bank PDF). Suite 1109 pass / 1 known fail. (Note: a redundant concurrent re-run occurred due to a misread truncated agent notification; resolved idempotently — same 11 banks, atomic last-writer-wins, no damage.)

---

## 9. OCR capability build (image rate cards)

**Context:** a class of co-ops publish FD rates **only as JPG/PNG images** (rajkot-nagrik `/admin/uploads/*.jpg`, janalaxmi gallery images) — invisible to both the deterministic HTML pipeline and Tier-2 HTML parsing. Tier-2 already *proved* the route works: tamil-nadu-apex was recovered via vision OCR of `INTEREST_page-0001.jpg`.

**Existing asset:** `lib/actions/extract_via_ocr.js` is a complete OCR extractor — calls Azure DocIntel `prebuilt-layout` on an image / image-PDF, converts the table structure to slabs, returns `extraction_method: 'automatic_ocr'`. It already handles **Hindi headers** (अवधि / ब्याज / दर), senior/super-senior columns, and currency variants. It is **not yet wired into `bulk-author`** — the gap is identical to the (now-fixed) PDF wiring.

**Build plan:**
1. Image detection in `bulk-author` fetch routing — URL ends in `.jpg`/`.png`, or `scraper_type:'image'` — route to `extract_via_ocr` instead of `fetch_html`/`fetch_pdf`.
2. Set the discovered image URLs in `rate_pages.fd` for the image banks (rajkot, janalaxmi, + any image co-ops surfaced in triage).
3. Gate (anti-fab / rate-range) + persist, with `extraction_method:'automatic_ocr'` and `scraper_type:'image'`.
4. Validate against the tamil-nadu fixture (known-good OCR) + run on the image banks.

**Result (2026-05-25, DONE — commit `b31d43e`):** wired `extract_via_ocr` into `bulk-author` — `IMG_RE`/`scraper_type:'image'` detection in `processOne` → `processOcr` (DocIntel layout → flatten `pages[].slabs` + enrich `source_row_text` → same gates) → `persistOcrEntry` (`scraper_type:'image'`, `extract.extractor:'extract_via_ocr'`, via `targetTemplateKey` so it never clobbers a domestic template). +8 tests; suite **1117 pass / 1 known fail**. Live `--write` on 3 image banks:
- **janalaxmi — PASS (9 slabs)**, persisted as an `image`/`extract_via_ocr` template; domain fixed (`janalaxmibank.in` → `janalaxmi.bank.in`), image `gallery_248.jpg` (probing showed 247 was garbled, 248 is the real card).
- **tamil-nadu — FAIL (17 slabs)**: OCR captured 4 bulk-deposit *premium* rows (0.15–0.5%) as rate slabs, tripping `rate_min_pct:1.0`. Extractor data-shape quirk for that image (premium-delta rows should be filtered), **not** a wiring defect — follow-up.
- **rajkot — FAIL (`ocr_no_slabs`)**: no FD rate image exists on the live site; honestly not persisted. Wiring is ready if a correct image URL surfaces.

Capability is shipped and proven (janalaxmi); the OCR path now auto-handles any image-rate-card bank pointed at an image URL.

**Sequencing rule reaffirmed:** capability builds that touch `bulk-author.js` and run the pipeline are executed **one at a time** — concurrent agents would race on `data/bank-domains.json` (a redundant-FCNR-run race confirmed this; resolved idempotently).

---

## 10. End-of-sprint status & remaining open work

- **#19 FCNR** — DONE (§8): multi-variant templates + 11 FCNR banks.
- **OCR capability** — DONE (§9): wired + janalaxmi landed; TN premium-row filter is a follow-up.
- **JS-XHR generalization** — STILL OPEN (the one larger capability): generalize the `--intercept` XHR-JSON capture (proven per-bank for dcb/icici in Tier-2) into the bulk fetch + an LLM-parse of the intercepted rate API, to templatize the class of SPA banks that render rates client-side.
- **Operator-authored `extracts[]`** — OPEN for esaf / emirates / icici-ibu (overlapping tables the LLM won't split).
- **Co-op long tail** (DCCB 130 + NSUCB 132) — deprioritized below Tier-1.

Commits this sub-phase: `d7508fd` (FCNR), `1aff57f` (FCNR doc), `b31d43e` (OCR).

---

## 11. Resume session (2026-05-25) — #3 co-op sweep + #2 breadth + fold

Resumed cold from `resume-handoff-2026-05-25.md`. Operator chose the **full plan** (#3 co-op + #2 breadth first; sustainability review last). Sequencing honored the one-registry-writer rule: the co-op sweep ran as the sole registry writer while the Tier-2 sub-agents (which only write `output/tier2/`) ran in parallel; all subsequent registry writes (#2a, fold, templatize re-run) were strictly sequential after the sweep.

### 11.1 #3 — Co-op deterministic sweep (`coop-sweep.json`, 216: DCCB 111 + NSUCB 105)
`bulk-author --cohort coop-sweep.json --write` → **96 PASS / 13 REVIEW / 107 FAIL**. All 96 PASS auto-persisted as templates. FAILs are dominated by down/parked hosts, Cloudflare challenges, and expired-cert sites — capability-gated, not effort-gated. Commit `004df13`.

### 11.2 #2 — Breadth Tier-2 (49 banks: 37 no-URL + 12 has-URL)
Four parallel `general-purpose` Tier-2 sub-agents (batches of ~12). **19 banks recovered with real rates (205 slabs):**
- **Tier-2-named (7):** mufg (15), jharkhand-scb (19), jp-morgan (26), societe-generale (14), tripura-gramin (13), mp-gramin (13), assam-gramin (10).
- **Tier-1 (1):** sikkim-scb (13, Scheduled State Co-op).
- **Tier-3 co-op (11):** thane-palghar-dccb (11), patiala-ccb (11), nanded-merchants (9), jsk-jabalpur (8), warangal-ucb (8), nawanshahr-ccb (7), sirsa-ccb (7), kota-nagrik (7), grain-merchants (5), sharad-nagari (5), jabalpur-mahila (4).

**Domain/path corrections only Tier-2 could make:** assam-gramin (registry hint pointed at a *loan* page; real card at `agvb.bank.in/pdf/...`), tripura-gramin (real domain is `.org`, not `.bank.in`), sikkim-scb (`/check-rate` hyphen vs the prior pass's `/check_rates`), mp-gramin (`.co.in` redirects to `.bank.in`).

**Correctly empty — no fabrication (~30):** both Payments Banks (Airtel distributes IndusInd FD, Jio sweeps to Suryoday — no own product), IBUs with no public FX card (ctbc-ibu, yes-ibu, sumitomo-ibu), foreign wholesale / institutional-only banks (nonghyup wholesale, amex institutional-only NBFC, ctbc-bank-co-limited WAF-blocked), and down/parked/no-website co-ops. Two image-PDF co-ops (**shri-mahalaxmi-kolhapur, bharath-bangalore**) have rate cards the agents couldn't OCR in-environment — parked with exact PDF URLs for a follow-up OCR pass.

### 11.3 Fold + templatize re-run
Adapted fold (`tmp/fold-tier2-2026-05-25.js`, gitignored): unlike the prior fold, these banks had **no working FD URL** in the registry, so the fold also set corrected `entry.domain` + `rate_pages.fd` from the agent-discovered `source_url` (required: `resolveBankUrl` returns null unless `domain` is truthy even for a full-URL `fd`). Per bank: curated `extraction_method` (clobber-protected), `tier2{}` hints block, and `output/latest/<slug>_rates.json` written (clobber-guarded). All **19 folded**.

Deterministic templatize re-run (`--banks <19> --write --force`) → **4 PASS converted to auto-refresh templates:** sirsa, kota, societe-generale, assam-gramin. The other 15 keep their Tier-2 manual data but stay non-templated (cert/JS/DI-OCR/host failures). Verified: the 4 carry both a `template` and a curated `extraction_method` — **not** a contradiction, because the curated-skip in `tier-router.js` is `mode==='discover'` only (gates LLM re-discovery), not the template-replay refresh path. Output/latest data intact (205 slabs, no clobber). Commit `cee2dfd`.

### 11.4 Coverage outcome (new `scripts/analysis/coverage-map.js`, §6 methodology: auto=template / static=data-file-only / gap=neither)

| Tier | Total | Auto (was) | Coverage (was) | Gap (was) |
|------|-------|-----------|----------------|-----------|
| Tier-1 (PSB/PVB/Sched/SFB/IBU) | 157 | 111 (111) | 137 (136) | 20 (21) |
| Tier-2 named (FB/RRB/NSSCB/PB/LAB/FI) | 94 | 37 (35) | 75 (68) | 19 (26) |
| Tier-3 co-op (DCCB/NSUCB) | 262 | 104 (6) | 201 (190) | 61 (72) |
| **TOTAL** | **513** | **252 (152)** | **413 (394)** | **100 (119)** |

**Auto-refresh 152 → 252 (+100, 30% → 49%)** — the headline win: the co-op sweep added ~96 templates plus 4 from the templatize re-run, directly halting the staleness-decay on the Tier-3 long tail (auto 6 → 104). **Rate-data coverage 394 → 413 (+19)** from the Tier-2 recoveries. **Gap 119 → 100.**

### 11.5 Remaining open work
- **Sustainability review (#1, still deferred):** ~161 static-data banks have a rate file but no template → convert to auto-refresh so coverage stops decaying (esp. the 26 Tier-1 + 38 Tier-2-named static).
- **OCR follow-up:** shri-mahalaxmi-kolhapur + bharath-bangalore (image-PDF cards); run the `extract_via_ocr` path against their parked PDF URLs.
- Carry-overs from §10: JS-XHR generalization (rejected — see §5/handoff), operator `extracts[]` (esaf/emirates/icici-ibu), TN OCR premium-row filter, runtime dispatch for `template_fcnr`/`template_gift`.

Commits this session: `004df13` (#3 co-op sweep, 96 templates), `cee2dfd` (#2 Tier-2 breadth — 19 folded, 4 templatized, coverage-map script). Suite 1117 pass / 1 known fail throughout.

---

## 12. OCR follow-up + final gap sweep (2026-05-25, operator-requested before sustainability)

Operator asked to (a) finish the OCR follow-up and (b) do ONE final Tier-2 pass over all 100 gap banks — recover rates where possible, else determine a precise reason and **persist website metadata** to the registry.

### 12.1 OCR follow-up — 2 recovered
The deterministic DI path failed both parked image-PDFs (shri-mahalaxmi: DI Layout parser choked on Devanagari tenures → 1 garbage slab; bharath: DI server-side fetch rejected the TLS-cert-mismatched host). Resolved with **vision**: downloaded each PDF, rendered page 1 → PNG (`pdfjs` + `@napi-rs/canvas`, crop+upscale via `sharp`), and read the table directly. **shri-mahalaxmi 7 slabs** (Marathi, w.e.f. 2026-05-01), **bharath 6 slabs** (English, w.e.f. 2023-04-01). Both clean reads, no fabrication.

### 12.2 Final gap sweep — 7 parallel agents over 100 gap banks
New tooling: `scripts/analysis/build-gap-cohort.js` (gap list + names from the RBI CSV + prior-attempt context → `tmp/cohorts/gap-100.json`). Agents produced a structured output per bank: rates, OR `gap_reason` + `website_metadata{domain,found_via,notes}`.

**Outcome — every gap bank resolved:** **28 recovered with real rates (224 slabs)**; **72 classified** (23 wholesale_no_retail, 17 no_rate_page, 16 no_website, 11 unreachable, 3 no_fd_product, 2 bot_blocked). Wins included vision OCR of image/Marathi/Hindi cards (angul 12, karimnagar-dccb 6, yavatmal 8, kanyaka 7, patan 5, janata-satara 9, sagar-dccb 6) and SPA rate-page-route discovery (Kheda React SPA → 14 slabs via JS-bundle CMS map + Playwright). Several registry domains were stale/wrong and got corrected (ganganagar `.com`, gondia, karnavati migration, chiplun `.bank.in`, amravati real site). Identity-confusion traps avoided and flagged (J&K State Co-op vs J&K Bank; Jalna vs Jalgaon; Nellore Urban vs Nellore DCCB; Salem Urban vs Salem DCCB).

### 12.3 Fold (`tmp/fold-gap-sweep-2026-05-25.js`, data-driven)
- **Recover (28):** domain + `rate_pages.fd` from discovered URL, curated `extraction_method`, `tier2{}` block, `output/latest` data file (clobber-guarded), cleared any stale `discovery_status`.
- **Classify (72):** persisted `website_metadata.domain` (where found) + `discovery_status` (`no_website`→`no_website_known`, `no_rate_page`/`wholesale_no_retail`/`no_fd_product`→`website_known_no_rate_page`, `image_needs_ocr`→`pending_vision` — all TERMINAL so future discovery skips them; `unreachable`/`bot_blocked` kept NON-terminal = retryable) + a `gap_classification{}` audit block. 3 cohort banks absent from the registry were seeded (`tmp/patch-missing-3.js`).
- Templatize re-run on the 19 HTML-source recoveries → **10 PASS new templates** (ganganagar, jijau, karnavati, janatha-seva, tirupati, karimnagar-urban, + maybank/nhb/mumbai-dccb/kheda... per report), 1 REVIEW.

### 12.4 Coverage (final, this session)
| Tier | Auto | Coverage | Gap |
|------|------|----------|-----|
| Tier-1 | 111 | 137 (87%) | 20 |
| Tier-2 named | 39 | 77 (82%) | 17 |
| Tier-3 co-op | 112 | 227 (87%) | 35 |
| **TOTAL** | **262 (51%)** | **441 (86%)** | **72** |

vs session start (152 auto / 394 cov / 119 gap): **auto +110, rate-data coverage +47 (77%→86%), gap −47.** The 72 remaining gaps are now **100% classified** — they are structural (no public rate data exists) except 11 `unreachable` + 2 `bot_blocked` (13 retryable from another network / with a WAF bypass).

Commit `13c5144`. **Next: solidify + ship for PM — see `solidify-ship-handoff-2026-05-25.md`.**

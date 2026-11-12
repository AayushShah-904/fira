# Clean PASS plan — cohort #3 final-mile (2026-05-23)

## Context

After this session's Phase A-F + G1-G3 work, the BIRD rate-pack stands at
**516 banks / 8293 slabs** with both gates verdict = **BLOCK**:

- vs `pack/history/rates-pack-2026-04-16.json` (PM floor): 23 regressions (20 blocking + 3 accepted), 208 anomalies, +257 banks / +3811 slabs gain
- vs `pack/history/rates-pack-2026-05-14.json` (engine efficacy): similar shape

Tests: 854 pass / 1 skip / 0 fail. All 6 logical commits (write_file bug, pack filter, commit_rates filter, prompt+looksLikeBadMapping, IBU routing, SDLC doc) are landed on `azure-openai-agent`.

The gate code (`scripts/quality-gate.js` ~line 394): `if (blockingR > 0 || blockingA > 0) return 'BLOCK';` — any single unaccepted item blocks. PASS requires zero unaccepted regressions AND zero unaccepted anomalies.

You chose the **Clean PASS via engine work** path: fix root causes, don't paper over with accepts. And revert Fix #5 (the rowspan/colspan readTableRows rewrite) — analysis showed it was net-neutral-to-negative (its 6 supposed beneficiaries were already at baseline from the earlier Fix #1c picker; PNB never validated because Playwright can't reach the page; ICICI got hurt by it).

Estimated total effort: **10-15 hours engineering**. Plus Azure blob container provisioning for Workstream D.

## Workstream A — Revert Fix #5 (~30 min)

**Files**:
- `lib/actions/_cheerio_tables.js` — restore the old `readTableRows` (the simple flat `<tr>`-walker before commit `5160f26`). Cheerio's `text()` + `find('th, td')` is sufficient for the tables the picker actually selects today.
- `tests/lib/actions/_cheerio_tables.test.js` — remove the three Fix #5 test cases ("rowspan expansion fills repeated cells", "colspan expansion duplicates the cell", "nested `<table>` inside a `<td>` does NOT contribute extra rows"). Keep the other 30 tests untouched.

**Why**: Fix #5's rowspan/colspan/nested-table handling is correct HTML semantics but never delivered the promised PNB FCNR recovery (PNB is unreachable from this dev environment — Playwright can't navigate the page). It DID inject 12 short-tenor Call-Deposit rows into ICICI's FCNR table that Phase C3's tenure-filter had to clean up downstream. The earlier Fix #1c picker (currency-count ranking) carried the load for Canara/IDBI/City-Union/Punjab-Sind/Dhanlaxmi/Karnataka — none of those benefited measurably from Fix #5.

**Verification**:
- `node --test tests/lib/actions/_cheerio_tables.test.js --test-force-exit` → expect 27 pass.
- Pack rebuild after Workstream D delivers the real FCNR recovery — confirm no regression on ICICI/Canara/IDBI/etc.

## Workstream B — Kotak picker fix (~1-2 hr)

**Symptom**: Kotak Mahindra Bank — regular 18→0, NRE 7→0. Phase C1's filter correctly dropped the 5 garbage slabs at 0.5-1% (well below 1.5% INR floor). But the underlying problem is the picker selecting the wrong table on https://kotak.bank.in/en/personal-banking/deposits/fixed-deposit/fixed-deposit-interest-rate.html — likely a promotional banner table.

**Strategy**:
1. Playwright the page to inspect the DOM (`node scripts/fetch_rates_playwright.js "<url>" --scroll --accordions` — already wired). Identify the canonical FD rate table's CSS selector.
2. Add `selectors.table` hint in `data/bank-domains.json` for `kotak-mahindra-bank-limited` so the deterministic picker restricts to that table.
3. Also check Kotak's NRE / NRO sub-pages (`/en/personal-banking/nri/accounts-deposits/deposits/nre-fixed-deposit/interest-rate.html` etc.) — similar fix likely needed.

**Files**:
- `data/bank-domains.json` — add `selectors.table` (and `selectors.rows` if needed) for `kotak-mahindra-bank-limited`.

**Verification**:
- `node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv --banks kotak-mahindra-bank-limited --concurrency 1 --path orchestrator`
- Expect: regular ≥18 slabs at 5-7%, NRE ≥7 slabs. All slabs pass the 1.5% floor — no Phase C1 drops.

## Workstream C — HDFC-IBU multi-currency PDF extraction (~2-4 hr)

**Symptom**: HDFC-IBU gift 34→8 USD-only. Baseline had USD + EUR (34 total). The PDF at `https://www.hdfcgiftcity.bank.in/.../offshore-deposit-interest-rates.pdf` has two currency blocks but the LLM PDF path collapses to USD. This session's attempts:
- Phase C2 prompt addendum (multi-currency emphasis) — did not stick.
- G2 Azure DI Layout via image_ocr hint — DI Layout returned 0 tables (PDF rates are styled spans, not `<table>` cells).

**Strategy** (pick one or combine):
1. **Vision LLM extraction** — route HDFC-IBU through `lib/actions/extract_via_vision.js` (already exists for image rate cards). The PDF is essentially a styled image to DI Layout; vision LLMs handle the EUR block more reliably than text LLMs that scan PDF byte streams.
2. **DI prebuilt-document model** — switch the OCR action from `prebuilt-layout` to `prebuilt-document` (more permissive table detection). Audit the analyze call in `lib/actions/extract_via_ocr.js` and confirm the SDK supports the swap.
3. **Per-bank prompt augmentation** — add a `extraction.fd_pdf_gift` block with `prompt_addendum` field that injects "the PDF contains USD on page 1 and EUR on page 2; emit a slab for each currency × tenure cell" directly into the LLM prompt.

**Recommended path**: try Strategy 1 first (vision LLM). If it returns >25 slabs across USD+EUR, ship. Otherwise fall back to Strategy 3.

**Files**:
- `data/bank-domains.json` — `hdfc-bank-ibu.extraction.fd_pdf_gift` with the chosen strategy's hint.
- `lib/actions/extract_via_vision.js` (existing) or `lib/actions/extract_pdf_table.js` (if Strategy 3) — possibly add a `prompt_addendum` consumption point.
- `lib/orchestrator.js` — wire the new hint type if needed; currently has `findHintedOcrUrl` / `findHintedPdfUrl` / `findHintedHtmlUrl`. May need `findHintedVisionUrl` resolver.
- `lib/extraction-hint.js` — add the new resolver if Strategy 1.

**Verification**:
- `node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv --banks hdfc-bank-ibu --concurrency 1`
- Expect: ≥34 gift slabs across USD + EUR. Cost ≤ $1.

## Workstream D — Phase D screenshot+OCR for PNB-class FCNR (~3-4 hr + Azure provisioning)

**Symptom**: PNB FCNR 30→21 USD-only (multi-currency baseline was 6 currencies × 5 tenures). Fix #5's rowspan rewrite did not help (Playwright can't reach the page). This is the canonical Phase D case.

**Strategy**: Playwright renders the page → captures a PNG screenshot of the rate-table region → uploads to an Azure Blob Storage container → gets a short-lived signed URL → sends to Azure Document Intelligence Layout (already wired) → existing slab-normaliser consumes the structured output.

**Infrastructure pieces (mostly exist)**:
- `lib/actions/_playwright_session.js` — exists; expose a `screenshot(selector?, fullPage)` method returning a Buffer.
- `lib/actions/extract_via_ocr.js` — accepts a URL today. Extend to accept a Buffer (upload to blob first, then call DI Layout with the signed URL).
- `lib/extraction-hint.js` — new `findHintedScreenshotOcrUrl(slug, product)` resolver for the new hint type.
- `lib/storage.js` (new) — blob-upload helper. SAS token issuance via managed identity OR shared-key. Reuse existing Azure storage credentials from `.env`.
- `lib/orchestrator.js` — route to `extract_screenshot_ocr` when `findHintedScreenshotOcrUrl` matches.

**Azure provisioning** (one-time ops):
- Create a blob container `bird-screenshot-ocr` with a short retention policy (24h auto-delete).
- Issue SAS token or grant managed-identity access. Add env vars `AZURE_BLOB_SCREENSHOT_CONTAINER` (and credentials if needed).

**Registry hint**:
- `data/bank-domains.json` — `punjab-national-bank.extraction.fd_fcnr_screenshot = { type: "screenshot_ocr", fulfills_product: ["fd_fcnr"], viewport: { width: 1366, height: 768 } }`.

**Files**:
- `lib/actions/_playwright_session.js` — add `screenshot()` method.
- `lib/actions/extract_via_ocr.js` (or new `lib/actions/extract_screenshot_ocr.js`) — handle Buffer→blob→signed-URL flow.
- `lib/storage.js` — new helper, ~30 lines.
- `lib/extraction-hint.js` — new resolver.
- `lib/orchestrator.js` — new branch alongside hintedPdf/hintedHtml/hintedOcr.
- `data/bank-domains.json` — punjab-national-bank hint.

**Cost**: $0.01/page × 1 page × 7 candidate banks = $0.07 per refresh. Even if extended to all 7 named banks, negligible.

**Verification**:
- `node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv --banks punjab-national-bank --concurrency 1`
- Expect: FCNR ≥25 slabs spanning USD + GBP + EUR + JPY + CAD + AUD.

## Workstream E — `senior_below_general` root-cause (~3-6 hr)

**Symptom**: 159 of the 208 anomalies are `senior_below_general` (e.g., shinhan-bank `general 6.75 / senior 6.5` ×8 occurrences). These are column-misalignment errors: the extractor swapped general and senior columns for specific banks, OR the page genuinely shows senior < general (rare but possible — wholesale rate cards).

**Strategy**: Audit the top 10 offending banks. For each:
1. Open the source page; identify column order.
2. If columns are reversed, add a per-bank `column_mapping` hint in `data/bank-domains.json` (the `column_mapping` field already exists per the registry schema).
3. If the bank legitimately shows senior < general, add a per-bank accept in `pack/quality-gate-accepts.json` with reason "wholesale rate card; senior tier intentionally below general".

**Top offenders (from quality-report.md analysis)**:
- shinhan-bank (regular ×8)
- karad-urban-co-operative-bank-ltd (regular ×4)
- the-vishweshwar-sahakari-bank-ltd-pune (regular ×3)
- the-puducherry-state-co-operative-bank-ltd (regular ×3+2)
- the-chhattisgarh-rajya-sahakari-bank-maryadit (regular ×3)
- uco-bank (nre ×2)
- raigad-district-central-co-operative-bank-ltd (regular ×2)
- karnataka-bank-limited (regular ×2)
- bandhan-bank-limited (regular ×7+ — value=1 column suggests column swap)
- bank-of-ceylon (nre ×N)

**Files**:
- `data/bank-domains.json` — add `column_mapping` overrides for the 5-10 banks where the audit shows reversed columns.
- `pack/quality-gate-accepts.json` — add per-bank accepts for legitimate senior<general cases.

**Verification**: re-extract the audited banks; rebuild pack; gate re-run shows the targeted anomalies cleared.

## Workstream F — Small-co-op partial regressions (~2-3 hr)

**Symptom**: 5 banks dropped 30-100% in single variants:
- ahmedabad-mercantile-co-op-bank-ltd NRE 3→0
- karimnagar-district-co-operative-central-bank-ltd regular 6→0
- g-p-parsik-janata-sahakari-bank-ltd-thane regular 17→10
- sbpp-co-operative-bank-ltd-killa-pardi regular 13→8 (this session: 14 emitted, 6 dropped by Phase B filter → 8 surviving)
- shikshak-sahakari-bank-ltd-nagpur regular 16→8

**Strategy**: per-bank investigation. Each is a different cause:
- ahmedabad-mercantile NRE 3→0 — likely the NRE page doesn't exist or returns 0 slabs; needs hint or accept.
- karimnagar 6→0 — bank dropped entirely; site change or scraper_type mismatch.
- g-p-parsik 17→10 — extraction caught only half the slabs; column mapping or table selector.
- sbpp 13→8 — Phase B dropped 6 slabs as out-of-band. Investigate WHY those 6 slabs were out-of-band (likely column misalignment), then either fix mapping or accept.
- shikshak 16→8 — likely same as g-p-parsik.

**Files**: `data/bank-domains.json` per-bank entries; possibly `pack/quality-gate-accepts.json` for unsalvageable cases.

**Verification**: per-bank re-run + comparison to baseline.

## Workstream G — Tier-2 FCNR drops (~2-3 hr)

**Symptom**:
- Bandhan Bank FCNR 24→19 (-5)
- Bank of Baroda FCNR 35→25 (-10)
- Indian Bank FCNR 40→25 (-15)
- UCO Bank FCNR 45→7 (-38, outlier — stale file from cohort #2)
- Ujjivan SFB FCNR 6→0 (partial_silent marker — image PDF; extraction deferred)

**Strategy**:
- **UCO Bank FCNR 7**: stale file from 2026-05-22; Phase F-stage-1b didn't re-extract FCNR for UCO. Investigate why (FCNR page reachable?) and re-extract OR add accept.
- **BoB / Indian Bank / Bandhan FCNR minor drops**: probably rate card menus genuinely shrunk by the banks (some currencies discontinued OR fewer tenure tiers). Audit each by comparing current vs baseline tenure×currency matrix. If menu legitimately shrunk, add per-bank accept with documented reason. If extraction missed slabs, fix per-bank.
- **Ujjivan FCNR 6→0**: image PDF; accept with reason "image PDF, automated extraction deferred — needs OCR or operator transcription" + keep partial_silent marker.

**Files**: per-bank `pack/quality-gate-accepts.json` entries; possibly per-bank registry hints.

## Workstream H — Final verification + ship (~1 hr)

After Workstreams A-G land:
1. `node --test --test-force-exit` — full suite must pass.
2. `node pack/build-pack.js` — rebuild.
3. `node scripts/quality-gate.js pack/dist/rates-pack.json pack/history/rates-pack-2026-04-16.json --accepts pack/quality-gate-accepts.json` → expect verdict `PASS` or `PASS_WITH_WARNINGS`.
4. `node scripts/run-dual-gate.js` → both gates PASS.
5. If still BLOCK on residual items, document each in a final ship-decisions doc and either accept or defer.

## Recommended ordering

**Parallel tracks** (work-streams are mostly independent):
- Track 1: **A → B → E** (revert + Kotak + senior_below_general — single-engineer, sequential)
- Track 2: **D** (Phase D — start early since Azure provisioning has lead time)
- Track 3: **C** (HDFC-IBU vision-LLM)
- Track 4: **F + G** (per-bank audits — can interleave)

**Critical path**: D (Azure provisioning + screenshot pipeline) is the longest; start day-0.
**Lowest-cost wins first**: A (30min) → B (1-2hr) → top-3 of E (1-2hr) — clears the most-visible regressions in ~3 hr.

## Files modified summary

| File | Workstream | Why |
|---|---|---|
| `lib/actions/_cheerio_tables.js` | A | Revert readTableRows |
| `tests/lib/actions/_cheerio_tables.test.js` | A | Drop 3 synthetic Fix #5 tests |
| `data/bank-domains.json` | B, C, D, E, F, G | Per-bank hints (selectors, column_mapping, extraction blocks) |
| `lib/actions/_playwright_session.js` | D | Add screenshot() |
| `lib/actions/extract_via_ocr.js` (or new extract_screenshot_ocr.js) | D | Buffer + blob upload path |
| `lib/storage.js` (new) | D | Blob upload helper |
| `lib/extraction-hint.js` | D | findHintedScreenshotOcrUrl |
| `lib/orchestrator.js` | D | New routing branch |
| `lib/actions/extract_via_vision.js` | C | Possibly extend for HDFC-IBU PDF |
| `pack/quality-gate-accepts.json` | E, F, G | Documented per-bank accepts for legitimate regressions |

## Verification end-to-end

1. `node --test --test-force-exit` → 837 pass / 1 skip / 0 fail (854 - 17 from Fix #5 test deletions + Workstream B/C/D unit additions ≈ same total or slightly more)
2. Per-workstream per-bank verification (each Workstream lists its `--banks <slug>` test)
3. `node pack/build-pack.js` → 516+ banks, ≥ 8400 slabs (current 8293 + Workstreams C/D/E/G recoveries should net ~+200-300)
4. `node scripts/run-dual-gate.js` → both gates PASS or PASS_WITH_WARNINGS
5. Update `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-passV1-2026-XX-XX.md` with the final shipping deltas

## Risks / open questions

- **PNB unreachability**: if Playwright still can't reach PNB's page even via the new screenshot path (Norton TLS MITM is the working theory), Workstream D fails for PNB. Mitigation: run the screenshot from a cloud worker (Azure Function or a dev workstation without Norton) — single command, environment-independent.
- **Vision LLM cost**: HDFC-IBU vision route may run $0.10-0.50 per attempt at gpt-4-vision-preview pricing. Acceptable, budget cap at $5/cohort.
- **`column_mapping` overrides**: existing schema supports per-bank overrides. Validate the `commit_rates` path honours them before applying broadly.
- **Phase F retest cost**: full per-bank retest after each Workstream is ~$0.02-0.10/bank; total ~$2-3 across all workstreams. Negligible vs the engineering hours.

## Commit strategy

One commit per Workstream, mirroring this session's pattern:
- `revert(sprint-004): Fix #5 cheerio rowspan/colspan rewrite — never delivered, ICICI side-effect`
- `fix(sprint-004): Kotak picker CSS selector hint for FD rate table`
- `feat(sprint-004): HDFC-IBU vision-LLM extraction for multi-currency PDF`
- `feat(sprint-004): Phase D — Playwright screenshot + Azure DI Layout pipeline`
- `fix(sprint-004): senior_below_general column-mapping audit for top-10 banks`
- `fix(sprint-004): small-co-op partial regressions — per-bank tuning`
- `fix(sprint-004): tier-2 FCNR drops — per-bank accepts + retunes`
- `sdlc(sprint-004): cohort #3 final-mile clean-PASS implementation report`

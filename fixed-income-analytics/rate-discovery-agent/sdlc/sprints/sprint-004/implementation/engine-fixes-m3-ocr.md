# Engine fixes — M3: OCR-fallback via Azure Document Intelligence

> Design ref: [`../design/ocr-fallback.md`](../design/ocr-fallback.md)
> Provisioning ref: [`./m3-docintel-setup.md`](./m3-docintel-setup.md)
>
> Closes the long-standing "image rate card / scanned PDF" cohort that
> the deterministic and LLM extractors couldn't read. Banks that were
> blocked at 0 slabs for months now extract slabs end-to-end through the
> orchestrator.

## Cohort results

| Bank | Surface | Slabs | Method | Cost |
|---|---|---:|---|---:|
| ajmer-central-co-operative-bank-ltd | Hindi scanned letter (JPG, बाँकेन) | **15** | automatic_ocr | ~$0.01 |
| banswara-central-co-operative-bank-ltd | Scanned-PDF rate circular (English) | **46** | automatic_ocr | ~$0.01 |
| barmer-central-co-operative-bank-ltd | Scanned-PDF rate card (Hindi headers) | **9** | automatic_ocr | ~$0.01 |
| **Total** |  | **70** |  | **~$0.03** |

All three were `0 / 0 / 0 / 0` before this milestone — operator-curated as
`pending_vision` and skipped by the registry gate. Now contributing real
slabs to the pack.

## Files changed

| File | Change |
|---|---|
| `lib/actions/extract_via_ocr.js` | NEW — DI Layout extractor matching `extract_pdf_table.js` shape. Tables → rate slabs via column-role classifier + tenure parser + currency-keyed shape detection. ~350 LOC. |
| `lib/extraction-hint.js` | NEW `findHintedOcrUrl(bankEntry, product)` paralleling `findHintedPdfUrl` / `findHintedHtmlUrl`. Single shared `findHintedUrlByType` underneath. |
| `lib/orchestrator.js` | OCR hint check beside the PDF/HTML hint checks. New `extract_via_ocr` extraction branch that fires when the registry declares `extraction.<key>.type === "image_ocr"` — bypasses the classifier and routes the URL directly to DI. |
| `lib/tier-router.js` | OCR-hint override on the `pending_vision` skip gate: banks with an OCR hint now have an automated path, so the legacy "pending_vision" marker no longer skips them. |
| `lib/extraction-methods.js` | NEW canonical method `automatic_ocr` added to `AUTO_OVERWRITEABLE_METHODS`. |
| `data/bank-domains.json` | OCR hints authored for ajmer / banswara / barmer (new `fd_image_ocr` rate_pages key + matching `extraction.fd_image_ocr` block). |
| `scripts/analysis/docintel-smoke.js` | NEW smoke script (file-or-URL → DI Layout call → table summary). Used to triage failures during integration. Renamed from `test-docintel-smoke.js` (the `test-` prefix triggered Node's auto-discovery and ran it as a test). |
| `tests/lib/actions/extract_via_ocr.test.js` | NEW — 27 unit tests with stub DI responses covering cell-merge → grid expansion, column classification, currency-keyed detection, rate-cell parsing, end-to-end via `_analyze` injection. |
| `sdlc/sprints/sprint-004/design/ocr-fallback.md` | Existing design doc (M3 design). |
| `sdlc/sprints/sprint-004/implementation/m3-docintel-setup.md` | Existing provisioning record. |

## Test results

| Suite | Tests | Status |
|---|---|---|
| `tests/lib/actions/extract_via_ocr.test.js` | 27 | ✅ all pass |
| Full suite (`node --test --test-force-exit`) | 785 pass / 1 skip / 0 fail | ✅ |

## Mechanism walk-through (Banswara case)

1. Operator authors hint:
   ```jsonc
   "banswara-central-co-operative-bank-ltd": {
     "rate_pages": { ..., "fd_image_ocr": "https://www.banswaraccb.com/.../BANSWARA%20CCB%20FD%20RATES%2011-07-2023.pdf" },
     "extraction": { "fd_image_ocr": { "type": "image_ocr", "fulfills_product": ["fd"] } }
   }
   ```
2. `tier-router.selectDiscoveryAction` sees the OCR hint and overrides the `pending_vision` skip.
3. Orchestrator iterates product `fd`. `findHintedOcrUrl` matches the hint and overrides `cachedPath`.
4. `find_rate_page` confirms the PDF URL exists (HEAD).
5. Orchestrator's new branch `if (hintedOcr) { extract_via_ocr(...) }` fires.
6. DI Layout returns 9 tables. The column classifier finds "Rate Of Interest" + "Senior Citizen" headers, falls back to col 0 for tenure (no recognized tenure-header keyword), emits slabs per row.
7. Orchestrator's existing M2.6 `pages: [...]` aggregation absorbs the output. `commit_rates` writes 46 slabs.

## Design decisions captured

| Question | Decision | Why |
|---|---|---|
| Which DI API: Layout vs Read? | Layout | Table cell structure is what we need; Read returns flat lines and requires reconstruction. Cost difference is real (~$10 vs $1.50 per 1000 pages) but absolute spend is negligible at our cadence. |
| Auth: key vs MI? | Key (interim) | Faster to set up; MI migration deferred until cohort runs prove value. ADR-007-compatible pattern noted in [`m3-docintel-setup.md`](./m3-docintel-setup.md). |
| Trigger paths supported? | Explicit hint only (Phase 1) | Auto-trigger on empty-PDF-text was in the original design but deferred — explicit hints surface intent more clearly during the rollout and avoid surprising the operator with OCR firing on banks they didn't authorize. Can be added later if a clear use case emerges. |
| How to handle non-English headers? | Classifier accepts Hindi keywords (अवधि, ब्याज, दर) + col-0 fallback | The fallback path turned out to matter more than the Hindi keywords — Banswara's "Fixed Deposits" English header isn't a Hindi case but still wasn't a recognized tenure-keyword. Falling back to col 0 when a rate column is detected handles both Hindi rate cards AND idiosyncratic English ones. |
| Where does the OCR extractor live in the tier? | Before the classifier-based switch | OCR is hint-driven (operator-authored), not classifier-detected. The hint asserts "this URL is an image-rate-card", overriding whatever the classifier would conclude. Same pattern as PDF/HTML hints. |

## What's open

1. **FCNR currency-keyed schema** — already backlogged. The OCR extractor *can* detect FCNR-shape tables (currency-rows × tenure-cols), but the orchestrator's commit path still expects per-variant files; multi-currency fan-out within an FCNR file is a separate slab-schema discussion. Will become more visible once we author OCR hints for FCNR-bearing image PDFs (e.g., Bank of India FCNR).
2. **Auto-trigger on empty-PDF-text** — when `extract_pdf_table` returns 0 slabs because the PDF is image-based, the orchestrator could automatically retry with OCR. Deferred to a follow-up so each OCR call remains traceable to an explicit hint during rollout.
3. **Effective-date detection from DI output** — currently `effective_date: null` on OCR pages. DI returns paragraph text; the date could be parsed from it via a small post-OCR pass. Future enhancement.
4. **Cost-tracker integration** — OCR pages aren't yet included in the per-run cost summary. Should add `cost_pages * 0.01` to the run's `total_cost_usd`. Trivial follow-up.
5. **Broader cohort rollout** — only 3 banks authored so far. Operator's `pending_vision` list has more candidates; each takes ~2 minutes to author + verify.

## Acceptance vs design doc

| Design criterion | Result |
|---|---|
| Single-bank smoke yields ≥ 8 slabs | Banswara 46 ✓ (over-achieved) |
| Cohort total under $0.05 | ~$0.03 ✓ |
| No-regression on 5 non-OCR PVBs | HDFC/Axis/ICICI/SBI/Kotak unchanged ✓ (only impacted code path is the new hint branch, which fires only when `findHintedOcrUrl` returns a match) |
| Unit tests cover stub DI responses | 27 tests ✓ |
| Operator-approval gate for provisioning | Provisioning recorded in `m3-docintel-setup.md` ✓ |

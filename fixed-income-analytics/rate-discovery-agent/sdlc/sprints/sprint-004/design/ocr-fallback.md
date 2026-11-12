# M3 — OCR fallback for image-based rate cards

> Closes the "needs OCR" category of banks that the current pipeline cannot extract:
> JPEG image rate cards (Tamilnad Mercantile, Mahesh Co-op deposit-ROI), scanned bank
> circulars (some PSB sub-units), and image-based PDFs that `pdf-parse` returns
> with empty text.
>
> **This design doc lands first. Provisioning Azure Document Intelligence is gated on operator approval — do NOT proceed to implementation (`extract_via_ocr.js`) without explicit go-ahead.**

## Context

The current extraction tiers handle:

1. `html_static` — Cheerio table extraction
2. `html_js` — Playwright + Cheerio
3. `pdf` — `pdf-parse` text extraction (Orch-1's PDF column-hint parser)
4. `manual` — operator transcription

Several banks publish rates as **rasterised content** that none of the above handle:

| Bank | Surface | Current outcome |
|---|---|---|
| `tamilnad-mercantile-bank-limited` | JPEG embedded on HTML page | 0 / 0 / 0 / 0 (partial_silent) |
| `bank-of-india` FCNR | PDF scanned by phone camera | FCNR 0 slabs |
| `apna-sahakari-bank-ltd` (and similar Maharashtra co-ops) | JPG of printed office-order letterhead | manual transcription required |
| `<various IBU>` | Image-based PDF rate cards | 0 slabs at extract time |
| `mashreqbank-psc` | Scanned PDF circular | partial_silent |

These banks contribute zero slabs to the pack today even when their rates ARE published — just in a format the pipeline can't read.

The fix is a fifth tier: **OCR fallback** that runs when (a) a PDF returns no extractable text, OR (b) the registry explicitly hints `type: "image_ocr"` for an HTML page that points to an image.

## Approach

### Service selection — Azure Document Intelligence

Three viable options:

| Option | Pros | Cons | Cost |
|---|---|---|---|
| **Azure Document Intelligence — Layout API** | High-accuracy table extraction; returns cells with structure; same Azure tenant as `bofia` resources | Paid per-page; needs provisioning + secret rotation | $10/1000 pages |
| Azure DI — Read API | Cheaper; works for letterhead/circular text | Returns flat lines, not tables — additional table-reconstruction step needed | $1.50/1000 pages |
| Tesseract (local via `tesseract.js`) | Free; no provisioning; runs in Node | Lower table accuracy; struggles with multi-column rate cards; CPU-heavy in cloud workers | Free |

**Recommendation: Azure DI Layout API**. The pipeline's value depends on accurate slab extraction; a free-but-noisy OCR (Tesseract) would create downstream cleanup burden that exceeds the $10/1000-page Azure cost. At rates-change cadence (quarterly per bank × ~30 banks = ~120 pages/year), annual cost is **~$1.20 — negligible**.

### Provisioning (Bicep)

New resource in the `bofia` resource group:

```bicep
resource docIntel 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'bofia-docintel'
  location: location
  kind: 'FormRecognizer'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: 'bofia-docintel'
    publicNetworkAccess: 'Enabled'
  }
}
```

Two new appSetting params (replace-not-merge per ADR-013):
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY` (Key Vault reference)

Operator action required: review the Bicep change and approve provisioning.

### New action — `lib/actions/extract_via_ocr.js`

Mirrors `extract_pdf_table.js`'s shape so the orchestrator can route to it the same way:

```js
async function extractViaOcr({ url, source_type, variant, hints }) {
  // 1. Fetch the image/PDF via existing fetch_pdf or fetch_image helper
  // 2. POST to DI Layout endpoint with prebuilt-layout model
  // 3. Poll the operation-location until succeeded
  // 4. Parse the returned `tables` array — each table has cells with row/col indices
  // 5. Apply the existing column_mapping + tenure_parser + senior_excluded_for /
  //    min_tenor_days_by_variant logic from Orch-1's section-context interpretation
  // 6. Return { ok: true, pages: [...] } matching extract_pdf_table.js shape
}
```

Reuses (no reinvention):
- `parsePdfRateLines` from `scripts/utils/parse-pdf-rate-lines.js` (post-OCR text → slabs)
- `normaliseDepositRange` from `lib/actions/extract_html_table.js`
- `captureSectionContext` + `interpretSectionContext` (Orch-1) for note interpretation when DI returns paragraph text alongside tables

### Tier-router hook (`lib/orchestrator.js`)

Two trigger paths:

1. **Auto-detect**: after `extract_pdf_table` returns and the page yielded `slabs.length === 0` AND `extractionMethod === 'empty_text'`, the orchestrator calls `extract_via_ocr` with the same URL. No registry change required for banks that have image PDFs.

2. **Explicit hint**: registry can declare `extraction.<key>.type === "image_ocr"` for HTML pages that embed images (Tamilnad Mercantile JPEG case). The existing `findHintedHtmlUrl` + a new `findHintedOcrUrl` helper route the iteration to the OCR path directly.

```js
const hintedOcr = (!hintedPdf && !hintedHtml) ? findHintedOcrUrl(bankEntry, product) : null;
const hinted = hintedPdf || hintedHtml || hintedOcr;
```

### Telemetry / cost-tracking

Each OCR call increments a per-run counter:
```js
session.cost_breakdown.ocr_pages = (session.cost_breakdown.ocr_pages || 0) + pageCount;
```

Cost is reported in the run summary alongside LLM token costs. Cohort runs can then enforce a budget cap.

### Registry hint authoring (post-provisioning)

Initial cohort to author hints for (after the resource is live):

| Bank | URL | Hint type |
|---|---|---|
| `tamilnad-mercantile-bank-limited` | `/assets/images/<rate-card>.jpg` | `extraction.fd = { type: "image_ocr", fulfills_product: ["fd"] }` |
| `apna-sahakari-bank-ltd` | `/wp-content/uploads/2025/09/Deposit-ROI_new.jpg` | same |
| `bank-of-india` FCNR PDF | (existing PDF URL with empty extract) | auto-trigger via empty-text path; no hint needed |

## Verification plan

Once `extract_via_ocr.js` lands (deferred behind operator approval):

1. **Unit tests** — fixture-based: a stub Document Intelligence response containing a known rate table; assert that `parsePdfRateLines` consumes the OCR output and produces the expected slabs.
2. **Single-bank smoke** — run Tamilnad Mercantile end-to-end. Acceptance: ≥ 8 slabs extracted from the JPEG rate card.
3. **Cohort smoke** — run the 3-bank OCR cohort (TMB + apna-sahakari + bank-of-india-fcnr); verify cost stays under $0.05 total.
4. **No-regression** — re-run a 5-bank non-OCR cohort (HDFC, Axis, ICICI, Kotak, SBI) to confirm OCR routing only triggers when needed.

## Cost ceiling

- Per-page: $10 / 1000 = $0.01
- Per cohort run (300 banks × 1 page average across image-bearing variants = ~30 pages OCR'd): **$0.30**
- Annual: ~$5 if rates re-collected weekly across the full cohort; ~$1 at the actual quarterly cadence

Operator can revoke the API key at any time to disable OCR cohort-wide (the pipeline degrades gracefully — the affected banks return to `partial_silent`).

## Out of scope

- **Vision LLM** (Claude/GPT-4o image input) as the OCR engine — more expensive ($0.01-0.10 per image depending on size), less deterministic for structured tables. Reserved as a future option if Azure DI accuracy proves insufficient on specific banks.
- **Hindi / regional-language rate cards** — DI Read supports Hindi, but the post-OCR parser has English-tuned regexes. Hindi cards would need additional script-detection + translation; out of scope for this milestone.
- **Image-bearing HTML pages that hide images behind JS** — Playwright already renders these; the resulting image URL goes through the same OCR path.
- **Bank-letterhead OCR with handwriting** — DI Layout doesn't handle handwriting well; out of scope.

## Stop conditions / decision gates

1. **Operator approval required** before any Azure provisioning. This doc lands first; implementation (task #25) is paused pending that approval.
2. If approval is denied, the alternate path is **Tesseract local** as the OCR engine. The same `extract_via_ocr.js` interface stays; only the back-end changes. Tesseract requires no cloud provisioning but ~50% lower accuracy on multi-column rate tables — accept the cleanup burden as the trade-off.
3. If even Tesseract is not approved, M3 ships as a no-op design document; image-bearing banks stay in `partial_silent` with explicit `extraction_method: "manual_image_transcription"` (already the current state).

## Files to modify (when implementation begins)

| File | Change |
|---|---|
| `bicep/main.bicep` (or wherever `bofia` resources are declared) | New `Microsoft.CognitiveServices/accounts` resource for Document Intelligence |
| `bicep/parameters.json` | Endpoint + key-vault-reference params |
| `lib/actions/extract_via_ocr.js` | NEW — OCR-driven extractor matching `extract_pdf_table` shape |
| `lib/extraction-hint.js` | NEW `findHintedOcrUrl(bankEntry, product)` paralleling the PDF + HTML helpers |
| `lib/orchestrator.js` | Tier-router: empty-text PDF path + explicit `type: "image_ocr"` hint path |
| `data/bank-domains.json` | Hint authoring for the initial 3-bank cohort |
| `tests/lib/actions/extract_via_ocr.test.js` | Unit tests with stubbed DI responses |
| `sdlc/sprints/sprint-004/implementation/engine-fixes-m3-ocr.md` | Implementation notes after smoke verification |

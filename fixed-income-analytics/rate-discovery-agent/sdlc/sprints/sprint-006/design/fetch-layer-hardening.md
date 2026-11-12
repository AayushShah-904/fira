# Step 1 — Hardened fetch layer (Phase B)

**Sprint:** 006
**Step:** 1
**Status:** Design — to be implemented in Step 1a/1b/1c commits.
**Lifts from:** `sdlc/sprints/sprint-005/design/extractor-registry.md` (Phase B section) + `scripts/fetch_rates_playwright.js` (existing implementation)

## Context

Sprint 5 shipped the extractor registry and dispatcher but left the fetch path as `scripts/fetch_rates_playwright.js` — a CLI script with brittle defaults that Phase 0.2 failure inventory pinned to ~20 banks lost to "JS-rendered .bank.in pages with default `domcontentloaded` waiting." Phase B re-architects fetch as a library function with per-bank `template.fetch` configuration, escalating retry rungs, iframe traversal, and challenge-detection routing.

## Goals

1. **`lib/fetch/fetch_html.js`** — library function `fetchHtml({url, templateFetch, log}) → {status, html, attempts, challenge_detected, ms}` that:
   - Tries escalation rungs in order (`default → stealth → firefox → llm-fallback`)
   - Honors per-bank `template.fetch` overrides (timeout, wait_for_selector, wait_for_function, click_to_reveal, iframe_selector)
   - Defaults `waitForFunction` to `() => /%/.test(document.body.innerText) && document.querySelectorAll('table tr').length >= 3` — the load-bearing fix for the 20-bank JS-rendered cluster
   - Captures HAR on failure to `tmp/runs/<bank>.har` for offline replay
2. **`lib/fetch/challenge_detect.js`** — pure function on response that returns `{challenged, vendor, signal}`. Called by `fetch_html.js` between rungs to short-circuit to `stealth` on first WAF signal.
3. **`lib/fetch/fetch_pdf.js`** — library function `fetchPdf({url, hints, log}) → {method, text|layout, slabs_preview}` that:
   - Downloads PDF, tries pdfjs-dist text extraction first
   - Falls back to Azure Document Intelligence Layout when text yields < 3 slabs OR multi-column hint present
4. **`lib/azure/doc_intelligence.js`** — shared Azure client extracted from `lib/actions/extract_via_vision.js`. Phase B sub-A; PDF + image paths both use it.

## Non-goals (out of scope for Step 1)

- Integration into `lib/orchestrator.js` runtime path. Step 1 ships the fetch library; Step 2 (per-bank manifest) and Step 4 (migration) wire it in.
- Replacing `scripts/fetch_rates_playwright.js` — kept as a deprecated stub through Sprint 6 per `scripts/analysis/code-inventory.md`.
- LLM-fallback path on terminal failure — that's Phase C+ `_llm-fallback.js` (Step 3a).

## Files modified / created

**Created:**

- `lib/fetch/fetch_html.js` — main fetch library
- `lib/fetch/challenge_detect.js` — pure WAF detector
- `lib/fetch/fetch_pdf.js` — PDF fetch library
- `lib/fetch/_playwright_session.js` — lifted from `lib/actions/_playwright_session.js`; shared browser launch helper used by all fetch_html rungs
- `lib/azure/doc_intelligence.js` — extracted from `lib/actions/extract_via_vision.js` (the layout-API + image-OCR client surface)
- `tests/lib/fetch/challenge_detect.test.js` — pure-function tests (no browser)
- `tests/lib/fetch/fetch_html.test.js` — orchestration tests with mocked Playwright
- `tests/lib/fetch/fetch_pdf.test.js` — orchestration tests with mocked pdfjs + mocked DocIntel
- `tests/lib/azure/doc_intelligence.test.js` — Azure client unit tests (mocked HTTP)

**Modified:**

- `lib/actions/extract_via_vision.js` — delegates to new `lib/azure/doc_intelligence.js`; keeps existing public surface so callers don't change
- `lib/actions/extract_via_ocr.js` — same: delegates to new shared client (Phase 0.3 code-inventory called for this)
- `lib/actions/extract_pdf_table.js` — gains an opt-in code path to use `lib/fetch/fetch_pdf.js` (env-gated `RDA_USE_NEW_PDF_FETCH=1`)

**Not modified in Step 1:** `lib/orchestrator.js`, `run-discovery.js`, `scripts/fetch_rates_playwright.js`. Step 1 is additive.

## Lifted utilities

| From | To | Why |
|---|---|---|
| `scripts/fetch_rates_playwright.js` (whole flag set + Playwright launch logic) | `lib/fetch/fetch_html.js` + `lib/fetch/_playwright_session.js` | Library-ify the CLI |
| `lib/actions/_playwright_session.js` (browser launch + stealth toggle) | `lib/fetch/_playwright_session.js` | Sprint 5 code-inventory called this out as a lift target |
| `lib/actions/extract_via_vision.js` (Azure client setup, polling, retry) | `lib/azure/doc_intelligence.js` | Sprint 5 code-inventory; PDF + image paths share |
| `scripts/utils/parse-pdf-rate-lines.js` (existing pdfjs-text path) | reused as-is by `lib/fetch/fetch_pdf.js` | Already tested and reliable for simple PDFs |

## API contracts

### `fetchHtml`

```js
async function fetchHtml({
  url,            // string, required
  templateFetch,  // object — template.fetch block from bank-domains.json (or {} for defaults)
  log,            // optional logger
  capturePath,    // optional — directory for HAR + screenshots on failure
}) {
  // returns
  return {
    status: 'success' | 'challenged' | 'failed',
    html: string | null,
    attempts: [
      { rung, browser, stealth, started_at, ended_at, ms, outcome, error?: { message, code } }
    ],
    challenge_detected: { vendor, signal } | null,
    final_strategy: 'default' | 'stealth' | 'firefox' | 'llm-fallback' | null,
    ms: number,                  // total elapsed
    iframe_traversed: boolean,
    capture_path?: string,       // HAR path on failure
  };
}
```

Escalation rungs from `templateFetch.retry_escalation` (default `['default', 'stealth', 'firefox', 'llm-fallback']`):
- `default` — chromium + standard UA
- `stealth` — chromium + playwright-extra + stealth plugin + rotating UA pool
- `firefox` — firefox engine (no stealth — stealth is chromium-only)
- `llm-fallback` — does NOT fetch; returns `status: 'failed', final_strategy: 'llm-fallback'` so the caller knows to route the unfetched URL through `_llm-fallback.js` (Step 3a)

Between rungs: if `challenge_detect.js` returns `challenged: true`, skip remaining `default` rungs and jump directly to `stealth`.

**Iframe traversal:** after page settle on any rung, enumerate `page.frames()`. If `templateFetch.iframe_selector` is set, switch the active frame to the first match and re-run the wait + extract.

**Wait condition:** if `templateFetch.wait_for_function` is set, use it. Else if `templateFetch.wait_for_selector` is set, wait for that. Else use the DEFAULT_WAIT_FN constant: `() => /%/.test(document.body.innerText) && document.querySelectorAll('table tr').length >= 3`. This default is the load-bearing fix for the JS-rendered .bank.in cluster.

**Per-bank timeout:** `templateFetch.timeout_ms` or 60000 default.

**HAR capture on failure:** when all rungs fail, write `<capturePath>/<bank>.har` and `<capturePath>/<bank>-final-screenshot.png` from the last rung's browser context for offline debugging.

### `challengeDetect`

```js
function detectChallenge({ html, status, headers, bodySize }) {
  return {
    challenged: boolean,
    vendor: 'cloudflare' | 'akamai' | 'cloudfront' | 'imperva' | 'unknown_waf' | null,
    signal: string | null,
  };
}
```

Signals (in order — first match wins):
1. Body matches `/Just a moment|Checking your browser|cf-chl-bypass|cf-mitigated/i` → cloudflare
2. Body matches `/Pardon Our Interruption|akamaihd\.net/i` → akamai
3. Body matches `/Access Denied|Request blocked.*cloudfront/i` → cloudfront
4. Body matches `/Imperva|incapsula/i` → imperva
5. Body matches `/Attention Required|blocked.*request/i` → unknown_waf
6. `status === 200 && bodySize < 5000 && !/<table/i.test(html)` → unknown_waf (suspiciously thin success)
7. `status === 403 || status === 429` → unknown_waf (challenge HTTP codes)

Pure function; testable without any network or browser dependencies.

### `fetchPdf`

```js
async function fetchPdf({ url, hints, log }) {
  // returns
  return {
    method: 'pdfjs' | 'doc_intelligence' | 'failed',
    pdfText: string | null,
    docIntelLayout: object | null,
    slabsPreview: number,        // best-effort count for routing decision
    ms: number,
    fallback_reason?: string,    // when method='doc_intelligence', why pdfjs wasn't enough
  };
}
```

Routing:
1. Download PDF to `os.tmpdir()/<sha>.pdf`. Use `lib/actions/_http.js#httpRequest`; clean up in finally.
2. Run pdfjs-dist text extraction (via existing `scripts/extract_rates_pdf.mjs` subprocess — already tested).
3. Pipe text through `scripts/utils/parse-pdf-rate-lines.js#parsePdfRateLines` to count preview slabs.
4. If slabs ≥ 3 AND no `hints.multi_column` flag → return `method: 'pdfjs'`.
5. Else → call `lib/azure/doc_intelligence.js#analyzeLayout(pdfBuffer)` → return `method: 'doc_intelligence'` with `fallback_reason`.

### `lib/azure/doc_intelligence.js`

```js
async function analyzeLayout({ pdfBuffer?, imageUrl?, imageBuffer?, log }) {
  // returns Azure prebuilt-layout result OR throws
  return {
    pages: Array<{ pageNumber, tables: Array<{ cells, rowCount, columnCount }> }>,
    // ... raw Azure DocIntel response
  };
}
```

Lifts from `lib/actions/extract_via_vision.js` + `lib/actions/extract_via_ocr.js`:
- `getClient()` — lazy-load `@azure/ai-form-recognizer`, env-var validation (`AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` + `AZURE_DOCUMENT_INTELLIGENCE_KEY`)
- `pollForResult()` — Azure async poller wrapper with timeout + retry
- `normalizeLayoutResponse()` — strips the verbose Azure response down to the slabs-friendly shape

## Verification

### Unit tests (no network, no browser)

- `challenge_detect.test.js` — 8 tests covering each signal pattern + boundary cases (empty body, oversized body with WAF text, status 200 with thin body, status 403 happy path)
- `fetch_html.test.js` — mocks the `playwright` and `playwright-extra` modules. 12 tests:
  - Single-rung happy path (default chromium succeeds, returns html)
  - Escalates default → stealth when challenge detected
  - Escalates default → stealth → firefox when stealth also blocked
  - All-rungs-fail returns `status: 'failed'`, attempts array populated
  - Honors `templateFetch.wait_for_function` over the default
  - Honors `templateFetch.iframe_selector` and switches frame
  - Per-bank timeout_ms is respected
  - HAR is captured on terminal failure
  - PDF URL short-circuits without launching a browser
  - `llm-fallback` rung returns immediately without fetching
- `fetch_pdf.test.js` — mocks `scripts/extract_rates_pdf.mjs` subprocess + Azure client. 6 tests covering pdfjs happy path, fallback fires on <3 slabs, fallback fires on multi-column hint, terminal failure, image-PDF routing.
- `doc_intelligence.test.js` — mocks the Azure SDK. 5 tests covering happy poll, retry on transient error, env-var validation, normalize shape.

### Integration smoke (manual, post-merge)

Pick one bank from each failure cluster in Phase 0.2 and run end-to-end via a small `scripts/probe/step-1-fetch-smoke.js` (NOT committed — operator-side):

| Cluster | Test bank | Expected outcome |
|---|---|---|
| JS-rendered .bank.in (~20 banks) | `alwar-central-co-operative-bank-ltd` | New default waitForFunction lets rates render; rows ≥ 5 |
| WAF-blocked FB | `bank-of-nova-scotia` | challenge_detect fires; stealth rung tried; documented if still blocked |
| Multi-column PDF | `axis-bank-limited` (fcnr PDF) | fetch_pdf hits DocIntel fallback; layout returned |
| iframe-wrapped | (TBD during smoke) | iframe traversal succeeds |

Integration smoke is operator-driven; tests in CI are pure-mocked.

## Risks and assumptions

1. **Playwright module-level mocking is fragile.** The existing `scripts/fetch_rates_playwright.js` uses `require('playwright')` at module load. The new library uses lazy-require inside `_playwright_session.js` so tests can intercept via require-cache injection. If a future Node version changes module resolution, mocks may break — mitigation: integration tests run on real Playwright in CI nightly.

2. **The DEFAULT_WAIT_FN may over-wait on some pages.** Sites that don't have tables (savings-only pages?) will time out. Mitigation: timeout fires within `timeout_ms`, attempt records the timeout, fetch_html still tries the next rung. Per-bank `wait_for_function` override is always available.

3. **HAR files can be large.** Mitigation: HAR captured only on FAILURE, written to `tmp/runs/` (gitignored), trimmed to last N requests via Playwright's `recordHar.omitContent: true`.

4. **The lib/actions/extract_via_vision.js → lib/azure/doc_intelligence.js refactor is invasive.** Callers stay on the old surface; the new shared client is the implementation. If the refactor breaks existing vision tests, we hold the lift and ship fetch_pdf with a temporary inline Azure client.

## Open follow-ups

- Wire `fetch_html` into the orchestrator (Step 2/4)
- Add `fetch_image` companion for image-based rate cards (Sprint 7 — currently `extract_via_ocr.js` covers it directly)
- HAR replay tool for golden-test fixtures (Sprint 7)

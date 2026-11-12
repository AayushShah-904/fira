# Step 1 (a/b/c) — Hardened fetch layer

**Date:** 2026-05-24
**Design:** `../design/fetch-layer-hardening.md`
**Plan:** `../plan/sprint-006-scope.md`

## What landed

Three new library modules + tests, all additive (no existing production code modified):

| Module | LOC | Tests |
|---|---:|---:|
| `lib/fetch/challenge_detect.js` (Step 1b) | 80 | 19 |
| `lib/fetch/_playwright_session.js` (Step 1a helper) | 175 | covered via fetch_html tests |
| `lib/fetch/fetch_html.js` (Step 1a) | 175 | 14 |
| `lib/azure/doc_intelligence.js` (Step 1c) | 130 | 10 |
| `lib/fetch/fetch_pdf.js` (Step 1c) | 175 | 10 |

**Total:** ~735 LOC + 53 new tests, all passing. Full suite: 978 pass / 0 fail / 51 skip (vs sprint-005 close at 926).

## Step 1a — `fetch_html.js`

Library function `fetchHtml({url, templateFetch, log, capturePath, _runRung}) → {status, html, attempts, challenge_detected, final_strategy, ms, iframe_traversed, capture_path?}`.

Key behaviors:
- **Escalation rungs** in order (default `[default, stealth, firefox, llm-fallback]`); overridable per-bank via `templateFetch.retry_escalation`
- **Jump-to-stealth**: when `challenge_detect` flags a response on a non-stealth rung, skip intervening rungs and go directly to `stealth` (used once per fetch to avoid loops)
- **PDF short-circuit**: URLs ending in `.pdf` return without launching a browser, with a `reason` telling the caller to use `fetch_pdf.js`
- **`llm-fallback` rung**: returns `status: 'failed', final_strategy: 'llm-fallback'` without fetching — the dispatcher uses this signal to route to Phase C+ `_llm-fallback.js` (Step 3a)
- **Iframe traversal**: when `templateFetch.iframe_selector` is set, switches active frame after page settle and re-waits inside the iframe
- **DEFAULT_WAIT_FN**: `() => /%/.test(document.body.innerText) && document.querySelectorAll('table tr').length >= 3` — the load-bearing fix for the ~20-bank JS-rendered `.bank.in` cluster from Phase 0.2
- **HAR + summary capture** on terminal failure to `<capturePath>.har` + `<capturePath>.summary.json`

Test injection via `_runRung` parameter lets unit tests script per-rung behavior (success / challenge / throw) without launching real Playwright. The `lib/fetch/_playwright_session.js` helper is what runs in production; tests bypass it.

## Step 1b — `challenge_detect.js`

Pure function `detectChallenge({html, status, headers, bodySize}) → {challenged, vendor, signal}`.

Signal sources in order:
1. Body matches `Just a moment|Checking your browser|cf-chl-bypass|cf-mitigated/cloudflare` → cloudflare
2. Body matches `Pardon Our Interruption|akamaihd\.net` → akamai
3. Body matches `Request blocked.*cloudfront` → cloudfront
4. Body matches `Imperva|incapsula` → imperva
5. Body matches `Attention Required|blocked.*request|web application firewall` → unknown_waf
6. **Thin-body heuristic**: `status === 200 && bodySize < 5000 && !<table>` → unknown_waf
7. HTTP 403 → unknown_waf, HTTP 429 → rate-limit
8. Header `server: cloudflare` WITH status ≥ 400 → cloudflare

19 tests covering each signal + boundaries (404 NOT flagged as WAF; 500 NOT flagged; oversized body without table NOT flagged; header server=cloudflare with 200 NOT flagged).

## Step 1c — `fetch_pdf.js` + `lib/azure/doc_intelligence.js`

**Scope adjustment from the design doc** (documented in both code comments and design doc Risks #4):

The original Phase B plan called for `lib/actions/extract_via_ocr.js` and `lib/actions/extract_via_vision.js` to be refactored to delegate to a shared `lib/azure/doc_intelligence.js`. That refactor is invasive — both files have 30+ existing tests built around their current shapes. **Sprint 6 Step 1c instead ships `lib/azure/doc_intelligence.js` as a NEW thin wrapper** that `lib/fetch/fetch_pdf.js` uses directly. The old modules continue working unchanged. The lift of `extract_via_ocr` and `extract_via_vision` onto this shared client is deferred to end-of-Sprint-6 or Sprint 7.

This keeps Step 1c blast radius small (zero modifications to working modules) while still delivering the shared Azure client for the new PDF fetch path.

`lib/azure/doc_intelligence.js` exports:
- `buildClient()` — throws `code: 'DOCINTEL_NOT_CONFIGURED'` if env missing
- `analyzeUrl({url, client?, log?})` — invokes `prebuilt-layout` model on a URL
- `analyzeBuffer({pdfBuffer, client?, log?})` — invokes on a Buffer (used by fetch_pdf which has the bytes in hand)
- `previewMetrics(result)` — slabs-friendly preview shape
- `isConfigured()` — boolean check used by fetch_pdf to decide whether the fallback is available

`lib/fetch/fetch_pdf.js` routing:
1. Download PDF via existing `lib/actions/_http.js#httpRequest`
2. Run `scripts/extract_rates_pdf.mjs` subprocess (pdfjs-dist text extraction)
3. Count slabs via `scripts/utils/parse-pdf-rate-lines.js#parseRateLines`
4. If slabs ≥ 3 AND no `hints.multi_column` → return `method: 'pdfjs'`
5. Else if DocIntel configured → call `analyzeBuffer` → return `method: 'doc_intelligence'` with `fallback_reason`
6. Else → return pdfjs result with `would_have_used_doc_intel` note (no-throw fallback when DocIntel disabled)

10 tests covering each routing branch + DocIntel failure rescue (DocIntel throws → fall back to whatever pdfjs gave us, with chained `fallback_reason`).

## Findings during implementation

1. **`parseRateLines()` returns `{slabs, warnings}`, not an array.** First implementation of `fetch_pdf.js` treated the return value as an array, which silently returned 0-length and triggered DocIntel fallback in the happy path. Fixed defensively to accept both shapes.

2. **The existing `lib/actions/_playwright_session.js` has a per-bank lifecycle** (one session per `orchestrate()` call, used for the orchestrator's HTTP-like calls). Sprint 6 Step 1a needed a per-rung lifecycle (different engine/stealth per rung). Created a NEW `lib/fetch/_playwright_session.js` rather than retrofitting the existing one — different responsibilities, different ownership, no risk of regressing orchestrator-path tests.

3. **The pre-existing `safe-write-exempt` discipline carried through cleanly.** All 5 new `fs.writeFileSync` / `fs.unlinkSync` call sites are annotated. `npm test` pretest hook stays green.

## Verification

```
$ node --test tests/lib/fetch/challenge_detect.test.js   → 19 pass
$ node --test tests/lib/fetch/fetch_html.test.js        → 14 pass
$ node --test tests/lib/fetch/fetch_pdf.test.js          → 10 pass
$ node --test tests/lib/azure/doc_intelligence.test.js   → 10 pass

$ npm test  → 978 pass / 0 fail / 51 skip (978 total tests)
```

## Open follow-ups (Sprint 6 later steps)

- **Step 1d — `scripts/author-template.js`** — uses `fetch_html.js` for the per-bank fingerprint flow.
- **Step 1e — `scripts/analysis/harvest-golden-html.js`** — uses `fetch_html.js` to backfill the 50 `.html` companions; the moment it runs, the 50 skipped golden tests bite.
- **Step 1f — Phase A.4 deep fix** — re-attempt-via-orchestrator for `scraper_type:null` banks, using the new fetch layer.
- **Sprint 7 (or end-of-Sprint-6 cleanup)**: refactor `lib/actions/extract_via_ocr.js` and `lib/actions/extract_via_vision.js` to delegate to `lib/azure/doc_intelligence.js` (the deferred-from-Step-1c lift).

## Risks tracked

1. **Real-Playwright integration smoke is pending.** All Step 1a/1c tests use injected mocks. Operator should run a Phase B integration smoke against ~5 real banks (one per failure cluster) before Step 4 migration starts. Smoke script lives in `scripts/probe/` (operator-side, NOT committed).
2. **HAR file size on busy pages.** Mitigated by `omitContent: true` in the recordHar config + only emitting on terminal failure.
3. **The `lib/azure/doc_intelligence.js` scope adjustment leaves duplicate Azure client code** in `extract_via_ocr.js`/`extract_via_vision.js`. Tracked as a Sprint 7 cleanup. Until then there are two paths into the Azure SDK; they don't conflict because each uses its own client instance per call.

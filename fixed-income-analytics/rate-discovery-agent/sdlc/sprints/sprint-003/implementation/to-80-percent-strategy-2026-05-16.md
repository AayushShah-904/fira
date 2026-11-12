# Strategy to ≥ 80 % orchestrator coverage (2026-05-16, post Phase 3)

Resume point after Phase 3 commit `cb3ce7e`. Read this with `option-a-c-handoff-2026-05-16.md` and the Phase 3 smoke `output/runs/smoke-p3-cb3ce7e/REPORT.md`.

## Where we are

| Bank | LLM | Orch P3 | Δ | Why we lose slabs |
|---|---:|---:|---:|---|
| SBI | 28 | 22 | −6 | FCNR file not written; rendered HTML for FCNR likely truncated past slab block |
| HDFC | 70 | 0 | −70 | Rate pages fetched (1 MB rendered), cheerio returns 0; `extract_html_table` errored on Path B subprocess; LLM fallback never fired because `bodyForFallback` was unset |
| AU SFB | 7 | 4 | −3 | NRO + FCNR 0 (regressed from 2+1=3 baseline); same TENURE_RE blind spot for `1 Yr`, plus truncation |
| Abhyudaya | 5 | 5 | 0 | Stable; no change needed |
| BOI-IBU (gift) | 64 | 0 | −64 | `bank-domains.json` has NO `rate_pages` for `bank-of-india-ibu` (verified); find_rate_page can't short-circuit, anchor crawl on `bankofindia.bank.in` Playwright-times-out + Node-fallback returns no useful link |
| **Total** | **174** | **31** | **−143** | |

Current coverage: 31/174 = **18 %**. To reach ≥ 80 % we need 139 slabs — i.e., recover **108 of the 143 missing slabs**.

## Where the gains live (ordered by leverage × certainty)

| Lever | Banks affected | Expected recovery | Confidence | Effort |
|---|---|---:|---|---|
| **A.** Seed `bank-of-india-ibu.rate_pages.fd_gift` in `data/bank-domains.json` | BOI-IBU | +64 | High (just unblocks find_rate_page → recheck mode → cached_path trust path) | Trivial |
| **B.** Phase 4 — `classify_rate_page` returns `body_html`; orchestrator passes as `hints.cached_body` to `extract_html_table` | HDFC, AU SFB, SBI FCNR | +25 to +50 | Med-High (Path A in extract_html_table is the well-tested cheerio path; sidesteps the subprocess dispatcher's truncation + errors) | Med |
| **C.** Raise `_http.js` `DEFAULT_MAX_BYTES` 512 KB → 2 MB; raise `_playwright_session.fetch` default `maxBytes` 2 MB → 4 MB | HDFC (1 MB pages), SBI FCNR | +6 to +20 | High | Trivial |
| **D.** Phase 5a — expand `_cheerio_tables.js` `TENURE_RE` (`Yrs?·Mos?·Wks?·Hrs?·p\.?a\.?` + bare `N to M`) | AU SFB, HDFC | +10 to +30 | High (regex change with new fixtures) | Low |
| **E.** Phase 5c — `inferColumnMapping(rows)` in `scripts/extract_rates.js` | HDFC, AU SFB | +15 to +40 | Med (HDFC's exact table shape needs inspection) | Med |
| **F.** Ensure `extract_html_table` LLM fallback fires when Path B dispatcher throws (HDFC today: `is_error: true`, fallback never ran) | HDFC, BOI-IBU | +20 to +50 | Med | Low |
| **G.** Switch session.fetch `waitUntil` from `networkidle` to `domcontentloaded` for orchestrator-delegated fetches | all 5 (latency, not slabs) | 0 slabs, ~3× faster wall clock | High | Trivial |

Sum of midpoints: A+B+C+D+E+F = 64 + 37 + 13 + 20 + 27 + 35 = **+196 slabs available**. We only need +108. So even if 4 of 6 levers underperform, we should clear 80 %.

## Recommended sequencing for tomorrow

Each step ends with `npm test` green + a one-bank smoke (cheap) before moving on.

### Step 1 — Quick wins (A + C + G) — same commit

- A: Add `bank-of-india-ibu.rate_pages.fd_gift` (URL TBD from RBI's IFSCA list; tomorrow's first task is finding the canonical BOI GIFT URL).
- C: `lib/actions/_http.js` `DEFAULT_MAX_BYTES = 2 * 1024 * 1024`; `_playwright_session.js` `maxBytes = 4 * 1024 * 1024`.
- G: `_playwright_session.fetch` default `waitFor = 'domcontentloaded'` (currently `'networkidle'`). The full-extraction path can override back to `networkidle` if rate widgets need it.

Smoke target after Step 1: BOI-IBU → 64 slabs, SBI FCNR back to 6, AU SFB regression healed. Expected total ≈ **31 + 64 + 6 + 3 = 104 slabs (60 %)**.

### Step 2 — Phase 4 cached_body plumbing (B)

`classify_rate_page` returns `body_html` (when kind is html_static/html_js); orchestrator passes into `extract_html_table.hints.cached_body`. `extract_html_table` already prefers Path A when cached_body is set — but verify it doesn't get truncated again at a different cap on the way through.

Smoke target after Step 2: HDFC and AU SFB no longer fetch their rate pages 2–3× per orchestrate(). HDFC may start returning slabs IF cheerio can parse its DOM — this is the **uncertainty bet** for tomorrow.

If HDFC still 0 after Step 2 → proceed to Step 3 (Phase 5a).
If HDFC > 30 → Step 2 alone may have crossed 80 %.

### Step 3 — Phase 5a TENURE_RE (D)

Expand `lib/actions/_cheerio_tables.js` line 35; add 4 fixtures to `tests/lib/actions/_cheerio_tables.test.js`. Recovers AU SFB's `1 Yr` cells; helps HDFC where applicable.

Smoke target after Step 3: AU SFB → 7+ across variants. HDFC partial recovery if its cells use abbreviations.

### Step 4 — Phase 5c column inference (E)

`scripts/extract_rates.js` `inferColumnMapping(rows)` — sample first 3 rows, detect percentage vs tenure columns, build per-table mapping. Keep config default as fallback.

Smoke target after Step 4: HDFC NRE/NRO/FCNR recover (different table shapes than `{0:tenure, 1:general, 2:senior}`).

### Step 5 — LLM fallback assurance (F)

Audit `extract_html_table.js:200–234`. When Path B dispatcher throws, `bodyForFallback` stays null and LLM never fires. Fix: even on dispatcher throw, attempt one fresh `httpRequest(url, 'GET', { session })` to populate `bodyForFallback` before deciding on LLM.

This is the last-resort lever for HDFC if 5a + 5c don't fully fix it.

### Step 6 — Run the 5-bank smoke + commit Phase 6 (telemetry)

`output/runs/smoke-to-80-<sha>/` + REPORT.md. Update `two-path-architecture.md` with the metrics table. Target ≥ 139/174 = 80 %.

## Open questions to resolve tomorrow (before coding)

1. **BOI GIFT URL.** RBI's IFSC notification or BOI's own corporate site lists their GIFT IBU rate page. If we can't find a stable URL, Step 1A becomes Step 1A′: pass `bank_type=IBU` into a new IBU-specific path-pattern list in `find_rate_page` (`/gift-ifsc/`, `/gift-city/deposit-rates`, etc. — already exists in `PATH_PATTERNS.fd_gift` but the HEAD-checks fail under WAF; Playwright session should succeed).
2. **Is HDFC's table cheerio-parseable at all?** Save the rendered HTML (`output/runs/smoke-p3-cb3ce7e/hdfc-bank-limited.trace.jsonl` likely has it) and run the cheerio extractor against it offline. If it can't pick a table, prefix Step 3 with that diagnostic; don't proceed to 5c until 5a is shown to help.
3. **Is the 6-slab SBI FCNR loss truly truncation?** Compare today's FCNR rendered HTML byte length vs the slab table's offset. If truncated past 512 KB, Step 1C alone fixes it.
4. **Does `domcontentloaded` lose rate data on JS-rendered pages?** For pages where rates load post-DOM (XHR), DOM-ready isn't enough. Mitigation: keep `networkidle` for `extract_html_table` (it uses its own session.fetch call once Phase 4 wires it through); only use `domcontentloaded` for the cheap delegated fetches inside `find_*` and `classify_*`.

## Stop conditions

- Time-box: 4 hours of dev time. If we're not at ≥ 60 % by hour 3, switch from Phase 5 to widening LLM fallback (Step 5) — cost ≤ $0.50 per bank is acceptable per the spec.
- If HDFC stays 0 after Steps 1–5: accept it as a Phase 7 carve-out, don't block ≥ 80 %. We can hit 80 % without HDFC by recovering BOI-IBU + AU SFB + SBI FCNR + finding incremental slabs on the other co-op / small SFB cohort.

## Resume command (paste verbatim tomorrow)

```
Continue Phase 4/5 of option A+C per
sdlc/sprints/sprint-003/implementation/to-80-percent-strategy-2026-05-16.md.
Start with Step 1: quick wins (A+C+G). Find the BOI-IBU GIFT URL first.
```

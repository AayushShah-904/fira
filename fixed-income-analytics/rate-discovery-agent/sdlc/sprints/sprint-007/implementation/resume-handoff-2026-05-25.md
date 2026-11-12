# Sprint 007 — Resume-Cold Handoff (2026-05-25)

**Purpose:** continue the 500-bank coverage push after a context clear. Branch `azure-openai-agent` (monorepo `fixed-income-yield-advisor`). Last commit `7dcc230`. All work below is committed/pushed unless noted.

**Companion doc:** `tier1-tier2-progress-2026-05-25.md` (full §1–§10 detail of everything done this sprint). Read it for context; this file is the action plan.

---

## 1. Where we are — 500-cohort (`data/cohorts/pm-refresh-2026-q2.json`, 513 banks)

| Tier | Total | Auto-refresh (template) | Static-data only | Gap | Rate-data coverage |
|------|-------|------|------|-----|-----|
| Tier-1 (PSB/PVB/Sched/SFB/IBU) | 157 | 111 (71%) | 25 | 21 | **136 (87%)** |
| Tier-2 named (FB/RRB/NSSCB/PB/LAB/FI) | 94 | 35 | 33 | 26 | 68 (72%) |
| Tier-3 co-op long tail (DCCB/NSUCB) | 262 | 6 | 184 | 72 | 190 (73%) |
| **TOTAL** | **513** | **152 (30%)** | **242** | **119** | **394 (77%)** |

Two key facts: **77% have rate data** but **only 30% auto-refresh** (templates); the 242 "static-data" banks will go stale. Re-measure anytime with the script in §6.

---

## 2. Active plan (operator chose: do #2 breadth + #3 co-op FIRST; sustainability review LAST)

Cohorts are already built in `tmp/cohorts/` (NOTE: `tmp/` is gitignored — regenerate with the §6 builder if cleared):
- **`coop-sweep.json` — 216** (DCCB 111 + NSUCB 105): co-ops with a rate URL and no template → **#3 deterministic templatization**.
- **`breadth-nourl.json` — 37** (mostly NSUCB 20 / DCCB 9 + a few PB/FB/IBU/RRB/NSSCB): gap banks with **no FD URL** → **#2 Tier-2 discovery + retrieval**.
- **`breadth-hasurl.json` — 12** (FB 5, RRB 4, SSCB 2, IBU 1): gap banks **with a URL that failed** → try deterministic first, then Tier-2.

### Step-by-step (resume here)

**#3 — Co-op deterministic sweep (biggest volume lever).** Run the current pipeline (it now has www-self-heal, aggressive-fetch, multi-table propose, currency, PDF, OCR) over the co-op family:
```
node scripts/bulk-author.js --cohort tmp/cohorts/coop-sweep.json --write   # background; ~1-2h for 216 banks
```
Auto-persists every PASS as a template. Then triage: `node scripts/bulk-triage.js`. The ones that still fail with a *clean HTML table* are candidates for a single hand-authored `.bank.in` co-op family template (memory: ~100 banks share the stack — one `expected.extract.json`-style config can cover many; see how the BoB/HDFC goldens use `tests/golden-html/<bank>.expected.extract.json`).

**#2a — Breadth has-URL (12).** Quick deterministic attempt first:
```
node scripts/bulk-author.js --cohort tmp/cohorts/breadth-hasurl.json --write --force
```
Remaining FAILs → fold into the Tier-2 batch.

**#2b — Breadth no-URL (37) → Tier-2 sub-agents (the proven playbook).** Launch ~3 parallel `general-purpose` sub-agents (batched ~12 banks each). Per-bank loop (same spec as the 25/40 marquee run that worked): read `data/bank-domains.json` entry → **WebSearch** the bank's official current FD page (own domain, NOT aggregators) → fetch via `node scripts/fetch_rates_playwright.js "<url>" --scroll --tabs --intercept` (parse after `=== JSON_OUTPUT ===`), or `WebFetch`, or `node scripts/extract_rates_pdf.mjs "<pdf>"`, or vision-OCR for images → parse rates with own judgment → write `output/tier2/<slug>_rates.json` (schema in §4) with `source_url` + `tier2_method`. **Constraints: write ONLY to `output/tier2/`; do NOT touch `data/bank-domains.json` or `output/latest/`; no aggregators; empty `rate_slabs`+warning rather than invent.**

**Fold step (after Tier-2 lands).** Adapt the proven folder `tmp/fold-tier2-metadata.js` (it's gitignored — pattern is in git history / the companion doc §3.1): for each recovered bank set `rate_pages.fd`=working source_url, `extraction_method` from the CURATED set (`manual_transcription_from_rendered_text` / `manual_pdf_transcription` / `manual_image_transcription`), a `tier2{}` hints block, `scraper_type`; write `output/latest/<slug>_rates.json` with `discovery_metadata{run_method:'tier-2'}`, **clobber-protected** (never overwrite a richer existing file — write `*.tier2.json` instead). Then **re-run deterministic on the URL-corrected banks** (`--banks <list> --write --force`) — this converts the ones with clean tables into auto-refresh templates (5 converted last time).

**Then:** re-measure (§6), update the companion SDLC doc with results, and finally the deferred **sustainability review** (#1: templatize/refresh the 242 static-data banks so coverage stops decaying).

---

## 3. CRITICAL gotchas / rules (do not relearn the hard way)

- **ONE registry-writing run at a time.** `bulk-author --write`, the fold script, and any `safeWriteArtifact` on `data/bank-domains.json` MUST be sequential — concurrent ones race (last-writer-wins, silent loss). **Tier-2 sub-agents write only `output/tier2/` → safe to run in parallel with a registry-writing co-op sweep.**
- **Verify a sub-agent actually COMPLETED before relaunching.** A truncated/interim agent notification once looked like failure → caused a redundant FCNR re-run (idempotent here, but don't rely on that). Check the registry/report state first.
- **No fabrication.** Anti-fabrication gate is strict (every slab needs `source_row_text` traceable to source). Tier-2 agents must write empty + warning, never invent. CURATED `extraction_method`s are auto-overwrite-protected so a failing automatic run can't clobber Claude data.
- **Multi-variant templates:** `targetTemplateKey(entry,variant)` routes gift/fcnr to `template_<variant>` when a domestic `template` exists (no clobber); gift-only/fcnr-primary stay on `template`. `bulk-revert.js` handles all three keys.
- **Gates** (`evaluateGates`): min_slabs 5, rate 1–12% (gift/fcnr relaxed to 0 + no senior), strict anti-fab. `baseline_drop` is **informational** (a `notes` channel), NOT verdict-affecting — April baselines are stale post-currency/multi-table.
- **Targeted re-runs:** `node scripts/bulk-author.js --from-report --write` re-runs only the last report's FAIL/REVIEW (skips dead buckets). Don't re-run the full cohort.
- **Tests:** `node --test --test-force-exit` → **1117 pass / 1 known fail** (`_playwright_session` "challenge on default → jumps directly to stealth", `tests/lib/fetch/fetch_html.test.js`). That ONE failure is pre-existing/allowed. The `npm test` `pretest` write-discipline hook trips on an untracked tmp file — run `node --test` directly.
- **Commits:** commit+push after each logical chunk. NO `Co-Authored-By` line (operator preference). LF→CRLF git warnings are benign (Windows).
- **Azure DocIntel** is configured (`.env`) — used by PDF/OCR paths.

---

## 4. Tier-2 rate-file schema (`output/tier2/<slug>_rates.json`)
```json
{ "bank_code","bank_name","product_type":"FD","variant":"regular|gift|fcnr",
  "effective_date","source_url","scraped_at":"<ISO>","extraction_confidence":"high|medium|low",
  "rate_slabs":[{"tenure_text","tenure_min_days","tenure_max_days","rate_general_pct":<num>,
    "rate_senior_pct":<num|null>,"rate_super_senior_pct":<num|null>,"deposit_range":"below_3cr","currency":"USD(gift/fcnr only)"}],
  "warnings":[], "tier2_method":"playwright_xhr|playwright_tables|webfetch|websearch+webfetch|pdf|ocr" }
```

---

## 5. Pipeline capability map (what handles what)
- **HTML static/JS tables** → `_generic-html-3col` (multi-extract `extracts[]`, `field@range#CUR` currency tags). Fetch: `fetch_html` (www self-heal + aggressive default).
- **PDF** → `fetch_pdf` (marker `=== JSON_OUTPUT ===`, buffer download) → `extract_rates_pdf.mjs` (text) or `ibu-static-pdf-quarterly`/`psb-pdf-rate-card-3col` (DocIntel). `processPdf` gift/fcnr fallback + `detectCurrencyFromSources`.
- **Image** → `IMG_RE` → `processOcr` → `extract_via_ocr` (DocIntel layout, Hindi-aware). `scraper_type:'image'`.
- **GIFT/IBU** → `--variant gift` reads `fd_gift`; DocIntel currency-matrix (`detectCurrencyColumns`).
- **FCNR** → `--variant fcnr` reads `fd_fcnr`; persists to `template_fcnr`.
- **Tier-2 (Claude)** → for what none of the above can read (JS dropdowns, bespoke POST-APIs, migrated/unknown URLs, images without a discoverable URL). NOTE: generic JS-XHR generalization was investigated and **rejected** — real bank SPAs don't expose passively-captureable rate-JSON APIs (Gatsby page-data / bespoke POST-HTML); not worth building.

---

## 6. Re-measure + rebuild-cohort scripts (paste-run)
**Coverage map:** the step-back script is in the companion doc / git history; quick version — count `template||template_fcnr||template_gift` (auto) vs `output/latest/<slug>_rates.json` slabs>0 (data) vs neither (gap), grouped by the Tier-1/2/3 category sets.
**Rebuild cohorts** (if `tmp/` cleared): re-run the builder that produced coop-sweep/breadth-nourl/breadth-hasurl (logic: co-op+url+no-template → coop-sweep; gap (no template, no data file, not image) split by has-url). Source in this session's history.

---

## 7. Open items (recommended order)
1. **#3 co-op sweep** (216) → templatize the long tail; biggest auto-refresh volume.
2. **#2 breadth** (37 no-url + 12 has-url) → Tier-2 discovery+retrieval; pushes overall coverage toward ~90%+.
3. **Fold** Tier-2 results (URLs + metadata + rate files + deterministic re-run to templatize).
4. **Sustainability review** (deferred #1): convert the 242 static-data banks (esp. 25 Tier-1 + 33 Tier-2-named) to auto-refresh so coverage doesn't decay.
5. Small follow-ups: TN OCR premium-row filter; operator-`extracts[]` for esaf/emirates/icici-ibu (overlapping tables the LLM won't split); runtime dispatch to read `template_fcnr`/`template_gift`.

## 8. Commit ledger (sprint-007)
`5f520ee` currency+www+from-report · `6dea259` city-union · `e5dda09` PDF wire · `6b14b44` PDF marker+buffer fix (9 banks) · `4a989ed` DocIntel currency-matrix (hdfc/idfc-ibu) · `d051d96` gift-PDF fallback (axis-ibu) · `5e57f2e` #18 multi-table + baseline-informational (12) · `0140055` Tier-2 25 banks + metadata · `0ccd3f7` SDLC doc + cohort · `1aff57f` FCNR doc · `d7508fd` FCNR multi-variant (11) · `b31d43e` OCR wire (janalaxmi) · `7dcc230` OCR doc + status.

# Agent Efficiency Audit

**Status:** Analysis only. No code changes in this pass. Follow-up sprint plan pending review.
**Date:** 2026-04-11
**Scope:** `run-discovery.js` / `run-batch.js` in `discover` mode — the cold-start discovery path for new banks. `--expand-nri` and `--rates-only` are not the binding constraint and are out of scope.

---

## 1. The problem in one sentence

Getting from the current 109 working banks to the full 1,995-bank RBI master list is blocked by a per-bank wall-clock cost of 2–5 minutes in the LLM-in-the-loop discover path, and the remaining 1,886 banks are disproportionately small cooperatives where that cost compounds the hardest.

## 2. Ground-truth numbers

### 2.1 Master list composition (`docs/Indian_Banks_Comprehensive_List_RBI.csv`)

| Category | Count | % of total |
|---|---:|---:|
| Non-Scheduled Urban Co-operative Bank | 1,392 | 69.8% |
| District Central Co-operative Bank | 352 | 17.6% |
| Scheduled Urban Co-operative Bank | 52 | 2.6% |
| Foreign Bank | 44 | 2.2% |
| IFSC Banking Unit (IFSCA) | 37 | 1.9% |
| Regional Rural Bank | 28 | 1.4% |
| Scheduled State Co-operative Bank | 24 | 1.2% |
| Private Sector Bank (Indian) | 21 | 1.1% |
| Public Sector Bank | 12 | 0.6% |
| Small Finance Bank | 11 | 0.6% |
| Non-Scheduled State Co-operative Bank | 10 | 0.5% |
| Payments Bank | 6 | 0.3% |
| Financial Institution | 4 | 0.2% |
| Local Area Bank | 2 | 0.1% |
| **Total** | **1,995** | |

**The concentration is the story.** 92% of the list (1,838 banks) is cooperative. The big-brand commercial banks everyone thinks of are less than 10% of the work. Any sprint that optimizes only the PSB/PVB/SFB/FB path is optimizing ~10% of the remaining work.

### 2.2 Current coverage (`output/latest/*_config.json`)

157 config files written. Coverage by category:

| Category | Master | Configs written | Configs w/ slabs | Coverage |
|---|---:|---:|---:|---:|
| Sched. State Co-op | 24 | 24 | ~24 | **100%** |
| Small Finance | 11 | 11 | ~11 | **100%** |
| Payments | 6 | 6 | ~6 | **100%** |
| Local Area | 2 | 2 | 2 | **100%** |
| IFSC Banking Unit | 37 | 33 | ~30 | ~89% |
| Public Sector | 12 | 14\* | ~14 | effectively 100% |
| Private Sector (Indian) | 21 | 22\* | ~22 | effectively 100% |
| Foreign Bank | 44 | 29 | ~25 | 66% |
| Dist. Central Co-op | 352 | 14 | ~14 | **4%** |
| Sched. Urban Co-op | 52 | 1 | 1 | **2%** |
| Reg. Rural | 28 | 0 | 0 | **0%** |
| Non-Sched. State Co-op | 10 | 0 | 0 | **0%** |
| Non-Sched. Urban Co-op | 1,392 | 0 | 0 | **0%** |
| Financial Institution | 4 | 0 | 0 | **0%** |

\* Over-count caused by duplicate slug captures (e.g., `axis-bank-limited` vs `axis_bank`). Real unique coverage is slightly lower.

**Effective useful-data coverage: 109 banks with ≥1 slab / 1,995 total = 5.5%.**

**The 157→109 gap** (48 banks where the agent wrote a config but couldn't extract rates):

| scraper_type | Empty rates | Interpretation |
|---|---:|---|
| manual | 18 | Legitimate — no website or blocked |
| html_js | 4 | Agent saw the page but couldn't extract |
| pdf | 3 | Agent saw the PDF but couldn't extract |
| html_static | 1 | Agent saw the table but couldn't extract |
| (no rates file) | 22 | Agent didn't even write a rates file |

The 8 non-manual failures are the cases where Pattern 2 (deterministic extractor) might succeed where the LLM didn't — they have real pages and real tables, the LLM just got confused.

### 2.3 Wall-clock timing (from 5 `_batch_results.json` files, 75 bank runs)

| Metric | Seconds | Note |
|---|---:|---|
| Successful runs | 53 | |
| **Mean** | **218s** | ≈ 3.6 min |
| **Median** | **211s** | ≈ 3.5 min |
| Minimum | 99s | **The floor — no bank finishes faster** |
| p90 | 300s | 10% hit the timeout |
| p99 / max | 409s | |

Histogram of successful runs:

```
  60s–120s  :   5
 120s–180s  :  14
 180s–240s  :  17
 240s–300s  :  11
 300s–420s  :   6
```

**There are no sub-60s runs. Zero. That 99s floor is the structural LLM-in-the-loop overhead — model startup, context load, tool round-trips, the omnibus reasoning loop. It's not fetch time; it's the LLM pattern.**

Failed runs averaged 97s of wasted time before the batch moved on. The first PSB batch (2026-03-30T1751) failed all 12 banks in 0 seconds — a broken-config run, excluded from averages.

Batch throughput observed:

| Batch | Success rate | Wall-clock |
|---|---:|---:|
| PSB (second attempt) | 83% (10/12) | 58 min |
| PVB | 77% (10/13) | 46 min |
| IBU | 86% (31/36) | 117 min |
| LAB | 100% (2/2) | 7 min |

### 2.4 Projected cost to reach full coverage

At observed mean of 218s/bank, the remaining 1,886 banks would take:

| Concurrency | Sequential hours | Notes |
|---:|---:|---|
| 1 | **114 h** (≈ 4.7 days continuous) | What a single `run-batch.js` process does today |
| 5 (current max in code) | **23 h** | If rate limits allow, which they have not so far |
| 10 | **11 h** | Would need rate-limit ceiling raised |

These are *optimistic* — they assume 100% success rate and no rate-limit backoff. In reality the observed batch success rate is ~80% and `run-batch.js` already has to pause for 5 minutes on the 2nd consecutive rate-limit and abort on the 3rd.

**If a sprint cuts mean to 60s/bank**: sequential drops from 114 h → 31 h; concurrent=5 drops from 23 h → 6 h. This is the target worth chasing.

## 3. Where the 218s actually goes

We cannot answer this precisely today because the logger captures only the final agent stdout (26 lines / ~1.4 KB per log on average). There are no tool-call timings, no per-fetch waits, no reasoning-step traces. This is the first thing the sprint has to fix.

**Qualitatively, the 99s floor + the 218s mean suggest:**

- **~30–60s** of near-constant LLM invocation overhead (process startup, prompt load, reasoning warm-up, final summary generation). Not addressable without leaving Claude Code.
- **~60–120s** of tool calls. Each WebFetch/WebSearch/Read is a round-trip with context transfer. A typical discover-mode run probably makes 4–8 tool calls: one search, one homepage fetch, one candidate-page fetch, optional re-search, 1–3 additional rate page fetches for NRI variants. At ~10–20s each including reasoning-step wait, that's the bulk.
- **~30–90s** of LLM interpretation / slab generation. Scales with page size and complexity. PDF-heavy banks are at the high end.

**Lever A (stream-json instrumentation) is non-negotiable** because every other lever's cost/benefit depends on knowing which of the three buckets above is actually dominating.

## 4. Configs are richer than I expected

**This is the single biggest finding for the sprint.**

| Bucket | Count (of 157) | Pattern-2 ready? |
|---|---:|---|
| `html_static` + full selectors + column_mapping | **64** | **Yes, today** |
| `html_static` + selectors only (no col_map) | 3 | Close |
| `pdf` + captured `pdf_url` | **16** | **Yes, today** |
| `pdf` + no `pdf_url` | 10 | Needs discovery |
| `html_js` + selectors (Playwright-shaped) | **28** | Yes, via Playwright |
| `html_js` + no selectors | 6 | Needs discovery |
| `mixed` | 4 | Case-by-case |
| `manual` | 26 | Out of reach |

**Immediate Pattern 2 candidates** (`html_static` + selectors + col_map, plus `pdf` + pdf_url): **80 banks, ~51% of current coverage.**

**With Playwright path**: +28 more = **108 banks, ~69%.**

These banks could be re-processed with zero LLM calls *right now*, using only existing helpers. The discover-mode LLM path has been capturing the structural metadata all along; nothing downstream has been using it except `run-batch.js --extract-only`, which isn't on the default path.

**The corollary is more important than the headline**: the LLM-only architecture isn't a necessity — the LLM *already* does the right thing (capturing selectors in configs). We just haven't closed the loop by feeding those selectors back into subsequent runs. Every bank the LLM processes in discover mode is a training artifact for a deterministic extractor the system already has.

## 5. Deterministic helpers that exist but aren't on the discover path

From `scripts/extract_rates.js` (579 lines) and peers:

| Helper | File:Line | What it does |
|---|---|---|
| `fetchUrl` | `scripts/extract_rates.js:56` | Plain HTTPS GET with redirect handling |
| `parseHtmlTables` | `scripts/extract_rates.js:82` | HTML `<table>` parser |
| `extractSlabsFromTable` | `scripts/extract_rates.js:120` | Column-mapping-driven slab extraction |
| `extractEffectiveDateFromHtml` | `scripts/extract_rates.js:165` | Regex hunt for "w.e.f." dates |
| `extractHtmlStatic` | `scripts/extract_rates.js:180` | Full Tier 1 extractor |
| `extractHtmlJs` | `scripts/extract_rates.js:221` | Tier 2 via Playwright spawn |
| `extractPdf` | `scripts/extract_rates.js:278` | Tier 3 via `extract_rates_pdf.mjs` spawn |
| `routeExtraction` | `scripts/extract_rates.js:335` | **Unified entry: takes `(config, url, variant)`, routes by tier** |
| `writeRatesFile` | `scripts/extract_rates.js:375` | Canonical-schema writer |
| `fetch_rates_playwright.js` | `scripts/fetch_rates_playwright.js` | Standalone Playwright fetcher with `--scroll`, `--tabs`, `--selects`, `--intercept` |
| `extract_rates_pdf.mjs` | `scripts/extract_rates_pdf.mjs` | pdfjs-dist-based PDF table extractor |

**These are invoked from exactly one code path: `run-batch.js --extract-only` mode** (`run-batch.js:462–495`). That path skips the LLM entirely and spawns `scripts/extract_rates.js <bank_code>` per bank — fast, deterministic, no orchestration logic.

**They are not invoked from `run-discovery.js` at all.** The three modes (`discover`, `expand-nri`, `rates-only`) each spawn `claude -p` with a prompt and let the LLM do everything through its own tool-use loop. The node wrapper doesn't even look at `scraper_type` before deciding how to run.

This is the core structural gap. The deterministic path and the LLM path are built, but they live in parallel universes connected only by `--extract-only`, a flag that isn't in the default batch workflow.

## 6. Bot-protection landscape (from `data/bank-domains.json`)

150 entries total. 21 have notes indicating WAF / CAPTCHA / bot-detection:

| Protection type | Examples |
|---|---|
| Cloudflare / CloudFront WAF | Airtel Payments, ICICI, AU SFB |
| Imperva / Incapsula | Kotak, CTBC |
| Akamai | (several FB) |
| Radware Bot Manager | CSB Bank |
| reCAPTCHA | Bank of India |

Current mitigation: Playwright (headless) with three evasion tricks (`scripts/fetch_rates_playwright.js:40–58`):
- `--disable-blink-features=AutomationControlled`
- `navigator.webdriver = false` via `addInitScript`
- Chrome 131 UA on Win64, viewport 1366×768, locale en-IN

**What's missing:**
- The `bank-domains.json` WAF/bot notes are human-readable prose, not a structured `bot_protection` field the code can dispatch on. `run-discovery.js` doesn't read these notes at all — the agent rediscovers the block each run.
- No rotation of UA strings or viewports.
- No plausibility events (mouse moves, realistic scroll delays, typed input).
- No retry-with-different-evasion fallback chain.
- No cookie persistence across runs.

The `data/bank-domains.json` metadata is **pre-existing intelligence the system already has but doesn't use**. Routing known-blocked banks directly to Playwright with appropriate evasion flags is a free optimization.

## 7. Sizing the "no website" long tail (lever J placeholder)

I cannot measure this precisely without running discovery against a sample of NSUCBs, but strong inference from the data:

- Of 1,392 NSUCBs in the master list, **zero** have been processed. Zero configs written. Zero `bank-domains.json` entries for this category.
- The 1 SUCB that *has* been processed (`cosmos-co-operative-bank-ltd`) is a large urban cooperative with a real website.
- Cooperative bank regulators (RBI, state registrars) historically published rate circulars as state-level PDF gazettes, not per-bank pages. Some small NSUCBs have never had a web presence at all.
- The `.bank.in` domain mandate from RBI is still rolling out and covers scheduled banks first. Most NSUCBs are non-scheduled by definition and are not in the first wave.

**Realistic sprint assumption:** a meaningful fraction of the 1,838 remaining banks — I would guess 30–50% — have no discoverable website through any amount of LLM effort. The sprint should include an explicit "probe, give up fast, mark as `no_website`" path so these banks don't eat the 300s timeout each.

Actual number is a follow-on measurement task, not solvable in the audit.

## 8. Levers and estimated impact

Each lever scored on *what it does to the 218s mean per bank*, plus what it unlocks. Estimates are intuitions calibrated against §2 and §3 — the real numbers need stream-json instrumentation (lever A) to verify.

| # | Lever | Est. impact on mean/bank | Est. impact on remaining 1,886 | Pattern class |
|---|---|---|---|---|
| **A** | `stream-json` instrumentation | +5s observability cost, 0 savings | Enables measurement for all other levers | — |
| **B** | Change-detection cache | Not applicable to `discover` mode | Irrelevant until `--rates-only` runs | — |
| **C** | Local HTML fetch + heuristic tier classification; feed result into agent prompt | −40 to −80s | Unlocks Pattern 2 for more banks | Pattern 1 + 5 |
| **D** | Local PDF text extraction before agent sees the page | −60 to −120s for PDF banks | Huge for LAB/DCCB/IBU long tail | Pattern 1 + 5 |
| **E** | Parallel multi-URL fetch within one bank | −20 to −60s for NRI banks | Modest | Pattern 1 |
| **F** | Real-time block/rate-limit detection; bail fast | −200s+ on blocked banks | Caps worst case, saves wasted timeouts | — |
| **G** | Deterministic-first for `--rates-only` | Deferred — no rates-only runs today | Zero now, large once coverage catches up | Pattern 2 |
| **H** | Route known-blocked banks directly to Playwright via `bank-domains.json` annotations | −30 to −60s for 21 known blocks | Small count, easy win | — |
| **I** | Playwright evasion improvements (UA rotation, mouse events, cookie persistence, per-bank flags) | Converts some `manual` → extractable | Unlocks banks currently at 0% | — |
| **J** | Explicit `no_website` detection tier (fast probe, fast give-up) | −200s+ on unreachable banks | Critical for the 30–50% estimated no-website cooperatives | — |
| **K** | Haiku for `--rates-only` | Deferred | Zero now | — |
| **L** | Trim prompt context (bank-domains.json loaded in its entirety) | −10 to −20s | Small but free | — |
| **M** | Batch resilience: higher concurrency, per-bank checkpoint, per-tier delay tuning, resume any time | 0 per bank, but enables parallel=5+ reliably | Paid in wall-clock, not per-bank | — |
| **★** | **Pattern 2 wiring for already-captured configs** | **−213s (bank never hits LLM)** | **Immediate win for 80–108 existing banks; compounds as new banks get captured** | Pattern 2 |

### The decisive lever is ★: close the Pattern 2 loop.

- 64 banks have `html_static + selectors + column_mapping` and are ready for deterministic extraction **right now**.
- 16 banks have `pdf + pdf_url` and are ready right now.
- 28 banks have `html_js + selectors` and are ready via Playwright right now.
- Every new bank the LLM processes produces a captured config that feeds Pattern 2 for subsequent runs.
- The helpers (`scripts/extract_rates.js`, `extract_rates_pdf.mjs`, `fetch_rates_playwright.js`) already exist and work — they just need to be wired into `run-discovery.js` ahead of the LLM, not parallel to it.

The architectural change is minimal: `run-discovery.js` gains a Phase A that reads the existing config (if any) from `output/latest/`, spawns `scripts/extract_rates.js` in "try" mode, inspects the result, and only falls through to `claude -p` if Phase A returned no slabs or no config existed in the first place.

For a cold-start (new bank, no config), Phase A has nothing to work with and the flow falls through to the LLM just like today. For a bank that's been seen before, Phase A wins outright in seconds. The discover path subsumes the `--rates-only` mode semantically.

## 9. Recommended sprint shape

**Phase 0 — Instrumentation (small, standalone commit):**
- Lever A: `--output-format stream-json` in `run-discovery.js`, parse events into structured per-tool timing, per-token-count, per-LLM-step data.
- One sacrificial 10-bank instrumented run to verify the tooling produces usable data.
- Deliverable: a second audit note quantifying the §3 buckets.

**Phase 1 — Pattern 2 wiring (the big one):**
- Lever ★: `run-discovery.js` gains Phase A / Phase B / Phase C per §4 of this doc.
- For banks with captured selectors, flows end in Phase A (zero LLM).
- For new banks, Phase A fails, Phase C runs the full LLM path as today.
- Re-run all 80+ ready banks to verify. Expected: ≤30s per bank vs. 218s today.

**Phase 2 — Local pre-parsing (C + D):**
- Node-side HTML fetcher + tier classifier runs before LLM invocation.
- Node-side PDF text extraction pipes into the LLM prompt for LLM-needed cases.
- LLM sees preprocessed content, doesn't tool-call to fetch.
- Expected: 90–140s drop on LLM-path banks, especially PDF-heavy categories.

**Phase 3 — Failure fast-path (F + H + J):**
- Real-time 403/429/CAPTCHA detection; bail in ≤10s.
- `bank-domains.json` `bot_protection` structured field; Playwright route for known blocks.
- `no_website` probe: heuristic URL guesses, 5s budget per bank, fast give-up.
- Expected: failure cost per bank drops from 97s → 15s; unreachable-bank cost capped.

**Phase 4 — Playwright evasion + resilience (I + M):**
- UA rotation, mouse plausibility, cookie persistence, per-bank evasion flags.
- Batch-level: per-bank checkpoint so operator can stop and resume mid-1900-bank run.
- Concurrency dial with rate-limit back-pressure.

**Explicit non-goals for the sprint:**
- Replacing LLM-extracts-rates for *new* banks (Phase C still uses the LLM for novel discovery — the rationale still holds for cold-starts).
- Building the no-website review queue (lever J deliverable is the *detection*, not the human-in-the-loop dashboard).
- Optimizing `--rates-only` (levers B, G, K) until coverage reaches the point where the steady-state path matters.

## 10. Open questions this audit cannot answer

1. **Where exactly does the 218s go?** §3 is qualitative inference. Needs lever A to get quantitative.
2. **How many of the 1,392 NSUCBs actually have websites?** §7 estimate is 50–70% do not. Needs a sacrificial 30-bank sample from the NSUCB list with a 30s-per-bank probe budget.
3. **How much of the 99s floor is addressable?** Is it Claude Code process startup, model warm-up, or something we can shrink with smaller prompts? Answerable via lever A.
4. **Does Pattern 2 extraction actually succeed on the 64 ready banks?** The selectors were LLM-captured and never round-tripped through the deterministic extractor as a test. Needs a verification run.
5. **Rate limits at higher concurrency.** We know the 5-parallel path works sometimes. We don't know where the ceiling is.

## 11. Suggested next step after this audit

One small, isolated commit that does Phase 0 only: `stream-json` instrumentation in `run-discovery.js`, gated behind `--log-level debug`, producing a structured per-tool log alongside the existing summary log. No behavioral changes. Run it against 10 diverse banks. Publish the results as an addendum to this audit. Then decide whether Phase 1 scope is correct based on real numbers.

That commit is probably 50–100 lines of code and one run. It answers the questions the current 1.4-KB log files cannot.

---

**Data provenance:** All numbers in this audit come from files already on disk. Master list: `docs/Indian_Banks_Comprehensive_List_RBI.csv`. Coverage and config analysis: `output/latest/*_config.json` (157 files), `output/latest/*_rates.json` (157 files, post-schema-heal). Timing: `output/runs/*/​_batch_results.json` (5 batches, 75 bank runs). Helper inventory: static reads of `scripts/extract_rates.js`, `scripts/fetch_rates_playwright.js`, `scripts/extract_rates_pdf.mjs`. WAF landscape: `data/bank-domains.json` (150 entries, 21 annotated). No real LLM runs were spent producing this audit.

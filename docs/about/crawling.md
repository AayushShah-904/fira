# Crawling & Discovery

> Part of the onboarding guidebook — see [overview.md](overview.md) for the whole system. This page covers the **first half** of the per-bank pipeline: finding a bank's website and rate pages, fetching them (plain HTTP vs. a real browser), and classifying what kind of page you're looking at. What happens *after* a page is fetched — turning HTML/PDF into rate slabs — is [extraction.md](extraction.md).

## 1. Framing

Discovery is a four-step funnel, run once per bank (and once per NRI/GIFT variant when applicable):

```
find website  →  find rate page(s)  →  classify page type  →  fetch (+ extract in the same step)
```

Two rules shape every step, and they are non-negotiable (see `CLAUDE.md` and `docs/agent/discovery-workflow.md`):

- **Prefer the RBI-mandated `.bank.in` domain.** All Indian banks are migrating to `.bank.in`; it's treated as the most authoritative source even when a bank also has a legacy `.com`/`.co.in` site.
- **Never use aggregator sites** — bankbazaar, paisabazaar, cleartax, groww, moneycontrol, and similar are hard-rejected. `lib/actions/find_website.js` enforces this in code (`AGGREGATOR_DOMAINS`), not just in the prompt.

The authoritative playbook for this whole area is **`docs/agent/discovery-workflow.md`** — it's what the LLM agent actually reads (via `lib/prompts/fragments.js`), so it's the single source of truth for *behavior*. This page explains the *mechanics* underneath: the deterministic tools the agent (and the automated pipeline) call to do the finding and fetching.

## 2. `find_website` and `find_rate_page`

### `find_website` — `lib/actions/find_website.js`

Deterministic-first, LLM-search as a fallback:

1. **Cached domain recheck.** If the caller passes `hints.cached_domain` (i.e. the bank is already in the registry), HEAD-confirm it. Many `.bank.in` sites serve incomplete TLS chains or reject bare Node requests from a WAF — so a failed HEAD does **not** disqualify a cached domain; the registry is hand-curated and trusted, and the function returns it anyway at `confidence: "medium"`, expecting the downstream Playwright fetch to succeed where Node HTTP didn't.
2. **Construct `<slug>.bank.in` candidates.** From the canonical slug (via `scripts/utils/slugify.js` — never hand-composed), plus a stripped variant (drops `-bank-limited`/`-ltd` suffixes) and an acronym guess (e.g. "State Bank of India" → `sbi`). Each is HEAD-checked; first 2xx wins at `confidence: "high"`.
3. **Web search fallback.** `"<bank name>" official website india [state]"` via Bing (if `BING_SEARCH_API_KEY` set) or the Azure OpenAI Responses API (web-search tool) otherwise.
4. **Rank candidates.** Score = TLD priority (`.bank.in` 100 > `.co.in` 80 > `.com` 60 > `.org` 50 > `.in` 40) + a name-match bonus. Aggregator domains are filtered out before scoring, not after. Below a confidence floor, the function **fails rather than guessing** (`error_class: "all_candidates_rejected"`) — no low-confidence URL is ever silently returned.

### `find_rate_page` — `lib/actions/find_rate_page.js`

Given a homepage URL and a target product (`fd`, `fd_nre`, `fd_nro`, `fd_fcnr`, `fd_nri_combined`, `fd_gift`, `savings`, `rd`):

1. **NRI-eligibility gate.** Co-op banks (SUCB/NSUCB/SSCB/NSSCB/DCCB), RRBs, Payments Banks, and Local Area Banks are rejected immediately for NRI products (`error_class: "not_applicable"`) — they don't offer NRE/NRO/FCNR, so the agent shouldn't waste budget searching.
2. **Recheck mode** tries `hints.cached_path` first (same WAF-tolerant trust-the-cache logic as `find_website`).
3. **Discover mode** fetches the homepage (up to 2 MB — raised twice after large bank homepages like Equitas/Citi pushed rate-page anchors past earlier, smaller caps) and regex-parses `<a href>` anchors, scoring them against per-product keyword patterns (e.g. `fd_fcnr` matches `FCNR`, `FCNR-B`, "foreign currency non-resident"; `fd_gift` matches `GIFT City/IFSC`, `IBU`).
4. **Path-pattern fallback** if no anchor matches — HEAD-checks a list of common paths per product (e.g. `/fcnr-deposits`, `/nre-fixed-deposit`) and takes the first 2xx at `confidence: "low"`.

### The registry — `data/bank-domains.json`

This file is the **cache of known domains and rate pages** — a slug-keyed map of `{ domain, rate_pages: { fd, fd_nre, fd_nro, fd_fcnr, savings, rd, ... }, scraper_type, notes, scraper_notes, extraction, template }`. Per `docs/agent/discovery-workflow.md` Step 0: **always check the registry before searching the web.** A hit with `domain` + `rate_pages.fd` means skip straight to classify/fetch; a hit with `domain` only means skip website search but still hunt for the rate page. IBUs carry a `parent_bank_code` pointing at the parent's registry entry (for GIFT-City discovery).

Some entries carry an `extraction.<rate_pages_key>` block (selectors, wait-for hints, click-to-reveal targets) — when present, the `run_playwright`/`fetch_pdf` tools auto-resolve the matching hint from the URL, so the agent doesn't hand-pass CSS selectors.

The registry is also the fleet's institutional memory of *failure modes* — many entries carry a `notes` field documenting why a bank is hard (JS-rendered, Cloudflare challenge, image-only rate card, etc.), which is exactly the kind of thing worth reading before re-attempting a bank that's already flagged.

> See §4 of `overview.md` for how the registry is synced with blob/git in cloud runs — that plumbing is out of scope here, but it matters: a registry fix baked into the image doesn't take effect until pushed to blob.

## 3. Page classification — `classify_rate_page`

`lib/actions/classify_rate_page.js` decides, per URL, which of four kinds a rate page is — and that classification is what tells the orchestrator which extractor path to use (see [extraction.md](extraction.md)):

| Kind | Meaning |
|---|---|
| `html_static` | Rate numbers are present in the raw HTTP response — a real `<table>` with `<tr>/<td>` containing rate-shaped digits. |
| `html_js` | React/Angular/Vue/Next.js scaffolding, or a script-heavy page with no `<table>` at all — rates are injected client-side. Needs Playwright. |
| `pdf` | URL ends in `.pdf`, or `Content-Type: application/pdf`. |
| `image` | URL or `Content-Type` indicates an image — the rate card is a scanned/rendered picture, not text. |

It's **deterministic, no LLM** — pure regex/heuristic sniffing:

- Quick wins on the URL alone (`.pdf`, image extensions) short-circuit before any fetch.
- If the orchestrator already prefetched the page body via `fetch_page` (`hints.cached_body`), classification reuses it instead of fetching again — this Phase-4 optimization exists specifically to cut 1-2 redundant fetches per (bank, product).
- Otherwise it does its own small GET (4 KB, then 32 KB if inconclusive) and sniffs: a `<table>…<tr>…<td>…\d+\.\d` regex match → `html_static`; a React/Next/Vue/Angular root marker → `html_js`; zero `<table>` tags with 3+ `<script>` tags → `html_js` at low confidence.
- On fetch failure (403/ECONNRESET from a WAF), if a `hints.cached_kind` from the registry is available, it trusts the cache rather than failing outright — the assumption being that the WAF is rejecting the bare Node request, not that the page is actually gone.

**Known pitfall: JS pages can look static in a quick sniff, or vice versa.** Backlog item **#31** ("classify_rate_page JS mislabel") was investigated in Sprint 011 and resolved as **no code change** — the classifier was already correct; a specific bank's zero-slab result traced instead to a downstream *parsing* bug (folded into a separate extractor fix, #29), not a classification error. The lesson for a new engineer: when a bank comes back with unexpectedly few/zero slabs, don't assume `classify_rate_page` mis-tagged the page — check whether the extractor for the classified kind is actually handling that page's structure (e.g. rate data in styled `<div>`s that a "verify it's `html_static`" table-scraper doesn't expect). Sprint 010 similarly found an "HDFC misclassification" that turned out to be an analysis-script bug, not an agent bug — the pattern repeats.

## 4. Fetching: plain HTTP vs. Playwright

### Plain HTTP — `lib/actions/_http.js`

The default fetch path (`httpRequest(url, method, opts)`) is Node's built-in `http`/`https`. Notable behaviors:

- **`tolerant: true`** accepts incomplete TLS chains — many `.bank.in` domains serve a trust chain missing the intermediate cert; Node rejects it by default, browsers usually don't.
- **Byte cap** (`DEFAULT_MAX_BYTES`) has been raised twice: 32 KB → 512 KB → **2 MB**, after HDFC's rendered pages (1.04-1.19 MB across FD/NRE/NRO/FCNR) were silently truncating the rate table out of the LLM-extraction fallback's view. Truncation is warn-logged, not silent, when it does fire.
- **Redirect following** (up to 5 hops), **partial-body recovery** on byte-cap `ECONNRESET` (keeps what arrived instead of discarding it), and a browser-shaped default `User-Agent` (`Mozilla/5.0 … Chrome/131.0.0.0`) to reduce trivial bot-fingerprinting.
- **Session delegation.** When a per-bank Playwright `session` is passed in, `httpRequest` routes through it (`sessionFetch`) instead of raw Node sockets — see below. It falls back to plain Node HTTP if `session.fetch` throws, so an infra hiccup doesn't poison the whole per-bank run.

### Playwright — `lib/actions/_playwright_session.js` and `scripts/fetch_rates_playwright.js`

**Why Playwright is needed at all** (see `docs/playwright-scraper.md`, written from the original HDFC investigation):

1. **JS-rendered rates.** Many bank sites (HDFC being the canonical example) don't put rate numbers in the initial HTML — a client-side JS bundle fetches/renders them after load. A plain HTTP GET only ever sees the empty scaffolding.
2. **WAF / bot protection.** CloudFront, Akamai, Cloudflare, and Imperva-style WAFs fingerprint headless HTTP clients and return 403/429 even for pages that would otherwise be static. Playwright driving a real Chromium process, with automation fingerprints suppressed, gets past this where a raw `fetch` cannot.
3. **No `<table>` tags at all.** HDFC's rate data is laid out in styled `<div>`s, not semantic tables — `page.innerText("body")` plus a tab-separated-line regex is what actually extracts it (`/^(.+?(?:days?|months?|years?).+?)\t(\d+\.\d+%)\t(\d+\.\d+%)$/i`), not table-cell parsing.

**Anti-bot evasion.** The standard session (`_playwright_session.js: createSession`) launches Chromium with `--disable-blink-features=AutomationControlled`, sets a real-browser `User-Agent` + `en-IN` locale + `1366×768` viewport, and (in the standalone script) strips `navigator.webdriver`. `scripts/fetch_rates_playwright.js` additionally supports **`--stealth`**, which swaps in `playwright-extra` + `puppeteer-extra-plugin-stealth` — reserved for outliers (SBI, Bank of India) that the baseline evasion doesn't beat, kept opt-in so the ~500+ banks that already work don't share a code path with it.

**Two Playwright entry points, different jobs:**
- **`_playwright_session.js`** — a persisted per-bank browser session used by the orchestrator's `find_website`/`find_rate_page`/`classify_rate_page`/`fetch_page` actions (via `_http.js`'s `session` option). Cheap sniffs default to `waitFor: 'domcontentloaded'` (not `networkidle` — that timed out at 8s on tracker-heavy hosts like bankofindia.bank.in). Lifecycle is one session per `orchestrate()` call, closed in a `finally` — per-process or per-action lifecycles were considered and rejected (cookie bleed / startup cost).
- **`scripts/fetch_rates_playwright.js`** — the standalone, CLI-driven scraper used for full extraction, with a much richer flag set: `--scroll` (lazy-loaded content, default on), `--accordions` (collapsed sections, default on), `--tabs`/`--tab-selector` (click tab UI and extract per-tab), `--selects` (iterate dropdown options), `--intercept` (capture XHR/fetch JSON responses — needed when rates come from an API call, not the DOM), `--wait-for-selector`/`--click-to-reveal`/`--extract-selector` (per-bank hints sourced from the registry's `extraction.<key>` block).

Binary responses (PDFs, images) **bypass Playwright entirely** — `page.goto()` aborts navigation with "Download is starting" for attachment-disposition responses, and `page.content()` would return rendered HTML anyway, not raw bytes. Use `fetch_pdf` for those.

**A pre-flight check exists** (`lib/playwright-preflight.js`): before a batch run starts processing banks, it spawns `fetch_rates_playwright.js` against a `data:` URL with a tight timeout, to catch a broken Chromium/cloud environment (spawn ETIMEDOUT, etc.) in ~5 seconds rather than burning 14 minutes of cohort budget discovering it one bank at a time (the motivating incident: a 12-bank cohort lost 14 minutes to 7 consecutive SBI Playwright spawn failures).

**Fallback discipline (from `docs/agent/discovery-workflow.md`):** on HTTP 403/429 or empty JS scaffolding, retry immediately with `run_playwright` on the *same* URL — don't guess `www.`/non-`www.` variants first. Only genuinely broken responses (404/500/timeout) mean move on. Never classify a bank `manual` before trying Playwright. If the registry has `"playwright_disabled": true` for a bank (an operator-declared network-hang workaround, e.g. sbi.bank.in in cloud), don't retry Playwright at all — fall back to `fetch_url`, since sub-pages (NRE/NRO/FCNR) sometimes serve static HTML even when the main page is JS-heavy.

## 5. The `www` subdomain gotcha — a live footgun

**This is an open, fleet-wide bug (backlog #27), not a resolved edge case.** The registry stores bare `.bank.in` domains (e.g. `axis.bank.in`), but a growing number of sites now **require** the `www` subdomain — the bare apex either 404s or fails TLS verification (`*.bank.in` wildcard certs that don't cover the bare domain), while `www.axis.bank.in` works fine.

Discovered during the Sprint 011 gold-11 run: **3 of 11 "gold" banks (IOB, Axis, Yes) failed for exactly this reason.** Since these are PM-curated, well-known banks, the working assumption is that this silently affects a much larger slice of the ~1,900-bank fleet — banks just silently return zero slabs instead of erroring loudly.

The only currently-sanctioned `www` retry is narrower than this bug needs: `docs/agent/field-learnings.md` rule 2 allows **one** `www.` retry, but only on a TLS/cert error or a near-empty bare-apex response — not as a general first-class fallback. Backlog #27 calls for a proper fleet-wide sweep: detect bare→`www` 404/redirect patterns across the whole registry and either normalize the stored domain or make the fetcher retry `www` automatically. Until that lands, **if a bank you're investigating 404s on its registry domain, try prefixing `www.` before concluding the bank is unreachable** — this is the single highest-value thing a new engineer can check on a "why did this bank return zero" investigation.

## 6. NRI / GIFT / IBU discovery specifics

NRE, NRO, FCNR, and GIFT-City (IBU) rates are **separate products with independent rate schedules** — never assume they mirror the domestic FD rate, and always fetch/extract each separately. Full detail lives in **`docs/agent/nri-gift-ibu.md`**; the discovery-relevant highlights:

- **NRI pages are gated by bank type.** Only PSB / PVB / Foreign Bank / large-SFB (AU, Equitas, Ujjivan, IDFC First, Bandhan) get NRI discovery attempted — co-ops, RRBs, Payments Banks, and Local Area Banks don't offer these products, and `find_rate_page`'s `NO_NRI_BANK_TYPES` gate enforces this in code, not just in the prompt.
- **FCNR/GIFT rate cards are frequently dated PDFs that roll weekly.** Several banks (Axis is the flagged example, backlog #23) publish a new PDF filename every ~week; a hard-coded URL breaks silently within days. The durable fix is to scrape the rate-page HTML for the *current* `.pdf` href on every run rather than caching a filename.
- **IBU / GIFT-City pages live under the parent bank's domain**, typically at paths like `/gift-ifsc/`, `/ifsc-banking/`, or `/international-banking/gift-city/`. An IBU's registry entry carries `parent_bank_code` specifically so discovery can reuse the parent's known-good domain instead of searching from scratch.
- **Multi-currency tables need every currency, not just USD.** FCNR/GIFT rate cards are usually laid out either as currency-rows × tenure-columns or tenure-rows × currency-columns — a real historical bug (HDFC-IBU, cohort #3) emitted only USD and silently dropped 23 of 35 baseline slabs by collapsing other currency columns. This is an *extraction* rule, but it starts at discovery time: don't stop at "found the FCNR page," check how many currency columns it has.

## 7. Field learnings: co-op / DCCB sites

Small cooperative and district-level banks (DCCBs) are the long tail where discovery breaks in distinctive ways. Full rules are in **`docs/agent/field-learnings.md`**; the headline patterns:

- **No standalone website** — some DCCBs only exist as a page on a **state-cooperative umbrella domain** (e.g. `<bank>.pbcoopbank.in`, `<bank>.upcooperativebank.org`, `<bank>.tncooperation.gov.in`). Prefer the bank's own `.bank.in` if it exists and is clean; only fall back to the umbrella domain if the own domain fails TLS/malware checks.
- **Multilingual rate pages** — Hindi-belt DCCBs (UP, MP, Rajasthan, Bihar, Jharkhand, Chhattisgarh) sometimes publish rates only at a Hindi-language URL/heading. After an English-only search comes up empty, retry once with a regional-language query (`<bank name> ब्याज दर`, etc.).
- **Image-only rate cards** — an `<img>` whose filename mentions `deposit`/`interest`/`rate`/`roi`/`tdr`/`fd`, with no HTML table or extractable PDF nearby, is a known automated-extraction dead end. Mark `scraper_type: "manual"` rather than attempting OCR inline (OCR is a separate, later-sprint capability — see `lib/extractors/` for the current `extract_via_ocr` support).
- **Scanned-image PDFs** — if `fetch_pdf` returns under ~200 chars of usable text, the PDF is almost certainly a scanned image with no reliable text layer; don't invent slabs from it, mark `manual`.
- **Recruitment-only lookalike domains** — bank-sounding domains (`<name>dccb.co.in`, `<name>-sahakari.in`) that only publish job postings, with no banking-product content, are treated as likely fraud lookalikes and must not be committed as the bank's website.
- **Always write partial progress.** If a website is found but no rate page can be located, still write the `_config.json` (`scraper_type: "manual"`, `rate_page_urls.fd: null`, explanatory note) rather than leaving an empty run directory — an empty output gives the operator no signal about what was tried.

## 8. Pointers

| Topic | Doc |
|---|---|
| Whole-system map, pipeline picture, component tree | [overview.md](overview.md) |
| The LLM agent itself: prompts, orchestrator, tier-router, modes | [agent-design.md](agent-design.md) |
| Turning a classified page into rate slabs: extractors, schema, tenure/currency parsing | [extraction.md](extraction.md) |
| Safe-write rules, quality gate, confidence scoring | [quality-checks.md](quality-checks.md) |
| Azure topology, Container Apps Job, deploy | [deployment.md](deployment.md) |
| **Authoritative discovery playbook** (what the agent reads) | `docs/agent/discovery-workflow.md` |
| Co-op/DCCB tricky-site rules | `docs/agent/field-learnings.md` |
| NRI/FCNR/GIFT-City specifics | `docs/agent/nri-gift-ibu.md` |
| Strict field names / schema for config + rate JSON | `docs/agent/schemas.md` |
| Playwright anti-bot deep dive (HDFC case study) | `docs/playwright-scraper.md` |
| Registry structure, all known domains/rate-pages/scraper hints | `data/bank-domains.json` |
| Open backlog (incl. #27 `www` audit, #23 dated-PDF discovery) | `sdlc/sprints/sprint-011/BACKLOG.md` |

---

*Written for handover, 2026-07-09. If a mechanism here looks stale, check the referenced source file first — this doc is a lens onto the code and `docs/agent/`, not a replacement for either.*

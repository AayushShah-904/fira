# Running notes from Sprint 002 operator follow-ups

**Sprint:** 002 (item #5 — codify learnings)
**Source:** operator review of the 12-bank action queue from the Sprint 002 #4 diagnostic writeup.
**Format:** each entry is a discrete agent-behavior learning with the specific bank evidence that surfaced it. Sprint 002 #5 codifies these into prompt / tool / `bank-domains.json` changes; this doc stays as the audit trail.

---

## L1 — When a search returns a deep-link URL, fetch the homepage too

**Surfaced by:** `agra-zilla-sahakari-bank-ltd` (UP, 2026-05-12).

**Symptom:** Search returned `https://dcbagra.org/Emi_calculator.php` as a top hit (an EMI calculator page). The agent fetched only that URL, found no rate table there, concluded "manual" — never visited the homepage where the navigation menu has "Interest Rate → Deposit Interest Rate" pointing to the real FD page at `/intrest.php?id=4`.

**Codification candidate:** prompt rule — *"If the URL the search returned is not the site root (i.e., it has a path other than `/`), fetch the site root (`https://<domain>/`) before deciding. Sites usually expose their rate-page link via the global navigation, not the deep URL the search may have surfaced."*

**Cost shape:** +1 fetch_url call per bank where this fires. Cheap; ≤8-call budget can absorb.

---

## L2 — The `www.` prefix is sometimes load-bearing for cert validity

**Surfaced by:** `agra-zilla-sahakari-bank-ltd`.

**Symptom:** `https://dcbagra.org/` is rejected by Chromium with `ERR_CERT_COMMON_NAME_INVALID` because the cert covers `*.dcbagra.org` but not the bare apex. The agent's `fetch_url` (Node TLS, more lenient) got past it sometimes; Playwright did not. The `www.dcbagra.org` variant works in both.

**Codification candidate:** narrow exception to CLAUDE.md's "do not guess www./non-www. variants" rule — specifically: *"If a fetch fails with a TLS / certificate error or the rendered HTML is < 1KB of useful content, try the `www.` prefix once before giving up. This is the only allowed www-variant retry."*

**Caution:** general URL-guessing is still forbidden. This is one named, well-scoped retry.

---

## L3 — JS-shell pages must escalate to Playwright before being classified manual

**Surfaced by:** `agra-zilla-sahakari-bank-ltd`.

**Symptom:** The agent's `fetch_url` returned the page's loading-spinner shell (a Bootstrap spinner div + minimal scaffolding) because the real content renders only after JS execution. The agent treated the spinner shell as "no rate data" and committed `scraper_type: "manual"` instead of escalating to `run_playwright`.

**Codification candidate:** prompt rule + heuristic — *"If `fetch_url` returns < 1KB of body content, OR the body is dominated by loader/spinner markup (e.g., classes like `spinner-grow`, `loader`, `loading-screen`, or a `<div id="root">` with no children), the page is JS-rendered. Immediately retry with `run_playwright` before classifying as manual."* Pair with a small detection helper in `lib/tools.js`'s `fetch_url` that flags suspiciously thin responses.

---

## L4 — Lookalike `.bank.in` domains exist; do not trust the slug match alone

**Surfaced by:** `agra-zilla-sahakari-bank-ltd` (and its sibling `zsblagra.bank.in`).

**Symptom:** Search returned `https://zsblagra.bank.in/` as a candidate for "Agra Zilla Sahakari Bank". The page has identical content to `dcbagra.org/intrest.php?id=4` BUT:
- TLS cert is flagged invalid by Chromium / Node (cert/altname mismatch on the bare `zsblagra.bank.in` host).
- Operator reports a malware warning when visiting the .bank.in version.
- Provenance is unverified — could be a legitimate RBI-mandated subdomain that's mis-configured, or a phishing lookalike that scraped the legit content.

Until provenance is confirmed (e.g., the bank announces the .bank.in domain officially), the `dcbagra.org` site is the authoritative source and the `.bank.in` mirror must be ignored.

**Codification candidate:**
1. `bank-domains.json` entry already records this — see the agra entry's `notes`.
2. Prompt rule — *"Prefer the bank's own `.org` / `.co.in` / `.com` domain over its `.bank.in` mirror UNLESS the .bank.in domain has a valid cert AND the .org variant is unreachable. RBI mandates .bank.in but the registry is incompletely policed, and lookalike domains have been observed."*
3. Tool-layer guard — `fetch_url` should treat TLS cert errors as a hard signal, NOT retry over insecure transport. Already the case in Node TLS, but worth documenting that we WILL NOT add a `rejectUnauthorized: false` escape hatch — better to lose the URL than fetch from a possibly-spoofed site.

---

## L5 — DCCBs often have a `.bank.in` domain AND a state-coop umbrella subdomain with identical content; the operator must disambiguate

**Surfaced by:** `bhatinda-central-co-operative-bank-ltd` (Punjab, 2026-05-12).

**Symptom:** Operator found two URLs hosting identical rate content:
- `https://bathindaccb.bank.in/deposit-interest-rates/` — the bank's own RBI-mandated `.bank.in` domain.
- `https://bathinda.pbcoopbank.in/deposit-interest-rates/` — a subdomain on the Punjab State Co-op Bank umbrella (`pbcoopbank.in`).

The agent committed to the `.bank.in` domain correctly but couldn't locate the rate page (the homepage's menu link is likely JS-rendered — see L3). Operator confirmed the `.bank.in` version is the official surface.

This case **inverts** L4 (where `.bank.in` had cert issues + malware warning and the `.org` was the trusted official). Both shapes are real:
- L4 pattern: `.bank.in` is the lookalike → prefer the `.org`.
- L5 pattern: `.bank.in` is official → prefer it over the state-coop subdomain.

**Codification candidate:** no blanket TLD preference. Instead:

1. **When two domains have identical rate content,** the agent should prefer the bank's own RBI-mandated `.bank.in` domain over a state-coop umbrella subdomain like `<bank>.pbcoopbank.in`, `<bank>.upcooperativebank.org`, `<bank>.tncooperation.gov.in`, etc. — UNLESS the `.bank.in` candidate has cert errors, malware warnings, or other red flags (L4). Detection of "umbrella subdomain" is via a known-umbrella suffix list (`pbcoopbank.in`, `upcooperativebank.org`, etc.) — easy to maintain.
2. **When the agent commits to a `.bank.in` domain but can't find the rate page,** L1+L3 already cover the fix (fetch homepage, escalate JS-shell to Playwright). The dual-domain check is independent of L1+L3.

**Operator-friendly rule for future banks (until codification lands):** if you find two domains with identical content, capture both in the registry `notes` and choose the `.bank.in` one as `domain` unless it has obvious problems. The unused mirror stays in notes for future audit.

---

## L6 — Agent must commit a partial config even when exploration ends inconclusively

**Surfaced by:** `dhanbad-district-central-co-operative-bank-ltd` (Jharkhand, 2026-05-12).

**Symptom:** The agent had budget (used 13 of 15 tool calls), correctly identified `dhanbadccb.in` as the bank's site (5 successful fetches across homepage, about-us, contact-us, personal-banking, and a candidate rate page), AND confirmed the `.bank.in` mirror is broken (4 failed fetches). It had enough to write a partial config: `website = "https://dhanbadccb.in"`, `scraper_type = "manual"`, `rate_pages.fd = null`, with a note explaining "rate page broken/non-existent." Instead it wrote **nothing** — no `_config.json` at all. The diagnostic captured this as `partial_success / reachable_uncommitted / not_attempted / not_attempted`.

**Why it matters:** This is the precise gap that Sprint 002 item #14 was scoped to address. The discover prompt currently treats the run as all-or-nothing — find website AND find rate page AND extract OR write nothing. When Phase 2 (rate page) fails, the agent abandons Phase 1's findings (the verified website) instead of persisting them.

Operator value lost: a partial config with verified website + verified broken-mirror would let the next run skip the broken mirror, skip re-discovery of the homepage, and focus the budget on finding a rate page (if one exists) or PDF-rate-card hunting. Today, the next run starts from zero.

**Codification candidate:** Sprint 002 #14 is the work. Concretely:

1. **Prompt change** — discover.md gets a "Phase 1 commit checkpoint" instruction: *"As soon as you've identified a website and made at least one successful fetch against it, write a partial `_config.json` with `website` set, `scraper_type: \"to_determine\"`, and `rate_pages.fd: null`. You will overwrite this file later in the run with the final config. If you run out of budget or encounter unrecoverable errors, the partial config persists and the operator can act on it."*
2. **Tool change (optional)** — a `commit_partial_config` tool that the agent invokes with `{ website, notes }`. Makes the checkpoint explicit and structured. Lower-priority than the prompt change.
3. **Classifier change** — `failure-classifier.js` should recognize a config with `scraper_type: "to_determine"` as the partial-Phase-1 state and route to `partial_success` with a new tier-1 axis value `website: found_committed_partial` to distinguish from full commit. (Optional polish; not blocking.)

**Status:** filed as evidence for #14. Bank's registry entry now carries `discovery_status: "website_known_no_rate_page"` (operator-confirmed terminal state) so future runs skip rediscovery regardless of #14.

---

## New `discovery_status` values introduced this session

| Value | Meaning | Seen in |
|---|---|---|
| `no_website_known` | No online presence after operator verification. Future runs skip discovery entirely. | `azamgarh-district-central-co-operative-bank-ltd` |
| `website_known_no_rate_page` | Website exists and is reachable, but no usable FD rate page exists or is published online. Future runs skip rediscovery. | `dhanbad-district-central-co-operative-bank-ltd` |

Sprint 002 #5 codification needs to teach `tier-router.js` and the discovery flow to honor these statuses (skip Tier 1 LLM discovery; emit a fast `manual` summary).

---

## L7 — Recruitment-only domains posing as banks are likely fraud lookalikes; do not commit

**Surfaced by:** `gondia-district-central-co-operative-bank-ltd` (Maharashtra, 2026-05-12).

**Symptom:** Search surfaced `gondiadccb.co.in` as a candidate for the bank. The agent fetched it (and even escalated to Playwright — L3 working correctly). The rendered content was entirely recruitment notices and announcements, no banking products, no FD/RD/savings information, no actual bank branding or service descriptions. The agent committed it as the bank's official website with `scraper_type: "manual"`. Operator flagged it as possibly fraudulent.

**The pattern:** In India, scam sites posing as cooperative banks publish job advertisements to collect application fees from job seekers. These sites:
- Use bank-sounding domains (`*dccb*`, `*sahakari*`, `*coopbank*`)
- Display recruitment notices prominently
- Have no banking products / services pages
- May have legitimate-looking bank branding scraped from real banks
- Often impersonate banks that genuinely have low/no online presence (DCCBs being a prime target)

**Codification candidate:** content-shape heuristic for the agent. When a candidate "bank" site's content is:
- > 50% recruitment / job-notification material
- AND has no visible banking-product pages (no "Deposits", "Loans", "FD", "RD", "Schemes" sections)
- AND has no branch/contact information

→ treat as **likely lookalike**. Do not commit as the bank's website. Continue searching or fall back to `no_candidates` with a note.

**Caveat:** some legitimate small DCCBs DO have minimal websites that are mostly notifications. The heuristic is "primarily recruitment" not "only notifications." Borderline cases should remain `reachable_uncommitted` and surface to the operator rather than auto-commit.

**Tooling support that would help:** the `fetch_url`/`run_playwright` tools could surface a tiny set of content-shape metrics in their response (link count, count of strings matching `recruitment|hiring|vacancy|application form`, count of strings matching `deposit|interest|FD|RD|savings|loan`) so the agent's prompt can reason about content shape numerically rather than just narratively.

---

## L8 — Multilingual rate pages: URL paths AND tenure strings can be in Hindi (or other regional languages)

**Surfaced by:** `indore-premier-co-operative-bank-ltd` (MP, 2026-05-12).

**Symptom:** Bank's official site is at `ipc.bank.in` (a 3-letter acronym domain — agent missed the abbreviation IPC = Indore Premier Cooperative). The rate page URL is `/%e0%a4%ac%e0%a5%8d%e0%a4%af%e0%a4%be%e0%a4%9c-%e0%a4%a6%e0%a4%b0/` — URL-encoded Devanagari (`/ब्याज-दर/` = "byaj-dar" = "interest rate"). Verified live: clean HTML table with 8 slabs.

**Two distinct gaps:**

### Gap 1 — Discovery doesn't try Hindi search terms

The agent's `site:bank.in` search uses English-only query terms (`interest rate deposit`). For banks whose .bank.in subdomain hosts a Hindi-first site, no English-language hit will surface the rate page. The agent never fetched `ipc.bank.in` — it didn't even know the bank's domain.

**Codification candidates:**
- Prompt rule — *"For DCCBs, SUCBs, NSUCBs, and other small co-op banks (especially those serving Hindi-speaking states: UP, MP, Rajasthan, Bihar, Jharkhand, Chhattisgarh), include Hindi search terms in at least one query attempt: `ब्याज दर` (interest rate), `सावधि जमा` (fixed deposit), `सहकारी बैंक` (cooperative bank). Use them in combination with the bank's English name."*
- Tooling — Web search via Bing/Azure Responses already returns results from Hindi pages if the query terms match; no tool change needed beyond the query strategy.
- Expand to other regional languages as banks from those states surface: Tamil (வட்டி விகிதம் = vatti vikitam = interest rate), Telugu (వడ్డీ రేటు = vaddi rate), Kannada (ಬಡ್ಡಿ ದರ = baddi dara), Marathi (व्याज दर — same as Hindi), Bengali (সুদের হার = suder har), etc.

### Gap 2 — Rate-slab text parser only knows English tenure patterns

When `fetch_url`/`run_playwright` does pull the HTML table, the downstream text parser (in `scripts/fetch_rates_playwright.js` and `lib/agent.js` post-processing) uses English-only regex like `/(\d+)\s*days?/i`, `/(\d+)\s*years?/i`. Hindi tenure strings like "7 दिन से 14 दिन तक" or "5 वर्ष एवं उससे अधिक" yield 0 parsed slabs. The data is there in `tables[].rows[]` but the slab-shape extraction can't normalize it.

Validation: ran `node scripts/fetch_rates_playwright.js` against the Indore page — output said `Rate slabs parsed from text: 0` despite the HTML table being clearly visible.

**Codification candidates:**
- **Lightweight (preferred first pass):** translate the tenure column via an LLM call before regex parsing. The LLM normalizes Hindi/Tamil/etc. tenure strings to canonical English ("7 दिन से 14 दिन तक" → "7 days to 14 days"). One small LLM call per rate page; tens of cents per category run.
- **Heavier:** maintain a Hindi → English term dictionary (`दिन`=day, `वर्ष`=year, `माह`=month, etc.) and pattern-match Devanagari-aware regex. Less general but cheaper.
- **Even heavier:** ditch regex parsing for slabs entirely and have the LLM produce structured slab JSON directly from any HTML table. Already the case for the Tier-2 extraction path? — verify.

**Status:** Indore's registry entry now carries `extraction_notes: "multilingual_hindi"` so the (yet-to-be-built) extraction pipeline can route this bank to the multilingual path. The bank will report `extraction: failed` on the next run with the current parser; the registry entry is correct, only the extractor needs to catch up.

### Sub-learning — domains are sometimes short acronyms

The bank's domain is `ipc.bank.in`, not `ipcb.bank.in` or `indorepremier.bank.in`. The "Co-operative Bank" tail of the bank's name is dropped; only the city/scope abbreviation remains. The agent's slug-based URL guesses don't reach this short form.

**Why not fix this by guessing?** CLAUDE.md still forbids URL guessing. The right fix is search-strategy improvement: when a `site:bank.in <full name>` search returns nothing, retry with `site:bank.in <words-stripped-to-2-or-3>` (`site:bank.in IPC`, `site:bank.in IPCB`). This stays within the "search, don't guess" boundary.

---

## L9 — Some banks publish rates as image-only (photo of a printed letterhead office order)

**Surfaced by:** `angul-united-central-co-operative-bank-ltd` (Odisha, 2026-05-12).

**Symptom:** Bank's rate page at `https://auccb.bank.in/deposit-rate-of-interest/` shows a single JPG image (`Deposit-ROI_new.jpg`) — a photo of a printed office order on the bank's letterhead, dated 21/11/2023. No HTML table, no PDF, no machine-readable surface. The agent correctly found the site, the rate page URL, and even attempted `fetch_pdf` on the JPG (which failed because JPG ≠ PDF). The agent's prose was accurate: "the rate page contains only an image, not a PDF or HTML table. Senior citizen premium is stated as +0.50% p.a. but no base rates are published."

**Pattern:** small banks digitize their office orders by photographing the printed/scanned letter and uploading the JPG, rather than converting to HTML or even text-extractable PDF. Common in older DCCBs that treat the website as a notice board, not a structured catalog.

**Status this turn:** rates manually transcribed from the operator screenshot into `output/latest/angul-united-central-co-operative-bank-ltd_rates.json` with `extraction_method: "manual_image_transcription"` and `extraction_confidence: "high"`. 12 FD slabs (7 days → 10 years) plus special schemes (staff +1%, retired senior staff +1.50%, senior citizens +0.50%). Effective date is the office order date (2023-11-21), not the image upload date (2025-09).

**Codification candidates (Sprint 002+):**

1. **`extraction_method` tag in the per-bank config.** New optional field. Values: `automatic_html`, `automatic_pdf`, `manual_image_transcription`, `manual_data_entry`. Lets the pipeline distinguish auto-extracted rows from operator-transcribed ones and skip the auto-extractor for known-image banks.

2. **OCR / Vision-API fallback for image-only rate pages.** When the agent fetches a rate page and the body is dominated by an `<img>` tag (or the page has < 1KB of non-image content), send the image URL to a Vision-capable LLM call (gpt-4 vision, Claude vision, Azure Document AI) to extract the table. Higher cost per bank (~$0.05-0.20 per image) but recovers a long tail of small banks.

3. **`scraper_type: "image"` enum extension.** In `bank-domains.json`, add `image` as a recognized scraper type. The Sprint 002 #5 codification can route banks tagged with this to the Vision-extraction path (when built) or skip them with a clean manual placeholder until then.

4. **Image-URL detection heuristic.** When the agent fetches a rate page and the HTML contains an `<img>` whose URL ends in `.jpg`, `.jpeg`, `.png`, `.webp` AND the image's filename includes keywords like `deposit`, `interest`, `rate`, `roi`, `tdr`, `fd` — flag the image as the likely rate card surface. The agent currently tries `fetch_pdf` on these (sometimes); a small heuristic in `lib/tools.js` would catch them more cleanly and either request Vision extraction or surface as an image-only signal to the operator.

**Sub-finding — cooperative banking rate column semantics.** The bank's rate card has multiple rate columns reflecting the DCCB → PACS → individual-depositor structure of cooperative banking:
- "Existing RoI" (prior rates)
- "Revised R.o.I of DCCB" (new rates at DCCB branches — what general depositors get)
- "DCCB to Deposit Counter including Addl. Int. @ 0.25%" (rate the DCCB pays its Primary Agricultural Co-op Societies)
- "Deposit Counter Depositor" (rate the PACS pays its individual member-depositors)

For the canonical rates file, use the "Revised R.o.I of DCCB" column — that's the rate a general depositor walking into an AUCCB branch receives. The other columns describe inter-cooperative flows. This pattern likely repeats in other DCCBs; worth documenting in the extraction prompt when L9's Vision path is built.

---

## L10 — Rate PDFs often contain MULTIPLE chronological circulars; only the latest is current

**Surfaced by:** `banswara-central-co-operative-bank-ltd` (Rajasthan, 2026-05-12).

**Symptom:** The bank's "deposit rates" PDF is a single file containing 9 pages, each a separate office order issued on a different date over a 2.5-year window (w.e.f. 12-03-2021 through w.e.f. 21-07-2023). Each order supersedes the previous. The cloud agent reported **45 slabs** for this bank — almost certainly the extractor pulling rate rows from ALL 9 pages and concatenating them, producing a fictional aggregate that includes obsolete rates. Treating those 45 slabs as current would have been a real data-quality error.

**The pattern:** small banks publish rates as a running log of office orders rather than rewriting a single "current rates" page. The PDF grows over time as new orders are appended. The latest applicable rates are on the LAST circular in the file (highest w.e.f. date).

**Codification candidates:**

1. **PDF-page-aware extraction.** The slab extractor should:
   - First, scan all pages for `w.e.f. <date>` patterns (or equivalents: "effective from", "with effect from", "WEF").
   - If multiple distinct dates found, identify the latest.
   - Extract slabs only from the page(s) within the latest circular.
   - Older pages go to `warnings: ["Older circular dated <X> found in same PDF; not extracted"]`.

2. **Cloud-side regression guard.** The Sprint 002 #12 cloud rerun MUST sanity-check absurdly high slab counts. A DCCB with > 25 slabs in `regular` variant is almost certainly a multi-circular over-extraction. The classifier can emit a `warning: implausible_slab_count` signal that the operator notices.

3. **PDF metadata heuristic.** Filenames sometimes include dates ("FD RATES 11-07-2023.pdf"); often the upload date in the URL path is also a date ("/uploads/2025/09/..."). When both are present and disagree by months/years, suspect multi-circular structure. Surface to operator.

**Cross-reference:** the v2 taxonomy's notes about a few banks (`barmer-central`, `banswara-central`) being "cloud 45-slab successes that became 0-slab extraction failures locally" — confirmed here. The cloud's 45 was inflated; locally we get 0 because the PDF text-layer is OCR'd garbage (see L11).

---

## L11 — PDFs with scanned page images and an OCR text layer: text-extractable but unreliable

**Surfaced by:** `banswara-central-co-operative-bank-ltd`.

**Symptom:** The 11-07-2023 PDF is structurally a sequence of scanned page images with an OCR-generated text layer underneath. Behavior:
- The user's PDF viewer shows the page images; text is not selectable (the image layer overlays the OCR layer).
- `pdf-parse` extracts ~12 KB of text from the OCR layer across 9 pages — text exists but is garbled (visible artifacts: "C0-0PERATIVE", "Hoad Offico", "Banawara 327001", numeric characters mis-recognized as alphabetic and vice versa).
- Cloud's auto-extractor ingested the OCR text, pattern-matched anything looking like a percentage, and produced 45 inflated slabs (L10 effect compounded by OCR noise).

**Distinction from L9:**
- **L9 (image-only):** Rate page hosts a JPG; no PDF wrapper; no text layer at all. Operator must visually transcribe.
- **L11 (scanned PDF with OCR):** Looks like a real PDF in viewers but the text layer is OCR-derived and noisy. `pdf-parse` returns text but it shouldn't be trusted for rate digit extraction.

**Codification candidates:**

1. **Detect OCR-text-layer PDFs early.** Heuristic: if the PDF has both `/Font` and `/Image` references with > N images per page (suggests page-scan-per-page), AND extracted text density is anomalously low or has high non-ASCII character ratio, treat it as `scraper_type: "pdf_scanned"`. Different code path from `pdf_text`.

2. **Route to Vision-API.** Same destination as L9 — send each page (as image) to a Vision LLM, parse the structured table back out.

3. **Stop trusting OCR text.** The existing `fetch_pdf` tool extracts the OCR text and hands it to the LLM. For scanned-PDF banks, this should be skipped in favor of image-based extraction. Until that's built, the extractor should be conservative and prefer 0 slabs (current behavior) over OCR-corrupted slabs (cloud's 45).

**Banswara status:** marked `extraction_method: "pending_vision"` in registry. Awaiting either operator visual transcription of page 8 (latest circular) or a future Vision-API pass.

---

## L12 — Bank homepages sometimes link to rate PDFs at broken URLs; agent path-probing can recover them

**Surfaced by:** `barmer-central-co-operative-bank-ltd` (Rajasthan, 2026-05-12).

**Symptom:** The bank's homepage advertises its rate PDF at `https://www.ccbbarmer.bank.in/Deposit_interest_rates.pdf` — that URL returns 404. The actual file is hosted at `https://ccbbarmer.bank.in/PDF/Deposit_interest_rates.pdf` (no www; `/PDF/` directory prefix; case-sensitive — `/PDF/` works, `/pdf/` is a different directory used by another policy doc). The agent's discovery process happened to find the working path via a different search pattern.

**Implications:**

1. **The agent's "discovered URL" is more reliable than the homepage's advertised link** when they disagree. The registry should record the working URL — not what the homepage menu says — even when these differ.

2. **Operators clicking the homepage link will get 404.** When debugging discrepancies, operators should test the working URL from the registry, not the homepage navigation. The registry entry's `notes` should record the broken homepage path so operators don't get confused.

3. **The agent's behavior here was the right one** but is largely accidental — there's no explicit fallback rule in the prompt for "homepage link returns 404, try variant paths." For now, when the agent stumbles onto the working path it commits it; when it doesn't, the bank ends up `discovery_failed` even though a working URL exists.

**Codification candidates:**

1. **Modest path-probing exception to the URL-guessing rule.** Allow the agent to retry a 404'd PDF URL with one well-defined transformation: try `/PDF/<filename>` if `/<filename>` returns 404 (and the converse). Case variants `/PDF/` ↔ `/pdf/` are also worth one retry. This is a small, named exception to "no URL guessing" — limited to PDF-suffixed URLs and a single retry per failed path.

2. **Registry-level `broken_homepage_link` field** (optional). For banks where the homepage's advertised rate URL differs from the working one, record both. Surfaces operator confusion early and lets a future "broken-link reporter" tool email banks to fix their sites.

3. **No special codification needed if cases are rare.** L12 may turn out to be a long-tail oddity for ~1-5 banks per category. If so, the registry note is enough.

**Cross-link:** L12 partly mitigates L1 (fetch homepage to see menu) — the menu link sometimes lies. The corrective is: fetch homepage AND validate the URLs the menu offers AND fall back to path-probing if they 404.

---

## L13 — Product pages are sometimes stubs; the rate table lives behind a "View More" link

**Surfaced by:** `nizamabad-district-co-operative-central-bank-ltd` (Telangana, 2026-05-12).

**Symptom:** The agent (correctly) went to `https://nizamabaddccb.bank.in/fixed-deposit/` — the URL the registry pointed at — and Playwright rendered it cleanly. Zero rate tables on that page. The agent stopped there. But the page has a "View More" link to `/deposit-schemes/` where the actual rate table lives (rendered as styled divs across 12 slabs + a 444-day Kamadhenu special scheme).

**Generalization of L1:** L1 said "if search returns a deep URL, also fetch the homepage." L13 says "if a product page is sparse and has 'View More' / 'Read More' / 'Learn More' / pagination links, follow them once before declaring `no rate table on this page`."

**Codification candidates:**

1. **Prompt rule.** When the agent's fetched rate page has < 200 chars of rate-keyword density (no `%`, no `days`/`years`/`months`, no recognizable tenure phrasing) BUT has visible "View More" / "Read More" / "Click here for details" type links, follow ONE such link before concluding the page has no rates. Cap at one follow-link per page to bound the budget.

2. **Tool change.** `fetch_url` / `run_playwright` could surface a small "outbound_links" array in their response, filtered to bank-internal URLs whose anchor text contains keywords (`view more`, `read more`, `details`, `schemes`, `rates`, `deposits`). Lets the agent reason about follow-up explicitly rather than parsing HTML.

3. **Registry self-correction.** When operator discovers (as here) that the canonical rate page is at a different path than the agent's committed URL, update the registry. We did exactly this — moved `rate_pages.fd` from `/fixed-deposit/` to `/deposit-schemes/`.

**Additional finding — "table" rendered as styled divs:**

The /deposit-schemes/ page has the rate table data but it's NOT an HTML `<table>` element — it's styled `<div>` blocks. Playwright's "Tables (HTML)" count came back as 0 even though the data is plainly visible in `document.body.innerText`. The slab-parsing pipeline that scans for `<table>` will miss this entirely.

**Codification candidate (small extraction improvement):** the rate-extractor should fall back from `<table>` parsing to text-pattern parsing of the rendered `innerText` when no tables found. The text already has tab-separated rows in the rendered output — easy to pattern-match `^\d+\t[\d\w to-]+\t\d+\.\d{2}` for slab rows. This recovers banks that use the "div table" pattern (common in WordPress themes that don't use the table block).

**Sub-finding — auxiliary rate images.** The page also links to two JPG images:
- `WhatsApp-Image-2025-10-22-at-12.21.40-PM.jpeg` — RD rates (English)
- `WhatsApp-Image-2025-10-22-at-12.21.41-PM.jpeg` — Telugu-language special scheme poster (multilingual — L8 cross-link)

The "WhatsApp-Image-..." filename pattern suggests bank staff are screenshotting rate posters from WhatsApp messages and uploading them as the website's rate-display surface. Worth a small detection heuristic — if a bank's WordPress media library has `WhatsApp-Image-*.jpeg` files in `/wp-content/uploads/`, flag as `extraction_notes: "whatsapp_screenshot_workflow"` and route to Vision-API.

---

## L14 — `no_rates_expected` classifier regex over-matches "no FD rates published"

**Surfaced by:** `bankura-district-central-co-operative-bank-ltd` (West Bengal, 2026-05-12).

**Symptom:** The Sprint 002 v2 classifier (in `lib/failure-classifier.js`) routed Bankura to `no_rates_expected` because the agent's notes contained the phrase "No FD ... rates are published online." But the bank DOES offer FDs — the website's `/interest-rate/` page just says "Coming Soon." Correct classification is `website_known_no_rate_page` (same shape as dhanbad: full website, real rate page URL, but page is unpopulated).

**The regex:**

```js
// lib/failure-classifier.js
const NO_RATES_NOTES_REGEX = /no\s+(fd|fixed deposit)|payments?\s+bank|does not offer/i;
```

The clauses are intended to match:
- "no FD product" / "no fixed deposit product" — bank doesn't offer FDs at all
- "payments bank" — Payments Banks can't offer term deposits per RBI regulation
- "does not offer" — explicit "bank does not offer X"

But `/no\s+(fd|fixed deposit)/` matches anything with "no FD" in it, including:
- "no FD rate is published" (Bankura's case — bank offers FDs, just doesn't publish rates online)
- "no FD page found" (could fire on any agent giving up on a rate-page hunt)
- "no FD information available on website" (different from "no FD product")

**Codification candidate (Sprint 002 #5):** tighten the regex to require an explicit "no X product" signal:

```js
const NO_RATES_NOTES_REGEX =
  /\bdoes not offer (fd|fixed deposit|term deposit)/i           // explicit no-product
  .source + '|' +
  /\bno (fixed )?deposit (product|scheme|account)\b/i.source    // "no deposit product"
  .source + '|' +
  /\bpayments?\s+bank\b/i.source                                 // Payments Bank category
  + ... ;
```

Or simpler — drop the brittle regex entirely and route on `bank_type === "PB"` (Payments Bank) AND a separate `agent_explicit_no_product_notes` flag the agent sets only when the bank clearly doesn't offer FDs.

**Tier-2 implications:** Add a test case to `tests/lib/failure-classifier.test.js`:
- "no FD rates published online" → `website_known_no_rate_page` (NOT `no_rates_expected`)
- "Coming Soon for FD rates" → `website_known_no_rate_page`
- "Bank does not offer fixed deposits" → `no_rates_expected`
- "This is a Payments Bank; per RBI regulation, no term deposits" → `no_rates_expected`

**Scope:** the bug also affects the diagnostic baseline — review the other bank in this run flagged `no_rates_expected` (`ajmer-central-co-operative-bank-ltd`) and the 3 banks from Sprint 001 cloud forensic that classified as `no_rates_expected` for the same reason. Those banks need re-classification when the regex tightens.

---

## Open

_Future operator-followup banks add learnings below._

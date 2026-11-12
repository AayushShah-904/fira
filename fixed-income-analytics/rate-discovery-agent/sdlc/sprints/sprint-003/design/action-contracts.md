# Sprint 003 Item #1a — Action contracts

**Date:** 2026-05-15 (Sprint 003 Week 1 Day 3); revised 2026-05-15 after operator Q1–Q13 answers.
**Status:** Operator-answered; revised. Q1–Q13 inline answers integrated into contracts. Outstanding follow-ups noted at end.
**References:** `sdlc/sprints/sprint-003/plan/scope.md:24-53` (the 8-action table), `plan/sub-agents.md:82-108` (A3 action-implementer template), `lib/tools.js`, `lib/agent.js`, `lib/safe-write.js`, `lib/extraction-methods.js`.

## Goal

Replace the agent's current monolithic discovery-and-extraction prompt with a thin **deterministic orchestrator** (Q13 answer) that calls named **actions** with explicit JSON contracts. The orchestrator is plain code; LLM is invoked only inside specific actions (`find_*`, and `extract_html_table`'s LLM-fallback). Extraction (`extract_*`) and persistence (`commit_*`) become deterministic functions the orchestrator invokes — not prompts the LLM inlines.

Why: clean seams allow surgical AI/deterministic mixing (per `re-think-plan.md` "AI is not one thing" reframing). They also make each action independently testable, observable, and replaceable — including replacement by a deterministic per-bank scraper in Fork B/C.

## Decisions log (Q1–Q13)

| # | Decision | How it changes the contract |
|---|----------|---|
| Q1 | Single URL recommended + ranked list as metadata | `find_website` returns `{url, candidates_considered[]}` — no change from draft. |
| Q2 | Fail-loud below confidence threshold; no low-confidence guess | No change from draft. |
| Q3 | Lean split (separate `classify_rate_page`); accept default pending cost-benefit | Cost-benefit analysis written below; recommendation: **split** into `find_rate_page` + `classify_rate_page` (now 9 actions, not 8). |
| Q4 | Fetch needed to confirm; `mode: "discover" \| "recheck"` parameter | `find_rate_page` and `classify_rate_page` both accept `mode`. Recheck mode skips re-fetch when cached `kind` is stable. |
| Q5 | Wrap both deterministic + LLM paths; need rule for LLM invocation. **Slab schema must include `currency`. Cross-check scraper FCNR/GIFT awareness.** | A3 variant enum extended to include `fcnr`/`gift`; slab schema adds `currency` field; LLM-invocation rule: deterministic first → LLM fallback if `slabs.length === 0` OR if column-mapping confidence < threshold OR if hints say `prefer_llm: true`. Scraper cross-check: see appendix — scraper IS updated for FCNR/GIFT. |
| Q6 | Use focused LLM for effective_date | No change from draft. |
| Q7 | Reject ambiguous columns; workflow handles outcome | No change. Orchestrator routes rejected outcomes to operator-resolve sidecar. |
| Q8 | **Multi-page PDF: parse ALL pages, not just latest. Single PDF may have multiple products/variants. Persist structure for repeat passes.** | A4 contract redone: returns array of `{page, product_type, variant, effective_date, slabs, currency_columns?}`; output adds `structure_hint` for future passes. |
| Q9 | Enum value: **`vision_model`** (not `automatic_vision`) | Added to `lib/extraction-methods.js` AUTO_OVERWRITEABLE_METHODS. |
| Q10 | `classify_outcome` returns only; orchestrator writes summary | No change from draft. |
| Q11 | Refuse + write maximum info for tracking and improvement | A8 redone: on validation failure, refuse the canonical write AND emit the rejected payload + flag detail to `output/runs/<ts>/_rejected/<bank>_<variant>.json` with full validation report. Logger entry at WARN with summary. |
| Q12 | Fail for that bank with proper log to help recover | A8 spells out the logging contract: WARN-level entry naming `bank_code`, `expected_slug`, `received_slug`, `mismatched_fields[]`. Action returns `{ok: false, error_class: "slug_mismatch", error_message, log_entry}`. |
| Q13 | **Deterministic orchestrator with LLM used as necessary** | Confirms recommendation. Orchestrator is `lib/orchestrator.js`, a plain function that walks the action sequence. LLM scoped to `find_website`, `find_rate_page`'s hint-following, and `extract_html_table`'s LLM-fallback path. |

## Cost-benefit: split `classify_rate_page` from `find_rate_page` (Q3)

**Cost of splitting:**
- 9 actions instead of 8 (modest doc/test surface increase).
- Orchestrator gains one more sequenced step per rate-page: `find_rate_page` → `classify_rate_page` → `extract_*`.
- Action-implementer subagent runs 9 times in #1b instead of 8.

**Benefit of splitting:**
- `find_rate_page` becomes pure URL-discovery (anchor parsing, pattern matching, optional LLM hint-following). Deterministic when domain is known + cached path is valid.
- `classify_rate_page` is the one place that decides `html_static` vs `html_js` vs `pdf` vs `image`. Owning the HEAD-fetch + content-sniff there means find_rate_page doesn't need network round trips when paths are known.
- The `mode: "discover" \| "recheck"` (Q4) parameter affects both actions differently: recheck skips re-classification when prior kind is stable + skips re-fetch when prior path resolves. Splitting lets each action handle its own recheck logic cleanly.
- Cleaner Fork-B story: a Selective-AI fork that wants per-bank deterministic scrapers can replace `classify_rate_page` for known banks while keeping `find_rate_page` LLM-driven for discovery. Single combined action makes that swap awkward.

**Recommendation:** split. The action count rises to 9 but the orchestrator and tests become easier. The benefit is concretely worth the modest cost.

## Cross-check: does packages/scraper handle FCNR/GIFT? (from operator concern in Q5 answer)

**Concern:** packages/scraper may have been created before the agent emitted FCNR/GIFT and not been updated.

**Finding (from `scraper-pipeline-audit.md`):** scraper IS updated. Evidence:
- `packages/scraper/src/import/import-discovery.ts:76` — `VARIANT_SUFFIXES = ["_nre_rates.json", "_nro_rates.json", "_fcnr_rates.json", "_gift_rates.json"]`.
- `packages/scraper/src/import/import-discovery.ts:79` — `CURRENCY_VARIANTS = new Set(["fcnr", "gift"])`.
- `packages/scraper/src/validators/range.ts:14-23` — variant-specific rate ranges for fcnr/gift (0.5–8.0%) and no-senior rule.
- Commit `59f7750` (parent repo) titled "Phase 5 step 6 (BIRD side): variant-aware validators and multi-variant import".

**Conclusion:** scraper handles FCNR/GIFT through ingestion + validation. The gap is in **this action-contracts doc** (slab schema missed `currency`), not in the scraper. Track 1 (#2c) will exercise this end-to-end as part of the import run; if any drift surfaces it lands in the run report.

## Today's tool surface (for reference, what we're replacing)

`lib/tools.js` exposes 7 primitives:

- `web_search` — Bing or AOAI Responses
- `fetch_url` — HTTP GET + truncated HTML
- `fetch_pdf` — spawns `scripts/extract_rates_pdf.mjs`
- `run_playwright` — spawns `scripts/fetch_rates_playwright.js`
- `read_file`, `write_file` — sandboxed FS with safe-write routing
- `slugify` — canonical slug

These are **plumbing**. Today the LLM glues them together inside one big prompt to do website-find + rate-page-find + table-extract + classify + commit, all inline. Action decomposition splits the gluing into 8 named JSON-contracted functions; the primitives above stay (some actions will call several of them).

## The 8 actions — draft contracts

Each action is a module at `lib/actions/<name>.js` exporting a single async function. Conventions:

- All inputs and outputs are plain objects (JSON-serializable).
- Failure returns `null` for extract-shaped actions (returning slabs); other actions return a `{ok: false, error_class, error_message}` envelope on failure.
- Side effects (writes) only happen inside `commit_*` actions; everything else is pure-ish (HTTP and tool spawns are fine, but no FS writes).
- Slugs are canonical (call `slugify` from `scripts/utils/slugify.js`); never compose by hand.
- Logging via the injected `logger` argument; no `console.log`.

### A1. `find_website(input) → output`

**Purpose:** discover a bank's official website.

**Input:**
```js
{
  bank_name: string,           // full name from master list
  bank_type: string,           // PSB/PVB/SFB/SUCB/...
  state?: string,              // optional, helps disambiguate cooperative banks
  hints?: {                    // optional, e.g., from bank-domains.json
    cached_domain?: string,    // prior known domain
    likely_tld?: string,       // "bank.in" / "co.in" / "com"
  }
}
```

**Output (success):**
```js
{
  ok: true,
  url: string,                       // canonical homepage URL (e.g., "https://abbl.com")
  confidence: "high" | "medium" | "low",
  candidates_considered: Array<{     // for traceability and Phase 2 fallback
    url: string,
    rejected_reason?: string,        // null if accepted
  }>,
  notes?: string,                    // human-readable provenance ("found via .bank.in lookup")
}
```

**Output (failure):**
```js
{
  ok: false,
  error_class: "no_candidates_found" | "all_candidates_rejected" | "tool_error",
  error_message: string,
  candidates_considered?: Array<...>,
}
```

**Reuse:** `lib/tools.js::web_search`, `fetch_url`. The CLAUDE.md "priority for domain identification" rules (`.bank.in` first, then `.co.in`/`.com`) become deterministic ranking inside this action.

**Open questions for operator:**
- **Q1.** Should `find_website` return a single URL or a ranked list? `candidates_considered` already exposes the ranking; the primary `url` is the top pick. Default: single + ranked list as metadata. Operator can pick.
A. return a single URL as the recommended answer + the ranked list as the metadata
- **Q2.** When should the action fail vs. return `confidence: "low"` with a guess? My default: fail (return `ok: false`) if no candidate scored above a threshold; never return a low-confidence guess that downstream might silently trust.
A: Defualt answer good
### A2. `find_rate_page(input) → output`

**Purpose:** given a website, locate the URL of the deposit-rates page (FD / NRE / NRO / FCNR / savings). URL only — kind classification is `classify_rate_page` (A2b, split per Q3 answer).

**Input:**
```js
{
  domain: string,              // homepage URL (from find_website)
  product: "fd" | "fd_nre" | "fd_nro" | "fd_fcnr" | "savings" | "rd",
  mode: "discover" | "recheck",   // Q4 — different behavior per context
  hints?: {
    cached_path?: string,      // prior known rate page path
    bank_type?: string,        // for NRI-eligibility check
  }
}
```

**Behavior by mode:**
- `discover` — first-time URL hunt. Fetch the homepage, parse anchors for rate-related link text, follow common path patterns (e.g., `/deposit-rates`, `/interest-rates`), apply NRI-eligibility filter, optionally use LLM to disambiguate when multiple candidates match.
- `recheck` — prior URL is known via `hints.cached_path`. HEAD-check or GET the cached path; if 200 OK, return it without re-discovery. If 404/410, fall back to `discover` semantics with logged provenance.

**Output (success):**
```js
{
  ok: true,
  url: string,
  confidence: "high" | "medium" | "low",
  notes?: string,             // human-readable provenance
  mode_used: "discover" | "recheck_hit" | "recheck_fell_back_to_discover",
}
```

**Output (failure):**
```js
{
  ok: false,
  error_class: "no_link_found" | "not_applicable" | "fetch_failed" | "tool_error",
  error_message: string,
}
```

**Reuse:** `fetch_url` on `domain`, parse anchors via cheerio (already a dependency — confirmed in `package.json`), check NRI-eligibility (cooperative banks, RRBs, Payments Banks don't offer NRI products per CLAUDE.md Step 2b).

### A2b. `classify_rate_page(input) → output` (NEW — split from A2 per Q3 answer)

**Purpose:** given a rate-page URL, classify its rendering kind (`html_static` / `html_js` / `pdf` / `image`).

**Input:**
```js
{
  url: string,
  mode: "discover" | "recheck",
  hints?: {
    cached_kind?: "html_static" | "html_js" | "pdf" | "image",  // prior classification
  }
}
```

**Behavior by mode:**
- `discover` — HEAD-fetch first (1 RTT, no body); if `Content-Type` is `application/pdf` or URL ends `.pdf`, return `pdf`. If `image/*`, return `image`. Otherwise GET first 4KB and content-sniff: presence of `<table>` with `<tr><td>` text → `html_static`; presence of React/Angular/Vue root divs + empty containers → `html_js`. If ambiguous, full GET (8KB) and re-sniff.
- `recheck` — trust `hints.cached_kind` after a HEAD-fetch confirms the URL still resolves (200). If HEAD-fetch returns a different content type than expected, re-classify in `discover` mode.

**Output (success):**
```js
{
  ok: true,
  kind: "html_static" | "html_js" | "pdf" | "image",
  confidence: "high" | "medium" | "low",
  evidence: string,           // short reason: "Content-Type: application/pdf" or "<table> found with rate-bearing TDs"
  mode_used: "discover" | "recheck_hit" | "recheck_invalidated",
}
```

**Output (failure):**
```js
{
  ok: false,
  error_class: "fetch_failed" | "ambiguous_after_full_fetch" | "tool_error",
  error_message: string,
}
```

**Reuse:** `fetch_url` (with byte limit), HTTP HEAD via `lib/tools.js` extension or direct `https.request` with `method: "HEAD"`.
### A3. `extract_html_table(input) → output`

**Purpose:** extract rate slabs from an HTML rate page (static or JS-rendered) for any variant including FCNR (per-currency) and GIFT.

**Input:**
```js
{
  url: string,
  kind: "html_static" | "html_js",
  product_type: "FD",              // for now; "RD" / "savings" later
  variant: "regular" | "nre" | "nro" | "fcnr" | "gift",
  hints?: {
    selectors?: { table?, rows?, effective_date? },  // from cached config
    column_mapping?: Record<string, string>,         // tenure→col-0, general→col-1, etc.
    expected_slab_count?: number,
    expected_currencies?: string[],  // for fcnr/gift: ["USD","GBP","EUR","JPY","CAD","AUD"]
    prefer_llm?: boolean,            // force LLM path (e.g., known-hard layouts)
  }
}
```

**Output (success):**
```js
{
  slabs: Array<{
    tenure_text: string,
    tenure_min_days: number | null,
    tenure_max_days: number | null,
    rate_general_pct: number,
    rate_senior_pct: number | null,             // null for fcnr/gift (no senior premium)
    rate_super_senior_pct: number | null,       // null for fcnr/gift
    currency: string | null,                    // REQUIRED for fcnr/gift (e.g., "USD"); null/absent for regular/nre/nro (INR implied)
    deposit_range?: "below_3cr" | "3cr_to_5cr" | "5cr_to_25cr" | "25cr_to_100cr" | "above_100cr" | "below_15l" | "15l_to_1cr" | "1cr_to_10cr" | "above_10cr",
  }>,
  effective_date: string | null,    // ISO-8601 if extractable; LLM call extracts (Q6 answer)
  warnings: string[],               // non-fatal extraction notes
  extraction_method: "automatic_html_static" | "automatic_html_js" | "llm_inline_extraction",
  path_used: "deterministic" | "llm_fallback",  // observability
}
```

**Output (failure):** returns `null`. Caller writes `_rates.json` with `rate_slabs: []` and reason in `warnings`.

**LLM-invocation rule (Q5 answer — how LLM is chosen vs. deterministic):**

1. Always try deterministic path first (wrapping `scripts/extract_rates.js` dispatcher).
2. Fall back to LLM path if ANY of:
   - Deterministic returned `slabs.length === 0`.
   - Deterministic returned slabs but column-mapping confidence is below threshold (e.g., column headers don't match any known pattern).
   - `hints.prefer_llm === true` (operator-set for known-hard banks).
   - For `fcnr`/`gift`: the deterministic dispatcher does not parse per-currency columns reliably (separate currency-column-aware path in the LLM fallback).
3. PNB-style "Existing vs Revised" two-column layout detected (Q7): reject in BOTH paths — return `null` with `warnings: ["ambiguous_columns: existing_vs_revised_layout_detected"]`. The orchestrator routes to operator-resolve.

**FCNR/GIFT note:** per CLAUDE.md, FCNR slabs have no senior premium (always null). Per-currency: a 1-year USD slab and a 1-year GBP slab are distinct slabs with the same tenure and different `currency`. Output `slabs[]` contains one entry per (tenure, currency) pair.

**Reuse:** **load-bearing #1d wiring.** `scripts/extract_rates.js` already dispatches by `scraper_type`. Wrap as the deterministic path; LLM fallback uses `fetch_url` + focused prompt.
### A4. `extract_pdf_table(input) → output`

**Purpose:** extract rate slabs from a PDF rate card. PDFs may contain **multiple products and/or multiple variants across pages** (e.g., Yes Bank-style — page 1 regular FD, page 2 NRE, page 3 FCNR); all pages are parsed and returned grouped (Q8 answer). PDFs may also contain multiple historical circulars; the action interprets effective_date per page to distinguish current from historical.

**Input:**
```js
{
  url: string,                     // PDF URL
  expected?: {                     // optional caller hint about what to expect
    products?: ("FD")[],
    variants?: ("regular" | "nre" | "nro" | "fcnr" | "gift")[],
  },
  hints?: {
    effective_date_pattern?: string,
    structure?: object,            // prior-pass `structure_hint` (see output); short-circuits page scanning
  },
}
```

**Output (success):**
```js
{
  pages: Array<{
    page_number: number,
    product_type: "FD",            // inferred per page
    variant: "regular" | "nre" | "nro" | "fcnr" | "gift",  // inferred per page
    effective_date: string | null,
    slabs: Array<{ ... }>,         // same slab schema as A3, including currency for fcnr/gift
    warnings: string[],
    confidence: "high" | "medium" | "low",  // per-page confidence (variant inference might be ambiguous)
  }>,
  structure_hint: {                // for future-pass optimization (Q8 answer — "work done in one pass should help repeat checks")
    page_count: number,
    pages: Array<{
      page_number: number,
      heading_pattern: string,     // e.g., "NRE FIXED DEPOSIT RATES W.E.F. ..."
      variant_inferred: string,
      table_count: number,
    }>,
  },
  extraction_method: "automatic_pdf",
}
```

**Output (failure):** returns `null`. Caller proceeds with `rate_slabs: []` per variant.

**Repeat-pass semantics (Q8 answer):** when the orchestrator has a prior-pass `structure_hint` and the PDF URL is unchanged, it can pass it back via `hints.structure`. The action uses the hint to short-circuit page scanning (jump directly to the page for the requested variant); if the hint is stale (page count differs or heading patterns don't match), the action invalidates the hint and falls back to full scanning, reporting `warnings: ["structure_hint_invalidated"]`.

**Reuse:** `fetch_pdf` tool which already calls `scripts/extract_rates_pdf.mjs`. Multi-page parsing requires extending `scripts/extract_rates_pdf.mjs` or wrapping its output — that's part of #1b's A4 implementation (~half-day extra vs. single-page version).
### A5. `extract_via_vision(input) → output`

**Purpose:** OCR/vision-based extraction for image-only rate cards or scanned PDFs. Per-currency support for FCNR/GIFT.

**Input:**
```js
{
  url: string,                     // image URL (jpg/png/webp) or PDF page rendered as image
  product_type: "FD",
  variant: "regular" | "nre" | "nro" | "fcnr" | "gift",
  hints?: {
    expected_currencies?: string[],  // for fcnr/gift
  }
}
```

**Output:** same shape as `extract_html_table` (slabs[] with `currency` field for fcnr/gift). `extraction_method: "vision_model"` (Q9 answer — new enum value, NOT `automatic_vision`). `confidence` field gains weight here (vision is more error-prone than HTML/PDF).

**Reuse:** to be implemented in Sprint 003 Item #5 (Vision integration). Action stub lands now; implementation later.

**Note on enum:** `vision_model` must be added to `lib/extraction-methods.js::AUTO_OVERWRITEABLE_METHODS`. Cross-check with packages/scraper: the scraper doesn't validate the specific enum value, only that `_rates.json` is parseable, so adding a new value is non-breaking downstream.
### A6. `classify_outcome(input) → output`

**Purpose:** given the per-bank artifacts produced so far in a run, classify the outcome.

**Input:**
```js
{
  bank_code: string,
  artifacts: {                     // pointers to what was produced
    config?: object,               // parsed _config.json
    rates?: object,                // parsed _rates.json
    variants?: object[],           // _nre_rates.json etc.
    summary?: object,              // _summary.json (in-progress)
  },
  signals: {                       // extraction-time observations
    website_found: boolean,
    rate_page_found: boolean,
    slabs_extracted_count: number,
  }
}
```

**Output:**
```js
{
  failure_class: "success" | "no_website_found" | "rate_page_not_found" | "extraction_failed_t1" | "extraction_failed_t2" | "partial_success",
  phase_outcomes: {                // v2 two-tier taxonomy per Sprint 002 #2
    website: "found_committed" | "found_uncommitted" | "candidates_all_failed",
    rate_page: "found" | "not_found" | "not_attempted",
    extraction: "success" | "zero_slabs" | "validation_failed" | "not_attempted",
  },
  failure_signals: string[],       // e.g., ["js_rendered_but_playwright_failed", "captcha_wall"]
}
```

**Reuse:** **wraps existing `lib/failure-classifier.js`** verbatim — already produces this taxonomy. Action is a thin adapter.

**Open questions:**
- **Q10.** Should this action also write the `summary.json` with the classification, or is that the orchestrator's job? Default: this action returns the classification; orchestrator writes the summary via `commit_to_registry` or a thin `write_summary` step. Splitting keeps classify_outcome pure.
A: Ok
### A7. `commit_to_registry(input) → output`

**Purpose:** update `data/bank-domains.json` with discovered fields, per ADR-011's confidence-aware merge.

**Input:**
```js
{
  bank_code: string,               // canonical slug
  updates: {                       // partial entry — only fields to merge
    domain?: string,
    confidence?: "high" | "medium" | "low",
    rate_pages?: { fd?, fd_nre?, fd_nro?, fd_fcnr?, fd_nri_combined?, savings?, rd? },
    scraper_type?: string,
    discovery_metadata?: { last_discovered_at, discovery_method, notes? },
  },
}
```

**Output:**
```js
{
  ok: true,
  wrote: boolean,                  // false if no fields changed
  deferred_to_pending: boolean,    // true if collision routed to bank-domains-pending.json
  pending_path?: string,           // present when deferred
}
```

**Reuse:** **wraps existing `lib/domain-cache.js::updateDomainEntry`** which already does confidence-aware merge + safe-write atomic rewrite per ADR-011 and ADR-012.

**Open questions:** none — this is a thin adapter over existing infrastructure.

### A8. `commit_rates(input) → output`

**Purpose:** write a `_rates.json` (or variant) through `lib/safe-write.js` per ADR-012.

**Input:**
```js
{
  bank_code: string,               // canonical slug
  variant: "regular" | "nre" | "nro" | "fcnr" | "gift",
  payload: {                       // the full rates JSON to write
    bank_code, bank_name, product_type, variant, effective_date,
    source_url, scraped_at, extraction_confidence,
    rate_slabs: [...],
    special_schemes: [...],
    warnings: [...],
    errors: [...],
  },
  extraction_method: string,       // must be in lib/extraction-methods.js AUTO_OVERWRITEABLE_METHODS or CURATED_EXTRACTION_METHODS
}
```

**Output (success):**
```js
{
  ok: true,
  wrote: boolean,
  deferred_to_pending: boolean,
  pending_path?: string,
  validation: {                    // **new gate enforced here per A1 deferred item**
    passed: boolean,
    critical_count: number,
    warning_count: number,
    flags: Array<{ severity, flag_type, slab_index?, details }>,  // full flag list for traceability
  }
}
```

**Output (failure — slug mismatch, Q12):**
```js
{
  ok: false,
  error_class: "slug_mismatch",
  error_message: string,
  log_entry: {                     // structured for log-aggregation; written at WARN level
    bank_code_expected: string,
    bank_code_received: string,
    mismatched_fields: string[],   // which top-level fields disagree
    payload_path_attempted: string,
    timestamp: string,
  },
}
```

**Output (failure — validation, Q11):**
- On `validation.passed === false`: the canonical write is refused (returns `ok: true, wrote: false, validation.passed: false, validation.flags: [...]`).
- AND the rejected payload + full validation report is captured at `output/runs/<run_label>/_rejected/<bank_code>_<variant>.json` for tracking and improvement (Q11 answer — write maximum info, not just refuse silently). The file contains: the agent's payload as submitted, the validation flags, the orchestrator's run_label, and a `caller_hint` field summarizing what the orchestrator should consider on retry.
- Logger entry at WARN level: `commit_rates validation failed bank=<code> variant=<v> critical=<n> warnings=<n>`.

**Behavior change vs. today:**
- **Enforces `validate-rates.js` as a hard gate** (closes A1 deferred item). Critical flags refuse the canonical write.
- **Enforces slug discipline at the action boundary** (closes A4 deferred item; Q12 answer). If `payload.bank_code !== input.bank_code`, fail with the structured `slug_mismatch` envelope above. No silent rewrite via `slug-guard.js` — that post-hoc correction stays as a defense-in-depth net but should never fire for action-produced writes.
- Validation flags are persisted into the output JSON's `validation` block when `wrote === true` (warnings only — critical flags refuse the write entirely).
- All other safe-write behaviors preserved (curated-target preservation, pending sidecars).

**Reuse:** wraps `lib/safe-write.js::safeWriteArtifact` + `scripts/utils/validate-rates.js::validateSlabs` + canonical `scripts/utils/slugify.js`.
## Orchestrator shape (decided per Q13 — deterministic, scoped LLM)

The orchestrator is **Sprint 003 Item #1c**, not this design doc — but the contract assumes the decided shape:

- **`lib/orchestrator.js`** is a plain Node function that walks the action sequence. No LLM loop at this layer.
- **LLM is scoped to inside specific actions**, not at the orchestrator level:
  - `find_website` — LLM for candidate disambiguation when web_search returns multiple plausible domains.
  - `find_rate_page` — LLM for anchor-link interpretation when text + path patterns are ambiguous.
  - `extract_html_table` LLM-fallback path — when deterministic dispatcher returns 0 slabs OR `prefer_llm: true` hint.
- Everywhere else: deterministic Node code.

Per-bank orchestration sequence:

1. `find_website(bank_name, bank_type, state, hints from bank-domains.json)`.
2. On success → `commit_to_registry({ domain, confidence })`.
3. For each applicable product (regular FD always; plus NRE/NRO/FCNR if `bank_type ∈ {PSB, PVB, FB, IBU} ∨ large_SFB` per CLAUDE.md Step 2b):
   a. `find_rate_page(domain, product, mode)` → URL.
   b. `classify_rate_page(url, mode)` → kind (new A2b per Q3 split).
   c. Branch on kind:
      - `html_static` / `html_js` → `extract_html_table(url, kind, variant)`.
      - `pdf` → `extract_pdf_table(url, expected.variants)`.
      - `image` → `extract_via_vision(url, variant)`.
   d. On slabs returned → `commit_rates(bank_code, variant, payload, extraction_method)`.
   e. On rejection (slug mismatch / validation fail) → log + continue (run not aborted by per-variant failure).
4. After all variants → `classify_outcome(...)` and write summary via thin `write_summary` step.

**PDF-multi-page case (Q8):** when an `extract_pdf_table` call returns multiple pages spanning multiple variants, the orchestrator iterates `pages[]` and calls `commit_rates` once per `(variant, currency)` partition. The `structure_hint` from the first pass is persisted in `bank-domains.json` under `discovery_metadata.pdf_structure` so future passes use `mode: "recheck"`.

## What's open for operator decision (consolidated — answers integrated)

| # | Question | Operator answer | Contract effect |
|---|----------|---|---|
| Q1 | `find_website` single result vs. ranked list? | Single + ranked metadata | A1 returns `url` + `candidates_considered[]` |
| Q2 | `find_website` fail-loud vs. low-confidence guess? | Default — fail-loud | A1 returns `ok: false` below threshold |
| Q3 | Combine `kind` classification into `find_rate_page`? | Split (with cost-benefit) | NEW A2b `classify_rate_page` action |
| Q4 | `find_rate_page` HEAD-fetch + mode parameter? | Yes; `mode: "discover" \| "recheck"` | A2 and A2b both take `mode` |
| Q5 | One `extract_html_table` or two? + currency field + scraper check | One action, rule for LLM defined; **currency added to slab schema; FCNR/GIFT included; scraper-cross-checked OK** | A3 variant enum extended; slab schema gains `currency`; LLM-invocation rule spelled out |
| Q6 | Replace effective-date regex with focused LLM? | OK | A3 owns effective_date via LLM call |
| Q7 | PNB-style ambiguous columns — reject or return both? | Reject; workflow handles | A3 returns `null` with explicit warning; orchestrator routes to operator-resolve |
| Q8 | Multi-page PDFs — latest only or all pages? | **All pages; structure persisted for repeat passes** | A4 returns `pages[]` + `structure_hint` |
| Q9 | New extraction_method enum value? | **`vision_model`** (not `automatic_vision`) | A5 emits `vision_model`; ADR-012 enum extended |
| Q10 | `classify_outcome` writes summary or returns only? | Returns only | A6 unchanged |
| Q11 | Validation-rejected payload — refuse or sidecar? | **Refuse + write rejected payload + full validation to `_rejected/`** | A8 refuses canonical write AND emits `_rejected/<bank>_<variant>.json` + WARN log |
| Q12 | `commit_rates` enforces slug discipline at boundary? | **Yes; structured log entry for recovery** | A8 returns `{ok: false, error_class: "slug_mismatch", log_entry}` |
| **Q13** | **Orchestrator: LLM, deterministic, or hybrid?** | **Deterministic with LLM scoped to specific actions** | `lib/orchestrator.js` is plain code; LLM only inside `find_*` and A3's LLM-fallback |

## Test plan (Item #1e, post-#1b-implementation)

Per `plan/sub-agents.md` A3 template, each action gets:

- Unit tests at `tests/lib/actions/<action>.test.js`. Coverage: happy path; every documented `error_class`; every boundary in the contract (null inputs, empty outputs, malformed payloads).
- Mocks for `web_search`, `fetch_url`, `fetch_pdf`, `run_playwright` — the actions call these directly; tests inject fakes.

Integration test at `tests/lib/actions/end-to-end.test.js`: walks one bank (a known-good PSB) through the full action sequence with all LLM-calls mocked. Asserts the artifacts produced match a golden fixture.

## Action count summary

Original Sprint 003 #1 scope listed 8 actions. Per Q3 split, we have **9**:

1. `find_website` (A1)
2. `find_rate_page` (A2) — URL only
3. `classify_rate_page` (A2b) — kind classification (NEW per Q3 split)
4. `extract_html_table` (A3) — extended to cover FCNR/GIFT per Q5
5. `extract_pdf_table` (A4) — multi-page support per Q8
6. `extract_via_vision` (A5) — emits `vision_model` per Q9
7. `classify_outcome` (A6)
8. `commit_to_registry` (A7)
9. `commit_rates` (A8) — validation gate + slug discipline + rejected-payload capture

The action-implementer subagent (`plan/sub-agents.md` A3) will be invoked 9 times in #1b.

## Acceptance criteria for #1a (per `scope.md:53`)

- ✅ Q1–Q13 answered by operator.
- ✅ Each action's JSON schema is unambiguous enough that an action-implementer subagent can implement it from this doc alone.
- The agent decomposition produces no regression in the 12-bank Sprint 002 replay (same success/partial/failed distribution); deterministic dispatcher handles ≥50% of `automatic_*` cases. **Measured in Track 2 #1d during Week 1.**

## Outstanding follow-ups (Week 2 if Fork A or B)

- **#1b implementation order:** suggest `commit_rates` (A8) first because validation-gate + slug-discipline form the contract every other action's tests rely on. Then `commit_to_registry` (A7). Then extract_* (A3, A4, A5). Then find_* (A1, A2, A2b). `classify_outcome` (A6) last.
- **PDF parser extension** for A4 multi-page: `scripts/extract_rates_pdf.mjs` today returns single-tables; extending it to emit per-page output adds ~half-day to #1b.
- **`vision_model` enum addition** to `lib/extraction-methods.js::AUTO_OVERWRITEABLE_METHODS` — small change, do it as part of A5 implementation.
- **Find-rate-page LLM use** (A2 anchor-link interpretation): worth a follow-up note on prompt design so different operators don't drift in how they ask. Defer to #1b kickoff.
- **PNB-style ambiguous-layout detector** (A3 rejection path): detection rule needs to be specified — "two columns labeled Existing / Revised", "two columns labeled W.E.F. <date1> / W.E.F. <date2>", any others? Capture concrete patterns from Sprint 002 #4 dccb-failure-analysis.md and PNB website inspection.

## What this doc does NOT do

- Does not implement any action — that's #1b (Week 2 if Fork A).
- Does not refactor `lib/agent.js` — that's #1c.
- Does not specify Vision provider — that's Sprint 003 Item #5.
- Does not address `find_*` for the long tail of unseeded banks (D2 deferred coverage debt) — that's a separate discovery probe if Fork A or B.

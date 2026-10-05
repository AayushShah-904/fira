# Functional Specification — Rate Discovery Agent (v2, clean-slate)

> Status: **Proposal / not yet implemented.** This is a from-scratch redesign that keeps every
> lesson from the v1 system (sprints 001–008) but is free of backward-compat constraints.
> Companion docs: [`evaluation-spec.md`](./evaluation-spec.md), [`design.md`](./design.md),
> [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md).

> **Instrument scope.** This spec describes the **`deposit`** instrument — the only one implemented
> in v2. The system is phase 1 of the FIRA platform; contracts here carry an `instrument_type`
> discriminator so future instruments (bonds, etc.) slot in without a core rewrite. See
> [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md).

## 1. Purpose & non-goals

### Purpose
Aggregate **INR deposit interest rates** (fixed deposit / recurring deposit / savings) published by
Indian banks on their **own** websites, into a standardised, machine-readable dataset that downstream
consumers (the FIRA/FIRA platform and a PM-facing pack) use to compare rates across institutions.

The system has two layers:
- **The per-bank agent** — invoked for *one bank at a time*: find the official site → locate rate
  pages → classify how rates are published → extract rate slabs → emit a config + rate-data files.
- **The fleet pipeline** — runs the per-bank agent across the full RBI master list (~1,900 banks),
  reusing extraction templates where possible, escalating hard banks to assisted retrieval, and
  assembling the validated, evaluated output into a release pack.

### Non-goals
- Not a real-time rate feed; refresh cadence is periodic (target: monthly).
- Not a loan/MCLR/lending-rate aggregator (those tables are an *error source*, not a target).
- Not a foreign-currency-rate product *except* the explicitly-modelled FCNR and GIFT/IBU variants.
- Does not fabricate, estimate, interpolate, or "fill in" any rate. Missing data stays missing.
- **Bonds and other fixed income instruments are out of scope *for v2*** — but the architecture is
  built to accommodate them later (the `deposit` instrument is the first of many). The downstream
  *analytics* product (yield curves, spread analysis) is also out of scope here; this system is the
  discovery/extraction substrate it sits on. See
  [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md).

## 2. Core principles (non-negotiable)

1. **No fabrication.** Every shipped rate slab must trace to a real source captured in an immutable
   snapshot. If rates can't be read, emit `rate_slabs: []` with `extraction_confidence: "none"` and a
   `warnings` entry — never invent numbers.
2. **`bank_code` is authoritative and verbatim.** It is the slug injected into the run, used
   unchanged in every output filename and every `bank_code` field. Never re-derive it from the name
   ad hoc; a slug for a *different* bank (e.g. an IBU's parent) is computed only via the canonical
   `slugify` utility.
3. **Own-site only.** Never use aggregators (bankbazaar, paisabazaar, cleartax, groww, codeforbanks,
   …). Prefer the RBI-mandated `.bank.in` domain.
4. **Always emit a rate file**, even with zero slabs.
5. **INR-only.** Domestic/NRE/NRO variants are INR. FCNR/GIFT are the *only* foreign-currency
   variants and each such slab must carry a `currency`. A foreign bank's home-currency rates on its
   home-country domain are **out of scope** and must be quarantined (see §8).
6. **Honest confidence.** Uncertainty is recorded in `warnings`, never papered over.
7. **Snapshot-first (new in v2).** Nothing is extracted from bytes that were not first captured into
   the content-addressed snapshot store, and every output references the snapshot it came from. This
   is what makes the output independently re-checkable (see [`evaluation-spec.md`](./evaluation-spec.md)).

## 3. Domain model & vocabulary

| Concept | Definition |
|---|---|
| **instrument_type** | The asset class a record describes. Always `"deposit"` in v2. A first-class discriminator on every output and registry entry so future instruments (bonds, etc.) coexist without a schema break. The **identity key** is instrument-specific: `bank_code` for deposits (ISIN for bonds later). |
| **bank_code** | Canonical slug for a bank (the `deposit` instrument's identity key). Algorithm: lowercase full name → drop everything except letters/digits/spaces/hyphens → spaces/underscores→hyphens → collapse repeats → trim. Never abbreviated, never suffixed with a product/variant. |
| **bank_type** | One of 15 RBI categories (§3.1). Drives routing, eval thresholds, and which variants apply. |
| **variant** | `regular` (domestic FD) · `nre` · `nro` · `fcnr` · `gift`. Each non-regular variant gets its own rate file. |
| **rate slab** | One tenure band × (optional) deposit tier × (optional) currency → its general/senior/super-senior rate(s). |
| **deposit tier** | Retail default `below_3cr`; bulk tiers `3cr_to_5cr … above_100cr`; co-op tiers `below_15l … above_10cr`. |
| **currency** | Required on `fcnr`/`gift` slabs (USD/GBP/EUR/JPY/CAD/AUD/…). Absent on INR slabs. |
| **snapshot** | Immutable, content-addressed capture of the exact source bytes (HTML/PDF/image) an extraction was derived from. |

### 3.1 bank_type codes (15)

PSB (Public Sector) · PVB (Private Sector) · SFB (Small Finance) · PB (Payments) · FB (Foreign) ·
RRB (Regional Rural) · SUCB (Scheduled Urban Co-op) · NSUCB (Non-Scheduled Urban Co-op) ·
SSCB (Scheduled State Co-op) · NSSCB (Non-Scheduled State Co-op) · DCCB (District Central Co-op) ·
LAB (Local Area) · FI (Financial Institution) · IBU (IFSC Banking Unit / GIFT City) · HFC (Housing Finance).

**NRI-bearing types** (only these get NRE/NRO/FCNR discovery): PSB, PVB, FB, IBU, and large SFBs
(AU, Equitas, Ujjivan, IDFC First, Bandhan). **GIFT** applies to IBU only. Payments banks have **no
FD product** at all — they are FD-quarantine candidates.

## 4. The per-bank agent contract

### 4.1 Inputs
- `Bank Name | Category | State` (the operator/registry record).
- `$BANK_CODE` — the canonical slug, injected; used verbatim (principle 2).
- `$OUTPUT_DIR` — where to write outputs (default `output/`).
- Registry hints (if the bank is already known): `domain`, `rate_pages`, `scraper_type`, template,
  parent bank (for IBUs), prior `discovery_status`.

### 4.2 Modes
- **discover** — full end-to-end (website → rate pages → classify → extract → emit). Used for unknown
  banks.
- **expand-nri** — for an already-discovered NRI-bearing bank, find & extract NRE/NRO/FCNR pages.
- **rates-only** — re-extract rates from already-known rate-page URLs (refresh path).

### 4.3 Stages (capabilities)

Each stage states its success / failure / uncertainty behaviour.

**S0 — Registry lookup.** If the bank is known with `domain` + `rate_pages.fd`, skip discovery and go
straight to classify/extract. If `parent_bank_code` is present (IBU), resolve the parent's domain for
GIFT discovery.

**S1 — Find official website.**
- Search `.bank.in` first (`site:bank.in "<name>"`), then `"<name>" official website india`, then
  (small co-ops) `"<name>" interest rates deposit`, then regional-language queries for Hindi-belt /
  South-Indian DCCBs.
- Domain priority: `.bank.in` > `.co.in`/`.com`/`.org`. Never aggregators.
- Reject lookalikes: a `.bank.in` candidate with TLS failure, malware flags, recruitment-only
  content, or content identical to an unsecured legacy site is **untrusted**, not authoritative.
- *Failure*: no trustworthy site → `discovery_status: no_website` (see §7), write a partial config.

**S2 — Find rate pages.**
- Fetch homepage once for nav links (`interest rate`, `deposit rate`, `FD rate`, `fixed deposit`,
  `NRI deposits`); fall back to `site:<domain> interest rate deposit`.
- Identify the **domestic FD** page first; record all other discovered URLs (`fd_nre`, `fd_nro`,
  `fd_fcnr`, `fd_nri_combined`, `savings`, `rd`) in config even if not extracted this run.
- Follow one "View More / Read More" link when a candidate page is sparse.
- *Failure*: site found but no rate page → write partial config (`scraper_type: manual`,
  `rate_page_urls.fd: null`, explanatory note). **Leaving an empty run dir when any fetch succeeded
  is forbidden.**

**S3 — Classify scraper type.** From the fetched page, classify as `html_static`, `html_js`, `pdf`,
`mixed`, `government`, or `manual`. Never mark `manual` before attempting the JS/Playwright path.
Image-only pages and text-less (scanned) PDFs route to OCR/vision, not fabrication.

**S4 — Extract slabs.** Parse tenure bands and rate columns (general / senior / super-senior) into
the strict slab schema. Multi-currency tables (FCNR/GIFT) emit **every** currency × tenure cell as a
separate slab (never collapse to USD). Senior premium published as a *note* ("+0.50% for senior
citizens") must be applied to derive `rate_senior_pct`, not dropped or shipped as a junk slab.
- *Uncertainty*: ambiguous columns or partial reads → extract best-effort, lower
  `extraction_confidence`, record specifics in `warnings`.

**S5 — Emit outputs.** Write `<bank_code>_config.json` and `<bank_code>[_variant]_rates.json` (§6),
each referencing the snapshot id(s) the data came from. Write config + rates in the same turn.

### 4.4 Budget discipline
Typical budget: 3–5 fetches for domestic FD + 2–3 for NRI per bank. Prefer fewer, larger tool calls.
Retry rules are tight (no blind URL guessing):
- HTTP 403/429 or empty JS scaffold → escalate to the browser/Playwright path (not a fetch retry).
- HTTP 404/500/timeout → move on.
- One `www.` retry allowed on TLS/cert error or sub-1KB apex response.
- One PDF path-probe retry (case toggle / `/PDF/` prefix) on a 404 `.pdf`.
- One "View More" follow per sparse page.

## 5. Fleet pipeline contract

The fleet pipeline runs the per-bank agent across the cohort and produces the release pack.

### 5.1 Registry as source of truth
A single registry (`data/bank-domains.json` in v1) holds, per bank: `domain`, `rate_pages`,
`scraper_type`, `discovery_status`, `extraction_method`, the persisted extraction **template**
(fetch profile + extract block + column map), variant-scoped templates (`template_gift`,
`template_fcnr`), an `audit`/provenance block (who persisted, verdict, when), and `tier2` hints (how
to re-fetch hard banks). The registry is the only place that knows how to refresh a bank
deterministically.

### 5.2 Two-tier model
- **Tier 1 — automated.** Fingerprint the page → reuse a matching template if one exists, else ask an
  LLM to *propose* an extract block (table index + column map + per-table extracts) → extract →
  evaluate → on pass, persist the template + rates with `extraction_method: llm_verified`. Within a
  single run, banks sharing a template fingerprint reuse one proposal (one LLM call per cluster).
- **Tier 2 — assisted retrieval.** For banks Tier-1 can't crack (JS-XHR/SPA, bot walls, image/PDF
  cards, multi-currency IBU PDFs, marquee PSB/PVB/FB/IBU), an LLM agent fetches and provides the data
  using richer methods (XHR replication, browser drive, cookie-warmed PDF, vision OCR, legacy-TLS
  GET). Tier-2 records a CURATED `extraction_method` (e.g. `manual_transcription_from_rendered_text`)
  and `tier2{sourced_at, run_method, source_url, slab_count, hints}`.

### 5.3 Clobber-protection invariants
- CURATED `extraction_method` values are **auto-overwrite-protected**: a later failing automatic run
  cannot clobber Tier-2 data.
- Variant-scoped templates: foreign-currency variants live in `template_gift` / `template_fcnr`, so a
  domestic refresh never overwrites GIFT/FCNR data and vice-versa.
- Richer-wins on merge: a write with more slabs / more complete currencies wins; thinner writes don't
  silently truncate.
- **Single registry writer at a time.** Parallel Tier-2 work writes to a separate output area and is
  folded in by one coordinated writer.

### 5.4 Incremental re-run
The pipeline supports `--from-report` (re-run only the previous report's FAIL/REVIEW banks, skip dead
buckets like `waf`/`missing-url`) and bucket filters — the operator does **not** re-run the full
cohort every cycle.

## 6. Output schemas (STRICT)

> Downstream **silently drops** wrong field names. These names are exact. (Carried verbatim from
> `docs/agent/schemas.md`.)

### 6.1 Config file — `<bank_code>_config.json`
```json
{
  "bank_code": "state-bank-of-india",
  "bank_name": "State Bank of India",
  "bank_type": "PSB",
  "category": "Public Sector Bank",
  "website": "https://sbi.co.in",
  "scraper_type": "html_static",
  "rate_page_urls": {
    "fd": "https://sbi.co.in/web/interest-rates/...",
    "fd_nre": null, "fd_nro": null, "fd_fcnr": null, "fd_nri_combined": null,
    "savings": null, "rd": null
  },
  "selectors": { "table": "table.rate-table", "rows": "tbody tr", "effective_date": null },
  "column_mapping": { "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct" },
  "expected_slab_count": 11,
  "notes": "",
  "scraper_notes": { "framework": null, "bot_protection": null, "data_format": null, "rate_tables_on_page": null },
  "discovery_metadata": { "discovered_at": "<ISO-8601>", "discovery_method": "web_search + page_fetch", "confidence": "high" }
}
```

### 6.2 Rate file — `<bank_code>[_variant]_rates.json`

The envelope carries `instrument_type` and `schema_version` so the same store can hold future
instruments and evolve safely. For v2, `instrument_type` is always `"deposit"`.

```json
{
  "instrument_type": "deposit",
  "schema_version": "2.0",
  "bank_code": "state-bank-of-india",
  "bank_name": "State Bank of India",
  "product_type": "FD",
  "variant": "regular",
  "effective_date": "2026-03-01",
  "source_url": "https://...",
  "scraped_at": "<ISO-8601 UTC>",
  "extraction_confidence": "high",
  "snapshot_ref": ["sha256:..."],
  "rate_slabs": [
    { "tenure_text": "7 days to 45 days", "tenure_min_days": 7, "tenure_max_days": 45,
      "rate_general_pct": 3.50, "rate_senior_pct": 4.00, "rate_super_senior_pct": null,
      "deposit_range": "below_3cr" }
  ],
  "special_schemes": [],
  "warnings": [],
  "errors": []
}
```

**Strict-name rules:** `rate_slabs` (not `slabs`); `product_type: "FD"`; `scraped_at` (not
`extracted_at`); `tenure_min_days`/`tenure_max_days`; `rate_general_pct` as a **number** (6.50, not
`"6.50%"`); `rate_senior_pct`/`rate_super_senior_pct` = `null` when not offered; `variant` ∈
{regular, nre, nro, fcnr, gift} and must match the filename suffix; **fcnr/gift slabs must carry
`currency` and have no senior rates**; zero parseable slabs → `rate_slabs: []`,
`extraction_confidence: "none"`, a `warnings` entry.

**`instrument_type` / `schema_version` (new in v2):** required on every output; `instrument_type` is
`"deposit"` for all v2 records. They make the store instrument-aware and versioned so bonds (and
schema evolution) don't break existing consumers.

**`snapshot_ref` (new in v2):** array of snapshot content-hashes the slabs were derived from.
Mandatory for any non-empty `rate_slabs`.

### 6.3 File naming
`<bank_code>_config.json`, `<bank_code>_rates.json` (regular), `<bank_code>_nre_rates.json`,
`_nro_`, `_fcnr_`, `_gift_`. **No other rate-file suffixes exist** — savings/RD/current/DDS rates
live in `rate_page_urls`, not separate files.

## 7. Discovery-status taxonomy (valid non-extraction outcomes)

The ~100–150 banks without usable rates are *classified*, not silently dropped. Status values:
`no_website` · `wholesale_no_retail` · `no_rate_page` · `unreachable` · `bot_blocked` ·
`foreign_currency_not_inr` · `no_fd_product` (e.g. payments banks) · `pending_vision` (image/scanned,
awaiting OCR). Each is persisted to the registry with a `website_metadata` note so the gap is
explainable and retryable.

## 8. Hard rules & special cases (carried from field learnings)

- **Aggregator ban** — never source from aggregator sites; quarantine any bank later found to have
  shipped aggregator data.
- **Foreign-currency exclusion** — a foreign bank's **home country lives in its `state` field as
  origin metadata, not a quarantine signal**; most FBs have legitimate India branches on `.bank.in`
  with plausible INR rates (Deutsche, HSBC, Emirates, DBS, SBM, Doha → KEEP). The wrong-source test
  is *home-country domain + home-currency rates* (e.g. AB Bank / Sonali Bank shipping BDT from
  abbl.com → quarantine `foreign_currency_not_inr`).
- **Co-op / DCCB quirks** — many have no site or only image rate cards; check state-coop umbrella
  portals but prefer the bank's own `.bank.in`; deprioritise umbrella suffixes (`pbcoopbank.in`,
  `upcooperativebank.org`, `tncooperation.gov.in`, …); use regional-language search terms.
- **www self-heal** — many "hard marquee" banks were just bare-host shells; one host-toggle retry
  recovers them.
- **NRI separation** — NRE/NRO/FCNR are distinct products with independent rate schedules; never
  assume they equal domestic FD. FCNR: foreign currency, no senior premium, tenure 1–5y.
- **GIFT/IBU** — discovered under the *parent* bank's IFSC/GIFT section; `bank_type: IBU`,
  `deposit_insurance: false`, `variant: gift`, per-slab currency.
- **Senior-premium-as-note** — apply the noted premium to compute `rate_senior_pct`; never ship the
  note text as a slab.
- **Image / scanned PDF** — route to OCR/vision; if unreadable, `pending_vision` + note, never
  invented digits.

## 9. Success criteria for the per-bank agent

A run is *correct* when: outputs use exact schema names; every non-empty slab traces to a referenced
snapshot; rates are INR (or carry currency for fcnr/gift); confidence honestly reflects certainty; and
either real rates were extracted **or** a precise `discovery_status` + warning explains why not. A run
is *incorrect* if it fabricates, mislabels a variant/currency, ships a loan/savings table as FD,
collapses multi-currency tables, truncates a rate ladder, or leaves an empty run dir after a
successful fetch. (How these are *measured* is [`evaluation-spec.md`](./evaluation-spec.md).)

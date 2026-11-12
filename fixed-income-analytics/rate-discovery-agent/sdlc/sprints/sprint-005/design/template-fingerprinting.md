# Phase A — Template fingerprinting + registry promotion

**Phase:** A (Sprint 005)
**Status:** Design — to be implemented in Phase A code drops.
**Predecessor:** `../implementation/phase-0-summary-2026-05-24.md`
**Plan parent:** `../plan/sprint-005-scope.md`

## Context

The architectural reset (per the approved plan) re-centers rate discovery around **template fingerprinting + per-template deterministic extractors**. A "template" is a structural identity that a bank's rate page shares with other banks running the same site framework. Two banks running the same WordPress theme produce the same template_hash; the per-template extractor for that template handles both.

Phase A produces the three artifacts that everything else depends on:

1. **Fingerprint function** — takes rendered HTML, returns a content-free structural signature.
2. **Schema extension** — `data/bank-domains.json` gets an optional `template` block per bank.
3. **Authoring CLI** — `scripts/author-template.js` walks the operator through fingerprinting a bank, reusing an existing template_id if structure matches, or LLM-proposing a new one if not.

Plus one Phase 0 finding folded in: **A.4 dispatcher repair** for `scraper_type: unknown` banks (~31 NSUCB/DCCB banks that the orchestrator currently bails on before fetching).

## Goals

- Two banks with structurally identical rate pages produce the same `template_hash` (cluster collision).
- A bank whose page structure changes produces a different `template_hash` on the next fingerprint (drift detection).
- `data/bank-domains.json` can carry the `template` block per bank without breaking any consumer that doesn't read it (back-compat).
- The dispatcher attempts a fetch for banks with `scraper_type: unknown` instead of bailing early.

## Non-goals (out of scope for Phase A)

- Writing per-template extractor modules (`lib/extractors/<template_id>.js`) — that's Phase C.
- Replacing `scripts/fetch_rates_playwright.js` with the hardened fetcher — that's Phase B.
- Migrating any banks to deterministic-only extraction — that's Phase E.
- Removing `lib/agent.js` or the two-path orchestrator — that's Phase F.

## Files modified / created

**Created:**

- `lib/templating/fingerprint.js` — `fingerprintPage({ html, url, kind }) → { template_hash, structural_signature, candidate_tables }`.
- `lib/templating/schema.md` — documentation of the `template` block JSON shape.
- `lib/templating/synonyms.js` — header-cell synonym map (separate file so it can grow without touching fingerprint logic).
- `tests/lib/templating/fingerprint.test.js` — unit tests for `fingerprintPage()`.
- `scripts/author-template.js` — interactive authoring CLI (deferred to Phase A.3; basic skeleton lands in Phase A).
- `lib/prompts/author-template.md` — LLM prompt for selector + column_map proposal (deferred to Phase A.3).

**Modified:**

- `lib/orchestrator.js` (A.4) — when `scraper_type` is null/unknown, default to html_static fetch attempt rather than bailing early.
- `data/bank-domains.json` — schema extension is back-compat (no data added in Phase A; that's Phase E migration territory). The schema doc in `lib/templating/schema.md` is the source of truth for what the `template` block looks like.

## Lifted utilities (per `scripts/analysis/code-inventory.md`)

| Reused from | For |
|---|---|
| `lib/actions/_cheerio_tables.js` table-picker scoring | `fingerprintPage()`'s "densest rate region" detection — same scoring rules pick which `<table>` is the rate table to fingerprint. |
| `lib/safe-write.js` | Eventually for `scripts/author-template.js --write` updates to `data/bank-domains.json`. |
| `scripts/utils/slugify.js` | Bank-code resolution in the CLI. |

## A.1 — Fingerprint algorithm

### Signature

```js
fingerprintPage({ html, url, kind }) → {
  template_hash:        "sha1:<hex>",
  structural_signature: { /* the inputs that were hashed; see below */ },
  candidate_tables:     [ { index, scoreboard, header_vector, row_count } ],
  reason:               "<short string for debugging>",  // e.g. "no-tables", "iframe-wrapped"
}
```

Inputs:
- `html` — the rendered HTML body (string). For PDFs/images, the caller is expected to pass a `kind` other than `"html"` and the fingerprint returns a special pdf/image signature (see "Non-HTML kinds" below).
- `url` — the page URL (used for the domain-TLD axis).
- `kind` — `"html"` | `"pdf-text"` | `"docintel-layout"` | `"image"`. For Phase A the focus is `"html"`; the others are stubbed to return `kind`-specific minimal signatures.

### Structural signature components (joined, then SHA-1'd)

Five components, all content-free (no rate numbers, no tenure wording leak through):

1. **Tag-tree skeleton** (rooted at the densest rate region) — DFS walk of the rate region's DOM tree. Each node emitted as `tag` plus the *first non-empty class token's prefix* (to collapse `class="rate-table-row first-row"` and `class="rate-table-row alt"` into the same node). Attributes other than `class`, `role`, and `data-*` keys are dropped. Walk depth capped at 6 levels (deeper trees collapse to `…`).

2. **Header-cell vector** — for each `<table>` element in the rate region, normalize the header row(s): lowercase, strip punctuation, strip `(*)`, collapse whitespace, then synonym-map via `lib/templating/synonyms.js` (`general → regular`, `non-senior → regular`, `sr citizen → senior`, `period of deposit → tenure`, `interest rate (%) → rate`, etc.). Emit a sorted column-token array.

3. **Slab-row-count bucket** — count `<tr>` rows in the densest `<table>` body. Bucket: `[0, 1-3, 4-8, 9-15, 16-30, 30+]`. Cushion absorbs week-over-week variance (a bank adding a tenure won't change its fingerprint).

4. **Framework hint** — sniff `wp-content` / `aem` / `bootstrap` / `react-root` / `angular`, jQuery accordion classes (`ui-accordion`, `panel-collapse`), iframe presence. Emit a sorted token set. Cheap signal that often perfectly predicts the cluster for big templates (`.bank.in` family, AEM-tabbed FCNR pages).

5. **Domain TLD** — `.bank.in` / `.co.in` / `.com` / `.org` / `.in` / `other`. The RBI-mandated `.bank.in` domain is the single strongest cluster signal (per Phase 0.1 — top 6 success clusters all share `.bank.in`).

### How the "densest rate region" is picked

Reuses the existing scoring heuristic from `lib/actions/_cheerio_tables.js`. The fingerprint function:

1. Parses HTML via cheerio.
2. Runs the table-picker scorer (lift `scoreTable()` into `lib/templating/_helpers/score-table.js` as a shared helper).
3. The highest-scoring table becomes the "rate region root"; if no table scores above zero, the fingerprint emits `reason: "no-tables"` and the tag-tree skeleton walks `body` instead.

This sharing is intentional: the fingerprint sees the same table the Phase C extractor will see, so cluster-equivalence implies extractor-equivalence.

### Hashing

`SHA1(JSON.stringify(structural_signature, withSortedKeys))` → `"sha1:" + hex`. SHA-1 is fast and collision-stable enough; we don't need cryptographic strength.

### Non-HTML kinds

| kind | Signature shape |
|---|---|
| `"html"` | the five components above |
| `"pdf-text"` | hash of `{ kind, page_count, has_currency_columns_hint, column_count_per_page_bucket }` |
| `"docintel-layout"` | hash of `{ kind, table_count, columns_per_table, headers_normalized }` |
| `"image"` | hash of `{ kind, dimensions_bucket, ocr_confidence_bucket }` |

These are stubs for Phase A; Phase C extractor work flushes them out with real signal as PDF/image extractors land.

## A.2 — Schema extension to `data/bank-domains.json`

The `template` block sits alongside existing fields. Absent ⇒ legacy path (dispatcher falls through to the old discovery + LLM extraction); present ⇒ new template-dispatched path.

```json
"axis-bank-limited": {
  "domain": "axisbank.com",
  "rate_pages": { "fd": "/...", "fd_nre": "/...", "fd_fcnr": "/..." },
  "scraper_type": "html_static",
  "notes": "...",

  "template": {
    "template_id": "axis-multi-column-with-sub-headers",
    "template_hash": "sha1:ab12...",
    "fingerprinted_at": "2026-05-25",
    "fingerprinted_from_url": "https://...",

    "fetch": {
      "strategy": "playwright",
      "browser": "chromium",
      "stealth": true,
      "wait_for_selector": "table.rate-grid tr td",
      "wait_for_function": "() => /%/.test(document.body.innerText) && document.querySelectorAll('table tr').length >= 6",
      "click_to_reveal": ["#fd-tab", ".accordion-header"],
      "iframe_selector": null,
      "timeout_ms": 90000,
      "retry_escalation": ["default", "stealth", "firefox", "llm-fallback"]
    },

    "extract": {
      "extractor": "axis-multi-column-with-sub-headers",
      "table_selector": "section#fd table",
      "table_index": 0,
      "header_row": 1,
      "header_span_rows": 2,
      "column_map": {
        "0": "tenure_text",
        "1": "rate_general_pct",
        "2": "rate_senior_pct",
        "3": "rate_super_senior_pct"
      },
      "tenure_cap_days": 5475
    },

    "variants": {
      "regular": { "rate_page_key": "fd" },
      "nre":     { "rate_page_key": "fd_nre" },
      "fcnr":    { "rate_page_key": "fd_fcnr", "extractor": "fcnr-currency-matrix" }
    },

    "verification": {
      "verified_at":         "2026-05-25",
      "verified_slab_count": 14,
      "verified_sample":     { "1y": 7.10, "5y": 7.00 }
    }
  }
}
```

Notes:
- `tenure_cap_days` fixes the silent 3650-day clip in `scripts/utils/parse-tenure.js` for Axis/HDFC 15-yr tenures. Phase A modifies `parse-tenure.js` to honor this override when called via the extractor pipeline (not in Phase A scope is the call-site changes; that's Phase C).
- `extraction.hints` (the M2.3 per-bank annotation) is **deprecated by this schema** — once `template` is present, hints are ignored. Phase A does NOT migrate existing hints; the migration script lives in Phase E.
- `template_hash` is informational — the dispatcher uses `template_id` to look up the extractor module. The hash exists for drift detection.

## A.3 — Authoring CLI (`scripts/author-template.js`)

Skeleton in Phase A; the LLM-proposal step (which needs `lib/prompts/author-template.md`) is stubbed and lands in Phase A.3 follow-up. Phase A delivers:

```
node scripts/author-template.js <bank-code> [--variant regular] [--from-url <url>] [--reuse-template <id>] [--write]
```

Steps:
1. Resolve URL from `data/bank-domains.json` (or `--from-url` override).
2. Fetch via the existing `scripts/fetch_rates_playwright.js` (Phase B replaces this with the hardened fetcher; Phase A uses what exists).
3. Snapshot HTML to `tmp/author/<bank>/<variant>.html`.
4. Compute fingerprint; if `template_hash` matches an existing template_id in any other bank's `template` block, **suggest reuse** — operator confirms with `[y/N]`.
5. On cluster miss, print "no matching template — author one with `--reuse-template <id>` if you're sure, or run the LLM-proposal flow (Phase A.3 follow-up)."
6. `--write` persists the chosen template_id and fetched signature into `data/bank-domains.json` via `lib/safe-write.js`. The agent NEVER auto-writes the `template` block.

## A.4 — Dispatcher repair for `scraper_type: unknown`

Per Phase 0.2 failure inventory, ~31 NSUCB/DCCB banks have `scraper_type: null` in their configs because the dispatcher bails when it can't classify. The fix:

**Location:** `lib/orchestrator.js` — wherever the dispatcher decides to fetch (currently relies on `scraper_type` being set).

**Change:** when `scraper_type` is `null` or `undefined` or `"unknown"`, default to attempting an `html_static` fetch first. If the fetch returns HTML containing `<table>` elements with `%` content, the bank is reclassified as `html_static` for this run; if the fetch returns a JS-heavy SPA with empty tables, retry with the JS path (`html_js`); if both fail, fall through to today's failure path.

**Test:** add a unit test against a representative from the failure cluster (e.g. `chiplun-urban-coopbank-ltd`) with a mocked fetch that returns a table-bearing HTML body, asserting the dispatcher attempts the fetch and classifies the response.

**Why in Phase A and not Phase B:** this is a one-line orchestrator behavior change, not a fetch-layer rewrite. Phase B replaces the fetcher; Phase A.4 just removes the bail-early shortcut in the dispatcher.

## Verification

### Unit tests (`tests/lib/templating/fingerprint.test.js`)

- Two synthetic WordPress-themed pages with different rate numbers and different bank names produce the **same** `template_hash` (cluster collision).
- A synthetic Axis-style multi-column page and a synthetic 3-column co-op page produce **different** `template_hash`es (cluster divergence).
- A page with no `<table>` elements produces `reason: "no-tables"` and a stable fingerprint based on the body skeleton.
- Synonym mapping: `["Senior Citizen Rate"]` and `["sr citizen rate"]` normalize to the same header vector.
- A page wrapped in an iframe sets `framework_hint` to include `"iframe"`.

### Dispatcher repair test (`tests/lib/orchestrator-dispatcher.test.js` — extend existing)

- A bank with `scraper_type: null` and a mocked fetch returning a 3-column rate HTML body completes through the html_static path without bailing.
- A bank with `scraper_type: null` and a mocked fetch returning a 403 still bails (the repair only changes the unknown→default-attempt behavior, not the all-paths-failed behavior).

### Integration smoke

End-to-end via `node scripts/author-template.js bandhan-bank-limited --variant regular` (read-only, no `--write`):
- Fetches the page (or uses a recorded snapshot if Playwright is unavailable).
- Computes fingerprint.
- Prints fingerprint hash + candidate tables.
- Exits cleanly with no `data/bank-domains.json` mutation.

## Risks and assumptions

1. **Risk: fingerprint over-clusters distinct templates.** If the tag-tree skeleton + header-vector hash collides for pages that should have different extractors, an operator would author one template that breaks on the other. Mitigation: the authoring CLI's reuse step is operator-confirmed (`[y/N]`), not auto-accepted.

2. **Risk: fingerprint under-clusters identical templates** (small DOM tweaks cause hash drift). Symptom: every bank lands in its own cluster, the architectural reset's leverage disappears. Mitigation: the synonym map and the `class` token prefixing absorb most cosmetic variation; Phase A's tests assert cluster collision on synthetic WP pages.

3. **Assumption: the densest-table-region is a reliable rate-region anchor.** Holds for ~95% of co-op .bank.in pages and PSB pages. Edge cases (HDFC's section-context tabs, Axis's multi-page PDFs) will need template-specific anchoring; that's handled per-extractor in Phase C, not in fingerprint logic.

4. **Assumption: `scripts/fetch_rates_playwright.js` is good enough for Phase A authoring.** Phase B replaces it. If Phase A authoring sessions repeatedly hit Playwright timeouts on real banks, accelerate Phase B.1.

5. **Assumption: the dispatcher repair is safe even if the fetched page is junk.** The fallback chain (html_static → html_js → fail) already handles bad responses today; A.4 just changes the entry condition. If the test against `chiplun-urban-coopbank-ltd` passes, the assumption holds.

## Open follow-ups (deferred from Phase A)

- LLM-proposal flow in `scripts/author-template.js` (Phase A.3 — lands shortly after Phase A skeleton).
- Per-bank `wait_for_function` defaults for the JS-rendered `.bank.in` cluster — these get authored in Phase B alongside the new fetch layer, then back-referenced from `template.fetch`.
- The `_cheerio_tables.js` table-picker lift into a shared `lib/templating/_helpers/score-table.js` so Phase A and Phase C use the same scorer — the file split itself can happen in Phase A (low risk) or be deferred to Phase C alongside the bigger `extract_html_table.js` split (also low risk). Decision: do it in Phase A — single source of truth for "what's the rate region" from day 1.

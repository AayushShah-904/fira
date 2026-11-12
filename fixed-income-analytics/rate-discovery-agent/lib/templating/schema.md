# `data/bank-domains.json` — `template` block schema

**Sprint 005 Phase A.** Source of truth for the structural shape of the `template` block.

## Status

The `template` block is **optional and additive**. Absent ⇒ legacy path (existing discovery + extraction flow). Present ⇒ template-dispatched path (Phase C extractor registry handles the bank).

No existing entry in `data/bank-domains.json` is modified by Phase A. The migration of banks into the template path is Phase E work, gated on a Phase C extractor existing for the bank's `template_id`.

## Schema (informative; JSON Schema in `./schema.json` to follow in Phase A.3)

```jsonc
{
  "<bank-code>": {
    // ---- Existing fields preserved unchanged ----
    "domain":      "<domain>",
    "rate_pages":  { "fd": "/...", "fd_nre": "/...", "fd_fcnr": "/...", ... },
    "scraper_type": "html_static" | "html_js" | "pdf" | "image" | "manual" | null,
    "notes":        "<freeform>",
    // ... other legacy fields

    // ---- NEW: optional template block (Sprint 005 Phase A) ----
    "template": {
      // Identity
      "template_id":            "<kebab-case slug, e.g. 'coop-bankin-3col-tenure-general-senior'>",
      "template_hash":          "sha1:<hex>",         // from lib/templating/fingerprint.js
      "fingerprinted_at":       "YYYY-MM-DD",
      "fingerprinted_from_url": "https://...",        // the URL the fingerprint was computed against

      // Fetch instructions (consumed by lib/fetch/fetch_html.js in Phase B)
      "fetch": {
        "strategy":          "playwright" | "http",
        "browser":           "chromium" | "firefox" | "webkit",
        "stealth":           true | false,
        "wait_for_selector": "<css selector>",         // optional
        "wait_for_function": "<JS expression returning bool>",  // optional; default = '() => /%/.test(document.body.innerText) && document.querySelectorAll("table tr").length >= 3'
        "click_to_reveal":   ["<css selector>", ...],  // optional pre-extraction clicks
        "iframe_selector":   "<css selector>" | null,  // optional iframe to switch context into
        "timeout_ms":        90000,                     // per-bank override (default 60000)
        "retry_escalation":  ["default", "stealth", "firefox", "llm-fallback"]
      },

      // Extraction instructions (consumed by lib/extractors/dispatch.js in Phase C)
      "extract": {
        "extractor":          "<extractor module name from lib/extractors/>",
        "table_selector":     "<css selector>",        // optional
        "table_index":        0,                        // when multiple tables match selector
        "header_row":         0,                        // row index of headers
        "header_span_rows":   1,                        // multi-row header bands
        "column_map": {
          "0": "tenure_text",
          "1": "rate_general_pct",
          "2": "rate_senior_pct",
          "3": "rate_super_senior_pct"
          // values are slab field names per the rate-file schema (CLAUDE.md)
        },
        "tenure_cap_days":    5475                       // override the default 3650-day cap (15yr tenures for Axis/HDFC)
      },

      // Per-variant overrides (FCNR uses a different extractor; NRI may use a different page)
      "variants": {
        "regular": { "rate_page_key": "fd" },                                  // points to rate_pages.fd
        "nre":     { "rate_page_key": "fd_nre" },
        "nro":     { "rate_page_key": "fd_nro" },
        "fcnr":    { "rate_page_key": "fd_fcnr", "extractor": "fcnr-currency-matrix" },
        "gift":    { "rate_page_key": "fd_gift", "extractor": "ibu-static-pdf-quarterly" }
      },

      // Verification trace (set by scripts/author-template.js when the operator confirms)
      "verification": {
        "verified_at":         "YYYY-MM-DD",
        "verified_slab_count": 14,
        "verified_sample":     { "1y": 7.10, "5y": 7.00 }   // spot-check key rates
      }
    }
  }
}
```

## Compatibility

- Any consumer that doesn't read `template` is unaffected (legacy fields preserved).
- A bank with `template` present **and** legacy fields present uses `template` — the legacy fields remain for diff history and for emergencies where the template block has to be rolled back.
- Once Phase C ships extractor `<template.extract.extractor>`, the bank is auto-routed through the template path on the next run. Until then, the presence of `template` is informational; the dispatcher falls through to legacy.

## What's deprecated (but not removed in Phase A)

- `extraction.hints` — the M2.3 per-bank annotation system in `lib/extraction-hint.js`. Subsumed by `template.extract.column_map`. The migration script lives in Phase E; legacy hints continue to work for banks without a `template` block.

## Authoring rules

- The `template` block is written ONLY by `scripts/author-template.js` with operator-confirmed `--write`. The agent never auto-writes it.
- `template_hash` is informational (drift detection); the **`template_id`** is what the dispatcher uses to look up the extractor module.
- When the same `template_id` exists across multiple banks, the dispatcher uses the per-bank `template.extract.column_map` as the canonical mapping for that bank. Template authors should keep column_maps consistent within a `template_id` cluster unless a bank genuinely differs.

## Versioning

Schema is currently v1 (implicit). A `"_schema_version": "v2"` field at the top of `data/bank-domains.json` will be introduced if/when a breaking change is needed — Phase A's additive change does not require it.

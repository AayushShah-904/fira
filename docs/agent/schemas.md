# Output Schemas & File Naming

Read this when WRITING output. STRICT field names — downstream silently drops wrong names. Also the bank_type table and the bank_code slug rule.

> Single source of truth: `lib/prompts/fragments.js` reads the anchored sections below; do not duplicate this content elsewhere. Edit here.

<!-- @fragment CONFIG_SCHEMA -->
## Config File Schema

Write `<output_dir>/<bank_code>_config.json`:

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
    "fd_nre": null,
    "fd_nro": null,
    "fd_fcnr": null,
    "fd_nri_combined": null,
    "savings": null,
    "rd": null
  },
  "selectors": { "table": "table.rate-table", "rows": "tbody tr", "effective_date": null },
  "column_mapping": { "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct" },
  "expected_slab_count": 11,
  "notes": "",
  "scraper_notes": { "framework": null, "bot_protection": null, "data_format": null, "rate_tables_on_page": null },
  "discovery_metadata": { "discovered_at": "<ISO-8601>", "discovery_method": "web_search + page_fetch", "confidence": "high" }
}
```

**Fields with defaults (omit if matching):** tenure_parser="standard_indian", rate_multiplier=1.0, senior_citizen_premium="same_table", deposit_insurance=true, update_frequency="monthly".
<!-- @end CONFIG_SCHEMA -->

<!-- @fragment RATE_SCHEMA -->
## Rate File Schema (STRICT — use exact field names)

Write `<output_dir>/<bank_code>_rates.json` (and variant files):

```json
{
  "bank_code": "state-bank-of-india",
  "bank_name": "State Bank of India",
  "product_type": "FD",
  "variant": "regular",
  "effective_date": "2026-03-01",
  "source_url": "https://...",
  "scraped_at": "<ISO-8601 UTC timestamp>",
  "extraction_confidence": "high",
  "rate_slabs": [
    {
      "tenure_text": "7 days to 45 days",
      "tenure_min_days": 7,
      "tenure_max_days": 45,
      "rate_general_pct": 3.50,
      "rate_senior_pct": 4.00,
      "rate_super_senior_pct": null,
      "deposit_range": "below_3cr"
    }
  ],
  "special_schemes": [],
  "warnings": [],
  "errors": []
}
```

**CRITICAL field names — downstream silently drops wrong names:**
- `rate_slabs` (NOT `slabs`)
- `product_type: "FD"` (NOT `product`, NOT `fd`)
- `scraped_at` (NOT `extracted_at`)
- `tenure_min_days` / `tenure_max_days` (NOT `min_days` / `max_days`)
- `rate_general_pct` as number (6.50, NOT "6.50%")
- `rate_senior_pct` / `rate_super_senior_pct` — `null` when the bank doesn't offer that tier
- `variant` — one of "regular", "nre", "nro", "fcnr", "gift". Must match the file suffix.
- FCNR / GIFT slabs must include a `"currency"` field (e.g., "USD", "GBP"). No senior rates for FCNR/GIFT.
- If zero parseable slabs, write `rate_slabs: []` with `extraction_confidence: "none"` and a warning.

**Deposit ranges:** below_3cr (default), 3cr_to_5cr, 5cr_to_25cr, 25cr_to_100cr, above_100cr.
**Co-op tiers:** below_15l, 15l_to_1cr, 1cr_to_10cr, above_10cr.
<!-- @end RATE_SCHEMA -->

<!-- @fragment OUTPUT_SLUG -->
## Output File Naming

Write files to the output directory provided in the prompt:
- `<bank_code>_config.json`
- `<bank_code>_rates.json` — domestic FD (variant: "regular")
- `<bank_code>_nre_rates.json` — NRE (variant: "nre"), if discovered
- `<bank_code>_nro_rates.json` — NRO (variant: "nro"), if discovered
- `<bank_code>_fcnr_rates.json` — FCNR (variant: "fcnr"), if discovered. Each slab must include a "currency" field.
- `<bank_code>_gift_rates.json` — GIFT City (variant: "gift"), for IBU banks only. Each slab must include a "currency" field.

**bank_code slug algorithm:** lowercase the full bank name → remove all characters except letters, digits, spaces, and hyphens → replace spaces and underscores with hyphens → collapse multiple hyphens → trim leading/trailing hyphens.

Examples: "State Bank of India" → `state-bank-of-india`, "HDFC Bank Limited" → `hdfc-bank-limited`

**Do NOT abbreviate** — always use the full name.

**The bank_code is a single canonical value for the whole bank.** It NEVER carries a product-type or variant suffix. Do NOT mint filenames like `<bank_code>_current_rates.json`, `<bank_code>_dds_rates.json`, `<bank_code>_rd_rates.json`, `<bank_code>_savings_rates.json` — these are not in the allowed file list above. The only allowed rate-file suffixes are the empty suffix (domestic FD) and the four FD variants (nre/nro/fcnr/gift). Savings, RD, current-account, and DDS rates are tracked via `rate_page_urls` in the config — they do **not** get their own rate files. The `bank_code` field inside every JSON file you write MUST equal the slug computed from the full bank name with no suffixes.
<!-- @end OUTPUT_SLUG -->

<!-- @fragment BANK_TYPE_TABLE -->
## Bank Type Classification

Map the bank's category to the `bank_type` code:

| Category | bank_type |
|----------|-----------|
| Public Sector Bank | PSB |
| Private Sector Bank (Indian) | PVB |
| Small Finance Bank | SFB |
| Payments Bank | PB |
| Foreign Bank | FB |
| Regional Rural Bank | RRB |
| Scheduled Urban Co-operative Bank | SUCB |
| Non-Scheduled Urban Co-operative Bank | NSUCB |
| Scheduled State Co-operative Bank | SSCB |
| Non-Scheduled State Co-operative Bank | NSSCB |
| District Central Co-operative Bank | DCCB |
| Local Area Bank | LAB |
| Financial Institution | FI |
| IFSC Banking Unit | IBU |
| Housing Finance Company | HFC |
<!-- @end BANK_TYPE_TABLE -->

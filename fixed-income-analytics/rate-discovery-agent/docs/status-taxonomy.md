# Bank Status Taxonomy — rate-discovery-agent

## Overview

The `status` field in `data/bank-domains.json` controls whether the rate-discovery-agent processes a bank. It is **internal to the agent** and distinct from the upstream BIRD schema's `scraperStatus` and `discoveryStatus` enums.

## Status Values

| Status | Meaning | Action |
|--------|---------|--------|
| *(absent)* | Normal — process as usual | Default |
| `website_not_found` | Searched but no website found | Skip; retry periodically |
| `no_retail_deposits` | Bank doesn't accept retail deposits (FIs like NABARD, SIDBI) | Skip permanently |
| `wholesale_only` | Bank operates wholesale/institutional only in India | Skip permanently |
| `rates_in_images` | Rates published as JPG/PNG images, not HTML/PDF | Skip; needs OCR |
| `site_unreachable` | Domain exists but site is broken (cert errors, 5xx, empty) | Skip; retry periodically |

## `domain_source` Field

Tracks how the domain was discovered:

| Value | Set by | Meaning |
|-------|--------|---------|
| `"discovered"` | `run-domain-discovery.js`, `domain-cache.js` | Found automatically via API search |
| `"manual"` | Human operator | Domain manually verified and entered |
| `"probed"` | `guess-bank-in.js` | Found via bank.in HEAD probe |
| *(absent)* | Legacy entries | Pre-dates this field; source unknown |

## Upstream BIRD Schema Alignment

The upstream BIRD project (`packages/shared/src/schemas/bank.ts`) defines its own status enums:

### `scraperStatus` (upstream)
```typescript
z.enum([
  "active",       // Scraper configured and running
  "no_website",   // Bank has no functional website
  "no_rates",     // Website exists but no rate page found
  "failed",       // Scraper configured but currently failing
  "manual_only",  // Rates only obtainable manually
  "pending",      // Not yet classified
])
```

### `discoveryStatus` (upstream)
```typescript
z.enum([
  "discovered",   // Rate page found and config created
  "not_found",    // Searched but no rate page found
  "partial",      // Some rate data found, incomplete
  "pending",      // Not yet searched
])
```

### Mapping (agent → upstream)

When importing agent results into the BIRD database, map as follows:

| Agent `status` | → Upstream `scraperStatus` | → Upstream `discoveryStatus` |
|----------------|----------------------------|------------------------------|
| *(absent)* + has rates | `active` | `discovered` |
| *(absent)* + 0 slabs | `failed` | `partial` |
| `website_not_found` | `no_website` | `not_found` |
| `no_retail_deposits` | `no_website` | `not_found` |
| `wholesale_only` | `no_rates` | `not_found` |
| `rates_in_images` | `manual_only` | `partial` |
| `site_unreachable` | `failed` | `not_found` |

### Important Notes

1. The agent uses `website_not_found` (not `no_website`) to distinguish "searched but not found yet" from the upstream's `no_website` which implies "confirmed no website exists." The upstream should decide which mapping applies per bank.

2. The agent's `wholesale_only` has no direct upstream equivalent. The upstream could use `no_rates` (website exists, no retail deposit rates) or add a new enum value.

3. The `domain_source` field has no upstream equivalent. If the upstream needs to track provenance of domain data, it should add a column to its `banks` table.

4. Both `run-batch.js` and `run-pipeline.js` recognize **both** `no_website` and `website_not_found` as skip statuses, so existing data using either form will be handled correctly.

5. Changes to the upstream enum values (`scraperStatus`, `discoveryStatus`) will require a database migration and schema update in `packages/shared`. These should not be made in the rate-discovery-agent.

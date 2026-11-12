# Phase 2: Scraping Pipeline — Implementation Doc

## Completed: 2026-03-28

---

## Architecture Decision

The original Phase 2 deep-dive (`docs/phase2-deep-dive.md`) assumed a traditional config-driven pipeline (Python/Scrapy/BeautifulSoup/Celery/PostgreSQL/Redis). After Phase 1 validated the rate-discovery-agent against real banks (SBI, HDFC, Cosmos, Axis), the architecture pivoted to a **hybrid approach**:

- **Agent = primary extractor** — handles per-bank quirks naturally (bot detection, PDF layouts, JS rendering, footnote rules) without per-bank scraper code
- **Change detection = daily lightweight check** — plain HTTP fetch + content hash comparison triggers agent re-extraction only when rates change
- **Cost model**: ~300 banks × daily HTTP fetch (~free) + ~30 changed banks/week × ~$0.10/agent run = ~$3/week

Phase 2 builds the **infrastructure around the agent**: import pipeline, validation engine, change detection, rate versioning, admin review queue, and scheduling. It does NOT duplicate the extraction logic built in the rate-discovery-agent's own optimization phases (1-6, completed in a parallel session).

### Scope Boundary

| Concern | Owner | Location |
|---------|-------|----------|
| Website discovery, rate page location | Agent (Phase 1) | `rate-discovery-agent/` |
| Rate extraction (HTML/JS/PDF) | Agent (optimization Phases 3-6) | `rate-discovery-agent/scripts/` |
| Config defaults, schema compaction | Agent (optimization Phase 6) | `rate-discovery-agent/scripts/utils/config-defaults.js` |
| **Change detection** | **Phase 2** | `packages/scraper/src/change-detector/` |
| **Import pipeline (agent output → DB)** | **Phase 2** | `packages/scraper/src/import/` |
| **7-layer validation engine** | **Phase 2** | `packages/scraper/src/validators/` |
| **Rate versioning (append-only)** | **Phase 2** | Integrated into import |
| **Admin review queue (API + UI)** | **Phase 2** | `packages/api/`, `packages/web/` |
| **Pipeline orchestration** | **Phase 2** | `packages/scraper/src/cli/pipeline.ts` |

---

## What Was Built

### `packages/scraper` (@bird/scraper) — Core Pipeline

Evolved from a scaffold (Phase 0) into the full data pipeline.

**Dependencies added**: `drizzle-orm`, `better-sqlite3`, `node-cron`, `tsx`

**Database connection** (`src/db.ts`):
- Uses `better-sqlite3` to access the local Wrangler D1 SQLite database
- Locates DB file recursively under `packages/api/.wrangler/state/v3/d1/`
- Returns typed Drizzle ORM instance with WAL mode and foreign keys enabled
- Imports schema directly from `packages/api/src/db/schema.ts` via relative path

**Import pipeline** (`src/import/import-discovery.ts`, 589 lines):
- Reads agent `*_config.json` + `*_rates.json` output files
- **Bank matching**: by slug code first, then by name (slugified)
- **Config defaults compatibility**: `mergeWithDefaults()` mirrors `rate-discovery-agent/scripts/utils/config-defaults.js` — never assumes all fields present in agent configs, safe for pre- and post-Phase 6 agent outputs
- **Status mapping**: `scraper_type` → `scraper_status` (active/manual_only/pending); `discovery_metadata.confidence` → `discovery_status` (discovered/partial/not_found)
- **Tenure resolution**: uses `parseTenureText()` from `@bird/shared` when agent output lacks pre-parsed `tenure_min_days` / `tenure_max_days`
- **Rate versioning** (append-only):
  1. Load active slabs for bank+product (where `effective_to IS NULL`)
  2. For each new slab, find matching active slab by exact tenure range
  3. Same rates → skip (unchanged); different rates → set `effective_to` on old slab, insert new slab, log changes to `rate_change_log`; no match → insert as new tenure
- **Scrape run recording**: creates `scrape_runs` entry per bank import with status/counts
- **Validation integration**: runs all import-time layers (1-5) before DB write; writes flags to `scrape_flags`
- **Special schemes**: imports promotional FDs with null-rate and duplicate protection

**Validation engine** (`src/validators/`, 7 files):
- **Types** (`types.ts`): `ValidationFlag`, `RawSlab`, `ActiveSlab` shared across layers
- **Orchestrator** (`index.ts`): `validateImport()` runs layers 1-5, returns `{ passed, flags, criticalCount, warningCount, infoCount }`
- **Layer 1 — Format** (`format.ts`): numeric rates, parseable tenures, required fields present, senior ≥ general. Critical flags auto-reject.
- **Layer 2 — Range** (`range.ts`): uses `PRODUCT_TYPES[type].rateRange` from `@bird/shared`. FD: 2.50–9.50% general, +1.0% for senior, +1.5% for super-senior. Critical if rate < 0 or > max + 2%.
- **Layer 3 — Delta** (`delta.ts`): compares new rates against active slabs by tenure overlap. 50 bps threshold (75 for SFB/NBFC/LAB). 2× threshold → critical.
- **Layer 4 — Monotonicity** (`monotonicity.ts`): rates should increase with tenure. Inversions flagged as warning (> 0.5% drop) or info (smaller). Never blocks import.
- **Layer 5 — Completeness** (`completeness.ts`): slab count vs `expected_slab_count` from config ±20%, and vs previous import count. Zero slabs → critical.
- **Layer 6 — Cross-reference**: deferred (requires external data sources like BankBazaar/StableMoney).
- **Layer 7 — Staleness** (`staleness.ts`): 60+ days → critical, 30–60 → warning. Runs on separate schedule, not during import.

**Change detection** (`src/change-detector/`):
- `normalize.ts`: strips `<script>`, `<style>`, `<noscript>`, HTML comments; removes all attributes except `class`/`id`; collapses whitespace. For PDFs: fingerprints `Content-Length | Last-Modified | ETag` from HEAD request.
- `index.ts`: fetches each active bank's rate page URL (plain HTTP, no Playwright — we only detect *change*, not extract data), SHA-256 hashes the normalized content, compares against `page_hashes` table. Results: `changed | unchanged | new | error`. Sequential processing to avoid overwhelming servers. 15-second timeout per bank.

**CLI tools** (`src/cli/`):
- `import.ts`: `npm run -w @bird/scraper import -- <path>` — import agent outputs (directory or single file)
- `detect.ts`: `npm run -w @bird/scraper detect [--category X] [--limit N]` — run change detection
- `validate.ts`: `npm run -w @bird/scraper validate -- <rates.json>` — standalone validation against a rates file
- `pipeline.ts`: `npm run -w @bird/scraper pipeline [--step detect|import|staleness]` — full daily orchestration or individual steps. Scheduler-agnostic (invoked by cron, systemd timer, Windows Task Scheduler, etc.)

### `packages/api` (@bird/api) — New Routes

**Schema addition** (`src/db/schema.ts`):
- `page_hashes` table for change detection: `id`, `bank_id` (FK), `url`, `content_hash` (SHA-256), `last_checked_at`, `last_changed_at`, `http_status`, `error_message`, `created_at`. Index on `bank_id`.
- Migration: `0001_luxuriant_prowler.sql`

**Rates API** (`src/routes/rates.ts`, 141 lines):
- `GET /api/rates` — query active rate slabs with bank/product/pagination filters
- `GET /api/rates/best` — highest rates sorted descending, filterable by tenure range
- `GET /api/banks/:code/rates` — all active rates for a single bank with full slab details

**Admin API** (`src/routes/admin.ts`, expanded from 63 to 207 lines):
- `GET /api/admin/flags` — paginated unresolved flags, filterable by severity/type, sorted critical-first
- `PATCH /api/admin/flags/:id` — resolve a flag (approved/rejected/held) with timestamp
- `GET /api/admin/scrape-runs` — recent scrape runs with bank name, status, record counts
- `GET /api/admin/pipeline-health` — aggregated metrics: 7-day success rate, flag queue depth, data coverage (banks with rates / active banks)

### `packages/web` (@bird/web) — Admin UI

**API client** (`src/lib/api.ts`, expanded from 34 to 122 lines):
- Types: `FlagRow`, `FlagListResponse`, `ScrapeRunRow`, `PipelineHealth`, `RateRow`
- Functions: `fetchFlags()`, `resolveFlag()`, `fetchScrapeRuns()`, `fetchPipelineHealth()`, `fetchBestRates()`
- Enhanced `request()` helper accepts `RequestInit` for PATCH support

**Pipeline dashboard** (`src/routes/admin/pipeline.tsx`, 198 lines):
- 4 metric cards: success rate (color-coded by threshold), flag queue depth (links to review queue), data coverage %, total runs
- Stacked status bar: green (success) / yellow (partial) / red (failed), proportional width
- Recent scrape runs table with status badges, change highlighting

**Flag review queue** (`src/routes/admin/flags.tsx`, 180 lines):
- Severity filter dropdown (critical/warning/info) + type filter (format/range/delta/monotonicity/completeness/staleness)
- Table with severity-colored badges, truncated detail messages (parsed from JSON), inline action buttons
- Approve (green) / Reject (red) / Hold (gray) buttons with optimistic UI removal
- Pagination for large queue depths

**Navigation** (`src/routes/__root.tsx`):
- Added "Pipeline" (`/admin/pipeline`) and "Flags" (`/admin/flags`) links to header nav

---

## Import Results

First bulk import of all 96 agent outputs:

| Metric | Count |
|--------|-------|
| Banks updated | 96 |
| Banks unmatched | 0 |
| Errors | 1 (SBI special scheme with null rate — fixed) |
| Rate slabs imported | 978 |
| Rate changes detected | 4 (Axis Bank — 2 config versions with different tenure parsing) |
| Slabs deduplicated | 40 (HDFC re-import correctly skipped) |
| Validation flags created | 272 |

**Import status breakdown**:

| Status | Count |
|--------|-------|
| active/discovered | 89 |
| manual_only/discovered | 5 |
| manual_only/partial | 1 |
| active/partial | 1 |

**Pipeline health after import**:

| Metric | Value |
|--------|-------|
| Scrape success rate (7d) | 97.7% |
| Flag queue depth | 276 |
| Active banks | 88 |
| Banks with rates | 77 |
| Staleness warnings | 6 |

---

## Verification Results

- `npx tsc --noEmit -p packages/api/tsconfig.json` — zero errors
- `npx tsc --noEmit -p packages/web/tsconfig.app.json` — zero errors
- `npm run build -w @bird/shared` — clean
- `npm run build -w @bird/api` — clean (407 KiB / 80 KiB gzip)
- Validate CLI tested against SBI (2 info flags, passed), HDFC (2 info flags, passed), Airtel Payments (3 warnings, passed), Bank of Bahrain (20 warnings, passed)
- Import CLI tested: single bank, re-import dedup, full bulk (96 banks)
- API endpoints tested: `/api/admin/pipeline-health`, `/api/rates/best`, `/api/banks/hdfc-bank-limited/rates`
- Pipeline staleness step tested: 0 stale, 6 warnings across 88 active banks

---

## Git History

```
c56719a Phase 2: Scraping pipeline — import, validation, change detection, admin UI
```

32 files changed, 4,194 insertions(+), 124 deletions(-).

---

## Deviations from Plan

- **No Crawlee/Cheerio/Playwright in `packages/scraper`**: The plan originally listed these as dependencies. Removed because the agent handles all extraction — the scraper only needs `better-sqlite3`, `drizzle-orm`, and `node-cron` for orchestration.
- **No internal node-cron scheduler**: The plan specified `packages/scraper/src/scheduler/` with node-cron jobs at specific IST times. Replaced with a simple `pipeline.ts` script that any external scheduler can invoke. The deployment environment determines the scheduler (cron, systemd, Task Scheduler, etc.).
- **Layer 6 (cross-reference) deferred**: Requires external data sources (BankBazaar, StableMoney, etc.). Stub acknowledged in plan; will implement when secondary source APIs/scraping are available.
- **Import pipeline kept in `packages/scraper`**: Plan mentioned enhancing the existing `packages/api/src/db/seed/import-discovery.mjs`. Instead, a full TypeScript rewrite was created in `packages/scraper/src/import/` with rate versioning and validation integration. The original `.mjs` file remains for backward compatibility but is superseded.
- **SAVINGS vs SA product type**: The agent uses "SAVINGS" while `@bird/shared` uses "SA". Range validation logs a warning for unknown product types but does not block. Mapping will be standardized in a future pass.

---

## Known Issues / Debt for Later Phases

1. **Duplicate slabs from multiple agent output formats** — Banks like HDFC and Axis have both legacy (`hdfc_rates.json`) and new-format (`hdfc-bank-limited_rates.json`) outputs. Some slabs with slightly different tenure day boundaries exist side by side (e.g., 639 vs 637 for "21 months"). A dedup pass or canonical tenure normalization would clean this up.
2. **Product type mapping** — Agent outputs use "SAVINGS", "FD", "SAVINGS/regular" etc. `@bird/shared` uses "SA", "FD". The range validator skips unknown types with a warning. Should standardize at import time.
3. **Cross-reference validation (Layer 6)** — Not yet implemented. Needs external data source integration.
4. **Change detection for JS-rendered pages** — Plain HTTP fetch won't see rate data on JS-rendered pages. Content changes (bundle hashes, framework versions) may correlate with rate changes, but false positives are expected. A weekly full agent re-extraction for `html_js` banks would be a safety net.
5. **No tests yet for scraper package** — Validators, import pipeline, and change detector all need Vitest tests with fixture data. The existing 14 tests in `@bird/shared` still pass but scraper-specific tests are needed.
6. **`tsc -b` fails for `@bird/web`** — Pre-existing issue from Phase 0 (web tsconfig has `noEmit: true` which conflicts with `tsc -b` composite mode). Vite build and typecheck work independently. Will be resolved when CI pipeline is set up.
7. **Special scheme dedup** — Re-importing creates duplicate special scheme entries. Should check for existing scheme by name+bank before insert.

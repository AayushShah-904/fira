# Phase 2: Scraping Pipeline — Detailed Plan

## Context & Architecture Decision

The original Phase 2 deep-dive (`docs/phase2-deep-dive.md`) assumed a traditional config-driven scraper pipeline (Scrapy/BeautifulSoup/Celery). After Phase 1 validated the rate-discovery-agent against real banks (SBI, HDFC, Cosmos, Axis), the architecture pivoted to a **hybrid approach** documented in `sdlc/phase1/scraping-architecture.md`:

- **Agent = primary extractor** — handles per-bank quirks (bot detection, PDF layouts, JS rendering) without per-bank code
- **Change detection = daily lightweight check** — HTTP fetch + content hash, triggers agent re-extraction only when rates change
- **Cost model**: ~300 banks x daily HTTP fetch (~free) + ~30 changed banks/week x $0.10/agent run = ~$3/week

This Phase 2 plan builds the **infrastructure around the agent**: change detection, import pipeline, validation, rate versioning, admin review queue, and scheduling. It does NOT duplicate the extraction logic being built in the rate-discovery-agent's own optimization phases (3-6).

---

## Scope Boundary: What We Build vs What the Agent Builds

| Concern | Owner | Location |
|---------|-------|----------|
| Website discovery, rate page location | Agent (Phase 1, done) | `rate-discovery-agent/` |
| Rate extraction (HTML/JS/PDF) | Agent (optimization Phases 3-6, in progress) | `rate-discovery-agent/scripts/` |
| Config defaults, schema compaction | Agent (optimization Phase 6, planned) | `rate-discovery-agent/scripts/utils/config-defaults.js` |
| **Change detection** | **Phase 2** | `packages/scraper/src/change-detector/` |
| **Import pipeline (agent output → DB)** | **Phase 2** (enhance existing) | `packages/api/src/db/seed/import-discovery.mjs` |
| **7-layer validation engine** | **Phase 2** | `packages/scraper/src/validators/` |
| **Rate versioning (append-only writes)** | **Phase 2** | `packages/scraper/src/import/` |
| **Admin review queue (API + UI)** | **Phase 2** | `packages/api/src/routes/`, `packages/web/` |
| **Scheduling & orchestration** | **Phase 2** | `packages/scraper/src/scheduler/` |
| **Pipeline observability** | **Phase 2** | `packages/api/src/routes/admin.ts` |

---

## Compatibility with Agent Config Defaults

The rate-discovery-agent's Phase 6 proposes `stripDefaults()` for compact config storage. Configs may omit fields that match defaults (e.g., `tenure_parser: "standard_indian"` is omitted when it matches the default). Our import/change-detection code must:

1. **Always use `mergeWithDefaults()` when reading agent configs** — never assume all fields are present
2. **Treat the agent's `CONFIG_DEFAULTS` as the source of truth** for default values
3. **Not add required fields to configs** — the agent owns the config schema

Current defaults from `rate-discovery-agent/scripts/utils/config-defaults.js`:
```
tenure_parser: "standard_indian"
rate_multiplier: 1.0
senior_citizen_premium: "same_table"
deposit_insurance: true
update_frequency: "monthly"
selectors: { table: null, rows: null, effective_date: null }
column_mapping: {}
scraper_notes: { framework: null, bot_protection: null, data_format: null, rate_tables_on_page: null }
```

---

## Step 1: Change Detection Service

**Goal**: Detect which bank rate pages have changed since last check, so we only trigger agent re-extraction when needed.

### 1.1 Content hash store

Add a new table to the Drizzle schema:

```sql
page_hashes (
  id INTEGER PRIMARY KEY,
  bank_id INTEGER NOT NULL REFERENCES banks(id),
  url TEXT NOT NULL,
  content_hash TEXT NOT NULL,        -- SHA-256 of normalized page content
  last_checked_at TEXT NOT NULL,     -- ISO timestamp
  last_changed_at TEXT,              -- ISO timestamp, null if never changed
  http_status INTEGER,               -- last HTTP status code
  error_message TEXT,                -- last error if fetch failed
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
```

### 1.2 Fetch & hash logic (`packages/scraper/src/change-detector/`)

For each bank with `scraper_status = 'active'` and a known `rate_page_url`:

1. HTTP GET the rate page URL (plain fetch, no Playwright — we only need to detect *change*, not extract data)
2. Normalize the response: strip timestamps, session tokens, ad scripts, whitespace — anything that changes on every request without meaning rate data changed
3. SHA-256 hash the normalized content
4. Compare against stored hash in `page_hashes`
5. If different → mark bank as "changed", update hash + `last_changed_at`
6. If same → update only `last_checked_at`
7. If fetch fails → log error, increment failure counter, keep previous hash

**Normalization strategy:**
- Strip `<script>`, `<style>`, `<noscript>` tags and content
- Strip HTML comments
- Remove all attributes except `class` and `id` (strips dynamic tokens)
- Collapse whitespace
- For PDF URLs: compare file size + first/last 1KB hash (avoid downloading full PDF every day)

**Edge cases:**
- JS-rendered pages: plain fetch won't see rate data, but page structure changes (bundle hashes, framework versions) correlate with content changes. Accept some false positives — they just trigger an agent run (~$0.10).
- PDF banks: HEAD request for `Content-Length` + `Last-Modified` header. Only download if headers changed.

### 1.3 Change queue

Changed banks are written to a simple JSON file or DB table:
```json
{ "bank_code": "state-bank-of-india", "changed_at": "2026-04-01T02:15:00Z", "previous_hash": "abc...", "new_hash": "def..." }
```

The scheduler picks up this queue and triggers agent re-extraction.

---

## Step 2: Enhanced Import Pipeline

**Goal**: Evolve `import-discovery.mjs` into a robust import module that handles rate versioning, validation, and audit logging.

### 2.1 Move to TypeScript (`packages/scraper/src/import/`)

Port `import-discovery.mjs` into `packages/scraper/src/import/import-discovery.ts`:
- Use Drizzle ORM directly (same schema as `packages/api`)
- Type-safe with `@bird/shared` Zod schemas
- Can run as CLI: `npx tsx packages/scraper/src/import/import-discovery.ts <path>`

### 2.2 Rate versioning logic

When importing rate slabs for a bank that already has rates:

1. Load current active slabs (where `effective_to IS NULL`) for the bank+product
2. Compare new slabs against current slabs by tenure range
3. For each new slab:
   - If matching tenure exists with same rates → no change, skip
   - If matching tenure exists with different rates → set `effective_to` on old slab, insert new slab
   - If no matching tenure → insert new slab (new tenure added)
4. For current slabs with no matching new slab → could mean tenure removed (flag for review, don't auto-expire)
5. Write `rate_change_log` entries for every changed field

### 2.3 Scrape run recording

Every import creates a `scrape_runs` record:
- `started_at`: import start time
- `completed_at`: import end time
- `status`: success / partial (some slabs failed validation) / failed
- `records_found`: total slabs in agent output
- `records_changed`: slabs that differed from current DB values
- `records_flagged`: slabs that triggered validation flags
- `scraper_version`: agent version or "discovery-agent-v1"

### 2.4 Agent output compatibility

Read configs using the agent's `mergeWithDefaults()` pattern:
- If a field is missing from config, apply the default from `CONFIG_DEFAULTS`
- Handle both full configs (pre-Phase 6 agent) and stripped configs (post-Phase 6 agent)
- Gracefully handle unknown fields (agent may add new ones)

---

## Step 3: Validation Engine

**Goal**: Implement the 7-layer validation pipeline from the Phase 2 deep-dive, adapted for the hybrid architecture.

### 3.1 Location: `packages/scraper/src/validators/`

Each layer is a standalone function that takes rate slabs + context and returns `ValidationResult`:
```typescript
type ValidationResult = {
  passed: boolean;
  flags: Array<{
    flag_type: FlagType;
    severity: FlagSeverity;
    details: string;
    rate_slab_id?: number;
  }>;
};
```

### 3.2 The 7 layers

**Layer 1: Format** — applied during import parsing
- Rates are numeric and parseable
- Tenure text resolves to valid min/max days via `parseTenureText()`
- Required fields present (bank_id, product_id, at least one rate)
- Action: auto-reject malformed records

**Layer 2: Range** — applied per slab
- Use `PRODUCT_TYPES[productType].rateRange` from `@bird/shared` as bounds
- FD: 2.50%–9.50% general, up to 10.50% senior (aligned with agent's `validate-rates.js` which uses 1.50% floor — we use the shared constants as canonical, but accept the agent's broader range for foreign banks)
- Action: flag for review

**Layer 3: Delta** — applied per slab when previous value exists
- Compare new rate vs last active rate for same bank/product/tenure
- Threshold: 50 bps (configurable per bank category — SFBs get 75 bps)
- Action: flag for review

**Layer 4: Monotonicity** — applied across all slabs for a bank/product
- FD rates should generally increase with tenure
- Sort by `tenure_min_days`, check each rate >= previous
- Known inversions stored in config can suppress false positives
- Action: flag for review (not rejection — inverted curves do happen)

**Layer 5: Completeness** — applied per bank/product import
- Compare slab count against `expected_slab_count` from config (±20%)
- Missing tenures vs previous import flagged
- Action: flag + trigger re-scrape

**Layer 6: Cross-reference** — applied weekly for top-tier banks
- Compare our rates against a secondary source (future: BankBazaar/StableMoney API or scrape)
- Threshold: 10 bps discrepancy
- Action: flag for review
- Note: deferred to later in Phase 2, as it requires external data sources

**Layer 7: Staleness** — applied on schedule
- Banks with no data update in 60+ days → flag
- Banks with `last_changed_at` (from change detector) but no new import → flag
- Action: force re-scrape + manual check

### 3.3 Integration with import

The validation pipeline runs automatically during import:
1. Format validation during parsing (Layer 1)
2. Range + Delta + Monotonicity + Completeness after parsing, before DB write (Layers 2-5)
3. If any critical flags → import as "partial", slabs with critical flags are held (not written as active)
4. If only warnings → import as "success", flags written to `scrape_flags`
5. Cross-reference and Staleness run on separate schedules

---

## Step 4: Admin Review Queue

**Goal**: Web UI for reviewing flagged records — approve, reject, or hold.

### 4.1 API endpoints (`packages/api/src/routes/admin.ts`)

Add to existing admin routes:

- `GET /api/admin/flags` — paginated list of unresolved flags
  - Filters: bank_id, flag_type, severity, resolution
  - Includes: bank name, product type, rate slab details, previous value
- `GET /api/admin/flags/:id` — single flag with full context
- `PATCH /api/admin/flags/:id` — resolve a flag
  - Body: `{ resolution: "approved" | "rejected" | "held", resolved_by: string }`
  - If approved: held slab becomes active
  - If rejected: slab is discarded, previous value remains
  - If held: no change, flag stays in queue
- `GET /api/admin/scrape-runs` — recent scrape runs with stats
  - Filters: bank_id, status, date range
- `GET /api/admin/pipeline-health` — aggregated health metrics
  - Success rate (last 7 days)
  - Coverage (banks with fresh data / total active banks)
  - Queue depth (unresolved flags)
  - Freshness distribution (green/yellow/red)

### 4.2 Web routes (`packages/web/`)

- `/admin/flags` — flag review queue table
  - Sortable by severity, bank, date
  - Inline approve/reject/hold buttons
  - Link to bank's rate page for manual verification
- `/admin/pipeline` — pipeline health dashboard
  - Success rate chart (7-day trend)
  - Freshness distribution donut chart
  - Recent scrape runs table
  - Queue depth indicator

### 4.3 Rates API (public)

Add public-facing rate endpoints needed for Phase 3 but useful now for verification:

- `GET /api/rates` — query rates (bank, product, tenure, amount filters)
- `GET /api/rates/best` — best rates by product/tenure/category
- `GET /api/banks/:code/rates` — all active rates for a bank

---

## Step 5: Scheduling & Orchestration

**Goal**: Automated daily pipeline — change detection → re-extraction → import → validation.

### 5.1 Scheduler (`packages/scraper/src/scheduler/`)

Use `node-cron` for scheduling (same monorepo, no external dependencies):

| Time (IST) | Job | What It Does |
|-------------|-----|-------------|
| 02:00 | Change detection | Fetch all active bank rate pages, compare hashes |
| 02:30 | Queue processing | For changed banks: trigger agent re-extraction |
| 04:00 | Import | Import new agent outputs into DB with validation |
| 04:30 | Staleness audit | Check all banks for data freshness, flag stale ones |
| Monday 06:00 | Cross-reference | Compare top-tier bank rates against secondary sources |

### 5.2 Re-extraction trigger

When change detection finds a changed bank:
1. Write to change queue (JSON file or DB table)
2. For `html_static` and `pdf` banks: run `node rate-discovery-agent/scripts/extract_rates.js <bank_code>` (deterministic, no LLM — from agent Phase 4)
3. For `html_js` banks: run `node rate-discovery-agent/scripts/fetch_rates_playwright.js <url>` (deterministic, no LLM)
4. For banks without deterministic extractors yet: run full agent `node rate-discovery-agent/run-discovery.js <bank_name> --no-extract` (LLM-based, fallback)
5. After extraction: auto-trigger import

### 5.3 CLI interface

The scraper package exposes CLI commands via `package.json` scripts:

```bash
# Run change detection for all active banks
npm run -w @bird/scraper detect

# Run change detection for a specific category
npm run -w @bird/scraper detect -- --category PSB

# Import agent outputs
npm run -w @bird/scraper import -- <path>

# Run validation on existing DB data
npm run -w @bird/scraper validate -- --bank <code>

# Run the full daily pipeline
npm run -w @bird/scraper pipeline

# Check staleness
npm run -w @bird/scraper staleness
```

---

## Step 6: Pipeline Observability

**Goal**: Know when things break, how much data is fresh, and where to look.

### 6.1 Metrics (computed from DB)

- **Scrape success rate**: `scrape_runs` where `status = 'success'` / total, last 7 days
- **Data coverage**: banks with at least one active rate slab / total active banks
- **Freshness distribution**:
  - Green: last successful import < 7 days ago
  - Yellow: 7-30 days
  - Red: 30+ days or never
- **Queue depth**: unresolved `scrape_flags` count
- **Change detection health**: `page_hashes` with `http_status != 200` or `error_message IS NOT NULL`

### 6.2 Logging

All scraper operations log to stdout in structured JSON format:
```json
{"level":"info","job":"change-detect","bank":"sbi","status":"changed","hash":"abc...","ts":"2026-04-01T02:15:00Z"}
```

---

## Implementation Order

The steps above are ordered by dependency. Concrete implementation sequence:

| Step | What | Depends On | Deliverable |
|------|------|-----------|-------------|
| 1a | Add `page_hashes` table to Drizzle schema | Nothing | Migration |
| 1b | Change detection fetch + hash logic | 1a | `packages/scraper/src/change-detector/` |
| 2a | Port import pipeline to TypeScript | Nothing | `packages/scraper/src/import/` |
| 2b | Rate versioning (append-only with effective_to) | 2a | Integrated into import |
| 3 | Validation engine (7 layers) | 2a | `packages/scraper/src/validators/` |
| 4a | Admin API endpoints (flags, scrape-runs, pipeline-health) | 3 | `packages/api/src/routes/admin.ts` |
| 4b | Admin web UI (flag review queue, pipeline dashboard) | 4a | `packages/web/src/routes/admin/` |
| 4c | Public rates API | 2b | `packages/api/src/routes/rates.ts` |
| 5 | Scheduler + orchestration | 1b, 2a, 3 | `packages/scraper/src/scheduler/` |
| 6 | Observability (health endpoint, logging) | 5 | Integrated |

### Priority tiers

**Must-have (Week 1-2)**: Steps 1a, 2a, 2b, 3 — the core pipeline that gets data into the DB correctly
**Should-have (Week 2-3)**: Steps 1b, 4a, 4c — change detection and APIs to query the data
**Nice-to-have (Week 3-4)**: Steps 4b, 5, 6 — admin UI, automation, observability

---

## Dependencies to Install

```bash
# packages/scraper
npm install -w @bird/scraper node-cron
npm install -w @bird/scraper -D @types/node-cron better-sqlite3 @types/better-sqlite3
```

Note: Crawlee/Cheerio/Playwright are NOT needed in `packages/scraper`. The agent handles extraction. The scraper package only needs:
- `node-cron` for scheduling
- `better-sqlite3` for direct DB access (same as `packages/api`)
- `drizzle-orm` for type-safe queries (already available via `@bird/shared` dependency chain)

---

## Expected Outcomes

- All agent-discovered banks (~150-300) have their rates imported with proper versioning
- Daily change detection runs for all active banks (~300 HTTP requests, <5 min)
- Changed banks automatically re-extracted and imported within 2 hours of detection
- 7-layer validation catches data quality issues before they reach users
- Admin can review flagged records and approve/reject/hold
- Pipeline health visible at a glance: success rate, coverage, freshness, queue depth

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Change detection false positives (page changes but rates didn't) | Accept ~10% false positive rate; agent re-run is cheap ($0.10). Improve normalization over time. |
| Agent extraction breaks for a bank | Validation catches it (completeness layer). Flag for review. Previous data stays active. |
| Agent config schema changes (Phase 6 defaults) | Always use `mergeWithDefaults()` when reading. Never assume field presence. |
| D1 write limits during bulk import | Batch writes in transactions of 50 slabs. Import one bank at a time. |
| JS-rendered pages change without HTTP content changing | Weekly full re-extraction for html_js banks as fallback. Change detection is a heuristic, not perfect. |

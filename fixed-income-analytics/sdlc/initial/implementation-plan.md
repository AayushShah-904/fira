# BIRD (Bank Interest Rate Dashboard) - Implementation Plan

## Context

BIRD is part of the Unified Fixed Income Analytics (UFA) platform under BharatOmni. The goal is to aggregate, standardize, and present fixed deposit and other interest-rate product data from Indian financial institutions. The RBI master list contains ~1900 banks (PSBs, PVBs, SFBs, co-operatives, RRBs, etc.), though many smaller/regional banks may lack functional websites or regularly updated rate pages. The platform must handle this full spectrum — from SBI with clean HTML tables to obscure cooperative banks with no web presence.

The tech stack mirrors QuestConquest: monorepo with npm workspaces, React 19 + Vite + TanStack Router + Tailwind + shadcn/ui (frontend), Hono on Cloudflare Workers (API), D1 + Drizzle ORM (database), Zod (shared schemas). The scraping pipeline is also TypeScript, using Crawlee (Apify's scraping framework), Cheerio, Playwright, and pdf.js/tabula-js for PDF parsing — keeping the entire codebase in a single language with shared Zod schemas and direct Drizzle ORM access.

**Key architectural tension**: D1 (SQLite) works initially but with ~1900 banks x multiple products x rate slabs x history, the dataset will grow significantly. Drizzle ORM supports both SQLite and PostgreSQL drivers, so the schema is designed for portability from day one.

---

## Monorepo Structure

```
BIRD/
├── packages/
│   ├── shared/                 # Zod schemas, types, constants (npm workspace)
│   │   └── src/
│   │       ├── schemas/        # bank.ts, product.ts, rate.ts, scrape.ts
│   │       ├── constants/      # bank-categories.ts, product-types.ts, tenure-maps.ts
│   │       └── types/          # Inferred Zod types, API contracts
│   ├── api/                    # Hono API on Cloudflare Workers (npm workspace)
│   │   └── src/
│   │       ├── app.ts          # Deployment-agnostic Hono app
│   │       ├── routes/         # banks, rates, products, compare, alerts, admin
│   │       ├── middleware/     # auth, cors, rate-limiting, request-id
│   │       ├── db/
│   │       │   ├── schema.ts   # Drizzle schema (portable SQLite/PG)
│   │       │   ├── migrations/ # Drizzle Kit migrations
│   │       │   └── seed/       # Bank master data seeding
│   │       └── lib/            # Validation, freshness calc, query helpers
│   └── web/                    # React 19 + Vite frontend (npm workspace)
│       └── src/
│           ├── routes/         # TanStack Router file-based routes
│           ├── components/     # UI components (comparison tables, calculators, etc.)
│           ├── context/        # Auth, theme, filter state
│           ├── lib/            # API client, formatters, rate helpers
│           └── styles/         # Tailwind config, theme variables
│   └── scraper/                # TypeScript scraping pipeline (npm workspace)
│       └── src/
│           ├── crawlers/       # Crawlee crawlers (HTML, JS-rendered, PDF)
│           ├── parsers/        # Cheerio HTML parser, pdf.js/tabula-js PDF parser
│           ├── configs/        # Per-bank JSON configs (~1900 entries)
│           ├── validators/     # 7-layer validation engine
│           ├── scheduler/      # node-cron or Cloudflare Cron Triggers
│           ├── cli/            # CLI tools for manual scrape, batch operations
│           └── lib/            # Shared scraper utilities, tenure normalization
├── rate-discovery-agent/       # Extracted from .tar.gz — Claude agent for bank discovery
├── docs/                       # Existing documentation (as-is)
├── data/                       # Generated data, discovery outputs, bank configs
├── sdlc/                       # SDLC artifacts: plans, implementation docs per phase
├── package.json                # Root workspace config
├── tsconfig.base.json
├── vitest.config.ts
├── wrangler.toml
└── .github/workflows/          # CI/CD
```

---

## Database Schema (Drizzle ORM — portable SQLite/PostgreSQL)

### Core Tables

**`banks`** (~1900 rows, seeded from RBI Excel)
- id, code (slug), name, category (PSB/PVB/SFB/SUCB/RRB/DCCB/etc.)
- state, website_url, rate_page_url, logo_url
- rbi_licence_no, ifsc_prefix, deposit_insurance (boolean)
- assets_under_mgmt, trust_score (computed)
- scraper_status: active | no_website | no_rates | failed | manual_only
- discovery_status: discovered | not_found | partial | pending
- created_at, updated_at

**`products`** (~5000-8000 rows as coverage grows)
- id, bank_id (FK), product_type (FD/RD/SA/PPF/SCSS/etc.)
- variant (regular/senior/super_senior/nre/nro/tax_saving/flexi)
- name, description, eligibility_notes
- sec_80c_eligible, premature_withdrawal_allowed
- min_deposit, max_deposit
- created_at, updated_at

**`rate_slabs`** (tens of thousands, append-only)
- id, product_id (FK), bank_id (FK, denormalized for query speed)
- tenure_min_days, tenure_max_days, tenure_text
- rate_general_pct, rate_senior_pct, rate_super_senior_pct
- compounding_frequency (quarterly/monthly/yearly)
- effective_from, effective_to (null = current)
- min_deposit_for_slab, max_deposit_for_slab
- source_url, scraped_at
- created_at

**`rate_change_log`** (audit trail)
- id, rate_slab_id, bank_id, product_id
- field_changed, old_value, new_value
- detected_at, source_url

**`scrape_runs`** (pipeline observability)
- id, bank_id, started_at, completed_at
- status (success/partial/failed), error_message
- records_found, records_changed, records_flagged
- scraper_version

**`scrape_flags`** (human review queue)
- id, scrape_run_id, bank_id, rate_slab_id
- flag_type (range/delta/monotonicity/completeness/cross_ref/staleness)
- severity (info/warning/critical)
- details (JSON), resolution (approved/rejected/held)
- resolved_by, resolved_at

**`special_schemes`** (promotional FDs, limited-period offers)
- id, bank_id, name, rate_pct, tenure_days
- launch_date, expiry_date, min_deposit
- source_url, notes

**`user_alerts`** (rate change notifications — Phase 3+)
- id, user_id, bank_id, product_type, threshold_bps
- channel (email/push), active, created_at

### Design Decisions for D1→PostgreSQL Portability
- Use Drizzle's `sqliteTable` initially, migrate to `pgTable` when needed
- Avoid SQLite-specific features (CTEs and JSON work in both)
- Use `text` columns for enums (D1 doesn't support native enums; PG migration adds them)
- Indexes defined in Drizzle schema (portable)
- JSONB columns → use `text` with JSON.parse/stringify in D1, switch to native `jsonb` in PG
- Full-text search: simple LIKE queries in D1, switch to `tsvector` in PG when needed

### Migration Trigger Criteria (D1 → PostgreSQL)
Move to PostgreSQL + Neon/Supabase when ANY of:
- D1 database size > 5GB (D1 limit is 10GB)
- Query latency for comparison queries > 200ms p95
- Need for concurrent writes from multiple scraper workers
- Need for materialized views or complex aggregations
- Full-text search becomes a bottleneck

---

## Implementation Phases

### Phase 0: Project Bootstrap (Week 1)

**Goal**: Monorepo scaffold, database schema, bank master data seeded.

1. Initialize monorepo matching QuestConquest patterns:
   - Root `package.json` with npm workspaces
   - `tsconfig.base.json` (ES2022, strict, bundler resolution)
   - ESLint v9 flat config, Vitest workspace config
   - `wrangler.toml` for Cloudflare Workers + D1 binding

2. **`packages/shared`**: Zod schemas for all domain entities
   - Bank schema (with category enum covering all 13+ RBI categories)
   - Product/rate schemas matching the unified data model from Phase 1 docs
   - API request/response contracts
   - Constants: bank categories, product types, tenure normalization maps

3. **`packages/api`**: Hono app skeleton
   - Drizzle schema with all tables above
   - Initial migration
   - Seed script: parse `Indian_Banks_Comprehensive_List_RBI.xlsx` → seed ~1900 banks
   - Each bank starts with `scraper_status: 'pending'`, `discovery_status: 'pending'`
   - Health route, basic CORS/request-id middleware

4. **`packages/web`**: Vite + React scaffold
   - TanStack Router with initial route structure
   - Tailwind + shadcn/ui setup
   - API client wired to Hono backend

### Phase 1: Rate Discovery & Bank Classification (Weeks 2-4)

**Goal**: Use the rate-discovery-agent to classify all ~1900 banks and build scraper configs for the viable ones.

1. Extract and set up `rate-discovery-agent` from the .tar.gz
2. Run batch discovery against the RBI bank list, prioritized by tier:
   - **Tier 1** (top 25): PSBs + large PVBs — must have configs
   - **Tier 2** (next 25): SFBs + mid-size PVBs + major NBFCs
   - **Tier 3** (next 100): Significant co-ops, RRBs with known web presence
   - **Tier 4** (remaining ~1750): Bulk discovery, expect many "no_website" or "no_rates"
3. For each bank, discovery produces:
   - `<bank_code>_config.json` — scraper configuration
   - `<bank_code>_rates.json` — extracted rate data (if available)
   - Classification: active / no_website / no_rates / manual_only
4. Update bank records in database with discovery results
5. Build admin dashboard page showing discovery progress across all ~1900 banks

**Expected outcome**: ~150-300 banks with functional rate pages and scraper configs; ~1600+ classified as no_website/no_rates/manual_only.

### Phase 2: Scraping Pipeline (Weeks 4-8)

**Goal**: Automated daily scraping for all discovered banks.

1. **TypeScript scraper setup** (`packages/scraper`):
   - Crawlee-based crawlers with per-bank JSON configs from Phase 1 discovery
   - Parsers by source type:
     - `html_static`: Crawlee HttpCrawler + Cheerio (40% of banks)
     - `html_js`: Crawlee PlaywrightCrawler with API interception (25%)
     - `pdf`: pdf.js text extraction → tabula-js table extraction → Tesseract.js OCR fallback (20%)
     - `mixed`: combination of above (15%)
   - Direct Drizzle ORM writes — no HTTP ingestion API needed (same DB, same monorepo)
   - Shared Zod schemas imported directly from `@bird/shared`

2. **Validation engine** (7 layers from Phase 2 docs):
   - Format, Range, Delta, Monotonicity, Completeness, Cross-reference, Staleness
   - Flags written to `scrape_flags` table for human review
   - Reuses Zod schemas for format validation (single source of truth)

3. **Database writes** (direct Drizzle ORM, no HTTP API needed):
   - Scraper imports Drizzle schema from `packages/api/src/db/schema.ts`
   - Append-only rate versioning: old slabs get `effective_to` set, new slabs inserted
   - Scrape runs and flags written directly to DB
   - Runs as a Node.js process (local, VPS, or container) with direct DB access

4. **Scheduling**: node-cron for daily scrape orchestration (or Cloudflare Cron Triggers for lighter jobs)
   - 02:00 IST: HTML scrapers
   - 03:00 IST: JS-rendered scrapers
   - 04:00 IST: PDF scrapers
   - 04:30 IST: Cross-reference validation
   - Weekly: Staleness audit

5. **Admin review queue** (web UI):
   - Flagged records with context (scraped data, previous value, bank link)
   - Approve / Reject / Hold actions
   - Pipeline health dashboard (success rates, coverage, freshness)

### Phase 3: Consumer Platform (Weeks 8-14)

**Goal**: Public-facing rate comparison website.

1. **Core pages** (TanStack Router file-based routes):
   - `/` — Homepage: best rates today, rate change feed, search
   - `/banks` — All banks filterable by category, state, trust score
   - `/banks/$bankCode` — Bank profile: all products, rate history, trust indicators
   - `/compare` — Side-by-side comparison (up to 4 banks)
   - `/fd` — FD rates: filterable by tenure, amount, bank type, senior citizen
   - `/fd/$bankCode` — Bank-specific FD rates with all variants
   - `/rd`, `/savings`, `/post-office` — Product-specific listing pages
   - `/calculators/fd` — FD maturity calculator
   - `/calculators/compare` — Multi-bank return comparison
   - `/rate-changes` — Timeline of recent rate changes

2. **API routes** (Hono):
   - `GET /api/banks` — List/filter banks (category, state, scraper_status)
   - `GET /api/banks/:code` — Bank detail with products
   - `GET /api/rates` — Query rates (bank, product, tenure, amount filters)
   - `GET /api/rates/best` — Best rates by product/tenure/category
   - `GET /api/rates/compare` — Multi-bank comparison
   - `GET /api/rates/history/:bankCode/:productId` — Rate change history
   - `GET /api/rate-changes` — Recent changes feed
   - `GET /api/calculators/fd` — FD maturity calculation

3. **Key UI components** (shadcn/ui + custom):
   - Rate comparison table with sortable columns
   - Bank trust indicator (DICGC insured badge, asset size, category)
   - Data freshness badge (Green/Yellow/Red)
   - Tenure selector (preset buttons + custom)
   - FD calculator with compound interest math
   - Rate change sparkline charts
   - Bank category filter pills

4. **SEO** (critical for organic traffic):
   - SSR-friendly meta tags via TanStack Router loaders
   - Programmatic pages: `/fd/best-rates-3-years`, `/fd/sbi-vs-hdfc`, etc.
   - Structured data (JSON-LD) for rate information
   - Sitemap generation for all bank/product pages

### Phase 4: Compliance, Alerts & Monetization (Weeks 14-18)

**Goal**: Production-ready with disclaimers, user features, revenue hooks.

1. **Compliance**: Disclaimers on every rate page, "verify with bank" CTAs, data freshness prominently displayed, ToS and privacy policy
2. **User accounts & alerts**: Email alerts for rate changes on watched banks/products
3. **Monetization hooks**: Affiliate links to bank FD application pages, ad placements, premium API for fintechs
4. **Post-tax calculators**: Compare FD returns vs mutual funds after tax (key differentiator)

### Phase 5+: Growth (Ongoing)

- Account Aggregator integration (show user's existing deposits)
- Bank reviews/ratings
- NRI-specific features (NRE/NRO comparison)
- Mobile app (React Native or PWA)
- API marketplace for fintech consumers
- PostgreSQL migration when D1 limits are hit

---

## Scraper ↔ Database Integration Pattern

The scraper is a TypeScript package in the same monorepo, writing directly via Drizzle ORM:

```
[node-cron Scheduler] → [Crawlee Crawlers] → [Validators] → [Drizzle ORM] → [D1/SQLite]
                              ↑                     ↑
                        @bird/shared            @bird/shared
                        (Zod schemas)          (validation rules)
```

- Scraper imports Zod schemas and Drizzle schema directly — no serialization boundary
- Runs as a standalone Node.js process (not on Cloudflare Workers — needs long execution times + Playwright)
- For local dev: writes to local SQLite via better-sqlite3 (same as API)
- For production: connects to D1 via REST API or writes to PostgreSQL directly (when migrated)
- Admin API endpoints still exist for the web admin UI to query scrape status, but the scraper doesn't need them

---

## Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| D1 size limits with ~1900 banks | Design for portability; Drizzle schema works with both SQLite and PostgreSQL; migrate when triggers hit |
| Most of ~1900 banks have no usable website | Classification in Phase 1; focus energy on the ~150-300 that have rate pages; mark rest as "no_website" |
| Bank websites change frequently | Config-driven scrapers; only JSON config updates needed, not code changes |
| PDF parsing in JS less mature than Python | 3-tier fallback: pdf.js → tabula-js → Tesseract.js OCR; human review for failures; can add thin Python microservice for edge cases later |
| Cloudflare Workers execution limits | Scraper runs as standalone Node.js process (not on Workers); only the web API runs on Workers |
| Rate data accuracy concerns | 7-layer validation + cross-referencing + human review queue + freshness indicators |

---

## Verification & Testing Strategy

- **Shared**: Unit tests for Zod schemas, tenure normalization, rate calculations (Vitest)
- **API**: Integration tests against local D1 with seeded data (Vitest + Hono test client)
- **Web**: Component tests for rate tables, calculators (Vitest + Testing Library); E2E for critical flows (Playwright)
- **Scraper**: Vitest for parsers, validators, tenure normalization; integration tests against sample HTML/PDF fixtures
- **CI/CD**: GitHub Actions — lint → typecheck → test → build → deploy (matching QuestConquest pattern)

---

## Immediate Next Step

**Phase 0**: Bootstrap the monorepo, create Drizzle schema, seed the ~1900 banks from the RBI Excel file, and stand up the basic Hono API + React frontend scaffolds.

# Phase 0: Project Bootstrap — Implementation Doc

## Completed: 2026-03-27

---

## What Was Built

### Root Monorepo
- npm workspaces with 4 packages: `@bird/shared`, `@bird/api`, `@bird/web`, `@bird/scraper`
- TypeScript 5.7 with strict mode, ES2022 target, bundler module resolution
- ESLint 9 flat config with separate rules for Node (shared/api/scraper), Browser+React (web), and test files
- Vitest 4 workspace config spanning all packages
- Concurrently for parallel API + Web dev servers

### `packages/shared` (@bird/shared)
- **Zod schemas**: bank, product, rate slab, rate change log, scrape run, scrape flag, special scheme
- **Enums**: 14 bank categories, 13 product types, 12 product variants, 5 compounding frequencies, scraper/discovery statuses, flag types/severities/resolutions
- **Constants**:
  - Bank category metadata (labels, descriptions, deposit insurance defaults)
  - Product type metadata (tenure ranges, rate ranges for validation, offered-by info)
  - Tenure text normalization maps + `parseTenureText()` parser
  - City-to-state mapping (~300 Indian cities) for RBI data cleanup
- **Types**: Inferred TypeScript types from all Zod schemas
- **Tests**: 14 tests covering schema validation, query param coercion, rate bounds, tenure parsing
- Built as ESM with declarations via `tsc -b`

### `packages/api` (@bird/api)
- **Hono v4** app on Cloudflare Workers with D1 binding
- **Drizzle ORM** schema with 7 tables:
  - `banks` (1958 rows) — with indexes on code, category, scraper_status
  - `products`, `rate_slabs`, `rate_change_log`, `scrape_runs`, `scrape_flags`, `special_schemes`
  - All with proper foreign keys and indexes
- **Middleware**: CORS (dynamic origins), request-id, logger
- **Routes**:
  - `GET /api/health` — status check
  - `GET /api/banks` — paginated, filterable by category/state/scraper_status/discovery_status/search
  - `GET /api/banks/:code` — single bank by slug
- **Migration**: Auto-generated via drizzle-kit (0000_ancient_virginia_dare.sql)
- **Seed pipeline**:
  - `generate-seed.mjs` — parses RBI CSV, handles unquoted commas via category-scanning fallback, normalizes city names to states
  - `seed.sql` — 1958 INSERT statements
  - `npm run db:setup` runs migration + seed

### `packages/web` (@bird/web)
- **React 19** + **Vite 7** + **SWC** compiler
- **TanStack Router** with file-based routing and auto-generated route tree
- **Tailwind CSS 3** with shadcn/ui CSS variable theme system
- **Routes**:
  - `/` — Homepage with project description
  - `/banks` — Bank listing table with category/status badges, fetches from API
  - `/banks/$bankCode` — Bank detail stub (Phase 3)
- **API client**: Typed fetch wrapper using `@bird/shared` types
- **Utilities**: `cn()` helper (clsx + tailwind-merge)
- Dev server proxies `/api` to Wrangler on port 8787

### `packages/scraper` (@bird/scraper)
- Scaffold only — directory structure for crawlers, parsers, configs, validators
- Placeholder entry point, ready for Phase 2 implementation

### Rate Discovery Agent
- Extracted from `rate-discovery-agent.tar.gz` into `rate-discovery-agent/`
- Claude Code agent for finding bank websites, rate pages, and generating scraper configs
- Supports single-bank and batch discovery from RBI bank list

---

## Bank Data Seeding Details

- **Source**: `docs/Indian_Banks_Comprehensive_List_RBI.csv` (exported from RBI Excel)
- **Total banks seeded**: 1958
- **CSV parsing challenges**: ~750 bank names contained unquoted commas (especially NSUCB/DCCB banks like "Foo Bank Ltd., CityName"). Solved by scanning all fields to find the known category value and reassembling the bank name from preceding fields.
- **State normalization**: RBI source data had city names in the state column for many banks. Added a ~300 city-to-state mapping that corrected 110 entries. 53 banks have NULL state (bank name fragments like "Ltd." that leaked into the state column — genuinely unmappable from CSV alone).
- **Category distribution**:
  | Category | Count |
  |----------|-------|
  | NSUCB | 1392 |
  | DCCB | 352 |
  | SUCB | 52 |
  | FB | 44 |
  | RRB | 28 |
  | SSCB | 24 |
  | PVB | 21 |
  | PSB | 12 |
  | SFB | 11 |
  | NSSCB | 10 |
  | PB | 6 |
  | FI | 4 |
  | LAB | 2 |

---

## Verification Results

- `npm run build` — all packages build clean (shared → api → web → scraper)
- `npm run typecheck` — zero TypeScript errors across all packages
- `npx vitest run` — 14 tests passing
- `npm run dev` — API (Wrangler) + Web (Vite) start concurrently
- API endpoints verified: health, bank list (paginated/filtered), bank detail by slug
- Web frontend renders, fetches bank data from API via proxy

---

## Git History

```
2529a59 Add rate-discovery-agent for bank website and rate page discovery
c5f097b Phase 0: Bootstrap BIRD monorepo with all packages and 1958 banks seeded
```

---

## Deviations from Plan

- **deposit_insurance default changed to `false`**: Plan originally had `true` — changed because most of the ~1900 banks (especially co-operatives) may not have DICGC coverage. Safer to default false and set true per bank.
- **City-to-state mapping added**: Not in original plan. The RBI source data had widespread data quality issues with city names in the state column. Added ~300 city mappings to the seed generator.
- **Wrangler port**: Wrangler auto-selected port 8788 when 8787 was busy. Vite proxy config targets 8787 (Wrangler's default).

---

## Known Issues / Debt for Later Phases

1. **53 banks with NULL state** — bank name fragments in state column from poorly-formatted CSV rows. Phase 1 discovery will fill these in.
2. **No lint run verified** — ESLint not run as part of verification (deferred to CI setup).
3. **shadcn/ui components not initialized** — `npx shadcn-ui@latest init` not run; Tailwind theme variables are set up but no shadcn components installed yet. Will add as needed in Phase 3.
4. **Scraper package has no dependencies** — Crawlee, Cheerio, Playwright not yet installed. Will be added in Phase 2.

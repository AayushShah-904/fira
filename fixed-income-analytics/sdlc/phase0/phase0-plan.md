# Phase 0: Project Bootstrap — Detailed Plan

## Goal

Stand up the monorepo with all four npm workspace packages (shared, api, web, scraper), define the Drizzle database schema, seed ~1900 banks from the RBI Excel file, and verify the full local dev loop works end-to-end.

---

## Step 1: Root Monorepo Scaffold

Create the root project configuration mirroring QuestConquest patterns.

### 1.1 `package.json`
- npm workspaces: `packages/shared`, `packages/api`, `packages/web`, `packages/scraper`
- Scripts: `dev` (concurrently api + web), `build` (shared → api → web), `lint`, `typecheck`, `test`, `test:coverage`
- Node >=20
- Dev dependencies: typescript ^5.7.3, eslint ^9.21.0, @eslint/js ^9.21.0, typescript-eslint ^8.24.0, vitest ^4.0.18, @vitest/coverage-v8 ^4.0.18, concurrently ^9.1.2, globals ^15.15.0
- Root dependency: zod 3.24.4 (with overrides to pin)

### 1.2 `tsconfig.base.json`
- target: ES2022, module: ESNext, moduleResolution: bundler
- strict: true, verbatimModuleSyntax: true, isolatedModules: true
- resolveJsonModule: true, esModuleInterop: true, skipLibCheck: true

### 1.3 `eslint.config.mjs`
- ESLint 9 flat config
- Ignore: dist, build, node_modules, .wrangler, *.d.ts, routeTree.gen.ts
- Shared/API/Scraper: Node globals
- Web: Browser globals + React + React Hooks rules
- Test files: relaxed any rules

### 1.4 `vitest.config.ts`
- Workspace projects: shared, api, web, scraper

### 1.5 `.gitignore`
- node_modules, dist, build, .wrangler, *.local, .env

---

## Step 2: `packages/shared` (@bird/shared)

Zod schemas, TypeScript types, and constants shared across all packages.

### 2.1 Package setup
- package.json: `@bird/shared`, ESM, composite build with tsc
- tsconfig.json: extends base, composite: true, outDir: dist, declaration: true

### 2.2 Schemas (`src/schemas/`)

**bank.ts** — Bank entity
```
bankCategory enum: PSB, PVB, SFB, PB, FB, RRB, SUCB, NSUCB, SSCB, NSSCB, DCCB, LAB, FI, NBFC
scraperStatus enum: active, no_website, no_rates, failed, manual_only, pending
discoveryStatus enum: discovered, not_found, partial, pending

bankSchema: id, code, name, category, state, website_url, rate_page_url,
  logo_url, rbi_licence_no, ifsc_prefix, deposit_insurance, assets_under_mgmt,
  trust_score, scraper_status, discovery_status, created_at, updated_at
```

**product.ts** — Product entity
```
productType enum: FD, RD, SA, PPF, SCSS, SSY, NSC, KVP, MIS, SGB, RBI_BOND, POTD, NBFC_FD
productVariant enum: regular, senior_citizen, super_senior, nre, nro, tax_saving, flexi, green, special_tenure
compoundingFrequency enum: monthly, quarterly, half_yearly, yearly

productSchema: id, bank_id, product_type, variant, name, description,
  eligibility_notes, sec_80c_eligible, premature_withdrawal_allowed,
  min_deposit, max_deposit, created_at, updated_at
```

**rate.ts** — Rate slab and change log
```
rateSlabSchema: id, product_id, bank_id, tenure_min_days, tenure_max_days,
  tenure_text, rate_general_pct, rate_senior_pct, rate_super_senior_pct,
  compounding_frequency, effective_from, effective_to, min_deposit_for_slab,
  max_deposit_for_slab, source_url, scraped_at, created_at

rateChangeLogSchema: id, rate_slab_id, bank_id, product_id,
  field_changed, old_value, new_value, detected_at, source_url
```

**scrape.ts** — Scrape run and flags
```
scrapeStatus enum: success, partial, failed
flagType enum: range, delta, monotonicity, completeness, cross_ref, staleness, format
flagSeverity enum: info, warning, critical
flagResolution enum: approved, rejected, held

scrapeRunSchema: id, bank_id, started_at, completed_at, status,
  error_message, records_found, records_changed, records_flagged, scraper_version

scrapeFlagSchema: id, scrape_run_id, bank_id, rate_slab_id, flag_type,
  severity, details, resolution, resolved_by, resolved_at
```

**special-scheme.ts** — Promotional/special FDs
```
specialSchemeSchema: id, bank_id, name, rate_pct, tenure_days,
  launch_date, expiry_date, min_deposit, source_url, notes
```

### 2.3 Constants (`src/constants/`)

**bank-categories.ts** — Labels, descriptions, deposit insurance rules per category
**product-types.ts** — Product type metadata (typical tenure ranges, rate ranges for validation)
**tenure-maps.ts** — Standard tenure text → min/max days normalization mappings

### 2.4 Types (`src/types/`)
- Inferred Zod types (z.infer<typeof bankSchema> etc.)
- API request/response contracts for each route

### 2.5 Vitest config
- vitest.config.ts: project name "shared", include src/**/*.test.ts

---

## Step 3: `packages/api` (@bird/api)

Hono API on Cloudflare Workers with Drizzle ORM and D1.

### 3.1 Package setup
- package.json: `@bird/api`, depends on `@bird/shared`
- Dependencies: hono ^4.7.0, drizzle-orm ^0.39.0, @hono/zod-validator ^0.7.6
- Dev deps: wrangler ^4.0.0, drizzle-kit ^0.30.0, @cloudflare/workers-types ^4.20250408.0, better-sqlite3 ^12.6.2, @types/better-sqlite3 ^7.6.13
- Scripts: dev (wrangler dev), build, deploy, db:generate, db:migrate, db:seed, db:setup
- tsconfig.json: extends base, composite, noEmit, types: @cloudflare/workers-types, references shared

### 3.2 Wrangler config (`wrangler.jsonc`)
- D1 binding: "DB" → "bird-db"
- Env vars: ENVIRONMENT, CORS_ORIGINS, API_KEY (for scraper auth)
- Compatibility flags: nodejs_compat
- Migrations dir: src/db/migrations

### 3.3 Drizzle schema (`src/db/schema.ts`)
Translate all Zod schemas to Drizzle sqliteTable definitions:
- banks, products, rate_slabs, rate_change_log, scrape_runs, scrape_flags, special_schemes
- Indexes: banks(code), banks(category), products(bank_id), rate_slabs(bank_id, effective_to), rate_slabs(product_id)
- ISO 8601 timestamp defaults
- Text columns for enums (D1 portability)

### 3.4 Seed script (`src/db/seed/`)
- Parse `docs/Indian_Banks_Comprehensive_List_RBI.xlsx` using a lightweight xlsx library (e.g., xlsx or exceljs)
- Map each row to a bank record: name, category, state
- Generate slug codes from bank names
- Set all banks to scraper_status: 'pending', discovery_status: 'pending'
- Output: SQL seed file or TypeScript seed script runnable via wrangler d1 execute

### 3.5 Initial Drizzle migration
- Run `drizzle-kit generate` to produce the 0001 migration from schema.ts

### 3.6 App skeleton (`src/app.ts`)
- Hono app with Env type (DB: D1Database, ENVIRONMENT, CORS_ORIGINS, API_KEY)
- Middleware: CORS, request-id, request-logger
- Routes (stubs returning empty arrays/objects for now):
  - `GET /api/health` — status check
  - `GET /api/banks` — list banks (paginated, filterable)
  - `GET /api/banks/:code` — bank detail
- Index entry point that exports the app for Cloudflare Workers

### 3.7 Vitest config
- vitest.config.ts: project name "api", include src/**/*.test.ts

---

## Step 4: `packages/web` (@bird/web)

React 19 + Vite + TanStack Router + Tailwind + shadcn/ui.

### 4.1 Package setup
- package.json: `@bird/web`, depends on `@bird/shared`
- Dependencies: react ^19.0.0, react-dom ^19.0.0, @tanstack/react-router ^1.114.0, clsx ^2.1.1, tailwind-merge ^3.0.1
- Dev deps: vite ^7.0.0, @vitejs/plugin-react-swc ^3.8.0, @tanstack/router-cli ^1.114.0, @tanstack/router-vite-plugin ^1.114.0, tailwindcss ^3.4.17, autoprefixer ^10.4.20, postcss ^8.5.1, @types/react ^19.0.8, @types/react-dom ^19.0.3, @testing-library/react ^16.3.2, @testing-library/jest-dom ^6.9.1, jsdom ^28.1.0
- Scripts: dev (vite), build (tsc -b && vite build), preview, routes (tsr generate)

### 4.2 Config files
- tsconfig.json with app/node split (same pattern as QC)
- vite.config.ts: React SWC plugin, TanStack Router plugin, @ alias, proxy /api → localhost:8787
- tailwind.config.js: content paths, CSS variable-based theme colors
- postcss.config.js: tailwindcss + autoprefixer

### 4.3 Initial routes
- `src/routes/__root.tsx` — Root layout with nav shell
- `src/routes/index.tsx` — Homepage placeholder ("BIRD — Bank Rate Analytics")
- `src/routes/banks/index.tsx` — Banks listing page (stub, fetches GET /api/banks)
- `src/routes/banks/$bankCode.tsx` — Bank detail page (stub)

### 4.4 Entry point
- `src/main.tsx` — StrictMode + RouterProvider (same pattern as QC)
- `src/index.css` — Tailwind directives + CSS variables
- `index.html` — Root HTML with title "BIRD — Bank Rate Analytics"

### 4.5 API client (`src/lib/api.ts`)
- Typed fetch wrapper for /api/* endpoints
- Uses Zod schemas from @bird/shared for response validation

### 4.6 shadcn/ui setup
- Initialize with `npx shadcn-ui@latest init`
- Add initial components: button, card, table, badge, input, select

### 4.7 Vitest config
- vitest.config.ts: project name "web", environment jsdom, @ alias

---

## Step 5: `packages/scraper` (@bird/scraper)

TypeScript scraping package — scaffold only in Phase 0, full implementation in Phase 2.

### 5.1 Package setup
- package.json: `@bird/scraper`, depends on `@bird/shared`
- Dependencies (initial): crawlee ^3.0.0, cheerio ^1.0.0, playwright ^1.50.0
- Dev deps: @types/better-sqlite3 (for local DB access)
- Scripts: scrape (single bank), scrape:batch (all active banks)
- tsconfig.json: extends base, composite, references shared

### 5.2 Placeholder structure
- `src/index.ts` — Entry point (placeholder)
- `src/configs/` — Directory for per-bank JSON configs (empty, populated in Phase 1)
- `src/crawlers/` — Directory for Crawlee crawlers (placeholder)
- `src/parsers/` — Directory for HTML/PDF parsers (placeholder)
- `src/validators/` — Directory for validation engine (placeholder)

### 5.3 Vitest config
- vitest.config.ts: project name "scraper", include src/**/*.test.ts

---

## Step 6: Bank Data Seeding

### 6.1 Parse the RBI Excel file
- Read `docs/Indian_Banks_Comprehensive_List_RBI.xlsx`
- Extract: bank name, category, state/country
- Map RBI categories to our bankCategory enum
- Generate URL-safe slug codes (e.g., "State Bank of India" → "state-bank-of-india")
- Handle duplicates and edge cases (branches vs banks, merged entities)

### 6.2 Seed the database
- Generate SQL insert statements or use Drizzle's insert API
- Verify: ~1900 rows in banks table
- All rows: scraper_status = 'pending', discovery_status = 'pending'

---

## Step 7: End-to-End Verification

### 7.1 Local dev loop
1. `npm install` — all workspace dependencies resolve
2. `npm run build` — shared → api → web builds succeed
3. `npm run lint` — zero errors
4. `npm run typecheck` — zero errors
5. `npm run test` — all placeholder tests pass

### 7.2 API verification
1. `cd packages/api && npm run db:setup` — migration + seed runs
2. `npm run dev` — Wrangler starts on port 8787
3. `GET http://localhost:8787/api/health` → 200
4. `GET http://localhost:8787/api/banks` → returns paginated bank list
5. `GET http://localhost:8787/api/banks?category=PSB` → filtered results
6. `GET http://localhost:8787/api/banks/state-bank-of-india` → single bank detail

### 7.3 Web verification
1. `npm run dev` from root — both api + web start
2. `http://localhost:5173/` → homepage renders
3. `http://localhost:5173/banks` → bank listing fetches from API and renders
4. Tailwind classes apply correctly, shadcn/ui components render

### 7.4 Scraper verification
1. `packages/scraper` builds without errors
2. Placeholder test passes

---

## Deliverables Checklist

- [ ] Root monorepo config (package.json, tsconfig, eslint, vitest, .gitignore)
- [ ] `packages/shared` with all Zod schemas, constants, and types
- [ ] `packages/api` with Drizzle schema, migration, seed, Hono app skeleton
- [ ] `packages/web` with Vite + React + TanStack Router + Tailwind + shadcn/ui
- [ ] `packages/scraper` scaffold (placeholder, ready for Phase 2)
- [ ] ~1900 banks seeded from RBI Excel into local D1
- [ ] Local dev loop verified (build, lint, typecheck, test all pass)
- [ ] API serves bank data at /api/banks
- [ ] Web renders bank listing from API
- [ ] Git repository initialized with initial commit

---

## Files Created/Modified (estimated ~40-50 files)

```
BIRD/
├── package.json
├── tsconfig.base.json
├── eslint.config.mjs
├── vitest.config.ts
├── .gitignore
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── schemas/bank.ts
│   │       ├── schemas/product.ts
│   │       ├── schemas/rate.ts
│   │       ├── schemas/scrape.ts
│   │       ├── schemas/special-scheme.ts
│   │       ├── schemas/index.ts
│   │       ├── constants/bank-categories.ts
│   │       ├── constants/product-types.ts
│   │       ├── constants/tenure-maps.ts
│   │       ├── constants/index.ts
│   │       ├── types/index.ts
│   │       └── __tests__/schemas.test.ts
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── wrangler.jsonc
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── app.ts
│   │       ├── routes/health.ts
│   │       ├── routes/banks.ts
│   │       ├── middleware/cors.ts
│   │       ├── middleware/request-id.ts
│   │       ├── middleware/request-logger.ts
│   │       ├── db/schema.ts
│   │       ├── db/migrations/0001_initial.sql
│   │       ├── db/seed/seed-banks.ts
│   │       ├── db/seed/seed.sql
│   │       └── lib/helpers.ts
│   ├── web/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.app.json
│   │   ├── tsconfig.node.json
│   │   ├── vitest.config.ts
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.js
│   │   ├── postcss.config.js
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── index.css
│   │       ├── routeTree.gen.ts
│   │       ├── routes/__root.tsx
│   │       ├── routes/index.tsx
│   │       ├── routes/banks/index.tsx
│   │       ├── routes/banks/$bankCode.tsx
│   │       ├── lib/api.ts
│   │       └── lib/utils.ts
│   └── scraper/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── index.ts
│           ├── configs/.gitkeep
│           ├── crawlers/.gitkeep
│           ├── parsers/.gitkeep
│           └── validators/.gitkeep
└── sdlc/
    └── phase0/
        └── phase0-plan.md (this file)
```

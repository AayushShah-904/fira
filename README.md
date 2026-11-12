# FDRates — India Fixed Deposit Intelligence Platform
### Beta v0.1.0 · RIA Edition

A full-stack web application for Registered Investment Advisors (RIAs) to research, compare, and analyse fixed deposit rates across all Indian bank categories.

---

## Architecture

```
fdrates/
├── api/          ← Express REST API (Node.js + SQLite)
│   ├── src/
│   │   ├── db/           ← Schema, connection, seed data
│   │   ├── middleware/   ← JWT + API key auth
│   │   └── routes/       ← auth, banks, rates, watchlists
│   └── .env
├── ui/           ← React SPA (Vite + TanStack Query + Tailwind)
│   └── src/
│       ├── components/   ← AppShell, UI primitives
│       ├── hooks/        ← useAuth
│       ├── lib/          ← API client, utils/calculations
│       └── pages/        ← All 10 pages
└── package.json  ← Workspace root
```

**Three fully separate layers:**
- **DB layer** — SQLite via `better-sqlite3`. WAL mode. Full schema with 10 tables. Seed script with 60+ banks and 80+ FD rates.
- **API layer** — Express REST API on port 4000. JWT + API key auth. Rate limiting. Versioned routes (`/api/v1/`).
- **UI layer** — React 18 + Vite SPA on port 5173. TanStack Query for data fetching. Tailwind CSS design system.

---

## Quick Start (100% Local - Zero Cloud Required)

### Prerequisites
- Node.js 18+ and npm 9+

### 🚀 1-Click Launch (Windows)
Double-click **`run-local.bat`** (or run `.\run-local.ps1` in PowerShell).  
It automatically verifies the database, starts both the API and UI servers, and opens your browser at **http://localhost:5173**.

---

### Manual Start:
#### 1. Install dependencies (if not already installed)
```bash
npm install
```

#### 2. Seed database (already pre-seeded with 570+ banks & 8,400+ rates)
```bash
cd api && npm run seed && cd ..
```

#### 3. Start development servers
```bash
npm run dev
```
- UI:  **http://localhost:5173**
- API: **http://localhost:4000**

#### 4. Sign in
- **Email**: `demo@fdrates.in` (or `demo@fira.in`)
- **Password**: `demo123!`

---

## API Reference

All endpoints require `Authorization: Bearer <token>` (JWT from login).

### Auth
| Method | Endpoint                | Description          |
|--------|-------------------------|----------------------|
| POST   | `/api/v1/auth/login`    | Login → JWT token    |
| POST   | `/api/v1/auth/register` | Register new RIA     |
| GET    | `/api/v1/auth/me`       | Current user profile |

### Banks
| Method | Endpoint                     | Description                        |
|--------|------------------------------|------------------------------------|
| GET    | `/api/v1/banks`              | List banks (filter: category, state, search, rated) |
| GET    | `/api/v1/banks/categories`   | All 8 bank categories with counts  |
| GET    | `/api/v1/banks/:id`          | Bank detail + all current rates    |
| GET    | `/api/v1/banks/:id/rates`    | Rates for a bank (filter: product) |

### Rates
| Method | Endpoint                     | Description                                    |
|--------|------------------------------|------------------------------------------------|
| GET    | `/api/v1/rates/best`         | Best rates ranked (filter: product, category, senior) |
| GET    | `/api/v1/rates/compare`      | Post-tax comparison (params: product, tax_slab, inflation, principal, years) |
| POST   | `/api/v1/rates/calculate`    | Single FD calculation (gross, tax, net, YTM, real yield) |
| GET    | `/api/v1/rates/products`     | All product types with tax-free flags         |

### Watchlists & Clients
| Method | Endpoint                              | Description              |
|--------|---------------------------------------|--------------------------|
| GET    | `/api/v1/watchlists`                  | List user's watchlists   |
| POST   | `/api/v1/watchlists`                  | Create watchlist         |
| GET    | `/api/v1/watchlists/:id/banks`        | Banks in watchlist       |
| POST   | `/api/v1/watchlists/:id/banks`        | Add bank to watchlist    |
| DELETE | `/api/v1/watchlists/:id/banks/:bankId`| Remove from watchlist    |
| GET    | `/api/v1/watchlists/clients/list`     | List client profiles     |
| POST   | `/api/v1/watchlists/clients`          | Add client profile       |

---

## Pages

| Route            | Page                   | Description                                  |
|------------------|------------------------|----------------------------------------------|
| `/dashboard`     | Dashboard              | Stats, top 15 rates table, category counts   |
| `/rates`         | Live Rates             | Full filterable rates table (all products)   |
| `/banks`         | Bank Directory         | Searchable 1,800+ bank directory             |
| `/banks/:id`     | Bank Detail            | Full bank profile, all rates, credit info    |
| `/compare`       | Compare & Analyse      | Side-by-side post-tax comparison + bar chart |
| `/calculator`    | Post-Tax Calculator    | Interactive calculator + 17-bank comparison  |
| `/watchlists`    | Watchlists             | Track banks per mandate / client             |
| `/clients`       | Client Profiles        | Anonymised tax/NRI parameters per client     |
| `/settings`      | Settings               | Profile, API keys, beta status               |
| `/alerts`        | Rate Alerts            | Coming soon                                  |

---

## Key Data (Apr 2026)

### Best domestic FD rates
| Rate  | Bank                      | Category |
|-------|---------------------------|----------|
| 8.25% | Kerala Primary Co-op      | NS-UCB   |
| 8.00% | Varachha Co-op Bank       | NS-UCB   |
| 7.90% | Suryoday SFB              | SFB      |
| 7.80% | Kangra DCCB               | DCCB     |
| 7.25% | Kalupur Bank              | Sch-UCB  |
| 7.25% | Yes / DCB Bank            | PVB      |
| 6.75% | Central Bank of India     | PSB      |
| 6.45% | SBI                       | PSB      |

### NRI products
| Rate     | Product       | Bank            |
|----------|---------------|-----------------|
| 7.50% INR| NRE FD        | Yes Bank        |
| 5.15% USD| FCNR(B)       | Yes / Cosmos UCB|
| ~5.5% USD| Gift City IBU | ICICI IBU       |
| 4.15% USD| Gift City IBU | Axis IBU ✓      |

---

## Production Deployment

```bash
# Build UI
cd ui && npm run build    # outputs to ui/dist/

# Set production env in api/.env
NODE_ENV=production
JWT_SECRET=<32-char-random-string>
CORS_ORIGIN=https://your-domain.com

# Start API (serves UI dist as static files in production mode)
cd api && npm start
```

For a production deploy, point your reverse proxy (nginx/Caddy) to:
- API: port 4000
- UI: serve `ui/dist/` as static files, proxy `/api/*` to port 4000

---

## Roadmap (beta → v1.0)

- [ ] Rate alert emails (threshold triggers)
- [ ] Webhook integration for portfolio management tools
- [ ] Historical rate charts (6m/1yr/3yr trends)
- [ ] NAFSCOB award rankings for DCCBs
- [ ] cooperatives.gov.in ranking scores (when accessible)
- [ ] PDF export — client-ready FD comparison reports
- [ ] Multi-user firm accounts with role-based access
- [ ] SEBI RIA compliance audit log export
- [ ] Real-time rate update pipeline (scraper + admin UI)

---

## Data Sources

| Category  | Source                                | Verified |
|-----------|---------------------------------------|----------|
| PSBs/PVBs | Bank websites, RBI database           | ✓        |
| SFBs      | Bank websites                         | ✓        |
| UCBs      | Bank websites, RBI 2nd Schedule list  | ✓        |
| DCCBs     | RBI districtcoop.pdf, kccb.in         | Partial  |
| IBUs      | IFSCA, Axis IBU rate chart (Feb-26)   | ✓        |
| Ratings   | CRISIL, ICRA public rationale reports | ✓        |

---

*FDRates is a research and intelligence tool for professional use. All rates are indicative — verify directly with banks before investing. Not SEBI registered as an investment advisor.*

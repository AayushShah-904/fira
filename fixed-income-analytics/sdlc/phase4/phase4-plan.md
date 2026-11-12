# Phase 4: Auth, Access Control & Polish — Detailed Plan

## Scope Change

The original Phase 4 ("Compliance, Alerts & Monetization") has been restructured. Compliance, alerts, and monetization are deferred to Phase 5+. Phase 4 now focuses on:

1. **User accounts & authentication** — login required for all pages except homepage
2. **Role-based access control** — admin functionality restricted to admin users
3. **Mobile responsiveness** — polish for small screens across all pages
4. **UI polish & known issues** — fix rough edges from Phase 3

---

## Step 1: Authentication

### Provider Choice

Use **Cloudflare Access** or a lightweight JWT-based auth since the API runs on Cloudflare Workers. For the initial implementation, use a simple email + password flow with sessions stored in D1.

Alternatively, use an OAuth provider (Google) for zero-password UX. The choice depends on deployment context — for now, plan for a provider-agnostic auth layer.

### Schema Additions

```sql
users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT,          -- bcrypt hash, null if OAuth-only
  role TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'admin'
  created_at TEXT,
  updated_at TEXT
)

sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,  -- crypto.randomUUID()
  expires_at TEXT NOT NULL,
  created_at TEXT
)
```

### API Changes

**New auth routes** (`packages/api/src/routes/auth.ts`):
- `POST /api/auth/register` — email, password, name → creates user + session token
- `POST /api/auth/login` — email, password → returns session token
- `POST /api/auth/logout` — invalidates session
- `GET /api/auth/me` — returns current user from session token

**Auth middleware** (`packages/api/src/middleware/auth.ts`):
- Reads `Authorization: Bearer <token>` header (or cookie)
- Looks up session in DB, checks expiry
- Attaches `user` to Hono context (`c.set("user", user)`)
- Two middleware variants:
  - `requireAuth` — returns 401 if not authenticated
  - `requireAdmin` — returns 403 if not admin role

**Route protection**:

| Route Pattern | Access |
|---------------|--------|
| `GET /api/health` | Public |
| `GET /api/rates/best` (homepage data) | Public |
| `POST /api/auth/*` | Public |
| `GET /api/banks/*` | Authenticated |
| `GET /api/rates/*` (except best) | Authenticated |
| `GET /api/rate-changes` | Authenticated |
| `GET /api/admin/*` | Admin only |
| `PATCH /api/admin/*` | Admin only |

### Frontend Changes

**Auth context** (`packages/web/src/context/auth.tsx`):
- React context providing `{ user, login, logout, loading }`
- On app load: call `GET /api/auth/me` to check existing session
- Token stored in `localStorage` (or `httpOnly` cookie)

**Login page** (`packages/web/src/routes/login.tsx`):
- Email + password form
- Register link
- Error display

**Register page** (`packages/web/src/routes/register.tsx`):
- Email + password + name form
- Redirects to login on success

**Route guards**:
- Root layout checks auth context
- If not authenticated and route is not `/` or `/login` or `/register` → redirect to `/login`
- Homepage (`/`) always accessible — shows best rates with "Login to see all rates" CTA

**Admin guard**:
- Admin pages (`/admin/*`) check `user.role === "admin"` in addition to auth
- Non-admin users see "Access denied" message

---

## Step 2: Role-Based Access Control

### Roles

Two roles for now:

| Role | Can Access |
|------|-----------|
| `user` | All consumer pages (FD rates, bank profiles, compare, calculator, rate changes) |
| `admin` | Everything above + admin pages (pipeline, flags, discovery, scrape runs) |

### Admin Seeding

First admin user created via CLI seed script:

```bash
npm run -w @bird/scraper seed-admin -- --email admin@bird.app --password <pw>
```

Or via D1 migration with a known admin record.

### Nav Adaptation

- Admin nav links (`Pipeline`, `Flags`, `Discovery`) only shown when `user.role === "admin"`
- Regular users see: `Home | FD Rates | Compare | Banks | Calculator | Changes`
- Admins see: `Home | FD Rates | Compare | Banks | Calculator | Changes | Admin ▸`

---

## Step 3: Mobile Responsiveness

### Audit of Current Pages

| Page | Issue | Fix |
|------|-------|-----|
| Homepage | Hero text too large on mobile | Reduce `text-3xl` to `text-2xl` on small screens |
| FD Rates | Filter bar wraps awkwardly | Stack filters vertically on mobile, tenure presets scroll horizontally |
| FD Rates | Table too wide | Make table horizontally scrollable (already has `overflow-x-auto`) |
| Bank Profile | Trust panel 4 cards side-by-side | Stack to 2×2 grid on mobile (already has `sm:grid-cols-2 lg:grid-cols-4`) |
| Compare | Search + chips + table all horizontal | Stack search above chips; table scrolls horizontally |
| Calculator | 2-column grid | Already has `sm:grid-cols-2`, should work |
| Rate Changes | Cards OK on mobile | Minor padding adjustments |
| Banks List | Filter bar horizontal | Stack vertically on mobile |
| Nav | Links overflow on small screens | Hamburger menu or horizontal scroll |

### Key Changes

**Navigation**: Replace horizontal link list with a collapsible mobile menu:
- Desktop (≥ 768px): horizontal links as-is
- Mobile (< 768px): hamburger icon → slide-down menu

**Filter bars** (FD Rates, Banks):
- Wrap tenure presets in `overflow-x-auto` container with horizontal scroll
- Stack dropdowns vertically on mobile
- Full-width search input on mobile

**Tables**:
- Already have `overflow-x-auto` — verify horizontal scrolling works
- Add `min-width` to prevent column crushing
- Consider card layout for key tables on very small screens (< 400px)

**Compare page**:
- Bank selector chips: wrap to multiple lines
- Comparison table: horizontal scroll with sticky first column (tenure)

---

## Step 4: UI Polish & Known Issue Fixes

From the Phase 3 known issues list:

1. **Compare tenure alignment** — fuzzy match tenure ranges within ±5 days to align comparison rows
2. **Product type filter on FD page** — add `product` query param support so same page works for RD/Savings
3. **FD calculator auto-fill** — when navigating from bank profile, pre-fill rate in calculator via URL search params
4. **Loading skeletons** — replace "Loading..." text with shimmer placeholders for tables and cards
5. **Empty states** — better messaging when no data (e.g., bank with no rates, empty search results)
6. **Dual config naming** — deduplicate rate slabs that exist from both `sbi_rates.json` and `state-bank-of-india_rates.json` imports

---

## Implementation Order

| Step | What | Complexity |
|------|------|-----------|
| 1a | `users` + `sessions` tables, migration | Low |
| 1b | Auth API routes (register, login, logout, me) | Medium |
| 1c | Auth middleware (requireAuth, requireAdmin) | Medium |
| 1d | Protect existing API routes | Low |
| 2a | Auth context + login/register pages | Medium |
| 2b | Route guards (redirect to login) | Low |
| 2c | Admin nav visibility | Low |
| 3a | Mobile nav (hamburger menu) | Medium |
| 3b | Mobile filter bars + tables | Low |
| 3c | Mobile compare page | Low |
| 4a | Tenure alignment in compare | Medium |
| 4b | Loading skeletons | Low |
| 4c | Calculator auto-fill from URL params | Low |

Steps 1a-1d (backend auth) can be done first, then 2a-2c (frontend auth), then 3-4 (polish) in parallel.

---

## Revised Phase Roadmap

With this restructuring, the remaining phases become:

| Phase | Title | Focus |
|-------|-------|-------|
| **Phase 4** (this) | Auth, Access Control & Polish | Login, RBAC, mobile, UI fixes |
| **Phase 5** | Compliance & SEO | Disclaimers, ToS, privacy policy, JSON-LD, sitemap, programmatic SEO pages |
| **Phase 6** | Alerts & Monetization | Email alerts for rate changes, affiliate links, premium API |
| **Phase 7+** | Growth | Account Aggregator, NRI features, mobile app, PostgreSQL migration |

import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { logger } from "hono/logger";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { bankRoutes } from "./routes/banks.js";
import { adminRoutes } from "./routes/admin.js";
import { rateRoutes } from "./routes/rates.js";
import { requireAuth, requireAdmin } from "./middleware/auth.js";

export type Env = {
  Bindings: {
    DB: D1Database;
    ENVIRONMENT: string;
    CORS_ORIGINS: string;
    API_KEY?: string;
  };
};

const app = new Hono<Env>();

// Global middleware
app.use("*", requestId());
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.CORS_ORIGINS.split(",").map((s: string) => s.trim());
      // Exact match
      if (allowed.includes(origin)) return origin;
      // Wildcard subdomain match: *.bird-web.pages.dev
      for (const a of allowed) {
        if (a.includes("*.")) {
          const suffix = a.replace("https://*.", ".");
          const originHost = origin.replace("https://", "");
          if (originHost.endsWith(suffix)) return origin;
        }
      }
      return allowed[0];
    },
  }),
);

// ── Public routes ─────────────────────────────────────────────────
app.route("/api", healthRoutes);
app.route("/api", authRoutes);

// Public: homepage best rates (no auth)
app.get("/api/rates/best", async (c) => {
  // Forward to rateRoutes handler — import the handler directly
  const { drizzle } = await import("drizzle-orm/d1");
  const { isNull, sql, desc, eq, and } = await import("drizzle-orm");
  const { rateSlabs, banks } = await import("./db/schema.js");

  const db = drizzle(c.env.DB);
  const tenureMinStr = c.req.query("tenure_min");
  const tenureMaxStr = c.req.query("tenure_max");
  const category = c.req.query("category");
  const insuredOnly = c.req.query("insured_only");
  const limit = Math.min(Number(c.req.query("limit") || "10"), 50);

  const conditions = [isNull(rateSlabs.effective_to)];
  if (tenureMinStr) conditions.push(sql`${rateSlabs.tenure_min_days} >= ${Number(tenureMinStr)}`);
  if (tenureMaxStr) conditions.push(sql`${rateSlabs.tenure_max_days} <= ${Number(tenureMaxStr)}`);
  if (category) conditions.push(eq(banks.category, category));
  if (insuredOnly === "true") conditions.push(eq(banks.deposit_insurance, true));

  const rows = await db
    .select({
      bank_code: banks.code, bank_name: banks.name, bank_category: banks.category,
      deposit_insurance: banks.deposit_insurance,
      tenure_text: rateSlabs.tenure_text, tenure_min_days: rateSlabs.tenure_min_days,
      tenure_max_days: rateSlabs.tenure_max_days, rate_general_pct: rateSlabs.rate_general_pct,
      rate_senior_pct: rateSlabs.rate_senior_pct, effective_from: rateSlabs.effective_from,
      scraped_at: rateSlabs.scraped_at,
    })
    .from(rateSlabs)
    .innerJoin(banks, eq(rateSlabs.bank_id, banks.id))
    .where(and(...conditions))
    .orderBy(desc(rateSlabs.rate_general_pct))
    .limit(limit);

  return c.json({ data: rows });
});

// Public: dashboard best rates per category/variant (no auth)
app.get("/api/rates/dashboard", async (c) => {
  const { drizzle } = await import("drizzle-orm/d1");
  const { isNull, sql, desc, eq, and, inArray } = await import("drizzle-orm");
  const { rateSlabs, banks, products } = await import("./db/schema.js");

  const db = drizzle(c.env.DB);

  // Helper: run a single "best rate" query with given filters
  async function bestRate(opts: {
    row_id: string;
    label: string;
    categories?: string[];
    variant?: string;
    currency?: string;
  }) {
    const conditions = [
      isNull(rateSlabs.effective_to),
      eq(products.product_type, "FD"),
    ];

    if (opts.categories && opts.categories.length > 0) {
      conditions.push(inArray(banks.category, opts.categories));
    }
    if (opts.variant) {
      conditions.push(eq(products.variant, opts.variant));
    }
    if (opts.currency) {
      conditions.push(eq(rateSlabs.currency, opts.currency));
    }

    const row = await db
      .select({
        rate_general_pct: rateSlabs.rate_general_pct,
        bank_name: banks.name,
        bank_code: banks.code,
        bank_category: banks.category,
        deposit_insurance: banks.deposit_insurance,
        tenure_text: rateSlabs.tenure_text,
        currency: rateSlabs.currency,
      })
      .from(rateSlabs)
      .innerJoin(products, eq(rateSlabs.product_id, products.id))
      .innerJoin(banks, eq(rateSlabs.bank_id, banks.id))
      .where(and(...conditions))
      .orderBy(desc(rateSlabs.rate_general_pct))
      .limit(1)
      .get();

    return {
      row_id: opts.row_id,
      label: opts.label,
      best_rate: row?.rate_general_pct ?? null,
      bank_name: row?.bank_name ?? null,
      bank_code: row?.bank_code ?? null,
      bank_category: row?.bank_category ?? null,
      tenure_text: row?.tenure_text ?? null,
      deposit_insurance: row?.deposit_insurance ?? null,
      currency: opts.currency || row?.currency || "INR",
    };
  }

  const CURRENCIES = ["USD", "GBP", "EUR", "AED"];

  // Run all 15 queries in parallel: 7 simple rows + 4 FCNR + 4 GIFT
  const [
    coopFd, sfbFd, scbFd, nbfcFd, hfcFd, nre, nro,
    ...currencyRows
  ] = await Promise.all([
    // Domestic FD rows
    bestRate({ row_id: "coop_fd", label: "Best Co-op FD Rate", categories: ["SUCB", "NSUCB", "SSCB", "NSSCB", "DCCB"], variant: "regular" }),
    bestRate({ row_id: "sfb_fd", label: "Best SFB FD Rate", categories: ["SFB"], variant: "regular" }),
    bestRate({ row_id: "scb_fd", label: "Best SCB FD Rate", categories: ["PSB", "PVB"], variant: "regular" }),
    bestRate({ row_id: "nbfc_fd", label: "Best NBFC Rate", categories: ["NBFC"], variant: "regular" }),
    bestRate({ row_id: "hfc_fd", label: "Best Housing Finance Rate", categories: ["HFC"], variant: "regular" }),
    // International FD rows
    bestRate({ row_id: "nre", label: "Best NRE Rate", variant: "nre" }),
    bestRate({ row_id: "nro", label: "Best NRO Rate", variant: "nro" }),
    // FCNR per currency
    ...CURRENCIES.map(cur => bestRate({ row_id: `fcnr_${cur.toLowerCase()}`, label: `Best FCNR Rate (${cur})`, variant: "fcnr", currency: cur })),
    // GIFT per currency
    ...CURRENCIES.map(cur => bestRate({ row_id: `gift_${cur.toLowerCase()}`, label: `Best GIFT City FD (${cur})`, categories: ["IBU"], variant: "gift", currency: cur })),
  ]);

  const fcnrCurrencies = currencyRows.slice(0, CURRENCIES.length);
  const giftCurrencies = currencyRows.slice(CURRENCIES.length);

  return c.json({
    rows: [coopFd, sfbFd, scbFd, nbfcFd, hfcFd, nre, nro],
    fcnr_currencies: fcnrCurrencies,
    gift_currencies: giftCurrencies,
    generated_at: new Date().toISOString(),
  });
});

// ── Authenticated routes ──────────────────────────────────────────
const authed = new Hono<Env>();
authed.use("*", requireAuth);
authed.route("/", bankRoutes);
authed.route("/", rateRoutes);
app.route("/api", authed);

// ── Admin routes ──────────────────────────────────────────────────
const admin = new Hono<Env>();
admin.use("*", requireAuth, requireAdmin);
admin.route("/", adminRoutes);
app.route("/api", admin);

export default app;

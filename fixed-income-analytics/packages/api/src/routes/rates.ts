import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, isNull, sql, desc, inArray } from "drizzle-orm";
import { rateSlabs, rateChangeLog, banks, products } from "../db/schema.js";
import type { Env } from "../app.js";

export const rateRoutes = new Hono<Env>()
  // GET /rates — query active rates with trust fields and filters
  .get("/rates", async (c) => {
    const db = drizzle(c.env.DB);
    const bankCode = c.req.query("bank");
    const productType = c.req.query("product");
    const tenureMinStr = c.req.query("tenure_min");
    const tenureMaxStr = c.req.query("tenure_max");
    const category = c.req.query("category");
    const insuredOnly = c.req.query("insured_only");
    const sortBy = c.req.query("sort_by") || "rate";
    const order = c.req.query("order") || "desc";
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "50"), 100);
    const offset = (page - 1) * limit;

    const conditions = [isNull(rateSlabs.effective_to)];

    if (bankCode) {
      conditions.push(eq(banks.code, bankCode));
    }
    if (productType) {
      conditions.push(eq(products.product_type, productType));
    }
    if (tenureMinStr) {
      conditions.push(sql`${rateSlabs.tenure_min_days} >= ${Number(tenureMinStr)}`);
    }
    if (tenureMaxStr) {
      conditions.push(sql`${rateSlabs.tenure_max_days} <= ${Number(tenureMaxStr)}`);
    }
    if (category) {
      conditions.push(eq(banks.category, category));
    }
    if (insuredOnly === "true") {
      conditions.push(eq(banks.deposit_insurance, true));
    }

    const orderClause = sortBy === "bank_name"
      ? (order === "asc" ? banks.name : desc(banks.name))
      : sortBy === "tenure"
        ? (order === "asc" ? rateSlabs.tenure_min_days : desc(rateSlabs.tenure_min_days))
        : (order === "asc" ? rateSlabs.rate_general_pct : desc(rateSlabs.rate_general_pct));

    const [countResult, rows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(rateSlabs)
        .innerJoin(banks, eq(rateSlabs.bank_id, banks.id))
        .innerJoin(products, eq(rateSlabs.product_id, products.id))
        .where(and(...conditions)),
      db
        .select({
          id: rateSlabs.id,
          bank_code: banks.code,
          bank_name: banks.name,
          bank_category: banks.category,
          deposit_insurance: banks.deposit_insurance,
          product_type: products.product_type,
          variant: products.variant,
          tenure_text: rateSlabs.tenure_text,
          tenure_min_days: rateSlabs.tenure_min_days,
          tenure_max_days: rateSlabs.tenure_max_days,
          rate_general_pct: rateSlabs.rate_general_pct,
          rate_senior_pct: rateSlabs.rate_senior_pct,
          rate_super_senior_pct: rateSlabs.rate_super_senior_pct,
          effective_from: rateSlabs.effective_from,
          scraped_at: rateSlabs.scraped_at,
          source_url: rateSlabs.source_url,
        })
        .from(rateSlabs)
        .innerJoin(banks, eq(rateSlabs.bank_id, banks.id))
        .innerJoin(products, eq(rateSlabs.product_id, products.id))
        .where(and(...conditions))
        .orderBy(orderClause)
        .limit(limit)
        .offset(offset),
    ]);

    return c.json({
      data: rows,
      total: countResult[0].count,
      page,
      limit,
    });
  })

  // GET /rates/best — best rates by tenure with trust fields
  .get("/rates/best", async (c) => {
    const db = drizzle(c.env.DB);
    const tenureMinStr = c.req.query("tenure_min");
    const tenureMaxStr = c.req.query("tenure_max");
    const category = c.req.query("category");
    const insuredOnly = c.req.query("insured_only");
    const limit = Math.min(Number(c.req.query("limit") || "10"), 50);

    const conditions = [isNull(rateSlabs.effective_to)];

    if (tenureMinStr) {
      conditions.push(sql`${rateSlabs.tenure_min_days} >= ${Number(tenureMinStr)}`);
    }
    if (tenureMaxStr) {
      conditions.push(sql`${rateSlabs.tenure_max_days} <= ${Number(tenureMaxStr)}`);
    }
    if (category) {
      conditions.push(eq(banks.category, category));
    }
    if (insuredOnly === "true") {
      conditions.push(eq(banks.deposit_insurance, true));
    }

    const rows = await db
      .select({
        bank_code: banks.code,
        bank_name: banks.name,
        bank_category: banks.category,
        deposit_insurance: banks.deposit_insurance,
        tenure_text: rateSlabs.tenure_text,
        tenure_min_days: rateSlabs.tenure_min_days,
        tenure_max_days: rateSlabs.tenure_max_days,
        rate_general_pct: rateSlabs.rate_general_pct,
        rate_senior_pct: rateSlabs.rate_senior_pct,
        effective_from: rateSlabs.effective_from,
        scraped_at: rateSlabs.scraped_at,
      })
      .from(rateSlabs)
      .innerJoin(banks, eq(rateSlabs.bank_id, banks.id))
      .where(and(...conditions))
      .orderBy(desc(rateSlabs.rate_general_pct))
      .limit(limit);

    return c.json({ data: rows });
  })

  // GET /rates/compare — multi-bank comparison
  .get("/rates/compare", async (c) => {
    const db = drizzle(c.env.DB);
    const banksParam = c.req.query("banks");
    if (!banksParam) return c.json({ error: "banks parameter required (comma-separated codes)" }, 400);

    const codes = banksParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 4);
    if (codes.length < 2) return c.json({ error: "At least 2 bank codes required" }, 400);

    // Get bank IDs
    const bankRows = await db
      .select({ id: banks.id, code: banks.code, name: banks.name, category: banks.category, deposit_insurance: banks.deposit_insurance })
      .from(banks)
      .where(inArray(banks.code, codes));

    const bankIds = bankRows.map(b => b.id);
    if (bankIds.length === 0) return c.json({ error: "No matching banks found" }, 404);

    const rows = await db
      .select({
        bank_code: banks.code,
        bank_name: banks.name,
        bank_category: banks.category,
        deposit_insurance: banks.deposit_insurance,
        product_type: products.product_type,
        variant: products.variant,
        tenure_text: rateSlabs.tenure_text,
        tenure_min_days: rateSlabs.tenure_min_days,
        tenure_max_days: rateSlabs.tenure_max_days,
        rate_general_pct: rateSlabs.rate_general_pct,
        rate_senior_pct: rateSlabs.rate_senior_pct,
        rate_super_senior_pct: rateSlabs.rate_super_senior_pct,
        effective_from: rateSlabs.effective_from,
        scraped_at: rateSlabs.scraped_at,
      })
      .from(rateSlabs)
      .innerJoin(banks, eq(rateSlabs.bank_id, banks.id))
      .innerJoin(products, eq(rateSlabs.product_id, products.id))
      .where(
        and(
          inArray(rateSlabs.bank_id, bankIds),
          isNull(rateSlabs.effective_to),
        ),
      )
      .orderBy(rateSlabs.tenure_min_days, banks.name);

    return c.json({
      banks: bankRows,
      rates: rows,
    });
  })

  // GET /rate-changes — recent rate changes feed
  .get("/rate-changes", async (c) => {
    const db = drizzle(c.env.DB);
    const bankCode = c.req.query("bank");
    const limit = Math.min(Number(c.req.query("limit") || "30"), 100);

    const conditions = [];
    if (bankCode) {
      conditions.push(eq(banks.code, bankCode));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: rateChangeLog.id,
        bank_code: banks.code,
        bank_name: banks.name,
        bank_category: banks.category,
        deposit_insurance: banks.deposit_insurance,
        field_changed: rateChangeLog.field_changed,
        old_value: rateChangeLog.old_value,
        new_value: rateChangeLog.new_value,
        detected_at: rateChangeLog.detected_at,
        tenure_text: rateSlabs.tenure_text,
        tenure_min_days: rateSlabs.tenure_min_days,
      })
      .from(rateChangeLog)
      .innerJoin(banks, eq(rateChangeLog.bank_id, banks.id))
      .innerJoin(rateSlabs, eq(rateChangeLog.rate_slab_id, rateSlabs.id))
      .where(where)
      .orderBy(desc(rateChangeLog.detected_at))
      .limit(limit);

    return c.json({ data: rows });
  })

  // GET /banks/:code/rates — all active rates for a bank with trust fields
  .get("/banks/:code/rates", async (c) => {
    const db = drizzle(c.env.DB);
    const code = c.req.param("code");

    const bank = await db
      .select()
      .from(banks)
      .where(eq(banks.code, code))
      .get();
    if (!bank) return c.json({ error: "Bank not found" }, 404);

    const rows = await db
      .select({
        id: rateSlabs.id,
        product_type: products.product_type,
        variant: products.variant,
        tenure_text: rateSlabs.tenure_text,
        tenure_min_days: rateSlabs.tenure_min_days,
        tenure_max_days: rateSlabs.tenure_max_days,
        rate_general_pct: rateSlabs.rate_general_pct,
        rate_senior_pct: rateSlabs.rate_senior_pct,
        rate_super_senior_pct: rateSlabs.rate_super_senior_pct,
        compounding_frequency: rateSlabs.compounding_frequency,
        effective_from: rateSlabs.effective_from,
        min_deposit_for_slab: rateSlabs.min_deposit_for_slab,
        max_deposit_for_slab: rateSlabs.max_deposit_for_slab,
        source_url: rateSlabs.source_url,
        scraped_at: rateSlabs.scraped_at,
      })
      .from(rateSlabs)
      .innerJoin(products, eq(rateSlabs.product_id, products.id))
      .where(
        and(
          eq(rateSlabs.bank_id, bank.id),
          isNull(rateSlabs.effective_to),
        ),
      )
      .orderBy(products.product_type, rateSlabs.tenure_min_days);

    return c.json({
      bank: {
        code: bank.code,
        name: bank.name,
        category: bank.category,
        deposit_insurance: bank.deposit_insurance,
        website_url: bank.website_url,
        rate_page_url: bank.rate_page_url,
        state: bank.state,
        assets_under_mgmt: bank.assets_under_mgmt,
      },
      rates: rows,
    });
  });

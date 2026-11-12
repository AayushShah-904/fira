import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { eq, like, sql, and } from "drizzle-orm";
import { bankQuerySchema } from "@bird/shared";
import { banks } from "../db/schema.js";
import type { Env } from "../app.js";

export const bankRoutes = new Hono<Env>()
  .get("/banks", zValidator("query", bankQuerySchema), async (c) => {
    const { category, state, scraper_status, discovery_status, search, page, limit } =
      c.req.valid("query");
    const db = drizzle(c.env.DB);

    const conditions = [];
    if (category) conditions.push(eq(banks.category, category));
    if (state) conditions.push(eq(banks.state, state));
    if (scraper_status) conditions.push(eq(banks.scraper_status, scraper_status));
    if (discovery_status) conditions.push(eq(banks.discovery_status, discovery_status));
    if (search) conditions.push(like(banks.name, `%${search}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db
        .select()
        .from(banks)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(banks.name),
      db
        .select({ count: sql<number>`count(*)` })
        .from(banks)
        .where(where),
    ]);

    return c.json({
      data,
      pagination: {
        page,
        limit,
        total: countResult[0].count,
        totalPages: Math.ceil(countResult[0].count / limit),
      },
    });
  })
  .get("/banks/:code", async (c) => {
    const code = c.req.param("code");
    const db = drizzle(c.env.DB);

    const bank = await db
      .select()
      .from(banks)
      .where(eq(banks.code, code))
      .limit(1);

    if (bank.length === 0) {
      return c.json({ error: "Bank not found" }, 404);
    }

    return c.json({ data: bank[0] });
  });

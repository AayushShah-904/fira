import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql, desc, isNull } from "drizzle-orm";
import { banks, scrapeRuns, scrapeFlags, rateSlabs } from "../db/schema.js";
import type { Env } from "../app.js";

export const adminRoutes = new Hono<Env>()
  // GET /admin/discovery-stats — existing endpoint
  .get("/admin/discovery-stats", async (c) => {
    const db = drizzle(c.env.DB);

    const [totalResult, byDiscovery, byScraper, byCategory] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(banks),
      db
        .select({ status: banks.discovery_status, count: sql<number>`count(*)` })
        .from(banks)
        .groupBy(banks.discovery_status),
      db
        .select({ status: banks.scraper_status, count: sql<number>`count(*)` })
        .from(banks)
        .groupBy(banks.scraper_status),
      db
        .select({
          category: banks.category,
          total: sql<number>`count(*)`,
          discovered: sql<number>`sum(case when discovery_status = 'discovered' then 1 else 0 end)`,
          partial: sql<number>`sum(case when discovery_status = 'partial' then 1 else 0 end)`,
          not_found: sql<number>`sum(case when discovery_status = 'not_found' then 1 else 0 end)`,
          pending: sql<number>`sum(case when discovery_status = 'pending' then 1 else 0 end)`,
        })
        .from(banks)
        .groupBy(banks.category)
        .orderBy(sql`count(*) desc`),
    ]);

    const byDiscoveryStatus: Record<string, number> = {};
    for (const row of byDiscovery) byDiscoveryStatus[row.status] = row.count;

    const byScraperStatus: Record<string, number> = {};
    for (const row of byScraper) byScraperStatus[row.status] = row.count;

    return c.json({
      total: totalResult[0].count,
      by_discovery_status: byDiscoveryStatus,
      by_scraper_status: byScraperStatus,
      by_category: byCategory,
    });
  })

  // GET /admin/flags — unresolved validation flags
  .get("/admin/flags", async (c) => {
    const db = drizzle(c.env.DB);
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "50"), 100);
    const offset = (page - 1) * limit;
    const severity = c.req.query("severity");
    const flagType = c.req.query("flag_type");

    const conditions = [isNull(scrapeFlags.resolution)];
    if (severity) conditions.push(eq(scrapeFlags.severity, severity));
    if (flagType) conditions.push(eq(scrapeFlags.flag_type, flagType));

    const [totalResult, rows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(scrapeFlags)
        .where(sql.join(conditions, sql` AND `)),
      db
        .select({
          id: scrapeFlags.id,
          bank_name: banks.name,
          bank_code: banks.code,
          flag_type: scrapeFlags.flag_type,
          severity: scrapeFlags.severity,
          details: scrapeFlags.details,
          scrape_run_id: scrapeFlags.scrape_run_id,
        })
        .from(scrapeFlags)
        .innerJoin(banks, eq(scrapeFlags.bank_id, banks.id))
        .where(sql.join(conditions, sql` AND `))
        .orderBy(
          sql`case ${scrapeFlags.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`,
          desc(scrapeFlags.id),
        )
        .limit(limit)
        .offset(offset),
    ]);

    return c.json({
      data: rows,
      total: totalResult[0].count,
      page,
      limit,
    });
  })

  // PATCH /admin/flags/:id — resolve a flag
  .patch("/admin/flags/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ resolution: string; resolved_by?: string }>();

    if (!["approved", "rejected", "held"].includes(body.resolution)) {
      return c.json({ error: "resolution must be approved, rejected, or held" }, 400);
    }

    db.update(scrapeFlags)
      .set({
        resolution: body.resolution,
        resolved_by: body.resolved_by || "admin",
        resolved_at: new Date().toISOString(),
      })
      .where(eq(scrapeFlags.id, id))
      .run();

    return c.json({ ok: true });
  })

  // GET /admin/scrape-runs — recent scrape runs
  .get("/admin/scrape-runs", async (c) => {
    const db = drizzle(c.env.DB);
    const limit = Math.min(Number(c.req.query("limit") || "50"), 100);

    const rows = await db
      .select({
        id: scrapeRuns.id,
        bank_name: banks.name,
        bank_code: banks.code,
        started_at: scrapeRuns.started_at,
        status: scrapeRuns.status,
        records_found: scrapeRuns.records_found,
        records_changed: scrapeRuns.records_changed,
        records_flagged: scrapeRuns.records_flagged,
        error_message: scrapeRuns.error_message,
      })
      .from(scrapeRuns)
      .innerJoin(banks, eq(scrapeRuns.bank_id, banks.id))
      .orderBy(desc(scrapeRuns.id))
      .limit(limit);

    return c.json({ data: rows });
  })

  // GET /admin/pipeline-health — aggregated health metrics
  .get("/admin/pipeline-health", async (c) => {
    const db = drizzle(c.env.DB);

    const [
      runStats,
      flagQueueDepth,
      coverageResult,
    ] = await Promise.all([
      // Scrape run success rate (last 7 days)
      db
        .select({
          total: sql<number>`count(*)`,
          success: sql<number>`sum(case when status = 'success' then 1 else 0 end)`,
          partial: sql<number>`sum(case when status = 'partial' then 1 else 0 end)`,
          failed: sql<number>`sum(case when status = 'failed' then 1 else 0 end)`,
        })
        .from(scrapeRuns)
        .where(sql`${scrapeRuns.started_at} >= datetime('now', '-7 days')`),

      // Unresolved flags
      db
        .select({ count: sql<number>`count(*)` })
        .from(scrapeFlags)
        .where(isNull(scrapeFlags.resolution)),

      // Coverage: banks with active rate slabs
      db
        .select({
          active_banks: sql<number>`count(distinct ${banks.id})`,
        })
        .from(banks)
        .where(eq(banks.scraper_status, "active")),
    ]);

    // Banks with at least one active rate slab
    const banksWithRates = await db
      .select({
        count: sql<number>`count(distinct ${rateSlabs.bank_id})`,
      })
      .from(rateSlabs)
      .where(isNull(rateSlabs.effective_to));

    const stats = runStats[0];
    const successRate = stats.total > 0
      ? ((stats.success + stats.partial) / stats.total * 100).toFixed(1)
      : "N/A";

    return c.json({
      scrape_runs_7d: {
        total: stats.total,
        success: stats.success,
        partial: stats.partial,
        failed: stats.failed,
        success_rate: successRate,
      },
      flag_queue_depth: flagQueueDepth[0].count,
      coverage: {
        active_banks: coverageResult[0].active_banks,
        banks_with_rates: banksWithRates[0].count,
      },
    });
  });

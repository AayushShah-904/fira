/**
 * Change detection service.
 * Fetches bank rate pages and compares content hashes to detect updates.
 * Only banks with detected changes need agent re-extraction.
 */
import { createHash } from "crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { createDb, schema } from "../db.js";
import { normalizeHtml, pdfFingerprint } from "./normalize.js";

type ChangeResult = {
  bank_code: string;
  bank_id: number;
  url: string;
  status: "changed" | "unchanged" | "error" | "new";
  http_status?: number;
  error?: string;
};

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Check a single bank's rate page for changes.
 */
async function checkBank(
  db: ReturnType<typeof createDb>["db"],
  bank: { id: number; code: string; rate_page_url: string; scraper_type?: string },
): Promise<ChangeResult> {
  const url = bank.rate_page_url;
  const now = new Date().toISOString();
  const isPdf = url.toLowerCase().endsWith(".pdf") || bank.scraper_type === "pdf";

  try {
    let contentHash: string;
    let httpStatus: number;

    if (isPdf) {
      // For PDFs, use HEAD request to check metadata
      const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
      httpStatus = resp.status;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      contentHash = sha256(pdfFingerprint(
        resp.headers.get("content-length"),
        resp.headers.get("last-modified"),
        resp.headers.get("etag"),
      ));
    } else {
      // For HTML, fetch and normalize
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "BIRD-ChangeDetector/1.0" },
      });
      httpStatus = resp.status;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      const normalized = normalizeHtml(html);
      contentHash = sha256(normalized);
    }

    // Look up existing hash
    const existing = db
      .select()
      .from(schema.pageHashes)
      .where(eq(schema.pageHashes.bank_id, bank.id))
      .get();

    if (!existing) {
      // First time — insert hash record
      db.insert(schema.pageHashes)
        .values({
          bank_id: bank.id,
          url,
          content_hash: contentHash,
          last_checked_at: now,
          last_changed_at: now,
          http_status: httpStatus,
        })
        .run();
      return { bank_code: bank.code, bank_id: bank.id, url, status: "new", http_status: httpStatus };
    }

    // Compare hashes
    const changed = existing.content_hash !== contentHash;

    db.update(schema.pageHashes)
      .set({
        content_hash: contentHash,
        last_checked_at: now,
        last_changed_at: changed ? now : undefined,
        http_status: httpStatus,
        error_message: null,
      })
      .where(eq(schema.pageHashes.id, existing.id))
      .run();

    return {
      bank_code: bank.code,
      bank_id: bank.id,
      url,
      status: changed ? "changed" : "unchanged",
      http_status: httpStatus,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Update error in DB if record exists
    const existing = db
      .select()
      .from(schema.pageHashes)
      .where(eq(schema.pageHashes.bank_id, bank.id))
      .get();

    if (existing) {
      db.update(schema.pageHashes)
        .set({ last_checked_at: now, error_message: msg })
        .where(eq(schema.pageHashes.id, existing.id))
        .run();
    }

    return { bank_code: bank.code, bank_id: bank.id, url, status: "error", error: msg };
  }
}

/**
 * Run change detection for all active banks with rate page URLs.
 */
export async function detectChanges(options?: {
  category?: string;
  limit?: number;
}): Promise<{ results: ChangeResult[]; summary: Record<string, number> }> {
  const { db } = createDb();
  const results: ChangeResult[] = [];

  // Get all active banks with rate page URLs
  let query = db
    .select({
      id: schema.banks.id,
      code: schema.banks.code,
      rate_page_url: schema.banks.rate_page_url,
      scraper_status: schema.banks.scraper_status,
    })
    .from(schema.banks)
    .where(
      and(
        eq(schema.banks.scraper_status, "active"),
        sql`${schema.banks.rate_page_url} IS NOT NULL`,
      ),
    );

  let banks = query.all();

  if (options?.category) {
    banks = banks.filter(b => {
      // Re-query to get category — simpler than joining
      const full = db.select().from(schema.banks).where(eq(schema.banks.id, b.id)).get();
      return full?.category === options.category;
    });
  }

  if (options?.limit) {
    banks = banks.slice(0, options.limit);
  }

  console.log(`Checking ${banks.length} banks for changes...\n`);

  // Process sequentially to avoid overwhelming servers
  for (const bank of banks) {
    if (!bank.rate_page_url) continue;
    const result = await checkBank(db, {
      id: bank.id,
      code: bank.code,
      rate_page_url: bank.rate_page_url,
    });
    results.push(result);

    const icon = result.status === "changed" ? "!!" :
      result.status === "new" ? "++" :
      result.status === "error" ? "XX" : "  ";
    console.log(`  ${icon} ${result.bank_code}: ${result.status}${result.error ? ` (${result.error})` : ""}`);
  }

  const summary: Record<string, number> = {};
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }

  console.log(`\nSummary: ${JSON.stringify(summary)}`);
  return { results, summary };
}

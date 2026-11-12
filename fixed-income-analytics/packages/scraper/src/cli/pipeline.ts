#!/usr/bin/env node
/**
 * Pipeline orchestration script.
 *
 * Runs the full daily pipeline:
 *   1. Change detection — fetch rate pages, compare hashes
 *   2. Re-extraction — trigger agent for changed banks (placeholder)
 *   3. Import — load agent outputs into DB with validation
 *   4. Staleness audit — flag banks with old data
 *
 * Designed to be invoked by any scheduler (cron, systemd timer, Task Scheduler, etc).
 *
 * Usage:
 *   npx tsx packages/scraper/src/cli/pipeline.ts                # full pipeline
 *   npx tsx packages/scraper/src/cli/pipeline.ts --step detect   # only change detection
 *   npx tsx packages/scraper/src/cli/pipeline.ts --step import   # only import
 *   npx tsx packages/scraper/src/cli/pipeline.ts --step staleness # only staleness audit
 */
import { resolve } from "path";
import { detectChanges } from "../change-detector/index.js";
import { runImport, printSummary } from "../import/import-discovery.js";
import { createDb, schema } from "../db.js";
import { validateStaleness } from "../validators/staleness.js";
import { eq, isNull, sql } from "drizzle-orm";

const projectRoot = resolve(import.meta.dirname!, "../../../..");
const agentOutputDir = resolve(projectRoot, "rate-discovery-agent/output");

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const step = getArg("step"); // detect | import | staleness | undefined (= all)

async function runDetect() {
  console.log("=== Step 1: Change Detection ===\n");
  const { results, summary } = await detectChanges();
  const changed = results.filter((r) => r.status === "changed");
  if (changed.length > 0) {
    console.log(`\n${changed.length} banks have changed rate pages.`);
    console.log("Trigger re-extraction with:");
    for (const c of changed) {
      console.log(`  node rate-discovery-agent/scripts/extract_rates.js ${c.bank_code}`);
    }
  }
  return summary;
}

function runImportStep() {
  console.log("\n=== Step 2: Import Agent Outputs ===\n");
  const stats = runImport(agentOutputDir);
  printSummary(stats);
  return stats;
}

function runStalenessAudit() {
  console.log("\n=== Step 3: Staleness Audit ===\n");
  const { db } = createDb();

  // Get all active banks and their latest scrape time
  const activeBanks = db
    .select({
      id: schema.banks.id,
      code: schema.banks.code,
      name: schema.banks.name,
    })
    .from(schema.banks)
    .where(eq(schema.banks.scraper_status, "active"))
    .all();

  let staleCount = 0;
  let warningCount = 0;

  for (const bank of activeBanks) {
    // Find the most recent scrape run for this bank
    const lastRun = db
      .select({ started_at: schema.scrapeRuns.started_at })
      .from(schema.scrapeRuns)
      .where(eq(schema.scrapeRuns.bank_id, bank.id))
      .orderBy(sql`${schema.scrapeRuns.started_at} DESC`)
      .limit(1)
      .get();

    const result = validateStaleness(lastRun?.started_at ?? null, bank.code);

    for (const flag of result.flags) {
      // Check if a staleness flag already exists for this bank
      const existing = db
        .select({ id: schema.scrapeFlags.id })
        .from(schema.scrapeFlags)
        .where(
          sql`${schema.scrapeFlags.bank_id} = ${bank.id} AND ${schema.scrapeFlags.flag_type} = 'staleness' AND ${schema.scrapeFlags.resolution} IS NULL`,
        )
        .get();

      if (!existing) {
        db.insert(schema.scrapeFlags)
          .values({
            bank_id: bank.id,
            flag_type: flag.flag_type,
            severity: flag.severity,
            details: flag.details,
          })
          .run();

        if (flag.severity === "critical") {
          staleCount++;
          console.log(`  STALE  ${bank.code}: ${JSON.parse(flag.details).message}`);
        } else {
          warningCount++;
        }
      }
    }
  }

  console.log(`\nStaleness: ${staleCount} stale, ${warningCount} warnings (of ${activeBanks.length} active banks)`);
}

async function main() {
  console.log(`BIRD Pipeline — ${new Date().toISOString()}\n`);

  if (!step || step === "detect") {
    await runDetect();
  }

  if (!step || step === "import") {
    runImportStep();
  }

  if (!step || step === "staleness") {
    runStalenessAudit();
  }

  console.log("\nPipeline complete.");
}

main().catch((err) => {
  console.error(`Pipeline failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

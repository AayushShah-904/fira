#!/usr/bin/env node
/**
 * CLI: Import rate-discovery-agent outputs into the BIRD database.
 *
 * Usage:
 *   npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/
 *   npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/sbi_config.json
 */
import { resolve } from "path";
import { runImport, printSummary } from "../import/import-discovery.js";

// Resolve paths relative to the monorepo root (2 levels up from packages/scraper/)
const projectRoot = resolve(import.meta.dirname!, "../../../..");
const input = process.argv[2];
if (!input) {
  console.error("Usage: import <output_dir_or_config_file>");
  console.error("");
  console.error("Examples:");
  console.error("  npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/");
  console.error("  npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/sbi_config.json");
  process.exit(1);
}

try {
  // Resolve input relative to project root so paths work from any cwd
  const resolved = resolve(projectRoot, input);
  const stats = runImport(resolved);
  printSummary(stats);
} catch (err) {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

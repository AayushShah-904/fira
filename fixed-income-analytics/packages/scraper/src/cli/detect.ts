#!/usr/bin/env node
/**
 * CLI: Run change detection for bank rate pages.
 *
 * Usage:
 *   npx tsx packages/scraper/src/cli/detect.ts
 *   npx tsx packages/scraper/src/cli/detect.ts --category PSB
 *   npx tsx packages/scraper/src/cli/detect.ts --limit 10
 */
import { resolve } from "path";
import { detectChanges } from "../change-detector/index.js";

// Ensure we're in the project root for DB resolution
const projectRoot = resolve(import.meta.dirname!, "../../../..");
process.chdir(projectRoot);

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const category = getArg("category");
const limitStr = getArg("limit");
const limit = limitStr ? parseInt(limitStr, 10) : undefined;

detectChanges({ category, limit }).catch(err => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

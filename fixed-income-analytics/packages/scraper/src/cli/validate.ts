#!/usr/bin/env node
/**
 * CLI: Run validation on a bank's rate data (from agent output or DB).
 *
 * Usage:
 *   npx tsx packages/scraper/src/cli/validate.ts rate-discovery-agent/output/sbi_rates.json
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { validateImport, type RawSlab } from "../validators/index.js";
import { parseTenureText } from "@bird/shared";

const projectRoot = resolve(import.meta.dirname!, "../../../..");
const input = process.argv[2];
if (!input) {
  console.error("Usage: validate <rates_json_file>");
  process.exit(1);
}

const ratesPath = resolve(projectRoot, input);
const rates = JSON.parse(readFileSync(ratesPath, "utf-8"));
const productType = rates.product_type || "FD";

const slabs: RawSlab[] = (rates.rate_slabs || []).map((s: Record<string, unknown>) => {
  let minDays = (s.tenure_min_days as number | null) ?? null;
  let maxDays = (s.tenure_max_days as number | null) ?? null;

  if ((minDays == null || maxDays == null) && s.tenure_text) {
    const parsed = parseTenureText(s.tenure_text as string);
    if (parsed) {
      minDays = minDays ?? parsed.minDays;
      maxDays = maxDays ?? parsed.maxDays;
    }
  }

  return {
    tenure_text: s.tenure_text as string,
    tenure_min_days: minDays,
    tenure_max_days: maxDays,
    rate_general_pct: s.rate_general_pct as number | null,
    rate_senior_pct: (s.rate_senior_pct as number | null) ?? null,
    rate_super_senior_pct: (s.rate_super_senior_pct as number | null) ?? null,
    compounding_freq: (s.compounding_freq as string | null) ?? null,
    min_deposit: (s.min_deposit as number | null) ?? null,
    max_deposit: (s.max_deposit as number | null) ?? null,
  };
});

console.log(`Validating ${slabs.length} slabs from ${ratesPath} (${productType})\n`);

const result = validateImport(slabs, {
  productType,
  activeSlabs: [], // no previous data for standalone validation
  expectedSlabCount: rates.expected_slab_count ?? null,
});

if (result.flags.length === 0) {
  console.log("All slabs passed validation.");
} else {
  for (const flag of result.flags) {
    const details = JSON.parse(flag.details);
    const slabInfo = flag.slab_index != null ? ` [slab ${flag.slab_index}]` : "";
    console.log(`  [${flag.severity.toUpperCase()}] ${flag.flag_type}${slabInfo}: ${details.message}`);
  }
  console.log(`\nTotal: ${result.criticalCount} critical, ${result.warningCount} warning, ${result.infoCount} info`);
}

console.log(`\nResult: ${result.passed ? "PASSED" : "FAILED"}`);
process.exit(result.passed ? 0 : 1);

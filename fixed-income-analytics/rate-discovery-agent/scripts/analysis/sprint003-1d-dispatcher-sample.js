#!/usr/bin/env node
/**
 * Sprint 003 Item #1d — measure the deterministic dispatcher against a 12-bank sample.
 *
 * Loads each bank's _config.json from output/latest/, invokes the new
 * lib/actions/extract_html_table.js action, and reports:
 *  - whether the action produced ≥1 slab (pass/fail)
 *  - how many slabs vs. the count in the existing _rates.json (LLM-inline ground truth)
 *  - per-bank wall-clock
 *
 * Bar (from week1-bars.md Track 2): ≥50% of the sample must produce ≥1 slab without
 * any LLM call. This script counts only deterministic outcomes.
 *
 * Usage: node scripts/analysis/sprint003-1d-dispatcher-sample.js
 */

const fs = require("fs");
const path = require("path");
const { extractHtmlTable } = require("../../lib/actions/extract_html_table");

const SAMPLE = [
  { code: "bank-of-baroda", kind: "html_static", cat: "PSB" },
  { code: "bank-of-india", kind: "html_js", cat: "PSB" },
  { code: "bandhan-bank-limited", kind: "html_static", cat: "PVB" },
  { code: "csb-bank-limited", kind: "html_js", cat: "PVB" },
  { code: "capital-small-finance-bank-limited", kind: "html_static", cat: "SFB" },
  { code: "au-small-finance-bank-limited", kind: "html_js", cat: "SFB" },
  { code: "abhyudaya-co-operative-bank-ltd-mumbai", kind: "html_static", cat: "SUCB" },
  { code: "bharati-sahakari-bank-limited", kind: "html_js", cat: "SUCB" },
  { code: "agra-zilla-sahakari-bank-ltd", kind: "html_static", cat: "DCCB" },
  { code: "eluru-district-co-operative-central-bank-ltd", kind: "html_js", cat: "DCCB" },
  { code: "ab-bank-plc", kind: "html_static", cat: "FB" },
  { code: "gujarat-state-co-operative-bank-ltd", kind: "html_static", cat: "SSCB" },
];

const OUTPUT_DIR = path.resolve(__dirname, "..", "..", "output", "latest");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

async function main() {
  const results = [];
  let passes = 0;

  for (const { code, kind, cat } of SAMPLE) {
    const configPath = path.join(OUTPUT_DIR, `${code}_config.json`);
    const ratesPath = path.join(OUTPUT_DIR, `${code}_rates.json`);
    const config = readJson(configPath);
    const groundTruth = readJson(ratesPath);
    const expectedSlabs = Array.isArray(groundTruth?.rate_slabs) ? groundTruth.rate_slabs.length : 0;

    const url = config?.rate_page_urls?.fd;
    if (!url) {
      results.push({ code, cat, kind, status: "skip", reason: "no fd URL", expected: expectedSlabs, actual: 0, ms: 0 });
      continue;
    }

    process.stdout.write(`\n[${cat}/${kind}] ${code}\n`);
    const t0 = Date.now();
    let actual = 0;
    let status = "fail";
    let reason = "";
    let extractionMethod = "";
    try {
      const out = await extractHtmlTable({
        url,
        kind,
        product_type: "FD",
        variant: "regular",
        config,
      });
      const ms = Date.now() - t0;
      if (out && Array.isArray(out.slabs) && out.slabs.length > 0) {
        actual = out.slabs.length;
        status = "pass";
        extractionMethod = out.extraction_method;
        passes++;
      } else {
        reason = "0 slabs";
      }
      results.push({ code, cat, kind, status, reason, expected: expectedSlabs, actual, extraction_method: extractionMethod, ms });
    } catch (err) {
      const ms = Date.now() - t0;
      results.push({ code, cat, kind, status: "error", reason: err.message.slice(0, 100), expected: expectedSlabs, actual: 0, ms });
    }
  }

  console.log("\n\n=== SUMMARY ===\n");
  console.log(`Passes (≥1 slab from deterministic): ${passes} / ${SAMPLE.length} (${((passes/SAMPLE.length)*100).toFixed(1)}%)`);
  console.log(`Bar (week1-bars.md): ≥50% — ${passes/SAMPLE.length >= 0.5 ? "GREEN, Fork A signal" : "RED, Fork B/C signal"}\n`);

  console.log("Per-bank:");
  for (const r of results) {
    const marker = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "!";
    const mthd = r.extraction_method ? ` method=${r.extraction_method}` : "";
    const rsn = r.reason ? ` (${r.reason})` : "";
    console.log(`  ${marker} [${r.cat}/${r.kind}] ${r.code.padEnd(50)} expected=${String(r.expected).padStart(3)} actual=${String(r.actual).padStart(3)} ${r.ms}ms${mthd}${rsn}`);
  }

  // Write machine-readable result
  const outPath = path.resolve(__dirname, "..", "..", "sdlc", "sprints", "sprint-003", "implementation", "1d-dispatcher-sample-result.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // safe-write-exempt: throwaway analysis output (Sprint 003 Track 2 measurement); not a canonical per-bank artifact.
  fs.writeFileSync(outPath, JSON.stringify({
    run_at: new Date().toISOString(),
    sample_size: SAMPLE.length,
    passes,
    pass_rate: passes / SAMPLE.length,
    bar: 0.5,
    bar_met: passes / SAMPLE.length >= 0.5,
    results,
  }, null, 2));
  console.log(`\nMachine-readable result: ${outPath}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

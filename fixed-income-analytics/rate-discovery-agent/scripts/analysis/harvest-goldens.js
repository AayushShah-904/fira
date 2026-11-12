#!/usr/bin/env node
'use strict';

// Sprint 005 / Phase 0.4 — harvest golden baselines.
//
// Produces the test fixtures Phase D3 regression tests will run against, and
// the regression-cases fixtures Phase C extractors must beat. Two cohorts:
//
//   Top-50 by slab count (NOT in the regression list)
//     → tests/golden-html/<bank>.expected.json     ← from baseline rates file
//     → tests/golden-html/<bank>.expected.meta.json  ← bank metadata + source URL
//     (HTML capture deferred to Phase A — Phase 0.4 captures expected.json only)
//
//   Regression-list banks (all 33)
//     → tests/golden-html/regression-cases/<bank>__<variant>.baseline.json
//     → tests/golden-html/regression-cases/<bank>__<variant>.actual.json
//     → tests/golden-html/regression-cases/<bank>__<variant>.diff.md
//     The Phase C extractor for that template must produce the baseline values
//     against the captured HTML; if it produces the actual values, it has
//     reproduced the regression bug.
//
// HTML fetch is deferred to Phase A — fetching 50+ live pages now would pull
// in Playwright (not installed in every env), and the new fetch_html.js
// hardening makes captures sturdier anyway. Phase A will write a companion
// `harvest-golden-html.js` that captures HTML alongside the expected.json
// files this script produces.

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const baselineDir = path.join(repoRoot, 'tmp', 'baseline-pre-reset');
const baselineOutputLatest = path.join(baselineDir, 'output-latest');
const goldenDir = path.join(repoRoot, 'tests', 'golden-html');
const regressionDir = path.join(goldenDir, 'regression-cases');

function loadJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

function loadRatesForBank(bankCode, variant) {
  const suffix = variant === 'regular' ? '_rates.json' : `_${variant}_rates.json`;
  return loadJsonSafe(path.join(baselineOutputLatest, `${bankCode}${suffix}`));
}

function loadConfigForBank(bankCode) {
  return loadJsonSafe(path.join(baselineOutputLatest, `${bankCode}_config.json`));
}

// Reduce a slab to the assertion shape we'll compare against
function slabKeyRates(slabs) {
  const out = {};
  for (const s of slabs) {
    // Pull common reference tenures: 1y, 2y, 3y, 5y if present
    const minD = s.tenure_min_days;
    const maxD = s.tenure_max_days;
    if (minD == null) continue;
    if (minD <= 365 && (maxD == null || maxD >= 365)) {
      if (out['1y'] == null) out['1y'] = { general: s.rate_general_pct, senior: s.rate_senior_pct };
    }
    if (minD <= 730 && (maxD == null || maxD >= 730)) {
      if (out['2y'] == null) out['2y'] = { general: s.rate_general_pct, senior: s.rate_senior_pct };
    }
    if (minD <= 1095 && (maxD == null || maxD >= 1095)) {
      if (out['3y'] == null) out['3y'] = { general: s.rate_general_pct, senior: s.rate_senior_pct };
    }
    if (minD <= 1825 && (maxD == null || maxD >= 1825)) {
      if (out['5y'] == null) out['5y'] = { general: s.rate_general_pct, senior: s.rate_senior_pct };
    }
  }
  return out;
}

function main() {
  fs.mkdirSync(goldenDir, { recursive: true });
  fs.mkdirSync(regressionDir, { recursive: true });

  // Load the quality report to find regression-list banks
  const qr = loadJsonSafe(path.join(baselineDir, 'quality-report.json'));
  if (!qr) {
    console.error('quality-report.json missing — cannot identify regression-list banks');
    process.exit(2);
  }
  const regressions = (qr.findings || []).filter(f => f.class === 'REGRESSION');
  const regressionBanks = new Set(regressions.map(r => r.bank_code));

  // Top 50 by slab count, EXCLUDING regression-list banks
  const allRatesFiles = fs.readdirSync(baselineOutputLatest)
    .filter(f => f.endsWith('_rates.json') && !f.startsWith('_'));
  const bankSlabCounts = [];
  for (const f of allRatesFiles) {
    // Determine bank_code and variant
    let variant = 'regular';
    let bankCode;
    if (f.endsWith('_nre_rates.json')) { variant = 'nre'; bankCode = f.replace(/_nre_rates\.json$/, ''); }
    else if (f.endsWith('_nro_rates.json')) { variant = 'nro'; bankCode = f.replace(/_nro_rates\.json$/, ''); }
    else if (f.endsWith('_fcnr_rates.json')) { variant = 'fcnr'; bankCode = f.replace(/_fcnr_rates\.json$/, ''); }
    else if (f.endsWith('_gift_rates.json')) { variant = 'gift'; bankCode = f.replace(/_gift_rates\.json$/, ''); }
    else if (f.endsWith('_rates.json')) { variant = 'regular'; bankCode = f.replace(/_rates\.json$/, ''); }
    else continue;
    const r = loadJsonSafe(path.join(baselineOutputLatest, f));
    if (!r || !r.rate_slabs) continue;
    bankSlabCounts.push({ bankCode, variant, slabCount: r.rate_slabs.length, rates: r });
  }

  // Pool of candidates for the top-50 = REGULAR variant only, excluding regressions
  const topPool = bankSlabCounts
    .filter(b => b.variant === 'regular' && !regressionBanks.has(b.bankCode) && b.slabCount > 0)
    .sort((a, b) => b.slabCount - a.slabCount);

  const top50 = topPool.slice(0, 50);

  // Write top-50 expected.json + expected.meta.json
  const top50Manifest = [];
  for (const b of top50) {
    const cfg = loadConfigForBank(b.bankCode);
    const expected = {
      bank_code: b.bankCode,
      variant: 'regular',
      slab_count: b.slabCount,
      key_rates: slabKeyRates(b.rates.rate_slabs),
      effective_date: b.rates.effective_date,
      source_url: b.rates.source_url,
      captured_from: 'tmp/baseline-pre-reset',
      captured_at: new Date().toISOString(),
    };
    const meta = {
      bank_code: b.bankCode,
      bank_name: cfg ? cfg.bank_name : null,
      bank_type: cfg ? cfg.bank_type : null,
      state: cfg ? cfg.state : null,
      website: cfg ? cfg.website : null,
      rate_page_url: cfg && cfg.rate_page_urls ? cfg.rate_page_urls.fd : null,
      scraper_type: cfg ? cfg.scraper_type : null,
      extraction_method: b.rates.extraction_method || (cfg ? cfg.extraction_method : null),
      slab_count: b.slabCount,
      sprint_005_phase: '0.4',
      note: 'Captured before Phase A. HTML capture deferred to Phase A harvester (scripts/analysis/harvest-golden-html.js will follow).',
    };
    // safe-write-exempt: phase-0.4 golden test fixture under tests/golden-html/; not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(goldenDir, `${b.bankCode}.expected.json`), JSON.stringify(expected, null, 2) + '\n');
    // safe-write-exempt: phase-0.4 golden test fixture meta under tests/golden-html/; not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(goldenDir, `${b.bankCode}.expected.meta.json`), JSON.stringify(meta, null, 2) + '\n');
    top50Manifest.push({ bank: b.bankCode, slabs: b.slabCount, type: cfg ? cfg.bank_type : null });
  }

  // Regression cases — for each regression finding, capture baseline + actual snapshots
  // The "actual" here is what's in baseline-pre-reset (the broken state we want to fix).
  // The "baseline" is what shipped in rates-pack-2026-05-14 — we don't have that file by
  // name in the snapshot, but we have the slab count from the quality-report finding.
  const regManifest = [];
  for (const r of regressions) {
    const variant = r.variant || 'regular';
    const baselineCount = r.baseline;
    const actualCount = r.actual;
    const actualRates = loadRatesForBank(r.bank_code, variant);
    const cfg = loadConfigForBank(r.bank_code);
    const stem = `${r.bank_code}__${variant}`;

    // safe-write-exempt: phase-0.4 regression-case fixture under tests/golden-html/regression-cases/; not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(regressionDir, `${stem}.baseline.json`), JSON.stringify({
      bank_code: r.bank_code,
      variant,
      slab_count: baselineCount,
      from: 'rates-pack-2026-05-14',
      note: 'Slab count only; full slab data not snapshotted by quality-gate. Phase A HTML harvester will capture the live page so Phase C extractor can validate against actual cell values.',
    }, null, 2) + '\n');

    // safe-write-exempt: phase-0.4 regression-case fixture under tests/golden-html/regression-cases/; not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(regressionDir, `${stem}.actual.json`), JSON.stringify({
      bank_code: r.bank_code,
      variant,
      slab_count: actualCount,
      from: 'tmp/baseline-pre-reset',
      rate_slabs: actualRates ? actualRates.rate_slabs : null,
      extraction_method: actualRates ? actualRates.extraction_method : null,
      warnings: actualRates ? actualRates.warnings : null,
      key_rates: actualRates ? slabKeyRates(actualRates.rate_slabs || []) : null,
    }, null, 2) + '\n');

    const dropPct = baselineCount > 0 ? Math.round((actualCount - baselineCount) / baselineCount * 100) : -100;
    const diffMd = [
      `# Regression: ${r.bank_code} (${variant})`,
      ``,
      `- **Baseline slabs (rates-pack-2026-05-14):** ${baselineCount}`,
      `- **Actual slabs (tmp/baseline-pre-reset):** ${actualCount}`,
      `- **Delta:** ${dropPct}%`,
      `- **Bank type:** ${cfg ? cfg.bank_type : 'unknown'}`,
      `- **Scraper type:** ${cfg ? cfg.scraper_type : 'unknown'}`,
      `- **Extraction method:** ${actualRates ? actualRates.extraction_method : (cfg ? cfg.extraction_method : 'unknown')}`,
      `- **Rate page URL:** ${cfg && cfg.rate_page_urls ? (cfg.rate_page_urls[variant === 'regular' ? 'fd' : `fd_${variant}`] || cfg.rate_page_urls.fd) : 'unknown'}`,
      ``,
      `## Hypothesis`,
      ``,
      actualCount === 0
        ? `100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced ${baselineCount}.`
        : `${baselineCount - actualCount}-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).`,
      ``,
      `## Phase C extractor target`,
      ``,
      `When the Phase C extractor for this bank's template is authored, it must produce **≥ ${baselineCount} slabs** against the live page (captured into tests/golden-html/regression-cases/${r.bank_code}.html by Phase A's HTML harvester). If it still produces ${actualCount}, the extractor has reproduced the bug.`,
      ``,
    ].join('\n');
    // safe-write-exempt: phase-0.4 regression-case fixture under tests/golden-html/regression-cases/; not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(regressionDir, `${stem}.diff.md`), diffMd);

    regManifest.push({ bank: r.bank_code, variant, baseline: baselineCount, actual: actualCount, dropPct });
  }

  // Index file
  const index = {
    generated_at: new Date().toISOString(),
    sprint: '005',
    phase: '0.4',
    top50_count: top50Manifest.length,
    regression_count: regManifest.length,
    top50: top50Manifest,
    regressions: regManifest,
    notes: [
      'HTML capture deferred to Phase A — running Playwright across 80+ live pages now would pull in dependencies and risk WAF triggers; the hardened fetch_html.js in Phase B is the right tool for that capture pass.',
      'The expected.json + expected.meta.json pair is sufficient for the immediate Phase D3 golden-test framework design; the test runner will skip pairs without a matching .html file until Phase A backfills them.',
    ],
  };
  // safe-write-exempt: phase-0.4 golden test index under tests/golden-html/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(path.join(goldenDir, 'INDEX.json'), JSON.stringify(index, null, 2) + '\n');

  console.log(`top 50 (excluding regressions): ${top50Manifest.length} banks`);
  console.log(`regression cases: ${regManifest.length} entries`);
  console.log(`wrote ${top50Manifest.length} expected.json + meta pairs to tests/golden-html/`);
  console.log(`wrote ${regManifest.length * 3} regression files to tests/golden-html/regression-cases/`);
  console.log(`wrote tests/golden-html/INDEX.json`);
}

main();

#!/usr/bin/env node
'use strict';

/**
 * Phase E pilot-50 migration — wave executor.
 *
 * Sprint 006 Step 4. Wraps the per-bank author-template.js --write flow with
 * wave-level orchestration. The wave composition is hard-coded from
 * sdlc/sprints/sprint-006/plan/pilot-50-cohort-selection.md so a typo in
 * --execute can't swap in an unintended bank.
 *
 * Refuses agent / CI / non-TTY for --execute. Dry-run is safe under agents.
 *
 * Design: ../sdlc/sprints/sprint-006/design/migration-runbook.md
 *
 * Usage:
 *   node scripts/migrate-pilot-wave.js <1|2|3> [--dry-run|--execute] [--skip a,b] [--only c,d]
 *
 * Exit codes:
 *   0   success / dry-run complete
 *   2   usage error / unknown wave
 *   10  refused (CI)
 *   11  refused (agent session)
 *   12  refused (no TTY for --execute)
 *   20  one or more bank migrations failed parity check
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectAgentEnvironment, detectCiEnvironment } = require('../lib/quality-gate/signed-accepts');

const REPO_ROOT = path.resolve(__dirname, '..');

// Wave composition mirrors pilot-50-cohort-selection.md.
// Format: { bank_code, template_id, variant }
//
// 2026-05-24 NOTE: template_id is now a *hint / clustering label*, not a
// dispatch constraint. executeOne no longer passes --reuse-template — the
// LLM-propose flow picks its own template_id from the actual page structure.
// The hint here documents the cohort planner's intent and survives in dry-run
// output so operators can spot if the LLM suggests something wildly different.
// SBI/BoB previously pinned to 'psb-pdf-rate-card-3col' which doesn't apply
// to html_static — this is moot under the propose flow but kept as historical
// context for the cohort selection rationale.
const WAVES = {
  1: [
    // 5 co-op (using shipped coop-bankin extractor)
    { bank_code: 'cuddapah-district-co-operative-central-bank-ltd', template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'apna-sahakari-bank-ltd',                            template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'ahmednagar-shahar-sahakari-bank-ltd-ahmednagar',    template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'bagalkot-central-co-operative-bank-ltd',            template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'ajara-urban-co-operative-bank-ltd',                 template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    // 2 PSB (using new psb-pdf-rate-card-3col)
    { bank_code: 'state-bank-of-india',     template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    { bank_code: 'bank-of-baroda',          template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    // 2 PVB (using new pvb-multi-variant)
    { bank_code: 'hdfc-bank-limited',       template_id: 'pvb-multi-variant', variant: 'regular' },
    { bank_code: 'icici-bank-limited',      template_id: 'pvb-multi-variant', variant: 'regular' },
    // 1 SSCB (reuses coop-bankin)
    { bank_code: 'the-andhra-pradesh-state-co-operative-bank-ltd', template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
  ],
  2: [
    // +10 co-op
    { bank_code: 'kakinada-co-operative-central-bank-ltd',           template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'solapur-district-central-co-operative-bank-ltd',   template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'meerut-district-co-operative-bank-ltd',            template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'goa-urban-co-operative-bank-limited',              template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'kalyan-janata-sahakari-bank-ltd-kalyan',           template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'rajkot-nagrik-sahakari-bank-ltd',                  template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'surat-peoples-co-operative-bank-ltd',              template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'eluru-co-operative-urban-bank-ltd',                template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'bagalkot-urban-co-operative-bank-ltd-bagalkot',    template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'bhuj-commercial-co-op-bank-ltd',                   template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    // +5 PSB
    { bank_code: 'punjab-national-bank',  template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    { bank_code: 'canara-bank',           template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    { bank_code: 'union-bank-of-india',   template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    { bank_code: 'indian-overseas-bank',  template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    { bank_code: 'central-bank-of-india', template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    // +5 PVB
    { bank_code: 'axis-bank-limited',         template_id: 'pvb-multi-variant', variant: 'regular' },
    { bank_code: 'kotak-mahindra-bank-limited', template_id: 'pvb-multi-variant', variant: 'regular' },
    { bank_code: 'indusind-bank-limited',     template_id: 'pvb-multi-variant', variant: 'regular' },
    { bank_code: 'yes-bank-limited',          template_id: 'pvb-multi-variant', variant: 'regular' },
    { bank_code: 'federal-bank-limited',      template_id: 'pvb-multi-variant', variant: 'regular' },
  ],
  3: [
    // +3 PSB
    { bank_code: 'idbi-bank-limited', template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    { bank_code: 'indian-bank',       template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    { bank_code: 'uco-bank',          template_id: 'psb-pdf-rate-card-3col', variant: 'regular' },
    // +3 PVB
    { bank_code: 'rbl-bank-limited',         template_id: 'pvb-multi-variant', variant: 'regular' },
    { bank_code: 'idfc-first-bank-limited',  template_id: 'pvb-multi-variant', variant: 'regular' },
    { bank_code: 'bandhan-bank-limited',     template_id: 'pvb-multi-variant', variant: 'regular' },
    // +8 FB non-WAF
    { bank_code: 'dbs-bank-india-limited',          template_id: 'fb-multi-variant', variant: 'regular' },
    { bank_code: 'citibank-na',                     template_id: 'fb-multi-variant', variant: 'regular' },
    { bank_code: 'sbm-bank-india-limited',          template_id: 'fb-multi-variant', variant: 'regular' },
    { bank_code: 'emirates-nbd-bank-pjsc',          template_id: 'fb-multi-variant', variant: 'regular' },
    { bank_code: 'mufg-bank-ltd',                   template_id: 'fb-multi-variant', variant: 'regular' },
    { bank_code: 'bank-of-bahrain-and-kuwait-bsc',  template_id: 'fb-multi-variant', variant: 'regular' },
    { bank_code: 'standard-chartered-bank',         template_id: 'fb-multi-variant', variant: 'regular' },
    { bank_code: 'hsbc-bank-india',                 template_id: 'fb-multi-variant', variant: 'regular' },
    // +4 SSCB/RRB (reuses coop-bankin)
    { bank_code: 'the-himachal-pradesh-state-co-operative-bank-ltd', template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'the-west-bengal-state-co-operative-bank-ltd',      template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'arunachal-pradesh-rural-bank',                     template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    { bank_code: 'karnataka-grameena-bank',                          template_id: 'coop-bankin-3col-tenure-general-senior', variant: 'regular' },
    // +2 IBU
    { bank_code: 'hdfc-bank-ibu', template_id: 'ibu-static-pdf-quarterly', variant: 'regular' },
    { bank_code: 'idbi-bank-ibu', template_id: 'ibu-static-pdf-quarterly', variant: 'regular' },
  ],
};

function fail(code, message) {
  process.stderr.write(`migrate-pilot-wave: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { wave: null, dryRun: true, execute: false, listBanks: false, writeBanksFile: null, harvestFirst: false, skip: [], only: [] };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\d+$/.test(a) && !out.wave) out.wave = parseInt(a, 10);
    else if (a === '--dry-run') { out.dryRun = true; out.execute = false; }
    else if (a === '--execute') { out.dryRun = false; out.execute = true; }
    else if (a === '--list-banks') { out.listBanks = true; out.dryRun = false; }
    else if (a === '--write-banks-file') { out.writeBanksFile = args[++i]; out.dryRun = false; }
    else if (a === '--harvest-first') out.harvestFirst = true;
    else if (a === '--skip') out.skip = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--only') out.only = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else fail(2, `unknown argument: ${a}`);
  }
  return out;
}

function printUsage() {
  process.stdout.write(`migrate-pilot-wave — execute one wave of the pilot-50 migration

Usage:
  node scripts/migrate-pilot-wave.js <wave-number> [options]

Wave numbers (composition locked in sdlc/sprints/sprint-006/plan/pilot-50-cohort-selection.md):
  1 — 5 co-op + 2 PSB + 2 PVB + 1 SSCB    (10 banks; smallest blast radius)
  2 — +10 co-op + 5 PSB + 5 PVB           (cumulative 30 banks)
  3 — +3 PSB + 3 PVB + 8 FB + 4 RRB + 2 IBU (cumulative 50 banks)

Options:
  --dry-run             (default) Walk the wave, print planned actions, exit
  --execute             Interactive per-bank flow. Refuses agent / CI / non-TTY.
  --list-banks          Print the wave's bank slugs (one per line). Pipe-friendly.
  --write-banks-file P  Write the wave's bank slugs to a file (for harvest --banks-file)
  --harvest-first       Before --execute, invoke harvest-golden-html.js for the wave's banks
  --skip <a,b>          Skip these bank codes within the wave
  --only <c,d>          Run only these bank codes (for targeted re-runs)
  --help       Show usage

Refusal: --execute refuses if running under CI, AI-agent session, or non-TTY.
Use --dry-run from anywhere (read-only).

Per-bank flow (--execute):
  1. Verify tests/golden-html/<bank>.html exists (or guide operator to harvest)
  2. Run author-template.js --reuse-template <id> --from-file <html> --write
     (which itself prompts [y/N] for the registry write)
  3. Print replay slabs + delta vs tmp/baseline-pre-reset/
  4. Tally per-wave outcomes

After the wave: operator manually runs
  node pack/build-pack.js && node scripts/quality-gate.js \\
    pack/dist/rates-pack.json pack/history/rates-pack-2026-05-14.json
`);
}

function checkRefusal(opts) {
  if (!opts.execute) return; // dry-run is always safe
  const ci = detectCiEnvironment();
  if (ci.isCI) fail(10, `--execute refused under CI (${ci.reason})`);
  const ag = detectAgentEnvironment();
  if (ag.isAgent) fail(11, `--execute refused inside AI-agent session (${ag.reason}) — open a fresh shell and re-run`);
  if (!process.stdin.isTTY) fail(12, `--execute requires a TTY`);
}

function dryRunOne(item, registry, baselineDir) {
  const bank = registry[item.bank_code];
  const status = {
    bank: item.bank_code,
    template_id: item.template_id,
    in_registry: !!bank,
    has_existing_template: !!(bank && bank.template),
    existing_template_id: bank && bank.template && bank.template.template_id,
    baseline_exists: fs.existsSync(path.join(baselineDir, `${item.bank_code}_rates.json`)),
    golden_exists: fs.existsSync(path.join(REPO_ROOT, 'tests', 'golden-html', `${item.bank_code}.html`)),
  };
  const actions = [];
  if (!status.in_registry) actions.push(`SKIP: not in registry`);
  else if (status.has_existing_template && status.existing_template_id === item.template_id) {
    actions.push(`SKIP: template already set to "${item.template_id}"`);
  } else if (status.has_existing_template) {
    actions.push(`OVERWRITE: existing template_id="${status.existing_template_id}" → "${item.template_id}"`);
  } else {
    actions.push(`AUTHOR: write new template block with template_id="${item.template_id}"`);
  }
  if (!status.golden_exists) actions.push(`PREREQ: run harvest-golden-html.js --banks ${item.bank_code} first`);
  if (!status.baseline_exists) actions.push(`WARN: no baseline at tmp/baseline-pre-reset/ — parity check will be NEW`);
  return { status, actions };
}

function executeOne(item) {
  const goldenHtml = path.join(REPO_ROOT, 'tests', 'golden-html', `${item.bank_code}.html`);
  if (!fs.existsSync(goldenHtml)) {
    return { bank: item.bank_code, outcome: 'skipped_no_golden', message: `No ${path.relative(REPO_ROOT, goldenHtml)} — run harvest-golden-html.js first` };
  }
  process.stdout.write(`\n--- ${item.bank_code} (hint_template=${item.template_id}, variant=${item.variant}) ---\n`);
  // Wave 1 2026-05-24 fix: drop --reuse-template so author-template runs the
  // LLM-propose flow. The WAVES table's template_id is now a clustering HINT
  // only — propose suggests its own template_id and column_map. Preload .env
  // via -r dotenv/config so AOAI_ENDPOINT/API_KEY are populated for the child.
  const r = spawnSync(process.execPath, [
    '-r', 'dotenv/config',
    path.join(REPO_ROOT, 'scripts', 'author-template.js'),
    item.bank_code,
    '--variant', item.variant,
    '--from-file', goldenHtml,
    '--write',
  ], { stdio: 'inherit' });
  if (r.status === 0) return { bank: item.bank_code, outcome: 'wrote' };
  if (r.status === 11) return { bank: item.bank_code, outcome: 'refused_agent', message: 'author-template refused — running inside an agent session?' };
  if (r.status === 12) return { bank: item.bank_code, outcome: 'refused_tty',   message: 'author-template refused — no TTY' };
  return { bank: item.bank_code, outcome: 'failed', status: r.status };
}

function loadRegistry() {
  const p = path.join(REPO_ROOT, 'data', 'bank-domains.json');
  if (!fs.existsSync(p)) fail(2, `registry missing at ${p}`);
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { fail(2, `registry parse failed: ${e.message}`); }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.wave == null) { printUsage(); process.exit(2); }
  const wave = WAVES[opts.wave];
  if (!wave) fail(2, `unknown wave ${opts.wave} (valid: 1, 2, 3)`);

  // Filter (do this BEFORE refusal check so --list-banks works under agents)
  let targets = wave;
  if (opts.only.length > 0) targets = wave.filter((w) => opts.only.includes(w.bank_code));
  if (opts.skip.length > 0) targets = targets.filter((w) => !opts.skip.includes(w.bank_code));

  // --list-banks: print and exit. Safe under agents (read-only).
  if (opts.listBanks) {
    for (const t of targets) process.stdout.write(`${t.bank_code}\n`);
    process.exit(0);
  }

  // --write-banks-file: write a banks file and exit. Safe under agents.
  if (opts.writeBanksFile) {
    const lines = [
      `# Auto-generated by migrate-pilot-wave.js --write-banks-file`,
      `# Wave ${opts.wave} — ${targets.length} banks`,
      '',
      ...targets.map((t) => t.bank_code),
    ];
    // safe-write-exempt: operator-supplied list file, not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(opts.writeBanksFile, lines.join('\n') + '\n');
    process.stdout.write(`wrote ${targets.length} bank slugs to ${opts.writeBanksFile}\n`);
    process.exit(0);
  }

  checkRefusal(opts);

  const registry = loadRegistry();
  const baselineDir = path.join(REPO_ROOT, 'tmp', 'baseline-pre-reset', 'output-latest');

  process.stdout.write(`Wave ${opts.wave}: ${targets.length} banks (mode=${opts.execute ? 'EXECUTE' : 'DRY-RUN'})\n`);
  process.stdout.write(`Registry: ${path.relative(REPO_ROOT, path.join(REPO_ROOT, 'data', 'bank-domains.json'))}\n`);
  process.stdout.write(`Baseline: ${path.relative(REPO_ROOT, baselineDir)}\n\n`);

  if (opts.dryRun) {
    const dryRows = targets.map((t) => dryRunOne(t, registry, baselineDir));
    for (const r of dryRows) {
      process.stdout.write(`${r.status.bank.padEnd(60)} ${r.actions.join('; ')}\n`);
    }
    const harvestNeeded = dryRows.filter((r) => r.actions.some((a) => a.startsWith('PREREQ'))).map((r) => r.status.bank);
    if (harvestNeeded.length > 0) {
      process.stdout.write(`\n${harvestNeeded.length} bank(s) need golden HTML capture first:\n`);
      process.stdout.write(`  RDA_AGENT_HARVEST_OK=1 node scripts/analysis/harvest-golden-html.js --banks ${harvestNeeded.join(',')}\n`);
    }
    process.stdout.write(`\nDry-run complete. Re-run with --execute to perform writes.\n`);
    process.exit(0);
  }

  // --harvest-first: run harvest-golden-html.js for the wave's banks before execute.
  // Requires RDA_AGENT_HARVEST_OK=1 if invoked from an agent (harvest enforces its own refusal).
  if (opts.harvestFirst) {
    process.stdout.write(`\n--harvest-first: invoking harvest-golden-html.js for ${targets.length} banks\n`);
    const harvest = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'analysis', 'harvest-golden-html.js'),
      '--banks', targets.map((t) => t.bank_code).join(','),
    ], { stdio: 'inherit' });
    if (harvest.status !== 0) {
      process.stderr.write(`\nharvest-golden-html exited ${harvest.status} — fix harvest issues before --execute\n`);
      process.exit(harvest.status || 1);
    }
  }

  // Execute path (refused for agent / CI / non-TTY above)
  const outcomes = [];
  for (const item of targets) {
    const r = executeOne(item);
    outcomes.push(r);
    process.stdout.write(`  result: ${r.outcome}${r.message ? ` — ${r.message}` : ''}\n`);
  }

  // Summary
  const summary = outcomes.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1;
    return acc;
  }, {});
  process.stdout.write(`\n=== Wave ${opts.wave} summary ===\n`);
  for (const [k, v] of Object.entries(summary)) process.stdout.write(`  ${k}: ${v}\n`);
  process.stdout.write(`\nNext: rebuild pack + run quality-gate:\n`);
  process.stdout.write(`  node pack/build-pack.js\n`);
  process.stdout.write(`  node scripts/quality-gate.js pack/dist/rates-pack.json pack/history/rates-pack-2026-05-14.json --out-dir pack/dist\n`);

  const failed = (summary.failed || 0) + (summary.refused_agent || 0) + (summary.refused_tty || 0);
  if (failed > 0) process.exit(20);
}

main();

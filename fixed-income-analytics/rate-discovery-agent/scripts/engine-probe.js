#!/usr/bin/env node
'use strict';

/**
 * Engine probe — sprint-004 M4.
 *
 * Runs each bank in the cohort under multiple engine configurations and
 * tallies slab counts + cost + duration. The intent is to answer: does
 * forcing Tier 2 (gpt-4.1) on the LLM path recover more slabs than the
 * default tier-router on the extraction-quality cohort, and at what cost
 * per slab? See `~/.claude/plans/pivot-to-engine-failure-lovely-wombat.md`
 * §M4 for the decision rule.
 *
 * Configurations (each run is a child `node run-discovery.js` invocation):
 *
 *   A — default
 *       The current production setting. For banks with PDF column hints
 *       (e.g. Axis), the M2.6 auto-switch routes to the orchestrator path
 *       at $0 cost. For banks without hints, the LLM-path's tier-router
 *       decides (Tier 1 mini default; escalation on drift).
 *
 *   B — force LLM-path + force Tier 2 (gpt-4.1)
 *       `--path llm` overrides the auto-switch; `RATE_FORCE_TIER=2` skips
 *       the Tier 1 step. Measures "what would happen if we always paid
 *       for gpt-4.1 on the LLM path?". Strictly more expensive than A.
 *
 *   C — force orchestrator path (regardless of hints)
 *       `--path orchestrator`. For hinted banks (Axis) same as A. For
 *       unhinted banks, the orchestrator's find_rate_page picks the HTML
 *       landing page; tells us whether the orchestrator's deterministic
 *       path can handle non-hinted banks gracefully (likely produces less
 *       data — that's evidence for "M2.7 priority: author HTML hints
 *       for the same cohort").
 *
 * Usage:
 *   node scripts/engine-probe.js
 *     [--cohort hdfc-bank-limited,dcb-bank-limited,...]
 *     [--configs A,B,C]
 *     [--out-dir <dir>]  default: output/probe/<timestamp>
 *
 * Cost: ~$0.30-$1 per run × banks × configs. The default cohort (4 banks
 * × 3 configs = 12 runs) lands around $5-10.
 *
 * IMPORTANT: this probe contaminates output/latest/ for each bank in the
 * cohort. The user can revert via `git checkout HEAD -- output/latest/<bank>*`
 * after reviewing the probe report.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LATEST_DIR = path.join(PROJECT_ROOT, 'output', 'latest');
const DOMAINS_FILE = path.join(PROJECT_ROOT, 'data', 'bank-domains.json');

const VARIANTS = ['regular', 'nre', 'nro', 'fcnr', 'gift'];

// Default cohort drawn from the M2 / M4 design (extraction-quality + PDF
// failure classes). HDFC / DCB / IDFC-First / Yes / CSB / Kotak / Karur-Vysya
// have known issues; Axis is the M2.6 baseline. Trim or extend via --cohort.
const DEFAULT_COHORT = [
  { slug: 'axis-bank-limited',          name: 'Axis Bank Limited',          category: 'Private Sector Bank (Indian)', state: 'Maharashtra' },
  { slug: 'hdfc-bank-limited',          name: 'HDFC Bank Limited',          category: 'Private Sector Bank (Indian)', state: 'Maharashtra' },
  { slug: 'idfc-first-bank-limited',    name: 'IDFC First Bank Limited',    category: 'Private Sector Bank (Indian)', state: 'Maharashtra' },
  { slug: 'kotak-mahindra-bank-limited',name: 'Kotak Mahindra Bank Limited',category: 'Private Sector Bank (Indian)', state: 'Maharashtra' },
];

const DEFAULT_CONFIGS = ['A', 'B', 'C'];

// ── Arg parsing ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let cohortFilter = null;
let configsFilter = null;
let outDir = null;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cohort' && argv[i + 1]) {
    cohortFilter = new Set(argv[++i].split(',').map((s) => s.trim()));
  } else if (argv[i] === '--configs' && argv[i + 1]) {
    configsFilter = new Set(argv[++i].split(',').map((s) => s.trim().toUpperCase()));
  } else if (argv[i] === '--out-dir' && argv[i + 1]) {
    outDir = argv[++i];
  }
}

const cohort = cohortFilter
  ? DEFAULT_COHORT.filter((b) => cohortFilter.has(b.slug))
  : DEFAULT_COHORT;
const configs = configsFilter
  ? DEFAULT_CONFIGS.filter((c) => configsFilter.has(c))
  : DEFAULT_CONFIGS;

if (!outDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  outDir = path.join(PROJECT_ROOT, 'output', 'probe', ts);
}
fs.mkdirSync(outDir, { recursive: true });

// ── Configuration definitions ────────────────────────────────────────

const CONFIGS = {
  A: {
    name: 'default',
    description: 'Production default — M2.6 auto-switch for hinted PDFs; LLM-path tier-router for unhinted.',
    flags: [],                // no --path override
    env: {},                  // no RATE_FORCE_TIER
  },
  B: {
    name: 'force-llm-tier2',
    description: 'Force LLM-path + force Tier 2 (gpt-4.1) for the initial attempt — no auto-switch.',
    flags: ['--path', 'llm'],
    env: { RATE_FORCE_TIER: '2' },
  },
  C: {
    name: 'force-orchestrator',
    description: 'Force orchestrator path regardless of hints — measures deterministic-path coverage on unhinted banks.',
    flags: ['--path', 'orchestrator'],
    env: {},
  },
};

// ── Per-bank tally ──────────────────────────────────────────────────

function readRateSlabs(slug, variant) {
  const suffix = variant === 'regular' ? '' : `_${variant}`;
  const file = path.join(LATEST_DIR, `${slug}${suffix}_rates.json`);
  if (!fs.existsSync(file)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data.rate_slabs) ? data.rate_slabs.length : 0;
  } catch {
    return 0;
  }
}

function readSummary(slug) {
  // Latest summary lands at output/latest/<slug>.summary.json (the .log/.summary
  // copy from run-discovery's final phase).
  const file = path.join(LATEST_DIR, `${slug}.summary.json`);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function isPartialSilent(slug) {
  const file = path.join(LATEST_DIR, `${slug}.partial_silent.json`);
  return fs.existsSync(file);
}

function tallyBank(slug) {
  const counts = {};
  let total = 0;
  for (const v of VARIANTS) {
    const n = readRateSlabs(slug, v);
    counts[v] = n;
    total += n;
  }
  const summary = readSummary(slug);
  return {
    slug,
    slab_counts: counts,
    total_slabs: total,
    cost_usd: summary.total_cost_usd ?? null,
    duration_ms: summary.wall_clock_ms ?? null,
    tool_calls: summary.tool_call_count ?? null,
    agent_path: summary.agent_path ?? null,
    partial_silent: isPartialSilent(slug),
  };
}

function bankHasPdfHint(slug) {
  try {
    const domains = JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf-8'));
    const entry = domains[slug];
    if (!entry || !entry.extraction) return false;
    return Object.values(entry.extraction).some((h) => h && h.type === 'pdf' && h.fulfills_product);
  } catch {
    return false;
  }
}

// ── Run a single config on a single bank ────────────────────────────

function runConfigOnBank(bank, configKey) {
  const cfg = CONFIGS[configKey];
  const runStartedAt = new Date().toISOString();
  console.log(`\n=== [${configKey}] ${cfg.name} on ${bank.slug} ===`);

  // Clear any stale partial_silent marker from the previous config so this
  // config starts from a comparable state.
  const markerFile = path.join(LATEST_DIR, `${bank.slug}.partial_silent.json`);
  if (fs.existsSync(markerFile)) {
    try { fs.unlinkSync(markerFile); } catch (_) { /* best-effort */ }
  }

  const args = ['run-discovery.js', bank.name, '--category', bank.category, '--state', bank.state, ...cfg.flags];
  const env = { ...process.env, ...cfg.env };
  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf-8',
    timeout: 6 * 60 * 1000, // 6 min hard cap per bank
    maxBuffer: 20 * 1024 * 1024,
  });

  const tally = tallyBank(bank.slug);
  return {
    ...tally,
    config: configKey,
    config_name: cfg.name,
    started_at: runStartedAt,
    exit_status: result.status,
    spawn_error: result.error ? result.error.message : null,
    stderr_tail: result.stderr ? result.stderr.slice(-500) : null,
  };
}

// ── Probe orchestration ──────────────────────────────────────────────

(async function main() {
  const results = []; // [{ bank, results_by_config: { A: {...}, B: {...}, C: {...} } }]
  const startedAt = new Date().toISOString();

  console.log(`Engine probe starting at ${startedAt}`);
  console.log(`Cohort (${cohort.length}): ${cohort.map((b) => b.slug).join(', ')}`);
  console.log(`Configs (${configs.length}): ${configs.join(', ')}`);
  console.log(`Out dir: ${outDir}`);

  for (const bank of cohort) {
    const bankResults = { bank, hint_present: bankHasPdfHint(bank.slug), runs: {} };
    for (const cfg of configs) {
      bankResults.runs[cfg] = runConfigOnBank(bank, cfg);
    }
    results.push(bankResults);
  }

  // ── Write artifacts ────────────────────────────────────────────────

  const rawPath = path.join(outDir, 'probe-results.json');
  // safe-write-exempt: engine-probe diagnostic output under output/probes/, not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(rawPath, JSON.stringify({
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    cohort: cohort.map((b) => b.slug),
    configs,
    config_defs: Object.fromEntries(configs.map((c) => [c, CONFIGS[c]])),
    banks: results,
  }, null, 2));

  // Markdown report
  const md = [];
  md.push(`# Engine probe — sprint-004 M4`);
  md.push('');
  md.push(`**Started**: ${startedAt}`);
  md.push(`**Completed**: ${new Date().toISOString()}`);
  md.push(`**Cohort**: ${cohort.map((b) => b.slug).join(', ')} (${cohort.length} banks)`);
  md.push(`**Configs run**: ${configs.join(', ')}`);
  md.push('');

  md.push('## Configurations');
  md.push('');
  for (const cfg of configs) {
    const c = CONFIGS[cfg];
    md.push(`- **${cfg}** (\`${c.name}\`): ${c.description}`);
    if (c.flags.length || Object.keys(c.env).length) {
      md.push(`  - flags: \`${c.flags.join(' ')}\``);
      md.push(`  - env: \`${Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}\``);
    }
  }
  md.push('');

  md.push('## Results by bank');
  md.push('');
  md.push('| Bank | Hint? | ' + configs.map((c) => `${c} slabs`).join(' | ') + ' | ' + configs.map((c) => `${c} cost`).join(' | ') + ' | ' + configs.map((c) => `${c} path`).join(' | ') + ' |');
  md.push('|---|---|' + configs.map(() => '---:').join('|') + '|' + configs.map(() => '---:').join('|') + '|' + configs.map(() => '---').join('|') + '|');
  for (const br of results) {
    const slabCols = configs.map((c) => br.runs[c].total_slabs);
    const costCols = configs.map((c) => br.runs[c].cost_usd != null ? `$${br.runs[c].cost_usd.toFixed(3)}` : '—');
    const pathCols = configs.map((c) => br.runs[c].agent_path || '?');
    md.push(`| ${br.bank.slug} | ${br.hint_present ? 'yes' : 'no'} | ${slabCols.join(' | ')} | ${costCols.join(' | ')} | ${pathCols.join(' | ')} |`);
  }
  md.push('');

  md.push('## Per-variant breakdown');
  md.push('');
  for (const br of results) {
    md.push(`### ${br.bank.slug} (hint=${br.hint_present})`);
    md.push('');
    md.push('| Config | regular | nre | nro | fcnr | gift | total | cost | partial_silent |');
    md.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const c of configs) {
      const r = br.runs[c];
      const sc = r.slab_counts;
      md.push(`| ${c} | ${sc.regular} | ${sc.nre} | ${sc.nro} | ${sc.fcnr} | ${sc.gift} | ${r.total_slabs} | ${r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : '—'} | ${r.partial_silent ? 'yes' : 'no'} |`);
    }
    md.push('');
  }

  md.push('## Aggregate');
  md.push('');
  const totalsByConfig = {};
  const costByConfig = {};
  for (const c of configs) {
    totalsByConfig[c] = results.reduce((a, b) => a + b.runs[c].total_slabs, 0);
    costByConfig[c] = results.reduce((a, b) => a + (b.runs[c].cost_usd || 0), 0);
  }
  md.push('| Config | Total slabs | Total cost | $/slab |');
  md.push('|---|---:|---:|---:|');
  for (const c of configs) {
    const total = totalsByConfig[c];
    const cost = costByConfig[c];
    const perSlab = total > 0 ? `$${(cost / total).toFixed(4)}` : '—';
    md.push(`| ${c} (${CONFIGS[c].name}) | ${total} | $${cost.toFixed(3)} | ${perSlab} |`);
  }
  md.push('');
  md.push('## Decision rule (per the M4 plan)');
  md.push('');
  md.push('- If config **B** (force Tier 2) recovers significantly more slabs than **A** AND cost-per-slab is comparable → productize "always Tier 2 for these bank types" in `lib/tier-router.js`');
  md.push('- If config **C** (force orchestrator) recovers most of B\'s slabs → ship M2-style hints (cheaper) and skip Tier 3 productization');
  md.push('- If neither closes the gap → log as evidence for a future deploy-stronger-model decision; no tier change');

  const mdPath = path.join(outDir, 'probe-report.md');
  // safe-write-exempt: engine-probe diagnostic output under output/probes/, not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(mdPath, md.join('\n'));

  console.log(`\n=== Probe complete ===`);
  console.log(`Raw results: ${rawPath}`);
  console.log(`Report:      ${mdPath}`);
})();

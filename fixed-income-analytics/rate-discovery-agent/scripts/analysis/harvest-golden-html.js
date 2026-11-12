#!/usr/bin/env node
'use strict';

/**
 * Backfill HTML companions for the Phase 0.4 golden test fixtures.
 *
 * Sprint 006 Phase A.3 / Step 1e. Walks tests/golden-html/ for
 * <bank>.expected.meta.json files, reads the rate_page_url, fetches the live
 * page via the new lib/fetch/fetch_html.js, and writes <bank>.html alongside.
 *
 * The moment this script runs successfully, the 50 skipped golden tests in
 * tests/extractors/golden.test.js bite — they assert slab parity vs the
 * captured HTML and Phase E migration is gated on them.
 *
 * Skip strategy: if <bank>.html already exists AND --force is not set, skip.
 * Failures are reported in the summary but don't abort the whole run.
 *
 * Usage:
 *   node scripts/analysis/harvest-golden-html.js [--force] [--limit N] [--banks bank1,bank2]
 *
 * Refusal: this script fetches real bank pages. It refuses to run inside an
 * AI agent unless RDA_AGENT_HARVEST_OK=1 is set (operator override for
 * supervised batch runs).
 */

const fs = require('node:fs');
const path = require('node:path');
const { fetchHtml } = require('../../lib/fetch/fetch_html');
const { detectAgentEnvironment } = require('../../lib/quality-gate/signed-accepts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GOLDEN_DIR = path.join(REPO_ROOT, 'tests', 'golden-html');

function parseArgs(argv) {
  const out = { force: false, limit: null, banks: null };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') out.force = true;
    else if (args[i] === '--limit') out.limit = parseInt(args[++i], 10);
    else if (args[i] === '--banks') out.banks = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (args[i] === '--banks-file') {
      // Sprint 006 fix: long bank lists break PowerShell line-wrap parsing.
      // --banks-file reads one bank slug per line (lines starting with # are comments).
      const filePath = args[++i];
      if (!fs.existsSync(filePath)) { process.stderr.write(`--banks-file not found: ${filePath}\n`); process.exit(2); }
      out.banks = fs.readFileSync(filePath, 'utf-8')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#'));
    }
    else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(`Usage: node scripts/analysis/harvest-golden-html.js [--force] [--limit N] [--banks bank1,bank2 | --banks-file <path>]\n`);
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${args[i]}\n`);
      process.exit(2);
    }
  }
  return out;
}

// Load data/bank-domains.json once (lazily, only when needed for URL fallback)
let _registryCache = null;
function loadRegistry() {
  if (_registryCache) return _registryCache;
  const p = path.join(REPO_ROOT, 'data', 'bank-domains.json');
  if (!fs.existsSync(p)) return {};
  try { _registryCache = JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { _registryCache = {}; }
  return _registryCache;
}

function urlFromRegistry(bankCode) {
  const reg = loadRegistry();
  const entry = reg[bankCode];
  if (!entry || !entry.rate_pages) return null;
  const rp = entry.rate_pages;
  const pagePath = rp.fd || rp.fd_combined || Object.values(rp).find(Boolean);
  if (!pagePath) return null;
  if (/^https?:\/\//i.test(pagePath)) return pagePath;
  if (!entry.domain) return null;
  const host = entry.domain;
  const sep = pagePath.startsWith('/') ? '' : '/';
  return `https://${host}${sep}${pagePath}`;
}

function listFixtures() {
  if (!fs.existsSync(GOLDEN_DIR)) return [];
  return fs.readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.expected.meta.json'))
    .map((f) => f.slice(0, -'.expected.meta.json'.length));
}

async function harvestOne(bankCode, opts, log) {
  const metaPath = path.join(GOLDEN_DIR, `${bankCode}.expected.meta.json`);
  const htmlPath = path.join(GOLDEN_DIR, `${bankCode}.html`);

  if (!opts.force && fs.existsSync(htmlPath)) {
    return { bankCode, status: 'skipped', reason: 'html_exists' };
  }

  // Sprint 006 fix: when no expected.meta.json fixture exists (e.g. pilot banks
  // that weren't in the Phase 0.4 top-50 harvest), fall back to looking up the
  // URL from data/bank-domains.json. This lets the pilot wave harvest banks
  // without first needing to write meta files for them.
  let url = null;
  let urlSource = null;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      url = meta.rate_page_url;
      urlSource = 'meta_fixture';
    } catch (e) {
      // Corrupt meta — fall through to registry lookup
    }
  }
  if (!url) {
    url = urlFromRegistry(bankCode);
    urlSource = url ? 'registry_fallback' : null;
  }
  if (!url) return { bankCode, status: 'failed', reason: 'no_url_in_fixture_or_registry' };
  if (log.info) log.info(`harvesting ${bankCode} from ${url} (source: ${urlSource})`);

  log.info(`harvesting ${bankCode} from ${url}`);
  // Read persisted template.fetch overrides from the registry so harvest
  // honors per-bank settings (wait_for_function, click_to_reveal,
  // expand_accordions, wait_for_network_idle, settle_window_ms, etc.).
  // Without this, banks needing accordion expansion or longer waits
  // (e.g., ICICI) capture only the initial-render shell.
  const reg = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'bank-domains.json'), 'utf-8')); } catch { return {}; } })();
  const templateFetch = (reg[bankCode] && reg[bankCode].template && reg[bankCode].template.fetch) || {};
  if (Object.keys(templateFetch).length > 0 && log.info) {
    log.info(`using template.fetch overrides: ${JSON.stringify(templateFetch)}`);
  }
  const result = await fetchHtml({
    url,
    templateFetch,
    log,
    capturePath: path.join(REPO_ROOT, 'tmp', 'runs', `harvest-${bankCode}`),
  });
  if (result.status !== 'success' || !result.html) {
    return {
      bankCode,
      status: 'failed',
      reason: `fetch_${result.status}`,
      final_strategy: result.final_strategy,
      challenge: result.challenge_detected,
      ms: result.ms,
    };
  }
  // safe-write-exempt: phase-0.4/A.3 golden test HTML fixture under tests/golden-html/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(htmlPath, result.html);
  return {
    bankCode,
    status: 'captured',
    bytes: result.html.length,
    final_strategy: result.final_strategy,
    ms: result.ms,
    iframe_traversed: result.iframe_traversed,
  };
}

async function main() {
  const opts = parseArgs(process.argv);

  const ag = detectAgentEnvironment();
  if (ag.isAgent && process.env.RDA_AGENT_HARVEST_OK !== '1') {
    process.stderr.write(`harvest-golden-html: refusing to run inside AI-agent session (${ag.reason}).\n`);
    process.stderr.write(`Set RDA_AGENT_HARVEST_OK=1 to override for supervised batch runs.\n`);
    process.exit(11);
  }

  const fixtures = listFixtures();
  // Sprint 006 fix: when --banks is explicit, use it AUTHORITATIVELY — don't
  // intersect with the fixtures list. The harvest is the FIRST capture for
  // pilot banks that may not have a meta fixture yet; intersecting filtered
  // them all out ("no fixtures matched"). Banks without registry entries
  // are caught downstream in harvestOne with a clear "no_url_in_fixture_or_registry"
  // reason.
  let targets = opts.banks ? opts.banks : fixtures;
  if (opts.limit) targets = targets.slice(0, opts.limit);

  if (targets.length === 0) {
    process.stderr.write(`no targets — use --banks <list> or --banks-file <path>, or populate tests/golden-html/*.expected.meta.json fixtures first\n`);
    process.exit(2);
  }

  const log = {
    info: (m) => process.stdout.write(`[harvest] ${m}\n`),
    warn: (m) => process.stderr.write(`[harvest:warn] ${m}\n`),
    error: (m) => process.stderr.write(`[harvest:error] ${m}\n`),
    debug: () => {},
  };

  process.stdout.write(`harvesting ${targets.length} bank(s) into ${path.relative(REPO_ROOT, GOLDEN_DIR)}/\n`);
  const results = [];
  for (const bankCode of targets) {
    try {
      const r = await harvestOne(bankCode, opts, log);
      results.push(r);
      process.stdout.write(`  ${r.status.padEnd(10)} ${bankCode}${r.reason ? ` (${r.reason})` : ''}\n`);
    } catch (e) {
      results.push({ bankCode, status: 'errored', reason: e.message });
      process.stdout.write(`  errored    ${bankCode} (${e.message})\n`);
    }
  }

  const summary = {
    total: results.length,
    captured: results.filter(r => r.status === 'captured').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed' || r.status === 'errored').length,
  };
  process.stdout.write(`\nSummary: captured=${summary.captured} skipped=${summary.skipped} failed=${summary.failed}\n`);
  const summaryPath = path.join(REPO_ROOT, 'tmp', 'analysis', 'harvest-golden-html-summary.json');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  // safe-write-exempt: harvest run summary under tmp/analysis/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(summaryPath, JSON.stringify({ generated_at: new Date().toISOString(), summary, results }, null, 2));
  process.stdout.write(`detailed summary: ${path.relative(REPO_ROOT, summaryPath)}\n`);
}

main().catch((e) => {
  process.stderr.write(`harvest-golden-html: ${e.stack || e.message}\n`);
  process.exit(1);
});

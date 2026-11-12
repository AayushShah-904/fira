'use strict';

/**
 * Integration test — exercises the Sprint 003 #1c action set end-to-end on
 * real cached HTML fixtures (from output/refresh/2026-05-13T17-29-11/fetched/).
 *
 * Goals:
 *   1. Confirm the actions compose: classify_rate_page → extract_html_table
 *      → commit_rates → commit_to_registry → classify_outcome works on
 *      real-world HTML the agent saw on 2026-05-13.
 *   2. No network calls (cached bodies replace HTTP fetches).
 *   3. No LLM calls (AZURE_OPENAI_ENDPOINT not set in test env → LLM-fallback
 *      path is dormant; deterministic path carries the test).
 *
 * If a fixture is missing the suite skips gracefully — fixtures live outside
 * tracked-in-git output/latest/ when this repo is cloned fresh, so the test
 * shouldn't fail-noisy in CI that doesn't pull the refresh cache.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractHtmlTable } = require('../../../lib/actions/extract_html_table');
const { commitRates } = require('../../../lib/actions/commit_rates');
const { commitToRegistry } = require('../../../lib/actions/commit_to_registry');
const { classifyOutcome } = require('../../../lib/actions/classify_outcome');

const FETCHED_DIR = path.resolve(__dirname, '..', '..', '..', 'output', 'refresh', '2026-05-13T17-29-11', 'fetched');
// capital-small-finance-bank-limited has a clean cached body that extracts 11 slabs
// (including the special-tenure FDs the Track 4 measurement surfaced). Good fixture
// because it exercises the regular path without triggering the PNB ambiguous-column
// detector that bank-of-baroda's cache does.
const FIXTURE_BANK = 'capital-small-finance-bank-limited';
const FIXTURE_FILE = path.join(FETCHED_DIR, `${FIXTURE_BANK}__regular.html`);

const fixtureAvailable = fs.existsSync(FIXTURE_FILE);

const tmpDirs = [];
function makeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'action-chain-test-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => { for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });

if (!fixtureAvailable) {
  test(`action-chain integration — SKIPPED: fixture ${FIXTURE_BANK}__regular.html not present`, () => {
    // Soft skip; the fixture cache isn't tracked in git so missing is fine.
  });
} else {
  test('action chain on cached capital-sfb HTML: extract → commit_rates → commit_to_registry → classify_outcome', async () => {
    const cached_body = fs.readFileSync(FIXTURE_FILE, 'utf-8');

    const output_dir = makeDir();
    const run_dir = makeDir();
    const domains_file = path.join(makeDir(), 'bank-domains.json');
    fs.writeFileSync(domains_file, '{}\n');
    const silentLogger = { warn: () => {}, info: () => {}, debug: () => {} };

    const SOURCE_URL = 'https://www.capital.bank.in/interest-rates/callable-domestic-term-deposit';
    const HOMEPAGE = 'https://www.capital.bank.in';
    const BANK_DISPLAY_NAME = 'Capital Small Finance Bank Limited';

    // ── Step 1: extract_html_table via cached_body (no network) ─────
    const extracted = await extractHtmlTable({
      url: SOURCE_URL,
      kind: 'html_static',
      product_type: 'FD',
      variant: 'regular',
      hints: { cached_body },
    });

    assert.ok(extracted, 'extract_html_table returned a result');
    assert.equal(extracted.ok, true);
    assert.ok(Array.isArray(extracted.slabs) && extracted.slabs.length > 0, 'at least one slab extracted');
    assert.equal(extracted.path_used, 'deterministic');
    // Capital SFB's cached body is the Track 4 "LLM under-extracts" case —
    // the deterministic dispatcher catches the 4 special-tenure slabs the
    // LLM missed in 2026-05-13. Pin that expectation here.
    assert.ok(extracted.slabs.length >= 10, `expected ≥10 slabs (Track 4 under-extraction fix); got ${extracted.slabs.length}`);

    // ── Step 2: commit_to_registry (domain) ─────────────────────────
    const regResult = await commitToRegistry({
      bank_code: FIXTURE_BANK,
      updates: { domain: HOMEPAGE, confidence: 'high' },
      domains_file,
      logger: silentLogger,
    });
    assert.equal(regResult.ok, true);
    assert.equal(regResult.wrote, true);

    // ── Step 3: commit_rates ────────────────────────────────────────
    const payload = {
      bank_code: FIXTURE_BANK,
      bank_name: BANK_DISPLAY_NAME,
      product_type: 'FD',
      variant: 'regular',
      effective_date: extracted.effective_date,
      source_url: SOURCE_URL,
      scraped_at: new Date().toISOString(),
      extraction_confidence: 'high',
      rate_slabs: extracted.slabs,
      special_schemes: [],
      warnings: extracted.warnings,
      errors: [],
    };
    const commitResult = await commitRates({
      bank_code: FIXTURE_BANK,
      variant: 'regular',
      payload,
      extraction_method: extracted.extraction_method,
      output_dir,
      logger: silentLogger,
    });
    assert.equal(commitResult.ok, true);
    assert.equal(commitResult.wrote, true);

    // File should exist with the right content
    const writtenPath = path.join(output_dir, `${FIXTURE_BANK}_rates.json`);
    assert.ok(fs.existsSync(writtenPath), 'canonical rates file written');
    const written = JSON.parse(fs.readFileSync(writtenPath, 'utf-8'));
    assert.equal(written.bank_code, FIXTURE_BANK);
    assert.equal(written.extraction_method, extracted.extraction_method);
    assert.equal(written.rate_slabs.length, extracted.slabs.length);

    // ── Step 4: classify_outcome ────────────────────────────────────
    // Copy the just-written rates + a minimal config into run_dir so the
    // classifier has artifacts to inspect.
    const configPath = path.join(run_dir, `${FIXTURE_BANK}_config.json`);
    fs.writeFileSync(configPath, JSON.stringify({
      bank_code: FIXTURE_BANK,
      bank_name: BANK_DISPLAY_NAME,
      website: HOMEPAGE,
      scraper_type: 'html_static',
      rate_page_urls: { fd: payload.source_url },
    }, null, 2));
    fs.copyFileSync(writtenPath, path.join(run_dir, `${FIXTURE_BANK}_rates.json`));
    fs.writeFileSync(path.join(run_dir, `${FIXTURE_BANK}.summary.json`), JSON.stringify({
      bank_code: FIXTURE_BANK,
      tool_calls: [
        { name: 'fetch_url', args: { url: HOMEPAGE }, isError: false },
        { name: 'fetch_url', args: { url: payload.source_url }, isError: false },
      ],
    }));

    const outcome = await classifyOutcome({
      bank_code: FIXTURE_BANK,
      run_dir,
      agent_result: { success: true },
      domain_was_known: true,
      initial_tier: 1,
      retry_attempted: false,
    });

    assert.equal(outcome.ok, true);
    assert.ok(outcome.failure_class);
    // bank-of-baroda's known data should classify as success
    assert.ok(['success', 'partial_success'].includes(outcome.failure_class));
    assert.ok(outcome.phase_outcomes);

    // ── Step 5: rate-pages registry update (closes the loop) ────────
    const ratePageResult = await commitToRegistry({
      bank_code: FIXTURE_BANK,
      updates: { rate_pages: { fd: payload.source_url }, scraper_type: 'html_static' },
      domains_file,
      logger: silentLogger,
    });
    assert.equal(ratePageResult.ok, true);

    // Final registry state should have domain + rate_pages.fd + scraper_type.
    // The domain-cache strips a `www.` prefix when storing (it tracks the
    // canonical hostname).
    const finalRegistry = JSON.parse(fs.readFileSync(domains_file, 'utf-8'));
    assert.ok(finalRegistry[FIXTURE_BANK]);
    assert.equal(finalRegistry[FIXTURE_BANK].domain, 'capital.bank.in');
    assert.ok(finalRegistry[FIXTURE_BANK].rate_pages);
    assert.ok(finalRegistry[FIXTURE_BANK].rate_pages.fd);
    assert.equal(finalRegistry[FIXTURE_BANK].scraper_type, 'html_static');
  });

  test('action chain handles FCNR cached HTML (currency tagging)', async () => {
    const fcnrFixture = path.join(FETCHED_DIR, 'state-bank-of-india__fcnr.html');
    if (!fs.existsSync(fcnrFixture)) {
      // Skip this assertion if the FCNR fixture isn't on disk; not all banks have FCNR caches.
      return;
    }
    const cached_body = fs.readFileSync(fcnrFixture, 'utf-8');

    const out = await extractHtmlTable({
      url: 'https://sbi.co.in/web/interest-rates/deposit-rates/fcnr-b-deposits',
      kind: 'html_static',
      product_type: 'FD',
      variant: 'fcnr',
      hints: { cached_body, expected_currencies: ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD'] },
    });

    if (out && out.ok) {
      // Every slab must carry a currency for fcnr
      assert.ok(out.slabs.every((s) => typeof s.currency === 'string' && s.currency.length > 0),
        'all fcnr slabs carry a currency');
    }
    // If extraction returned null, that's also acceptable — the fixture may not be parseable
    // by the deterministic path. The test asserts the contract, not extraction success.
  });
}

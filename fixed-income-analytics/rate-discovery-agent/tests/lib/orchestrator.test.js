'use strict';

/**
 * Smoke tests for lib/orchestrator.js (Sprint 003 #1c).
 *
 * The orchestrator chains 9 actions per-bank. Full integration testing
 * requires mocking each action; the simpler approach is to assert input-
 * contract behavior and the `shouldQueryNri` policy that decides variant
 * coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { orchestrate, _shouldQueryNri, _productsForBank } = require('../../lib/orchestrator');
const { mockSession } = require('../_helpers/mock_session');

test('shouldQueryNri: PSB/PVB/FB eligible (retail NRE/NRO/FCNR)', () => {
  for (const t of ['PSB', 'PVB', 'FB']) {
    assert.equal(_shouldQueryNri(t, 'any-bank'), true, `${t} should query NRI`);
  }
});

test('shouldQueryNri: IBU NOT eligible (uses fd_gift product instead, see productsForBank)', () => {
  assert.equal(_shouldQueryNri('IBU', 'state-bank-of-india-ibu'), false);
});

test('shouldQueryNri: cooperative + RRB + PB NOT eligible', () => {
  for (const t of ['SUCB', 'NSUCB', 'SSCB', 'NSSCB', 'DCCB', 'RRB', 'PB', 'LAB']) {
    assert.equal(_shouldQueryNri(t, 'any-bank'), false, `${t} should NOT query NRI`);
  }
});

test('shouldQueryNri: large SFB eligible (AU, Equitas, Ujjivan, IDFC First, Bandhan)', () => {
  assert.equal(_shouldQueryNri('SFB', 'au-small-finance-bank-limited'), true);
  assert.equal(_shouldQueryNri('SFB', 'equitas-small-finance-bank-limited'), true);
  assert.equal(_shouldQueryNri('SFB', 'ujjivan-small-finance-bank-limited'), true);
  assert.equal(_shouldQueryNri('SFB', 'idfc-first-bank-limited'), true);
  assert.equal(_shouldQueryNri('SFB', 'bandhan-bank-limited'), true);
});

test('shouldQueryNri: small SFB NOT eligible by default', () => {
  assert.equal(_shouldQueryNri('SFB', 'unity-small-finance-bank-limited'), false);
});

test('productsForBank: IBU → [fd_gift] only (no domestic FD, no retail NRI)', () => {
  assert.deepEqual(_productsForBank('IBU', 'state-bank-of-india-ibu'), ['fd_gift']);
});

test('productsForBank: PSB → fd + fd_nre/nro/fcnr', () => {
  assert.deepEqual(_productsForBank('PSB', 'state-bank-of-india'), ['fd', 'fd_nre', 'fd_nro', 'fd_fcnr']);
});

test('productsForBank: SUCB → fd only (no NRI, no gift)', () => {
  assert.deepEqual(_productsForBank('SUCB', 'some-coop-bank'), ['fd']);
});

test('productsForBank: large SFB → fd + retail NRI', () => {
  assert.deepEqual(_productsForBank('SFB', 'au-small-finance-bank-limited'), ['fd', 'fd_nre', 'fd_nro', 'fd_fcnr']);
});

test('productsForBank: small SFB → fd only', () => {
  assert.deepEqual(_productsForBank('SFB', 'unity-small-finance-bank-limited'), ['fd']);
});

test('orchestrate: throws on missing bank_name', async () => {
  await assert.rejects(
    orchestrate({
      bank_type: 'PSB',
      output_dir: '/tmp', run_dir: '/tmp', domains_file: '/tmp/d.json',
    }),
    /bank_name is required/,
  );
});

test('orchestrate: throws on missing output_dir', async () => {
  await assert.rejects(
    orchestrate({
      bank_name: 'Test', bank_type: 'PSB',
      run_dir: '/tmp', domains_file: '/tmp/d.json',
    }),
    /output_dir is required/,
  );
});

test('orchestrate: throws on missing run_dir', async () => {
  await assert.rejects(
    orchestrate({
      bank_name: 'Test', bank_type: 'PSB',
      output_dir: '/tmp', domains_file: '/tmp/d.json',
    }),
    /run_dir is required/,
  );
});

test('orchestrate: throws on missing domains_file', async () => {
  await assert.rejects(
    orchestrate({
      bank_name: 'Test', bank_type: 'PSB',
      output_dir: '/tmp', run_dir: '/tmp',
    }),
    /domains_file is required/,
  );
});

test('orchestrate: failure path returns structured summary (no exception thrown)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    // Use a clearly-bogus bank name so find_website fails fast and the
    // orchestrator returns a structured result rather than throwing.
    const result = await orchestrate({
      bank_name: 'Nonexistent Bogus Test Bank Zzz',
      bank_type: 'PSB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
    });
    assert.equal(result.ok, false);
    assert.equal(result.bank_code, 'nonexistent-bogus-test-bank-zzz');
    assert.ok(Array.isArray(result.phase_events));
    assert.ok(result.phase_events.length > 0);
    // The first event should be find_website
    assert.equal(result.phase_events[0].step, 'find_website');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── Happy-path: mock all 9 actions and verify the orchestrator sequences them correctly ──

/**
 * Build a fresh set of mock actions with a shared `calls` log so tests can
 * assert both the order of invocation and the args each action received.
 * Each mock returns a canonical "successful" result shape per
 * sdlc/sprints/sprint-003/design/action-contracts.md.
 */
function buildMockActions({ kind = 'html_static', slabs = sampleSlabs(), variants = ['fd'] } = {}) {
  const calls = [];
  const trace = (name, args) => { calls.push({ name, args }); };
  const url = 'https://example.bank.in/fd-rates';
  // Phase 3 of option A+C: orchestrator creates a per-bank Playwright session
  // and threads it into the three fetching actions. Tests inject this mock so
  // assertions can verify (a) session was created/closed, (b) session was
  // forwarded into find_website/find_rate_page/classify_rate_page.
  const session = mockSession();
  return {
    calls,
    session,
    actions: {
      findWebsite: async (args) => { trace('findWebsite', args); return { ok: true, url: 'https://example.bank.in/', confidence: 'high' }; },
      findRatePage: async (args) => { trace('findRatePage', args); return { ok: true, url, product: args.product }; },
      fetchPage: async (args) => { trace('fetchPage', args); return { ok: true, body: '<html><body>mock</body></html>', content_type: 'text/html', status_code: 200, final_url: args.url, truncated: false, fetched_via: 'session' }; },
      classifyRatePage: async (args) => { trace('classifyRatePage', args); return { ok: true, kind, url: args.url }; },
      extractHtmlTable: async (args) => { trace('extractHtmlTable', args); return { slabs, extraction_method: 'html_static_cheerio', effective_date: '2026-05-15' }; },
      extractPdfTable: async (args) => { trace('extractPdfTable', args); return null; },
      extractViaVision: async (args) => { trace('extractViaVision', args); return null; },
      commitRates: async (args) => { trace('commitRates', args); return { wrote: true, path: '/tmp/fake_rates.json' }; },
      commitToRegistry: async (args) => { trace('commitToRegistry', args); return { wrote: true }; },
      commitConfig: async (args) => { trace('commitConfig', args); return { wrote: true, path: '/tmp/fake_config.json' }; },
      classifyOutcome: async (args) => { trace('classifyOutcome', args); return { failure_class: 'success', ok: true }; },
      createSession: async () => { trace('createSession', {}); return session; },
    },
  };
}

function sampleSlabs() {
  return [
    { tenure_text: '7 days to 45 days', tenure_min_days: 7, tenure_max_days: 45, rate_general_pct: 3.5, rate_senior_pct: 4.0, rate_super_senior_pct: null },
    { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.5, rate_senior_pct: 7.0, rate_super_senior_pct: 7.25 },
  ];
}

test('orchestrate happy path: PSB → 4 variants → all committed', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-happy-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls, session } = buildMockActions();

    const result = await orchestrate({
      bank_name: 'State Bank of India',
      bank_type: 'PSB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    // Phase 3 session lifecycle: created once at top, closed in finally.
    assert.equal(calls.filter((c) => c.name === 'createSession').length, 1, 'createSession called exactly once per orchestrate()');
    assert.equal(session._internals.closed, true, 'session.close called in finally');
    // Session was threaded into the 3 fetching actions.
    const findWebsiteCall = calls.find((c) => c.name === 'findWebsite');
    assert.equal(findWebsiteCall.args.session, session, 'find_website received the session');
    const firstFindRatePageCall = calls.find((c) => c.name === 'findRatePage');
    assert.equal(firstFindRatePageCall.args.session, session, 'find_rate_page received the session');
    const firstClassifyCall = calls.find((c) => c.name === 'classifyRatePage');
    assert.equal(firstClassifyCall.args.session, session, 'classify_rate_page received the session');

    // Top-level outcome
    assert.equal(result.ok, true, 'overall ok=true when slabs committed');
    assert.equal(result.bank_code, 'state-bank-of-india');
    assert.equal(result.homepage, 'https://example.bank.in/');
    assert.equal(result.websiteConfidence, 'high');
    assert.equal(result.signals.website_found, true);
    assert.equal(result.signals.rate_page_found, true);
    assert.equal(result.signals.slabs_extracted_count, 8, 'PSB queries 4 variants × 2 slabs each');

    // Per-variant: all four variants committed
    assert.equal(result.variantSummary.regular?.status, 'committed');
    assert.equal(result.variantSummary.nre?.status, 'committed');
    assert.equal(result.variantSummary.nro?.status, 'committed');
    assert.equal(result.variantSummary.fcnr?.status, 'committed');
    for (const v of ['regular', 'nre', 'nro', 'fcnr']) {
      assert.equal(result.variantSummary[v].slabs, 2, `variant ${v} should report 2 slabs`);
      assert.equal(result.variantSummary[v].kind, 'html_static');
    }

    // Action invocation order
    const seq = calls.map((c) => c.name);
    // Start: createSession (Phase 3) → findWebsite → commitToRegistry(domain)
    assert.equal(seq[0], 'createSession');
    assert.equal(seq[1], 'findWebsite');
    assert.equal(seq[2], 'commitToRegistry');
    // Each variant: findRatePage → classifyRatePage → extractHtmlTable → commitRates → commitToRegistry(rate_page)
    // 4 variants × 5 steps = 20, plus the initial 2 + final classifyOutcome
    assert.equal(seq.filter((n) => n === 'findRatePage').length, 4, '4 variants → 4 findRatePage calls');
    assert.equal(seq.filter((n) => n === 'classifyRatePage').length, 4);
    assert.equal(seq.filter((n) => n === 'extractHtmlTable').length, 4);
    assert.equal(seq.filter((n) => n === 'commitRates').length, 4);
    assert.equal(seq.filter((n) => n === 'classifyOutcome').length, 1);

    // phase_events records every step
    assert.ok(result.phase_events.length >= 22, `phase_events should record every action (got ${result.phase_events.length})`);
    assert.ok(result.phase_events.every((e) => typeof e.ms === 'number'), 'every event has ms');

    // PDF and Vision extractors should NOT have been called (kind=html_static)
    assert.equal(seq.filter((n) => n === 'extractPdfTable').length, 0);
    assert.equal(seq.filter((n) => n === 'extractViaVision').length, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('orchestrate happy path: SUCB skips NRI variants → only regular committed', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sucb-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls, session } = buildMockActions();

    const result = await orchestrate({
      bank_name: 'Some Cooperative Bank Ltd.',
      bank_type: 'SUCB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    assert.equal(result.ok, true);
    assert.equal(result.variantSummary.regular?.status, 'committed');
    assert.equal(result.variantSummary.nre, undefined, 'SUCB skips NRE');
    assert.equal(result.variantSummary.nro, undefined);
    assert.equal(result.variantSummary.fcnr, undefined);
    // Only 1 variant → 1 findRatePage call (not 4)
    assert.equal(calls.filter((c) => c.name === 'findRatePage').length, 1);
    assert.equal(session._internals.closed, true, 'session closed even on single-variant runs');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('orchestrate routes PDF extractor when classify_rate_page returns kind=pdf', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pdf-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls } = buildMockActions({ kind: 'pdf' });
    // Override the PDF extractor to return a successful multi-page payload
    actions.extractPdfTable = async (args) => {
      calls.push({ name: 'extractPdfTable', args });
      return {
        pages: [{ page_number: 1, variant: 'regular', slabs: sampleSlabs(), effective_date: '2026-05-15' }],
        extraction_method: 'pdf_text',
        structure_hint: { columns: 3 },
      };
    };

    const result = await orchestrate({
      bank_name: 'PDF-only Cooperative Bank',
      bank_type: 'SUCB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    const seq = calls.map((c) => c.name);
    assert.equal(seq.filter((n) => n === 'extractPdfTable').length, 1);
    assert.equal(seq.filter((n) => n === 'extractHtmlTable').length, 0);
    assert.equal(seq.filter((n) => n === 'extractViaVision').length, 0);
    assert.equal(result.variantSummary.regular?.status, 'committed_multi_page');
    assert.equal(result.variantSummary.regular?.pages, 1);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('orchestrate happy path: IBU bank → fd_gift product → gift variant with per-currency slabs', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ibu-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');

    // IBU rate tables are per-currency. CLAUDE.md spec: each slab carries a
    // `currency` field (USD/GBP/EUR/...), no senior_pct, tenure 365-1825 days.
    const giftSlabs = [
      { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 5.25, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'USD' },
      { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 4.10, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'EUR' },
      { tenure_text: '2 years to 3 years', tenure_min_days: 730, tenure_max_days: 1095, rate_general_pct: 5.40, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'USD' },
    ];

    const calls = [];
    const trace = (name, args) => { calls.push({ name, args }); };
    const session = mockSession();
    const actions = {
      findWebsite: async (args) => { trace('findWebsite', args); return { ok: true, url: 'https://example-ibu.bank.in/', confidence: 'high' }; },
      findRatePage: async (args) => { trace('findRatePage', args); return { ok: true, url: 'https://example-ibu.bank.in/ifsc-banking/', product: args.product }; },
      classifyRatePage: async (args) => { trace('classifyRatePage', args); return { ok: true, kind: 'html_static', url: args.url }; },
      extractHtmlTable: async (args) => { trace('extractHtmlTable', args); return { slabs: giftSlabs, extraction_method: 'html_static_cheerio', effective_date: '2026-05-15' }; },
      extractPdfTable: async (args) => { trace('extractPdfTable', args); return null; },
      extractViaVision: async (args) => { trace('extractViaVision', args); return null; },
      commitRates: async (args) => { trace('commitRates', args); return { wrote: true, path: '/tmp/fake_gift_rates.json' }; },
      commitToRegistry: async (args) => { trace('commitToRegistry', args); return { wrote: true }; },
      commitConfig: async (args) => { trace('commitConfig', args); return { wrote: true, path: '/tmp/fake_ibu_config.json' }; },
      classifyOutcome: async (args) => { trace('classifyOutcome', args); return { failure_class: 'success', ok: true }; },
      createSession: async () => { trace('createSession', {}); return session; },
    };

    const result = await orchestrate({
      bank_name: 'State Bank of India – IBU',
      bank_type: 'IBU',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    // IBU should query exactly one product (fd_gift) → exactly one variant (gift)
    assert.equal(calls.filter((c) => c.name === 'findRatePage').length, 1, 'IBU = 1 product only');
    const findRatePageCall = calls.find((c) => c.name === 'findRatePage');
    assert.equal(findRatePageCall.args.product, 'fd_gift', 'product must be fd_gift for IBU');

    // No retail NRI or domestic FD queries
    const products = calls.filter((c) => c.name === 'findRatePage').map((c) => c.args.product);
    assert.deepEqual(products, ['fd_gift']);

    // commit_rates was called with variant=gift
    const commitCall = calls.find((c) => c.name === 'commitRates');
    assert.equal(commitCall.args.variant, 'gift', 'commit_rates variant must be gift');

    // Result shape
    assert.equal(result.ok, true);
    assert.equal(result.bank_code, 'state-bank-of-india-ibu');
    assert.equal(result.variantSummary.gift?.status, 'committed');
    assert.equal(result.variantSummary.gift?.slabs, 3);
    assert.equal(result.variantSummary.regular, undefined, 'IBU does NOT produce regular variant');
    assert.equal(result.variantSummary.nre, undefined);
    assert.equal(result.variantSummary.nro, undefined);
    assert.equal(result.variantSummary.fcnr, undefined);
    assert.equal(result.signals.slabs_extracted_count, 3);

    // The committed slabs include per-currency tagging (USD/EUR)
    const committedSlabs = commitCall.args.payload.rate_slabs;
    const currencies = new Set(committedSlabs.map((s) => s.currency));
    assert.deepEqual([...currencies].sort(), ['EUR', 'USD']);
    assert.ok(committedSlabs.every((s) => s.rate_senior_pct === null), 'GIFT slabs have no senior rates');

    // Phase 3: session lifecycle works for IBU single-product flow.
    assert.equal(session._internals.closed, true, 'IBU run closes session in finally');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('orchestrate: rate_page failure for one variant does not break others', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-partial-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls } = buildMockActions();
    // FCNR rate page not found; other three variants succeed
    const realFindRatePage = actions.findRatePage;
    actions.findRatePage = async (args) => {
      if (args.product === 'fd_fcnr') {
        calls.push({ name: 'findRatePage', args });
        return { ok: false, error_class: 'no_link_found' };
      }
      return realFindRatePage(args);
    };

    const result = await orchestrate({
      bank_name: 'Mostly Working Bank',
      bank_type: 'PSB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    assert.equal(result.ok, true, 'overall ok=true: 3 of 4 variants still committed');
    assert.equal(result.variantSummary.regular?.status, 'committed');
    assert.equal(result.variantSummary.nre?.status, 'committed');
    assert.equal(result.variantSummary.nro?.status, 'committed');
    assert.equal(result.variantSummary.fcnr?.status, 'rate_page_not_found');
    assert.equal(result.variantSummary.fcnr?.reason, 'no_link_found');
    // 6 slabs from 3 variants (regular/nre/nro × 2 slabs each)
    assert.equal(result.signals.slabs_extracted_count, 6);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── Phase 3 fault-injection: createSession throwing ──────────────────────

test('orchestrate: createSession throws → continues without session, actions still run', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nosession-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls } = buildMockActions();
    actions.createSession = async () => { throw new Error('playwright not installed'); };

    const result = await orchestrate({
      bank_name: 'No Session Test Bank',
      bank_type: 'PSB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    // Orchestrator must absorb createSession failure and proceed with session=null
    // (graceful degradation — actions fall back to plain Node HTTP via _http.js).
    assert.equal(result.ok, true, 'orchestrate completes despite session unavailable');
    const findWebsiteCall = calls.find((c) => c.name === 'findWebsite');
    assert.equal(findWebsiteCall.args.session, null, 'session is null when createSession threw');
    // 4 variants still committed because mocks don't actually fetch.
    assert.equal(result.signals.slabs_extracted_count, 8);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('orchestrate: RDA_USE_PLAYWRIGHT_SESSION=0 bypass → createSession never called', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bypass-'));
  const prev = process.env.RDA_USE_PLAYWRIGHT_SESSION;
  process.env.RDA_USE_PLAYWRIGHT_SESSION = '0';
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls } = buildMockActions();

    const result = await orchestrate({
      bank_name: 'Bypass Test Bank',
      bank_type: 'PSB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.filter((c) => c.name === 'createSession').length, 0, 'flag bypass skips createSession entirely');
    const findWebsiteCall = calls.find((c) => c.name === 'findWebsite');
    assert.equal(findWebsiteCall.args.session, null, 'actions receive session=null under bypass');
  } finally {
    if (prev === undefined) delete process.env.RDA_USE_PLAYWRIGHT_SESSION;
    else process.env.RDA_USE_PLAYWRIGHT_SESSION = prev;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Sprint 4 A13: shared variant URLs trigger fetch_page exactly once per unique URL', async () => {
  // AU SFB-style: fd, fd_nre, fd_nro all map to the same URL but fd_fcnr is
  // separate. Without the per-URL cache, fetch_page was called 4 times and
  // the 2nd/3rd Playwright re-fetches occasionally returned empty bodies,
  // making classify_rate_page fall back to a stale html_js cached_kind and
  // extract_html_table fail instantly. With the cache: 2 unique URLs → 2
  // fetch_page calls, and every variant sees the same body bytes.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-url-cache-'));
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls } = buildMockActions();

    // Override findRatePage so fd/fd_nre/fd_nro share a URL.
    const sharedUrl = 'https://au.bank.in/interest-rates/fixed-deposit-interest-rates';
    const fcnrUrl  = 'https://au.bank.in/interest-rates/au-fcnr';
    actions.findRatePage = async (args) => {
      calls.push({ name: 'findRatePage', args });
      const url = args.product === 'fd_fcnr' ? fcnrUrl : sharedUrl;
      return { ok: true, url, product: args.product };
    };

    await orchestrate({
      bank_name: 'AU Small Finance Bank Limited',
      bank_type: 'SFB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'discover',
      actions,
    });

    const fetchCalls = calls.filter((c) => c.name === 'fetchPage');
    const uniqueUrls = new Set(fetchCalls.map((c) => c.args.url));
    assert.equal(fetchCalls.length, uniqueUrls.size, `fetch_page invoked once per unique URL (got ${fetchCalls.length} calls for ${uniqueUrls.size} URLs)`);
    assert.equal(fetchCalls.length, 2, 'AU-style 4-variant layout with 1 shared URL + 1 FCNR URL → 2 fetches total');
    // The shared URL was fetched exactly once.
    assert.equal(fetchCalls.filter((c) => c.args.url === sharedUrl).length, 1);
    // All four variants' classify calls received a non-empty cached_body —
    // the proof that the cached fetch was reused for fd_nre and fd_nro.
    const classifyCalls = calls.filter((c) => c.name === 'classifyRatePage');
    assert.equal(classifyCalls.length, 4, 'one classify call per variant');
    for (const c of classifyCalls) {
      assert.ok(c.args.hints?.cached_body && c.args.hints.cached_body.length > 0,
        `classify_rate_page for ${c.args.url} received a non-empty cached_body`);
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

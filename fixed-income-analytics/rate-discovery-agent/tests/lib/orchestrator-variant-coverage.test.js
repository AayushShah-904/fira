'use strict';

/**
 * Sprint 011 item 18 (2026-07-06) — variant coverage guarantee.
 *
 * Regression tests for the 2026-06-15 Axis FCNR miss:
 *   1. Registry-configured products are attempted even when bank_type
 *      resolution failed (UNKNOWN) — the union fix.
 *   2. CLI mode strings ("rates-only"/"expand-nri") are normalised before
 *      reaching find_rate_page/classify_rate_page (they THROW on unknown
 *      modes) — the actionMode fix.
 *   3. Phase 3.5 coverage loop recovers PDF/image variants whose commit was
 *      missed, is a no-op for fully-covered runs, and never duplicates a
 *      deterministic zero-slab attempt.
 *   4. input.only_products (--variant) restricts the run to one product.
 *
 * All tests use temp dirs + mocked actions via the input.actions DI seam
 * (see DEFAULT_ACTIONS in lib/orchestrator.js). No network, no Azure, and
 * never a write to output/latest/ or data/bank-domains.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { orchestrate } = require('../../lib/orchestrator');
const { mockSession } = require('../_helpers/mock_session');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fcnrSlabs() {
  // Valid FCNR shape: per-currency, no senior premium.
  return [
    { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 5.1, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'USD' },
    { tenure_text: '2 years', tenure_min_days: 730, tenure_max_days: 730, rate_general_pct: 4.8, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'GBP' },
  ];
}

function regularSlabs() {
  return [
    { tenure_text: '7 days to 45 days', tenure_min_days: 7, tenure_max_days: 45, rate_general_pct: 3.5, rate_senior_pct: 4.0, rate_super_senior_pct: null },
    { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.5, rate_senior_pct: 7.0, rate_super_senior_pct: 7.25 },
  ];
}

/**
 * Axis-shaped multi-URL bank: four products at four distinct PDF URLs
 * declared in cached_rate_pages. All mocks are PDF-kind.
 */
function axisShapedHints() {
  return {
    cached_domain: 'example-multi.bank.in',
    cached_rate_pages: {
      fd: 'https://example-multi.bank.in/docs/domestic.pdf',
      fd_nre: 'https://example-multi.bank.in/docs/nre.pdf',
      fd_nro: 'https://example-multi.bank.in/docs/nro.pdf',
      fd_fcnr: 'https://example-multi.bank.in/docs/fcnr.pdf',
    },
  };
}

/**
 * Mock action set for a multi-URL PDF bank. Each product's find_rate_page
 * resolves to its cached URL; extract_pdf_table returns one page whose
 * variant matches the iteration product.
 */
function buildPdfBankMocks({ commitRatesImpl, logs } = {}) {
  const calls = [];
  const trace = (name, args) => { calls.push({ name, args }); };
  const session = mockSession();
  const PRODUCT_TO_VARIANT = { fd: 'regular', fd_nre: 'nre', fd_nro: 'nro', fd_fcnr: 'fcnr', fd_gift: 'gift' };
  const actions = {
    findWebsite: async (args) => { trace('findWebsite', args); return { ok: true, url: 'https://example-multi.bank.in/', confidence: 'high' }; },
    findRatePage: async (args) => {
      trace('findRatePage', args);
      // Mirror the real contract: an unknown mode is an input-contract
      // violation and THROWS (lib/actions/find_rate_page.js VALID_MODES).
      if (!['discover', 'recheck'].includes(args.mode)) {
        throw new Error(`findRatePage: input.mode must be one of discover, recheck (got "${args.mode}")`);
      }
      return { ok: true, url: args.hints?.cached_path || `https://example-multi.bank.in/docs/${args.product}.pdf`, product: args.product };
    },
    fetchPage: async (args) => { trace('fetchPage', args); return { ok: true, body: '<html>x</html>', content_type: 'text/html', status_code: 200, final_url: args.url, truncated: false, fetched_via: 'session' }; },
    classifyRatePage: async (args) => {
      trace('classifyRatePage', args);
      if (!['discover', 'recheck'].includes(args.mode)) {
        throw new Error(`classifyRatePage: input.mode must be one of discover, recheck (got "${args.mode}")`);
      }
      return { ok: true, kind: 'pdf', url: args.url };
    },
    extractHtmlTable: async (args) => { trace('extractHtmlTable', args); return null; },
    extractPdfTable: async (args) => {
      trace('extractPdfTable', args);
      const variant = (args.expected?.variants || ['regular'])[0];
      const slabs = variant === 'fcnr' ? fcnrSlabs() : regularSlabs();
      return {
        pages: [{ page_number: 1, variant, slabs, effective_date: '2026-07-01' }],
        extraction_method: 'automatic_pdf',
      };
    },
    extractViaVision: async (args) => { trace('extractViaVision', args); return null; },
    extractViaOcr: async (args) => { trace('extractViaOcr', args); return { ok: true, pages: [], extraction_method: 'automatic_ocr', cost_pages: 0 }; },
    commitRates: async (args) => {
      trace('commitRates', args);
      if (commitRatesImpl) return commitRatesImpl(args);
      return { ok: true, wrote: true, target_path: '/tmp/fake.json' };
    },
    commitToRegistry: async (args) => { trace('commitToRegistry', args); return { wrote: true }; },
    commitConfig: async (args) => { trace('commitConfig', args); return { wrote: true }; },
    classifyOutcome: async (args) => { trace('classifyOutcome', args); return { failure_class: 'success', ok: true }; },
    createSession: async () => { trace('createSession', {}); return session; },
  };
  return { actions, calls, session, PRODUCT_TO_VARIANT, logs };
}

function collectLogger(logs) {
  return {
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    debug: (m) => logs.push(String(m)),
  };
}

// ── (root cause #1) configured products attempted despite bank_type=UNKNOWN ──

test('item 18: UNKNOWN bank_type + configured rate_pages → all 4 products attempted', async () => {
  const d = tempDir('vc-unknown-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls } = buildPdfBankMocks();

    const result = await orchestrate({
      bank_name: 'Example Multi Bank Limited',
      bank_type: 'UNKNOWN', // what the registry derivation yields when category is missing
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only', // the CLI string that used to leak into the actions
      hints: axisShapedHints(),
      actions,
    });

    const products = calls.filter((c) => c.name === 'findRatePage').map((c) => c.args.product);
    assert.deepEqual(products, ['fd', 'fd_nre', 'fd_nro', 'fd_fcnr'],
      'registry-configured NRI products must be attempted even when bank_type resolution failed');
    assert.equal(result.variantSummary.regular?.status, 'committed_multi_page');
    assert.equal(result.variantSummary.nre?.status, 'committed_multi_page');
    assert.equal(result.variantSummary.nro?.status, 'committed_multi_page');
    assert.equal(result.variantSummary.fcnr?.status, 'committed_multi_page');
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── (root cause #2) CLI mode strings normalised at the action boundary ──

test('item 18: mode="rates-only" without cached paths → actions receive a valid mode', async () => {
  const d = tempDir('vc-mode-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    // No hints at all: every product goes through the non-cached branch,
    // which used to forward "rates-only" verbatim and made findRatePage throw.
    const { actions, calls } = buildPdfBankMocks();

    const result = await orchestrate({
      bank_name: 'Example Multi Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      actions,
    });

    const modes = calls.filter((c) => c.name === 'findRatePage').map((c) => c.args.mode);
    assert.equal(modes.length, 4, 'PVB defaults: 4 products attempted');
    assert.ok(modes.every((m) => m === 'discover'), `non-cached products run in discover mode (got ${modes.join(',')})`);
    // All four variants extracted + committed — none died on the mode throw.
    for (const v of ['regular', 'nre', 'nro', 'fcnr']) {
      assert.equal(result.variantSummary[v]?.status, 'committed_multi_page', `variant ${v} committed`);
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── (a) multi-URL bank: coverage loop recovers a variant whose commit was missed ──

test('item 18(a): coverage loop recovers fcnr when its main-loop commit was missed', async () => {
  const d = tempDir('vc-recover-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const logs = [];
    // Simulate the missed commit: the FIRST commit for variant=fcnr reports
    // wrote:false (e.g. transient safe-write refusal); the retry succeeds.
    let fcnrCommitAttempts = 0;
    const { actions, calls } = buildPdfBankMocks({
      commitRatesImpl: (args) => {
        if (args.variant === 'fcnr') {
          fcnrCommitAttempts += 1;
          if (fcnrCommitAttempts === 1) return { ok: true, wrote: false, deferred_to_pending: false, validation: { passed: true, critical_count: 0 } };
        }
        return { ok: true, wrote: true };
      },
    });

    const result = await orchestrate({
      bank_name: 'Example Multi Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      hints: axisShapedHints(),
      actions,
      logger: collectLogger(logs),
    });

    // Coverage loop re-extracted the fcnr PDF and committed it.
    assert.equal(fcnrCommitAttempts, 2, 'fcnr committed once in main loop (missed) + once via coverage loop');
    assert.equal(result.variantSummary.fcnr?.status, 'committed_via_coverage_loop');
    assert.equal(result.variantSummary.fcnr?.slabs, 2);
    assert.equal(result.variantSummary.fcnr?.extractor, 'pdf');
    // Other variants untouched by the coverage loop.
    for (const v of ['regular', 'nre', 'nro']) {
      assert.equal(result.variantSummary[v]?.status, 'committed_multi_page', `variant ${v} stays main-loop committed`);
    }
    // The coverage extraction targeted the fcnr URL specifically.
    const coverageExtracts = calls.filter((c) => c.name === 'extractPdfTable' && c.args.url === 'https://example-multi.bank.in/docs/fcnr.pdf');
    assert.equal(coverageExtracts.length, 2, 'fcnr PDF extracted in main loop + coverage loop');
    // Operator-visible log line.
    assert.ok(logs.some((l) => l.includes('[variant-coverage] recovered variant=fcnr')), 'a [variant-coverage] recovery line is logged');
    // Slab totals include the recovered variant.
    assert.equal(result.signals.slabs_extracted_count, 8, '3×2 main-loop + 2 recovered fcnr slabs');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('item 18(a): OCR-hinted variant (Axis fd_image_ocr_fcnr shape) recovers via extractViaOcr', async () => {
  const d = tempDir('vc-ocr-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const logs = [];
    let fcnrCommits = 0;
    const { actions, calls } = buildPdfBankMocks({
      commitRatesImpl: (args) => {
        if (args.variant === 'fcnr') {
          fcnrCommits += 1;
          if (fcnrCommits === 1) return { ok: true, wrote: false };
        }
        return { ok: true, wrote: true };
      },
    });
    // OCR mock returns real pages (main loop AND coverage loop route fcnr
    // through it because of the image_ocr hint).
    actions.extractViaOcr = async (args) => {
      calls.push({ name: 'extractViaOcr', args });
      return {
        ok: true,
        pages: [{ page_number: 1, variant: 'fcnr', slabs: fcnrSlabs(), effective_date: null }],
        extraction_method: 'automatic_ocr',
        cost_pages: 1,
      };
    };

    const hints = {
      ...axisShapedHints(),
      cached_extraction: {
        fd_image_ocr_fcnr: { type: 'image_ocr', fulfills_product: ['fd_fcnr'] },
      },
    };
    // rate_pages needs the hint key too (extraction-hint resolves URL via rate_pages[key]).
    hints.cached_rate_pages.fd_image_ocr_fcnr = 'https://example-multi.bank.in/docs/fcnr.pdf';

    const result = await orchestrate({
      bank_name: 'Example Multi Bank Limited',
      bank_type: 'UNKNOWN', // exercises hint-driven product union too (fulfills_product)
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      hints,
      actions,
      logger: collectLogger(logs),
    });

    assert.equal(result.variantSummary.fcnr?.status, 'committed_via_coverage_loop');
    assert.equal(result.variantSummary.fcnr?.extractor, 'ocr');
    const ocrCalls = calls.filter((c) => c.name === 'extractViaOcr');
    assert.equal(ocrCalls.length, 2, 'OCR ran once in main loop (commit missed) + once in coverage loop');
    assert.equal(result.ocr_pages, 2, 'both OCR passes accounted in cost pages');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── (b) shared-URL bank: coverage loop is a NO-OP ──

test('item 18(b): single shared HTML URL, all variants committed → coverage loop is a no-op', async () => {
  const d = tempDir('vc-noop-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const logs = [];
    const { actions, calls } = buildPdfBankMocks();
    // All variants share one HTML page that yields slabs per variant.
    const sharedUrl = 'https://shared.bank.in/fd-interest-rates';
    actions.findRatePage = async (args) => {
      calls.push({ name: 'findRatePage', args });
      return { ok: true, url: sharedUrl, product: args.product };
    };
    actions.classifyRatePage = async (args) => {
      calls.push({ name: 'classifyRatePage', args });
      return { ok: true, kind: 'html_static', url: args.url };
    };
    actions.extractHtmlTable = async (args) => {
      calls.push({ name: 'extractHtmlTable', args });
      return { slabs: args.variant === 'fcnr' ? fcnrSlabs() : regularSlabs(), extraction_method: 'automatic_html_static', effective_date: '2026-07-01' };
    };

    const result = await orchestrate({
      bank_name: 'Shared Page Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      actions,
      logger: collectLogger(logs),
    });

    for (const v of ['regular', 'nre', 'nro', 'fcnr']) {
      assert.equal(result.variantSummary[v]?.status, 'committed', `variant ${v} committed via main loop`);
    }
    // No coverage-loop extraction: exactly 4 HTML extracts, zero PDF/OCR.
    assert.equal(calls.filter((c) => c.name === 'extractHtmlTable').length, 4);
    assert.equal(calls.filter((c) => c.name === 'extractPdfTable').length, 0);
    assert.equal(calls.filter((c) => c.name === 'extractViaOcr').length, 0);
    assert.ok(!logs.some((l) => l.includes('[variant-coverage] recovered')), 'no recovery log lines on a fully-covered run');
    // Exactly one commit per variant.
    assert.equal(calls.filter((c) => c.name === 'commitRates').length, 4);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('item 18(b2): coverage loop skips a zero-slab URL the main loop already tried (no duplicate deterministic attempt)', async () => {
  const d = tempDir('vc-dup-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const logs = [];
    const { actions, calls } = buildPdfBankMocks();
    // fcnr PDF yields zero slabs deterministically.
    actions.extractPdfTable = async (args) => {
      calls.push({ name: 'extractPdfTable', args });
      const variant = (args.expected?.variants || ['regular'])[0];
      if (variant === 'fcnr') return { pages: [], extraction_method: 'automatic_pdf' };
      return { pages: [{ page_number: 1, variant, slabs: regularSlabs(), effective_date: null }], extraction_method: 'automatic_pdf' };
    };

    const result = await orchestrate({
      bank_name: 'Example Multi Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      hints: axisShapedHints(),
      actions,
      logger: collectLogger(logs),
    });

    // Main loop tried the fcnr PDF once (0 slabs); coverage loop must NOT re-run it.
    const fcnrExtracts = calls.filter((c) => c.name === 'extractPdfTable' && c.args.url === 'https://example-multi.bank.in/docs/fcnr.pdf');
    assert.equal(fcnrExtracts.length, 1, 'same URL + same engine + 0 slabs → coverage loop skips');
    assert.ok(logs.some((l) => l.includes('skipping duplicate attempt')), 'skip decision is logged');
    assert.equal(result.variantSummary.fcnr?.status, 'committed_multi_page', 'fcnr keeps its main-loop status (0 slabs committed)');
    assert.equal(result.variantSummary.fcnr?.slabs, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── (c) only_products allowlist (--variant fcnr) ──

test('item 18(c): only_products=[fd_fcnr] runs exactly one product', async () => {
  const d = tempDir('vc-only-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const { actions, calls } = buildPdfBankMocks();

    const result = await orchestrate({
      bank_name: 'Example Multi Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      only_products: ['fd_fcnr'],
      hints: axisShapedHints(),
      actions,
    });

    const products = calls.filter((c) => c.name === 'findRatePage').map((c) => c.args.product);
    assert.deepEqual(products, ['fd_fcnr'], '--variant fcnr → only fd_fcnr attempted');
    assert.equal(result.variantSummary.fcnr?.status, 'committed_multi_page');
    assert.equal(result.variantSummary.regular, undefined, 'regular not touched under the allowlist');
    assert.equal(result.variantSummary.nre, undefined);
    assert.equal(result.variantSummary.nro, undefined);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── Sprint 011 hint-fallback (2026-07-07): rolled dated-PDF hint URLs ──
//
// Axis-shaped registry entry: rate_pages.fd is a live HTML landing page,
// and a separate fd_pdf_domestic key carries a DATED pdf URL with an
// extraction hint (fulfills_product: 'fd'). Banks roll those dated
// filenames, so the hinted URL 404s while the default page stays alive.

function rolledHintHints({ defaultFdPath = '/deposits/fixed-deposits/fd-interest-rates' } = {}) {
  return {
    cached_domain: 'axis-shaped.bank.in',
    cached_rate_pages: {
      fd: defaultFdPath,
      fd_pdf_domestic: 'https://axis-shaped.bank.in/docs/domestic-fixed-deposits-13-june-26.pdf',
    },
    cached_extraction: {
      fd_pdf_domestic: { type: 'pdf', fulfills_product: 'fd' },
    },
  };
}

const ROLLED_PDF_URL = 'https://axis-shaped.bank.in/docs/domestic-fixed-deposits-13-june-26.pdf';

/** Mocks where any .pdf URL 404s (fetch-class envelope) and HTML pages extract fine. */
function buildRolledHintMocks() {
  const { actions, calls } = buildPdfBankMocks();
  actions.findRatePage = async (args) => {
    calls.push({ name: 'findRatePage', args });
    if (!['discover', 'recheck'].includes(args.mode)) {
      throw new Error(`findRatePage: input.mode must be one of discover, recheck (got "${args.mode}")`);
    }
    const cached = args.hints?.cached_path;
    if (cached) {
      const url = cached.startsWith('http') ? cached : `https://axis-shaped.bank.in${cached}`;
      return { ok: true, url, product: args.product };
    }
    return { ok: true, url: 'https://axis-shaped.bank.in/discovered', product: args.product };
  };
  actions.classifyRatePage = async (args) => {
    calls.push({ name: 'classifyRatePage', args });
    return { ok: true, kind: /\.pdf(\?|$)/i.test(args.url) ? 'pdf' : 'html_static', url: args.url };
  };
  actions.extractPdfTable = async (args) => {
    calls.push({ name: 'extractPdfTable', args });
    // Mirrors extract_pdf_table's Sprint 011 fetch-class envelope for a
    // rolled dated URL (download HTTP 404, no bytes obtained).
    return { ok: false, failure_class: 'fetch', http_status: 404, error_message: 'download HTTP 404' };
  };
  actions.extractHtmlTable = async (args) => {
    calls.push({ name: 'extractHtmlTable', args });
    return { slabs: regularSlabs(), extraction_method: 'automatic_html_static', effective_date: '2026-07-01' };
  };
  return { actions, calls };
}

test('hint-fallback(a): hinted PDF 404 → falls back to default rate page and commits its slabs (single commit)', async () => {
  const d = tempDir('hf-404-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const logs = [];
    const { actions, calls } = buildRolledHintMocks();

    const result = await orchestrate({
      bank_name: 'Axis Shaped Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      only_products: ['fd'],
      hints: rolledHintHints(),
      actions,
      logger: collectLogger(logs),
    });

    // Fallback ran the normal un-hinted path and committed the HTML slabs.
    assert.equal(result.variantSummary.regular?.status, 'committed');
    assert.equal(result.variantSummary.regular?.slabs, 2);
    assert.equal(result.ok, true);
    assert.equal(result.signals.slabs_extracted_count, 2);

    // Hinted attempt tried the dated PDF exactly once; fallback used HTML.
    const pdfCalls = calls.filter((c) => c.name === 'extractPdfTable');
    assert.equal(pdfCalls.length, 1, 'hinted PDF attempted once, never re-tried');
    assert.equal(pdfCalls[0].args.url, ROLLED_PDF_URL);
    const htmlCalls = calls.filter((c) => c.name === 'extractHtmlTable');
    assert.equal(htmlCalls.length, 1, 'default rate page extracted once');
    assert.equal(htmlCalls[0].args.url, 'https://axis-shaped.bank.in/deposits/fixed-deposits/fd-interest-rates');

    // Exactly ONE commit — the fallback never double-commits, and the
    // coverage loop skips the covered variant.
    assert.equal(calls.filter((c) => c.name === 'commitRates').length, 1);
    assert.ok(!logs.some((l) => l.includes('[variant-coverage] recovered')), 'coverage loop stays a no-op');

    // Operator-visible fallback log line.
    assert.ok(
      logs.some((l) => l.includes('product=fd: hinted URL failed (HTTP 404) — falling back to default rate page /deposits/fixed-deposits/fd-interest-rates')),
      `fallback log line present (got: ${logs.filter((l) => l.includes('hinted')).join(' | ')})`,
    );

    // Runtime-only: no registry update ever touches the extraction hints.
    const registryCalls = calls.filter((c) => c.name === 'commitToRegistry');
    assert.ok(registryCalls.every((c) => !('extraction' in (c.args.updates || {}))), 'registry extraction hints untouched');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('hint-fallback(b): hinted PDF fetches OK but yields 0 slabs → NO fallback, no duplicate extraction', async () => {
  const d = tempDir('hf-0slab-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const logs = [];
    const { actions, calls } = buildRolledHintMocks();
    // Download succeeded, parse produced nothing → extract_pdf_table's real
    // contract returns null (parse-class), NOT the fetch envelope.
    actions.extractPdfTable = async (args) => {
      calls.push({ name: 'extractPdfTable', args });
      return null;
    };

    const result = await orchestrate({
      bank_name: 'Axis Shaped Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      only_products: ['fd'],
      hints: rolledHintHints(),
      actions,
      logger: collectLogger(logs),
    });

    // No fallback: default page never visited, no second extraction pass.
    assert.ok(!logs.some((l) => l.includes('falling back to default rate page')), 'no fallback log on a parse-class failure');
    assert.equal(calls.filter((c) => c.name === 'extractHtmlTable').length, 0, 'default HTML page never extracted');
    assert.equal(result.variantSummary.regular?.status, 'extraction_failed');
    assert.equal(calls.filter((c) => c.name === 'commitRates').length, 0, 'nothing committed');

    // Coverage loop also declines to re-run the same deterministic attempt.
    assert.equal(calls.filter((c) => c.name === 'extractPdfTable').length, 1, 'PDF extracted exactly once across main + coverage loops');
    assert.ok(logs.some((l) => l.includes('skipping duplicate attempt')), 'coverage-loop dedup guard engaged');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('hint-fallback(c): fallback attempt also fetch-fails → terminal extraction_failed, exactly one retry', async () => {
  const d = tempDir('hf-double404-');
  try {
    fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
    const logs = [];
    // Default fd page is ALSO a (rolled) PDF → both attempts 404.
    const { actions, calls } = buildRolledHintMocks();

    const result = await orchestrate({
      bank_name: 'Axis Shaped Bank Limited',
      bank_type: 'PVB',
      output_dir: d,
      run_dir: d,
      domains_file: path.join(d, 'bank-domains.json'),
      mode: 'rates-only',
      only_products: ['fd'],
      hints: rolledHintHints({ defaultFdPath: '/docs/also-rolled.pdf' }),
      actions,
      logger: collectLogger(logs),
    });

    assert.equal(result.variantSummary.regular?.status, 'extraction_failed');
    assert.equal(result.variantSummary.regular?.reason, 'fetch_failed');
    // One hinted attempt + one un-hinted fallback attempt — never a third
    // (the coverage loop's dedup guard sees the hinted URL already tried).
    assert.equal(calls.filter((c) => c.name === 'extractPdfTable').length, 2);
    assert.equal(logs.filter((l) => l.includes('falling back to default rate page')).length, 1, 'exactly one fallback per product');
    assert.equal(calls.filter((c) => c.name === 'commitRates').length, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── (d) idempotency: second identical run does not duplicate ──

test('item 18(d): two identical runs through the REAL commitRates produce a stable rates file', async () => {
  // Uses the real commit_rates → safe-write chain against a temp output_dir
  // (never output/latest/). Everything upstream is mocked.
  const outDir = tempDir('vc-idem-out-');
  const runDir1 = tempDir('vc-idem-run1-');
  const runDir2 = tempDir('vc-idem-run2-');
  const domainsFile = path.join(runDir1, 'bank-domains.json');
  fs.writeFileSync(domainsFile, '{}\n');
  try {
    const runOnce = async (runDir) => {
      const { actions } = buildPdfBankMocks();
      delete actions.commitRates; // fall through to the real commit_rates action
      return orchestrate({
        bank_name: 'Idempotent Test Bank Limited',
        bank_type: 'PVB',
        output_dir: outDir,
        run_dir: runDir,
        domains_file: domainsFile,
        mode: 'rates-only',
        only_products: ['fd'],
        hints: { cached_domain: 'example-multi.bank.in', cached_rate_pages: { fd: 'https://example-multi.bank.in/docs/domestic.pdf' } },
        actions,
      });
    };

    const r1 = await runOnce(runDir1);
    assert.equal(r1.variantSummary.regular?.status, 'committed_multi_page');
    const ratesPath = path.join(outDir, 'idempotent-test-bank-limited_rates.json');
    assert.ok(fs.existsSync(ratesPath), 'rates file written to temp output_dir');
    const first = JSON.parse(fs.readFileSync(ratesPath, 'utf-8'));
    assert.equal(first.rate_slabs.length, 2);

    const r2 = await runOnce(runDir2);
    assert.equal(r2.variantSummary.regular?.status, 'committed_multi_page');
    const second = JSON.parse(fs.readFileSync(ratesPath, 'utf-8'));
    assert.equal(second.rate_slabs.length, 2, 'second run does not duplicate slabs');
    assert.deepEqual(second.rate_slabs, first.rate_slabs, 'slab content identical across runs');
    // Exactly one rates file for this bank — no ghost variant files appeared.
    const bankFiles = fs.readdirSync(outDir).filter((f) => f.startsWith('idempotent-test-bank-limited') && f.endsWith('_rates.json'));
    assert.deepEqual(bankFiles, ['idempotent-test-bank-limited_rates.json']);
  } finally {
    for (const d of [outDir, runDir1, runDir2]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── Fix A follow-on (2026-07-07): per-bank expected_currencies override ──

test('fcnr expected_currencies: registry extraction.fd_fcnr override reaches extractHtmlTable; default applies otherwise', async () => {
  const runOnce = async (cachedExtraction) => {
    const d = tempDir('vc-ccy-');
    try {
      fs.writeFileSync(path.join(d, 'bank-domains.json'), '{}\n');
      const { actions, calls } = buildPdfBankMocks();
      // HTML-kind bank so the extract_html_table hint site is exercised.
      actions.classifyRatePage = async (args) => ({ ok: true, kind: 'html_static', url: args.url });
      actions.extractHtmlTable = async (args) => { calls.push({ name: 'extractHtmlTable', args }); return null; };
      await orchestrate({
        bank_name: 'Example Multi Bank Limited',
        bank_type: 'FB',
        output_dir: d,
        run_dir: d,
        domains_file: path.join(d, 'bank-domains.json'),
        mode: 'rates-only',
        hints: { ...axisShapedHints(), ...(cachedExtraction ? { cached_extraction: cachedExtraction } : {}) },
        actions,
      });
      const fcnrCall = calls.find((c) => c.name === 'extractHtmlTable' && c.args.variant === 'fcnr');
      assert.ok(fcnrCall, 'fd_fcnr must reach extractHtmlTable');
      return fcnrCall.args.hints.expected_currencies;
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  };

  // With the registry override (emirates-nbd class: USD-only FCNR menu).
  const overridden = await runOnce({ fd_fcnr: { expected_currencies: ['USD'] } });
  assert.deepEqual(overridden, ['USD']);

  // Without an override: fleet default of 6.
  const defaulted = await runOnce(null);
  assert.deepEqual(defaulted, ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD']);
});

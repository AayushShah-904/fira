'use strict';

/**
 * Tests for Fix A (sprint-011, fcnr-yield-root-cause-2026-07-07) —
 * currency-aware chunk selection for fcnr/gift in the LLM-fallback path of
 * lib/actions/extract_html_table.js.
 *
 * Root cause: ~13 banks (PNB, UCO, idbi, …) publish ALL variants on one
 * consolidated rates page. For variant=fcnr the generic "top-6 rate-bearing
 * chunks" selection fed the LLM the dominant INR FD table; extraction then
 * correctly died at the missing_currency_multi backstop — wasted LLM calls
 * and an imprecise triage signal.
 *
 * Fix under test:
 *   (a) fcnr/gift: only currency-bearing chunks (≥2 distinct currency
 *       tokens) are sent to the LLM, ranked by distinct-currency count;
 *   (b) no currency-bearing chunk at all → fail fast with reason
 *       `no_currency_chunk` BEFORE any LLM call;
 *   (c) all other variants: chunk set completely unchanged.
 *
 * No network: pages come in via hints.cached_body; the AOAI client is
 * mocked by patching the exports of lib/azure-openai-client (the extractor
 * requires it lazily at call time, so the patch is picked up).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractHtmlTable,
  _filterChunksForCurrencyVariant,
  extractTableChunksReExport: extractTableChunks,
} = require('../../../lib/actions/extract_html_table');

const { detectCurrencyTokens } = require('../../../scripts/utils/normalise-currency');

// Patched in the integration tests below. Lazy-required by the extractor,
// so mutating the exports object here is picked up at call time.
const aoai = require('../../../lib/azure-openai-client');

// ── Fixtures (synthetic, no network) ────────────────────────────────────

// Consolidated all-variant page: dominant INR FD table (7 rows, includes the
// distinctive "444 days" special-tenure marker) + smaller FCNR currency
// matrix (currency column headers USD/GBP/EUR/JPY).
const CONSOLIDATED_PAGE_HTML = `
<html><body>
  <h2>Domestic Term Deposit Rates</h2>
  <table>
    <tr><th>Tenure</th><th>General Public</th><th>Senior Citizen</th></tr>
    <tr><td>7 days to 14 days</td><td>3.50%</td><td>4.00%</td></tr>
    <tr><td>15 days to 45 days</td><td>4.00%</td><td>4.50%</td></tr>
    <tr><td>46 days to 90 days</td><td>4.50%</td><td>5.00%</td></tr>
    <tr><td>91 days to 179 days</td><td>5.25%</td><td>5.75%</td></tr>
    <tr><td>180 days to 364 days</td><td>5.75%</td><td>6.25%</td></tr>
    <tr><td>444 days</td><td>7.25%</td><td>7.75%</td></tr>
    <tr><td>2 years to 3 years</td><td>6.80%</td><td>7.30%</td></tr>
  </table>
  <h2>FCNR (B) Deposit Rates</h2>
  <table>
    <tr><th>Maturity</th><th>USD</th><th>GBP</th><th>EUR</th><th>JPY</th></tr>
    <tr><td>1 year to less than 2 years</td><td>5.10</td><td>4.75</td><td>3.25</td><td>0.55</td></tr>
    <tr><td>2 years to less than 3 years</td><td>4.60</td><td>4.25</td><td>3.05</td><td>0.45</td></tr>
    <tr><td>3 years to less than 4 years</td><td>4.30</td><td>4.05</td><td>2.85</td><td>0.35</td></tr>
  </table>
</body></html>
`;

// Page with rate tables but ZERO currency tokens anywhere — the class-C
// "page has no FCNR content" shape.
const INR_ONLY_PAGE_HTML = `
<html><body>
  <h2>Deposit Rates</h2>
  <table>
    <tr><th>Tenure</th><th>General Public</th><th>Senior Citizen</th></tr>
    <tr><td>7 days to 14 days</td><td>3.50%</td><td>4.00%</td></tr>
    <tr><td>15 days to 45 days</td><td>4.00%</td><td>4.50%</td></tr>
    <tr><td>91 days to 179 days</td><td>5.25%</td><td>5.75%</td></tr>
    <tr><td>1 year to 2 years</td><td>6.50%</td><td>7.00%</td></tr>
    <tr><td>2 years to 3 years</td><td>6.80%</td><td>7.30%</td></tr>
  </table>
  <table>
    <tr><th>Tenure</th><th>Bulk Rate</th></tr>
    <tr><td>1 year</td><td>6.90%</td></tr>
    <tr><td>2 years</td><td>7.10%</td></tr>
  </table>
</body></html>
`;

// jkb-style page (addendum 2026-07-07): the currency grid uses spelled-out
// currency NAMES with zero ISO codes.
const NAME_FORM_FCNR_PAGE_HTML = `
<html><body>
  <h2>Foreign Currency Deposit Rates</h2>
  <table>
    <tr><th>Period</th><th>US Dollar</th><th>Euro</th><th>Yen</th></tr>
    <tr><td>1 year to less than 2 years</td><td>5.10</td><td>3.25</td><td>0.55</td></tr>
    <tr><td>2 years to less than 3 years</td><td>4.60</td><td>3.05</td><td>0.45</td></tr>
  </table>
</body></html>
`;

const SIX_CURRENCIES = ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD'];

// ── AOAI mock plumbing ──────────────────────────────────────────────────

/**
 * Patch lib/azure-openai-client exports for the duration of `fn`.
 * `respond(params)` receives the chatCompletion params and returns the
 * parsed-JSON payload to wrap in an OpenAI-shaped response.
 */
async function withMockedAoai(respond, fn) {
  const savedEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const savedCreate = aoai.createClient;
  const savedChat = aoai.chatCompletion;
  const calls = [];
  process.env.AZURE_OPENAI_ENDPOINT = 'https://unit-test.invalid';
  aoai.createClient = () => ({ mocked: true });
  aoai.chatCompletion = async (_client, params) => {
    calls.push(params);
    const payload = respond(params);
    return {
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
  };
  try {
    return await fn(calls);
  } finally {
    if (savedEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = savedEndpoint;
    else delete process.env.AZURE_OPENAI_ENDPOINT;
    aoai.createClient = savedCreate;
    aoai.chatCompletion = savedChat;
  }
}

// ── detectCurrencyTokens (shared util) ──────────────────────────────────

test('detectCurrencyTokens: ISO codes are word-boundaried and case-sensitive', () => {
  assert.deepEqual([...detectCurrencyTokens('Rates in USD, GBP and EUR')].sort(), ['EUR', 'GBP', 'USD']);
  // "audit"/"CASCADE"/lowercase codes must NOT count.
  assert.equal(detectCurrencyTokens('annual audit of the CASCADE model; usd amounts').size, 0);
  // "Europe" must not count as EUR.
  assert.equal(detectCurrencyTokens('branches across Europe').size, 0);
});

test('detectCurrencyTokens: spelled-out names count (jkb-style, zero ISO codes)', () => {
  const found = detectCurrencyTokens('US Dollar / Euro / Yen deposit slabs');
  assert.deepEqual([...found].sort(), ['EUR', 'JPY', 'USD']);
  assert.ok(detectCurrencyTokens('Pound Sterling and Swiss Franc').has('GBP'));
  assert.ok(detectCurrencyTokens('Pound Sterling and Swiss Franc').has('CHF'));
});

test('detectCurrencyTokens: bare "Dollar" is ambiguous and never counted', () => {
  assert.equal(detectCurrencyTokens('Dollar deposits welcome').size, 0);
  // Qualified forms do count.
  assert.ok(detectCurrencyTokens('Canadian Dollar').has('CAD'));
  assert.ok(detectCurrencyTokens('Australian Dollar').has('AUD'));
});

// ── _filterChunksForCurrencyVariant (pure) ──────────────────────────────

test('filter: fcnr keeps only currency-bearing chunks, ranked by distinct count', () => {
  const chunks = extractTableChunks(CONSOLIDATED_PAGE_HTML).filter((c) => c.score > 0);
  assert.equal(chunks.length, 2, 'fixture should chunk into 2 rate-bearing tables');
  const r = _filterChunksForCurrencyVariant(chunks, 'fcnr', SIX_CURRENCIES);
  assert.equal(r.filtered, true);
  assert.equal(r.rejected, false);
  assert.equal(r.chunks.length, 1, 'only the FCNR matrix chunk survives');
  assert.match(r.chunks[0].tableHtml, /GBP/);
  assert.ok(!/444 days/.test(r.chunks[0].tableHtml), 'INR chunk dropped');
  assert.deepEqual(r.counts, [4], 'USD/GBP/EUR/JPY = 4 distinct');
});

test('filter: name-form currency headers (no ISO codes) still qualify', () => {
  const chunks = extractTableChunks(NAME_FORM_FCNR_PAGE_HTML).filter((c) => c.score > 0);
  assert.equal(chunks.length, 1);
  const r = _filterChunksForCurrencyVariant(chunks, 'fcnr', SIX_CURRENCIES);
  assert.equal(r.rejected, false);
  assert.equal(r.chunks.length, 1);
  assert.ok(r.counts[0] >= 2, `US Dollar/Euro/Yen should count as >=2 distinct (got ${r.counts[0]})`);
});

test('filter: no currency chunk anywhere → rejected with no_currency_chunk', () => {
  const chunks = extractTableChunks(INR_ONLY_PAGE_HTML).filter((c) => c.score > 0);
  assert.ok(chunks.length >= 1);
  const r = _filterChunksForCurrencyVariant(chunks, 'fcnr', SIX_CURRENCIES);
  assert.equal(r.filtered, true);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /^no_currency_chunk:/);
  assert.match(r.reason, /no currency-keyed content/);
});

test('filter: single expected currency lowers threshold to >=1 (Saraswat-style)', () => {
  const usdOnly = `
    <html><body><table>
      <tr><th>Tenure</th><th>USD Rate</th></tr>
      <tr><td>1 year to 2 years</td><td>4.50%</td></tr>
      <tr><td>2 years to 3 years</td><td>4.30%</td></tr>
    </table></body></html>`;
  const chunks = extractTableChunks(usdOnly).filter((c) => c.score > 0);
  assert.equal(chunks.length, 1);
  // Multi-currency expectation: 1 distinct token < 2 → rejected.
  const multi = _filterChunksForCurrencyVariant(chunks, 'fcnr', SIX_CURRENCIES);
  assert.equal(multi.rejected, true);
  // Single-currency expectation: >=1 qualifies.
  const single = _filterChunksForCurrencyVariant(chunks, 'fcnr', ['USD']);
  assert.equal(single.rejected, false);
  assert.equal(single.chunks.length, 1);
});

test('filter: per-currency-table layout — union of single-currency chunks qualifies (emirates-nbd class)', () => {
  // One table per currency: every chunk has exactly 1 distinct token, but the
  // union spans 3 currencies — all single-currency chunks must be kept.
  // Synthetic chunk objects (extractTableChunks context windows can bleed a
  // neighbouring heading into the adjacent chunk, which would give some
  // chunks 2 tokens and bypass the union path this test must exercise).
  const mkChunk = (ccy, rate) => ({
    tableHtml: `<table><tr><th>Tenure</th><th>${ccy} Rate</th></tr><tr><td>1 year to 2 years</td><td>${rate}%</td></tr></table>`,
    contextHtml: '',
    score: 1,
  });
  const chunks = [mkChunk('USD', '4.50'), mkChunk('GBP', '4.10'), mkChunk('JPY', '0.01')];
  const r = _filterChunksForCurrencyVariant(chunks, 'fcnr', SIX_CURRENCIES);
  assert.equal(r.rejected, false, r.reason || '');
  assert.equal(r.chunks.length, 3, 'all three single-currency chunks kept');
  // A single lone-currency table (union < 2) still fails fast.
  const r2 = _filterChunksForCurrencyVariant([mkChunk('USD', '4.50')], 'fcnr', SIX_CURRENCIES);
  assert.equal(r2.rejected, true);
});

test('filter: non-fcnr/gift variants pass through untouched', () => {
  const chunks = extractTableChunks(CONSOLIDATED_PAGE_HTML).filter((c) => c.score > 0);
  for (const variant of ['regular', 'nre', 'nro']) {
    const r = _filterChunksForCurrencyVariant(chunks, variant, SIX_CURRENCIES);
    assert.equal(r.filtered, false, `${variant} must not be filtered`);
    assert.equal(r.chunks, chunks, `${variant} chunk array identity preserved`);
  }
});

// ── Integration through extractHtmlTable (mocked AOAI, cached_body) ────

test('fcnr on consolidated page: LLM receives ONLY the currency-bearing chunk', async () => {
  // The mock answers with the full 3-tenure × 4-currency matrix; every
  // source_row_text traces verbatim to the FCNR chunk so the
  // anti-fabrication validator keeps all 12 slabs.
  const rows = [
    { t: '1 year to less than 2 years', rates: { USD: 5.10, GBP: 4.75, EUR: 3.25, JPY: 0.55 }, row: '1 year to less than 2 years 5.10 4.75 3.25 0.55' },
    { t: '2 years to less than 3 years', rates: { USD: 4.60, GBP: 4.25, EUR: 3.05, JPY: 0.45 }, row: '2 years to less than 3 years 4.60 4.25 3.05 0.45' },
    { t: '3 years to less than 4 years', rates: { USD: 4.30, GBP: 4.05, EUR: 2.85, JPY: 0.35 }, row: '3 years to less than 4 years 4.30 4.05 2.85 0.35' },
  ];
  const rate_slabs = [];
  for (const r of rows) {
    for (const [currency, rate] of Object.entries(r.rates)) {
      rate_slabs.push({
        tenure_text: r.t,
        tenure_min_days: 365,
        tenure_max_days: 729,
        rate_general_pct: rate,
        currency,
        source_row_text: r.row,
      });
    }
  }
  await withMockedAoai(
    () => ({ rate_slabs, effective_date: null, warnings: [], errors: [] }),
    async (calls) => {
      const out = await extractHtmlTable({
        url: 'https://example.com/consolidated',
        kind: 'html_static',
        variant: 'fcnr',
        hints: { cached_body: CONSOLIDATED_PAGE_HTML, expected_currencies: SIX_CURRENCIES },
      });
      assert.equal(calls.length, 1, 'exactly one chunk (the FCNR matrix) goes to the LLM');
      const userMsg = calls[0].messages.find((m) => m.role === 'user').content;
      assert.match(userMsg, /GBP/, 'LLM saw the currency-keyed chunk');
      assert.ok(!/444 days/.test(userMsg), 'LLM never saw the INR table chunk');
      assert.ok(out, 'extraction succeeds');
      assert.equal(out.path_used, 'llm_fallback');
      const currencies = new Set(out.slabs.map((s) => s.currency));
      assert.ok(currencies.has('GBP') && currencies.has('JPY'), `per-currency slabs present (got ${[...currencies].join(',')})`);
    },
  );
});

test('fcnr on currency-less page: fast-fail no_currency_chunk, LLM never called', async () => {
  await withMockedAoai(
    () => { throw new Error('LLM must not be called'); },
    async (calls) => {
      const out = await extractHtmlTable({
        url: 'https://example.com/inr-only',
        kind: 'html_static',
        variant: 'fcnr',
        hints: { cached_body: INR_ONLY_PAGE_HTML, expected_currencies: SIX_CURRENCIES },
      });
      assert.equal(calls.length, 0, 'no LLM call for a page with zero currency tokens');
      // missing_currency backstops still reject the currency-less result.
      assert.equal(out, null);
    },
  );
});

// ── Per-chunk error scoping (sprint-011, rbl-gift-2026-07-08) ────────────
//
// RBL's GIFT-City page (.satable div-wrapped <table>s) has a currency matrix
// AND a large fees/charges table. The charges table trips the currency-token
// count (it mentions "USD 200", "USD 100", …) so it survives chunk selection,
// but the LLM correctly returns { rate_slabs: [], errors: ["no ... table"] }
// for it. Previously ANY chunk error poisoned the WHOLE LLM result — nuking
// the 60 good currency-matrix slabs — and the mis-mapped deterministic slabs
// then died at the missing_currency_multi backstop → null. The fix scopes an
// error to its chunk: a zero-slab chunk's error is informational, not blocking.
const RBL_STYLE_MATRIX_AND_CHARGES_HTML = `
<html><body>
  <h2>GIFT City Term Deposit Rates</h2>
  <div class="satable">
    <table>
      <tr><th>Tenor</th><th>USD</th><th>EUR</th><th>GBP</th><th>AUD</th><th>JPY</th><th>AED</th></tr>
      <tr><td>7 days to 30 days</td><td>3.25%</td><td>2.00%</td><td>3.25%</td><td>2.90%</td><td>0.10%</td><td>3.20%</td></tr>
      <tr><td>31 days to 90 days</td><td>3.60%</td><td>2.10%</td><td>3.40%</td><td>3.50%</td><td>0.40%</td><td>3.15%</td></tr>
      <tr><td>91 days to 120 days</td><td>3.80%</td><td>2.20%</td><td>3.20%</td><td>3.25%</td><td>0.35%</td><td>3.40%</td></tr>
    </table>
  </div>
  <h2>Schedule of Charges</h2>
  <div class="satable">
    <table>
      <tr><th>Sr. No.</th><th>Description of Charges</th><th>Charges/Amount</th></tr>
      <tr><td>1.1</td><td>Commitment + Usance charges</td><td>0.30% p.a. subject to a minimum of USD 200</td></tr>
      <tr><td>1.2</td><td>LCs against cash margin</td><td>0.20% p.a. subject to a minimum of USD 100</td></tr>
      <tr><td>1.3</td><td>Amendment charges</td><td>Flat USD 50 per amendment; min GBP 40</td></tr>
    </table>
  </div>
</body></html>
`;

test('fcnr: a zero-slab chunk error does NOT discard good slabs from other chunks (RBL GIFT class)', async () => {
  // The matrix chunk → 3 tenors × 6 currencies = 18 slabs, no errors.
  // The charges chunk → empty slabs + a "no rates table found" error.
  const matrixRows = [
    { t: '7 days to 30 days', min: 7, max: 30, rates: { USD: 3.25, EUR: 2.00, GBP: 3.25, AUD: 2.90, JPY: 0.10, AED: 3.20 }, row: '7 days to 30 days 3.25% 2.00% 3.25% 2.90% 0.10% 3.20%' },
    { t: '31 days to 90 days', min: 31, max: 90, rates: { USD: 3.60, EUR: 2.10, GBP: 3.40, AUD: 3.50, JPY: 0.40, AED: 3.15 }, row: '31 days to 90 days 3.60% 2.10% 3.40% 3.50% 0.40% 3.15%' },
    { t: '91 days to 120 days', min: 91, max: 120, rates: { USD: 3.80, EUR: 2.20, GBP: 3.20, AUD: 3.25, JPY: 0.35, AED: 3.40 }, row: '91 days to 120 days 3.80% 2.20% 3.20% 3.25% 0.35% 3.40%' },
  ];
  const matrixSlabs = [];
  for (const r of matrixRows) {
    for (const [currency, rate] of Object.entries(r.rates)) {
      matrixSlabs.push({ tenure_text: r.t, tenure_min_days: r.min, tenure_max_days: r.max, rate_general_pct: rate, currency, source_row_text: r.row });
    }
  }

  await withMockedAoai(
    (params) => {
      const userMsg = params.messages.find((m) => m.role === 'user').content;
      // The charges chunk carries "Description of Charges"; the model returns
      // an error + no slabs for it. The matrix chunk returns the full grid.
      if (/Description of Charges|Commitment|Usance/.test(userMsg)) {
        return { rate_slabs: [], effective_date: null, warnings: [], errors: ['no GIFT City / IFSC Banking Unit deposit rates table found in input'] };
      }
      return { rate_slabs: matrixSlabs, effective_date: null, warnings: [], errors: [] };
    },
    async (calls) => {
      const out = await extractHtmlTable({
        url: 'https://rbl.bank.in/gift-city',
        kind: 'html_js',
        variant: 'gift',
        hints: { cached_body: RBL_STYLE_MATRIX_AND_CHARGES_HTML, expected_currencies: ['USD', 'EUR', 'GBP', 'AUD', 'JPY', 'AED'] },
      });
      assert.ok(calls.length >= 2, `both the matrix and charges chunks reach the LLM (got ${calls.length})`);
      assert.ok(out, 'extraction succeeds despite the charges chunk error');
      assert.equal(out.path_used, 'llm_fallback');
      // All 6 currencies survive — the charges-chunk error did not poison them.
      const byCur = {};
      for (const s of out.slabs) byCur[s.currency] = (byCur[s.currency] || 0) + 1;
      for (const ccy of ['USD', 'EUR', 'GBP', 'AUD', 'JPY', 'AED']) {
        assert.ok(byCur[ccy] > 0, `currency ${ccy} present (got ${JSON.stringify(byCur)})`);
      }
      assert.ok(out.slabs.length >= 12, `meaningful slab count recovered (got ${out.slabs.length})`);
      // The informational (non-blocking) downgrade must be recorded.
      assert.ok(
        out.warnings.some((w) => /chunk\[\d+\].*informational, not blocking/.test(w)),
        `zero-slab chunk error downgraded to warning (warnings: ${JSON.stringify(out.warnings).slice(0, 300)})`
      );
    },
  );
});

test('fcnr: an error from a chunk that DID yield slabs still poisons LLM adoption (blocking preserved)', async () => {
  // Guard against over-relaxing: if the matrix chunk itself reports a blocking
  // error (e.g. truncated) alongside slabs, those slabs are untrustworthy and
  // the LLM result must be rejected — keeping the pre-fix conservatism.
  const matrixSlabs = [
    { tenure_text: '7 days to 30 days', tenure_min_days: 7, tenure_max_days: 30, rate_general_pct: 3.25, currency: 'USD', source_row_text: '7 days to 30 days 3.25% 2.00% 3.25% 2.90% 0.10% 3.20%' },
    { tenure_text: '7 days to 30 days', tenure_min_days: 7, tenure_max_days: 30, rate_general_pct: 2.00, currency: 'EUR', source_row_text: '7 days to 30 days 3.25% 2.00% 3.25% 2.90% 0.10% 3.20%' },
  ];
  await withMockedAoai(
    (params) => {
      const userMsg = params.messages.find((m) => m.role === 'user').content;
      if (/Description of Charges|Commitment|Usance/.test(userMsg)) {
        return { rate_slabs: [], effective_date: null, warnings: [], errors: [] };
      }
      // Matrix chunk: slabs + a blocking truncation error.
      return { rate_slabs: matrixSlabs, effective_date: null, warnings: [], errors: ['input_truncated_mid_table'] };
    },
    async () => {
      const out = await extractHtmlTable({
        url: 'https://rbl.bank.in/gift-city',
        kind: 'html_js',
        variant: 'gift',
        hints: { cached_body: RBL_STYLE_MATRIX_AND_CHARGES_HTML, expected_currencies: ['USD', 'EUR', 'GBP', 'AUD', 'JPY', 'AED'] },
      });
      // LLM slabs rejected (blocking error on a slab-bearing chunk) → the
      // mis-mapped deterministic slabs die at missing_currency_multi → null.
      assert.equal(out, null, 'blocking error on a slab-bearing chunk still discards LLM output');
    },
  );
});

test('regular variant on the same consolidated page: chunk set unchanged (no filtering)', async () => {
  await withMockedAoai(
    () => ({ rate_slabs: [], effective_date: null, warnings: [], errors: [] }),
    async (calls) => {
      const out = await extractHtmlTable({
        url: 'https://example.com/consolidated',
        kind: 'html_static',
        variant: 'regular',
        // prefer_llm forces the LLM branch even though deterministic succeeds,
        // so we can observe the unfiltered chunk set.
        hints: { cached_body: CONSOLIDATED_PAGE_HTML, prefer_llm: true },
      });
      assert.equal(calls.length, 2, 'both rate-bearing chunks still go to the LLM for regular variant');
      const contents = calls.map((c) => c.messages.find((m) => m.role === 'user').content).join('\n---\n');
      assert.match(contents, /444 days/, 'INR chunk included');
      assert.match(contents, /GBP/, 'FCNR chunk included too (unchanged behaviour)');
      assert.ok(out, 'deterministic extraction still returns slabs');
      assert.ok(out.slabs.length >= 5);
    },
  );
});

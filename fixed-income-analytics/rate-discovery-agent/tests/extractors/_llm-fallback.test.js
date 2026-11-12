'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fallback = require('../../lib/extractors/_llm-fallback');

// --- Module shape --------------------------------------------------------

test('_llm-fallback module shape', () => {
  assert.equal(fallback.template_id, '_llm-fallback');
  assert.ok(fallback.applies_to.kinds.includes('html_static'));
  assert.ok(fallback.applies_to.kinds.includes('html_js'));
  assert.equal(typeof fallback.extract, 'function');
});

// --- Edge cases (no html / AOAI not configured) --------------------------

test('returns empty result when html is missing', async () => {
  const r = await fallback.extract({ productContext: { bank_code: 'x' } });
  assert.equal(r.slabs.length, 0);
  assert.match(r.warnings[0], /html input missing/);
});

test('returns empty result when AOAI not configured AND no _chatOverride', async () => {
  const prev = process.env.AZURE_OPENAI_ENDPOINT;
  try {
    delete process.env.AZURE_OPENAI_ENDPOINT;
    const r = await fallback.extract({
      html: '<html><body><table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1y</td><td>6.5%</td></tr></table></body></html>',
      productContext: { bank_code: 'x' },
    });
    assert.equal(r.slabs.length, 0);
    assert.match(r.warnings[0], /AOAI not configured/);
  } finally {
    if (prev != null) process.env.AZURE_OPENAI_ENDPOINT = prev;
  }
});

test('returns empty result when no <table> chunks found', async () => {
  const fakeChat = async () => ({ choices: [{ message: { content: '{}' } }] });
  const r = await fallback.extract({
    html: '<html><body><p>no tables here</p></body></html>',
    productContext: { bank_code: 'x' },
    _chatOverride: fakeChat,
  });
  assert.equal(r.slabs.length, 0);
  assert.match(r.warnings[0], /no rate-bearing/);
});

// --- Happy path with mocked AOAI ------------------------------------------

test('extracts slabs from LLM response, preserves source_row_text', async () => {
  const html = `<html><body>
    <h2>FD Rates</h2>
    <table>
      <thead><tr><th>Period</th><th>General</th><th>Senior</th></tr></thead>
      <tbody>
        <tr><td>1 year</td><td>6.50%</td><td>7.00%</td></tr>
        <tr><td>3 years</td><td>6.75%</td><td>7.25%</td></tr>
      </tbody>
    </table>
  </body></html>`;
  const fakeChat = async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          rate_slabs: [
            { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.50, rate_senior_pct: 7.00, source_row_text: '1 year 6.50 7.00' },
            { tenure_text: '3 years', tenure_min_days: 1095, tenure_max_days: 1095, rate_general_pct: 6.75, rate_senior_pct: 7.25, source_row_text: '3 years 6.75 7.25' },
          ],
          effective_date: null,
          warnings: [],
          errors: [],
        }),
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  });
  const r = await fallback.extract({
    html,
    productContext: { bank_code: 'test-bank', variant: 'regular' },
    _chatOverride: fakeChat,
  });
  assert.equal(r.slabs.length, 2, `warnings=${JSON.stringify(r.warnings)}, diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.slabs[0].rate_general_pct, 6.5);
  assert.ok(r.slabs[0].source_row_text);
  assert.equal(r.diagnostics.extractor_kind, 'llm_fallback_aoai');
  assert.equal(r.diagnostics.chunks_with_slabs, 1);
});

test('anti-fabrication: drops slabs whose source_row_text is NOT in chunk', async () => {
  const html = `<html><body>
    <table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1 year</td><td>6.5%</td></tr></table>
  </body></html>`;
  const fakeChat = async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          rate_slabs: [
            { tenure_text: '1 year', rate_general_pct: 6.5, source_row_text: '1 year 6.5' },
            { tenure_text: '99 years', rate_general_pct: 99.99, source_row_text: 'completely fabricated row' },
          ],
          warnings: [],
          errors: [],
        }),
      },
    }],
    usage: { prompt_tokens: 500, completion_tokens: 100 },
  });
  const r = await fallback.extract({
    html,
    productContext: { bank_code: 'test-bank', variant: 'regular' },
    _chatOverride: fakeChat,
  });
  assert.equal(r.slabs.length, 1);
  assert.equal(r.slabs[0].rate_general_pct, 6.5);
  assert.ok(r.warnings.some((w) => w.includes('anti_fabrication')));
});

test('records llm_usages per chunk + extractor_kind=llm_fallback_aoai', async () => {
  const html = `<html><body><table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1 year</td><td>6.5%</td></tr></table></body></html>`;
  let callCount = 0;
  const fakeChat = async () => {
    callCount++;
    return {
      choices: [{ message: { content: JSON.stringify({ rate_slabs: [{ tenure_text: '1 year', rate_general_pct: 6.5, source_row_text: '1 year 6.5' }], warnings: [], errors: [] }) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
    };
  };
  const r = await fallback.extract({
    html,
    productContext: { bank_code: 'x', variant: 'regular' },
    _chatOverride: fakeChat,
  });
  assert.equal(callCount, 1);
  assert.equal(r.diagnostics.llm_usages.length, 1);
  assert.equal(r.diagnostics.llm_usages[0].prompt_tokens, 1000);
  assert.equal(r.diagnostics.extractor_kind, 'llm_fallback_aoai');
});

test('handles LLM call throwing — emits warning but completes', async () => {
  const html = `<html><body><table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1y</td><td>6.5%</td></tr></table></body></html>`;
  const fakeChat = async () => { throw new Error('AOAI rate-limited'); };
  const r = await fallback.extract({
    html,
    productContext: { bank_code: 'x', variant: 'regular' },
    _chatOverride: fakeChat,
  });
  assert.equal(r.slabs.length, 0);
  assert.ok(r.warnings.some((w) => /llm_chunk\[\d+\]/.test(w)));
});

test('FCNR variant: system prompt mentions currency', async () => {
  // Two distinct currency columns so the sprint-011 Fix A chunk filter keeps
  // the chunk (>=2 distinct tokens required with the default 6-currency set).
  const html = `<html><body><table><tr><th>Tenure</th><th>USD</th><th>GBP</th></tr><tr><td>1y</td><td>5.50%</td><td>4.75%</td></tr></table></body></html>`;
  let capturedSystem = null;
  const fakeChat = async (params) => {
    capturedSystem = params.messages.find((m) => m.role === 'system')?.content || '';
    return { choices: [{ message: { content: JSON.stringify({ rate_slabs: [], warnings: [], errors: [] }) } }] };
  };
  await fallback.extract({
    html,
    productContext: { bank_code: 'hdfc-bank-ibu', variant: 'fcnr' },
    _chatOverride: fakeChat,
  });
  assert.ok(/currency|Currency/.test(capturedSystem), 'system prompt should mention currency for fcnr variant');
});

// ── Sprint-011 Fix A: currency-aware chunk selection in the dispatcher path ──

const INR_TABLE = `<table>
  <tr><th>Period</th><th>General Rate</th><th>Senior Citizen Rate</th></tr>
  <tr><td>7 days to 45 days</td><td>3.50%</td><td>4.00%</td></tr>
  <tr><td>1 year to 2 years</td><td>6.80%</td><td>7.30%</td></tr>
</table>`;
const FCNR_TABLE = `<table>
  <tr><th>Maturity</th><th>USD</th><th>GBP</th><th>JPY</th></tr>
  <tr><td>1 year to less than 2 years</td><td>4.00%</td><td>4.10%</td><td>0.01%</td></tr>
</table>`;

test('fcnr: currency filter drops INR chunks so only the currency matrix reaches the LLM', async () => {
  const html = `<html><body><h2>Domestic FD</h2>${INR_TABLE}<h2>FCNR (B)</h2>${FCNR_TABLE}</body></html>`;
  const chunksSeen = [];
  const fakeChat = async (params) => {
    chunksSeen.push(params.messages.map((m) => m.content).join('\n'));
    return { choices: [{ message: { content: JSON.stringify({ rate_slabs: [], warnings: [], errors: [] }) } }] };
  };
  await fallback.extract({
    html,
    productContext: { bank_code: 'test-bank', variant: 'fcnr' },
    _chatOverride: fakeChat,
  });
  assert.equal(chunksSeen.length, 1, 'only the currency-bearing chunk should fire an LLM call');
  assert.ok(/USD/.test(chunksSeen[0]) && /JPY/.test(chunksSeen[0]), 'the FCNR matrix chunk is the one sent');
  assert.ok(!/Senior Citizen Rate/.test(chunksSeen[0]), 'the INR chunk must not be sent');
});

test('fcnr: no currency-bearing chunk fails fast without any LLM call', async () => {
  const html = `<html><body>${INR_TABLE}</body></html>`;
  let llmCalls = 0;
  const fakeChat = async () => { llmCalls++; return { choices: [{ message: { content: '{}' } }] }; };
  const r = await fallback.extract({
    html,
    productContext: { bank_code: 'test-bank', variant: 'fcnr' },
    _chatOverride: fakeChat,
  });
  assert.equal(llmCalls, 0, 'no LLM call on a page without currency-keyed content');
  assert.equal(r.slabs.length, 0);
  assert.ok(r.warnings.some((w) => /no_currency_chunk/.test(w)), `warnings=${JSON.stringify(r.warnings)}`);
});

test('regular variant: chunk filter does not apply in dispatcher path', async () => {
  const html = `<html><body>${INR_TABLE}</body></html>`;
  let llmCalls = 0;
  const fakeChat = async () => { llmCalls++; return { choices: [{ message: { content: JSON.stringify({ rate_slabs: [], warnings: [], errors: [] }) } }] }; };
  await fallback.extract({
    html,
    productContext: { bank_code: 'test-bank', variant: 'regular' },
    _chatOverride: fakeChat,
  });
  assert.equal(llmCalls, 1, 'regular variant still sends the INR chunk');
});

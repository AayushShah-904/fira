'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProposePrompt,
  parseProposeResponse,
  proposeTemplate,
} = require('../../../lib/templating/llm_propose');

const sampleHtml = `<html><body>
<table>
  <thead><tr><th>Period</th><th>Rate</th><th>Senior</th></tr></thead>
  <tbody>
    <tr><td>1 year</td><td>6.50%</td><td>7.00%</td></tr>
    <tr><td>2 years</td><td>6.75%</td><td>7.25%</td></tr>
    <tr><td>3 years</td><td>7.00%</td><td>7.50%</td></tr>
  </tbody>
</table>
</body></html>`;

// --- buildProposePrompt ----------------------------------------------------

test('buildProposePrompt produces system+user strings', () => {
  const { system, user } = buildProposePrompt({
    bankCode: 'test-bank',
    variant: 'regular',
    url: 'https://x.example/rates',
    html: sampleHtml,
  });
  assert.ok(system.length > 100);
  assert.match(user, /bank_code: test-bank/);
  assert.match(user, /variant: regular/);
  assert.match(user, /candidate_tables_count/);
  assert.match(user, /candidate_index/);
});

test('buildProposePrompt allows systemTemplate override (for tests)', () => {
  const { system } = buildProposePrompt({
    bankCode: 'x', variant: 'regular', url: 'https://x',
    html: sampleHtml,
    systemTemplate: 'OVERRIDE',
  });
  assert.equal(system, 'OVERRIDE');
});

test('buildProposePrompt throws on missing html', () => {
  assert.throws(() => buildProposePrompt({ bankCode: 'x', variant: 'regular', url: 'https://x' }), /html required/);
});

// --- parseProposeResponse --------------------------------------------------

test('parseProposeResponse accepts strict JSON string with required fields', () => {
  const raw = JSON.stringify({
    template_id_suggestion: 'test-template',
    table_index: 0,
    header_row: 0,
    column_map: { '0': 'tenure_text', '1': 'rate_general_pct', '2': 'rate_senior_pct' },
    reason: 'looks like a 3-col rate table',
  });
  const r = parseProposeResponse(raw);
  assert.equal(r.template_id_suggestion, 'test-template');
  assert.equal(r.column_map['0'], 'tenure_text');
  assert.equal(r.reason, 'looks like a 3-col rate table');
});

test('parseProposeResponse accepts already-parsed object', () => {
  const r = parseProposeResponse({
    template_id_suggestion: 'test-template',
    column_map: { '0': 'tenure_text', '1': 'rate_general_pct' },
  });
  assert.equal(r.template_id_suggestion, 'test-template');
});

test('parseProposeResponse strips ```json fence if present', () => {
  const raw = '```json\n{"template_id_suggestion":"x","column_map":{"0":"tenure_text","1":"rate_general_pct"}}\n```';
  const r = parseProposeResponse(raw);
  assert.equal(r.template_id_suggestion, 'x');
});

test('parseProposeResponse throws on invalid JSON', () => {
  assert.throws(() => parseProposeResponse('not json at all'), /JSON parse failed/);
});

test('parseProposeResponse allows template_id_suggestion=null (LLM cannot identify)', () => {
  const r = parseProposeResponse({ template_id_suggestion: null, reason: 'no rate table identified' });
  assert.equal(r.template_id_suggestion, null);
  assert.match(r.reason, /no rate table/);
});

test('parseProposeResponse throws when column_map missing required tenure_text', () => {
  assert.throws(() => parseProposeResponse({
    template_id_suggestion: 'x',
    column_map: { '0': 'rate_general_pct', '1': 'rate_senior_pct' },
  }), /tenure_text/);
});

test('parseProposeResponse throws when column_map missing rate_general_pct', () => {
  assert.throws(() => parseProposeResponse({
    template_id_suggestion: 'x',
    column_map: { '0': 'tenure_text', '1': 'rate_senior_pct' },
  }), /rate_general_pct/);
});

test('parseProposeResponse filters unrecognized field names out of column_map', () => {
  const r = parseProposeResponse({
    template_id_suggestion: 'x',
    column_map: { '0': 'tenure_text', '1': 'rate_general_pct', '2': 'unknown_field', '3': 'currency' },
  });
  assert.equal(r.column_map['0'], 'tenure_text');
  assert.equal(r.column_map['1'], 'rate_general_pct');
  assert.equal(r.column_map['3'], 'currency');
  assert.equal(r.column_map['2'], undefined, 'unknown_field should be filtered out');
});

test('parseProposeResponse accepts #currency and @range#currency column tags (gift/fcnr)', () => {
  const r = parseProposeResponse({
    template_id_suggestion: 'ibu-gift-currency',
    variant: 'gift',
    column_map: {
      '0': 'tenure_text',
      '1': 'rate_general_pct#USD',
      '2': 'rate_general_pct@below_500k#EUR',
      '3': 'rate_general_pct@above_2mio#GBP',
    },
    reason: 'gift currency table',
  });
  // Full specs preserved verbatim for the extractor to re-split.
  assert.equal(r.column_map['1'], 'rate_general_pct#USD');
  assert.equal(r.column_map['2'], 'rate_general_pct@below_500k#EUR');
  assert.equal(r.column_map['3'], 'rate_general_pct@above_2mio#GBP');
});

test('parseProposeResponse still rejects an unknown field even with a #currency suffix', () => {
  const r = parseProposeResponse({
    template_id_suggestion: 'x',
    column_map: {
      '0': 'tenure_text',
      '1': 'rate_general_pct#USD',
      '2': 'bogus_field#EUR',
    },
  });
  assert.equal(r.column_map['1'], 'rate_general_pct#USD');
  assert.equal(r.column_map['2'], undefined, 'unknown field must be filtered even with #currency suffix');
});

test('parseProposeResponse defaults table_index, header_row, header_span_rows', () => {
  const r = parseProposeResponse({
    template_id_suggestion: 'x',
    column_map: { '0': 'tenure_text', '1': 'rate_general_pct' },
  });
  assert.equal(r.table_index, 0);
  assert.equal(r.header_row, 0);
  assert.equal(r.header_span_rows, 1);
});

// --- proposeTemplate (full pipeline with mocked AOAI) ---------------------

test('proposeTemplate full pipeline with mocked chat returns parsed proposal', async () => {
  const fakeChat = async (params) => ({
    choices: [{
      message: {
        content: JSON.stringify({
          template_id_suggestion: 'coop-bankin-3col-tenure-general-senior',
          table_index: 0,
          column_map: { '0': 'tenure_text', '1': 'rate_general_pct', '2': 'rate_senior_pct' },
          reason: 'matched .bank.in co-op pattern',
        }),
      },
    }],
  });
  const r = await proposeTemplate({
    bankCode: 'apna-sahakari-bank-ltd',
    variant: 'regular',
    url: 'https://apna.bank.in/rates',
    html: sampleHtml,
    _chat: fakeChat,
  });
  assert.equal(r.proposal.template_id_suggestion, 'coop-bankin-3col-tenure-general-senior');
  assert.equal(r.proposal.column_map['0'], 'tenure_text');
  assert.ok(r.prompt.system.length > 0);
  assert.ok(r.raw_response);
});

test('proposeTemplate throws when AOAI returns response with no content', async () => {
  const fakeChat = async () => ({ choices: [{ message: {} }] });
  await assert.rejects(
    proposeTemplate({ bankCode: 'x', variant: 'regular', url: 'https://x', html: sampleHtml, _chat: fakeChat }),
    /missing message content/,
  );
});

test('proposeTemplate throws AOAI_NOT_CONFIGURED when env missing AND no _chat injection', async () => {
  const prev = process.env.AZURE_OPENAI_ENDPOINT;
  try {
    delete process.env.AZURE_OPENAI_ENDPOINT;
    let caught;
    try { await proposeTemplate({ bankCode: 'x', variant: 'regular', url: 'https://x', html: sampleHtml }); }
    catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, 'AOAI_NOT_CONFIGURED');
  } finally {
    if (prev != null) process.env.AZURE_OPENAI_ENDPOINT = prev;
  }
});

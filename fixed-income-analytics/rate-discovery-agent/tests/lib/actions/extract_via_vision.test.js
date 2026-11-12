'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractViaVision, _buildPrompt } = require('../../../lib/actions/extract_via_vision');

test('throws on missing url', async () => {
  await assert.rejects(
    extractViaVision({}),
    /input.url is required/,
  );
});

test('throws on invalid variant', async () => {
  await assert.rejects(
    extractViaVision({ url: 'https://x.png', variant: 'savings' }),
    /unsupported variant/,
  );
});

test('returns null when AZURE_OPENAI_ENDPOINT is unset (test env)', async () => {
  const saved = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  try {
    const r = await extractViaVision({ url: 'https://example.com/rates.png', variant: 'regular' });
    assert.equal(r, null);
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_ENDPOINT = saved;
  }
});

test('_buildPrompt: regular variant mentions INR (no currency field)', () => {
  const p = _buildPrompt('regular', undefined);
  assert.match(p, /INR-denominated/);
  assert.match(p, /do NOT include a "currency" field/);
});

test('_buildPrompt: fcnr variant requires currency field per slab', () => {
  const p = _buildPrompt('fcnr', {});
  assert.match(p, /MUST include a "currency" field/);
  assert.match(p, /NO senior or super-senior premium/);
});

test('_buildPrompt: expected_currencies hint surfaced in prompt', () => {
  const p = _buildPrompt('fcnr', { expected_currencies: ['USD', 'GBP'] });
  assert.match(p, /Expected currencies.*USD, GBP/);
});

test('_buildPrompt: response_format guidance present', () => {
  const p = _buildPrompt('regular', undefined);
  assert.match(p, /Return ONLY a JSON object/);
});

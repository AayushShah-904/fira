'use strict';

/**
 * Tests for the `slugify` tool exposed by lib/tools.js.
 *
 * Sprint 002 #6 — exposes the canonical slugify utility to the LLM as a
 * tool, eliminating slug-derivation drift between agent and orchestrator.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_DEFINITIONS, executeTool } = require('../../lib/tools');
const { slugify } = require('../../scripts/utils/slugify');

test('slugify tool is registered in TOOL_DEFINITIONS', () => {
  const t = TOOL_DEFINITIONS.find((d) => d.function && d.function.name === 'slugify');
  assert.ok(t, 'slugify tool definition missing');
  assert.equal(t.type, 'function');
  assert.deepEqual(t.function.parameters.required, ['name']);
});

test('slugify tool returns canonical slug matching utility', async () => {
  const samples = [
    'State Bank of India',
    'HDFC Bank Limited',
    'Rajkot Nagrik Sahakari Bank Ltd.',
    'Cosmos Co-operative Bank Ltd.',
    'Central Co-operative Bank Ltd. (ARA)',
  ];
  for (const name of samples) {
    const raw = await executeTool('slugify', { name }, {});
    const parsed = JSON.parse(raw);
    assert.equal(parsed.slug, slugify(name), `slug mismatch for "${name}"`);
  }
});

test('slugify tool rejects empty input', async () => {
  const raw = await executeTool('slugify', { name: '' }, {});
  const parsed = JSON.parse(raw);
  assert.ok(parsed.error, 'expected error on empty name');
});

test('slugify tool rejects non-string input', async () => {
  const raw = await executeTool('slugify', { name: null }, {});
  const parsed = JSON.parse(raw);
  assert.ok(parsed.error, 'expected error on null name');
});

test('slugify tool returns hyphenated lowercase result with no underscores', async () => {
  const raw = await executeTool('slugify', { name: 'My_Test Bank (Pvt.) Ltd.' }, {});
  const parsed = JSON.parse(raw);
  assert.match(parsed.slug, /^[a-z0-9-]+$/);
  assert.doesNotMatch(parsed.slug, /_/);
});

'use strict';

// Guard: prompt fragments are sourced from docs/agent/*.md (single source of
// truth). This catches a broken/renamed anchor or a missing doc file before it
// silently empties the system prompt. Added with the sprint-007 CLAUDE.md
// refactor (Option A).

const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../../lib/prompts/fragments.js');
const { buildSystemPrompt } = require('../../lib/prompts/build-prompt.js');

const FRAGMENT_NAMES = [
  'IDENTITY', 'EFFICIENCY_RULES', 'STEP_FIND_WEBSITE', 'STEP_FIND_RATE_PAGES',
  'STEP_NRI_FCNR', 'STEP_GIFT_CITY', 'STEP_SCRAPER_TYPE', 'STEP_EXTRACT_RATES',
  'CONFIG_SCHEMA', 'RATE_SCHEMA', 'BANK_TYPE_TABLE', 'RULES_CORE', 'OUTPUT_SLUG',
  'LEARNINGS_FROM_FIELD',
];

test('every fragment resolves to a non-empty string from docs/agent', () => {
  for (const name of FRAGMENT_NAMES) {
    assert.equal(typeof f[name], 'string', `${name} should be a string`);
    assert.ok(f[name].length > 0, `${name} should be non-empty`);
  }
});

test('a missing/renamed anchor throws a clear error', () => {
  assert.throws(() => f._frag('core.md', 'NOPE_NOT_A_FRAGMENT'), /not found in docs\/agent\/core\.md/);
});

test('buildSystemPrompt assembles a substantial prompt for each mode', () => {
  for (const [mode, ctx] of [
    ['discover', { bankType: 'PSB', isIBU: false }],
    ['discover', { bankType: 'IBU', isIBU: true }],
    ['expand-nri', {}],
    ['rates-only', {}],
  ]) {
    const p = buildSystemPrompt(mode, ctx);
    assert.ok(p.length > 2000, `${mode} prompt should be substantial, got ${p.length}`);
    assert.match(p, /Bank Rate Discovery Agent/, `${mode} prompt should include identity`);
  }
});

test('discover mode includes NRI fragment for NRI-eligible types only', () => {
  const psb = buildSystemPrompt('discover', { bankType: 'PSB' });
  const coop = buildSystemPrompt('discover', { bankType: 'SUCB' });
  assert.match(psb, /NRI\/FCNR Rate Pages/);
  assert.doesNotMatch(coop, /NRI\/FCNR Rate Pages/);
});

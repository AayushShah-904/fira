'use strict';

// Sprint 008, Phase 4 — cross-check pure helpers + shared prompt module.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseKey, hashSlabs } = require('../../scripts/audit/cross-check-all.js');
const { buildExtractionPrompt, variantInstructions, classifyAgreement } = require('../../lib/llm/reextract-prompt.js');

test('parseKey splits bank__variant', () => {
  assert.deepEqual(parseKey('hdfc-bank-limited__regular'), { slug: 'hdfc-bank-limited', variant: 'regular' });
  assert.deepEqual(parseKey('axis-bank-ibu__gift'), { slug: 'axis-bank-ibu', variant: 'gift' });
  assert.equal(parseKey('no-variant-here'), null);
});

test('hashSlabs is stable and order-sensitive', () => {
  const a = [{ tenure_text: '1y', rate_general_pct: 7 }];
  assert.equal(hashSlabs(a), hashSlabs([{ tenure_text: '1y', rate_general_pct: 7 }]));
  assert.notEqual(hashSlabs(a), hashSlabs([{ tenure_text: '1y', rate_general_pct: 7.1 }]));
});

test('classifyAgreement maps diff summaries', () => {
  assert.equal(classifyAgreement(null, 5), 'LLM_NO_DATA');
  assert.equal(classifyAgreement({ summary: {} }, 0), 'LLM_NO_DATA');
  assert.equal(classifyAgreement({ summary: { slabs_added: 0, slabs_removed: 0, slabs_changed: 0 }, unchanged_count: 7 }, 7), 'FULL');
  assert.equal(classifyAgreement({ summary: { slabs_added: 1, slabs_removed: 0, slabs_changed: 1 }, unchanged_count: 5 }, 6), 'PARTIAL');
  assert.equal(classifyAgreement({ summary: { slabs_added: 6, slabs_removed: 6, slabs_changed: 0 }, unchanged_count: 0 }, 6), 'DISAGREE');
});

test('buildExtractionPrompt includes schema + variant note', () => {
  const p = buildExtractionPrompt('fcnr', 'https://x', 'TABLE', 'HTML');
  assert.ok(p.system && p.user);
  assert.match(p.user, /rate_slabs/);
  assert.match(p.user, /currency/);
  assert.match(p.user, /FCNR/);
});

test('variantInstructions distinguishes fcnr/gift from inr', () => {
  assert.match(variantInstructions('fcnr'), /currency/i);
  assert.match(variantInstructions('regular'), /INR/);
});

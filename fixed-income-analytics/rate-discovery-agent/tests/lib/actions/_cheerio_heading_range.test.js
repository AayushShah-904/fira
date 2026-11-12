'use strict';

/**
 * Tests for `lib/actions/_cheerio_heading_range.js#headingToDepositRange`.
 * Orch-1 (sprint-004 2026-05-21).
 *
 * Pure-function tests covering the heading shapes seen on Indian PVB / PSB
 * rate pages, plus edge cases (null, empty, ambiguous, mixed case, whitespace
 * weirdness, rupee glyph variants).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { headingToDepositRange } = require('../../../lib/actions/_cheerio_heading_range');

// ── below_3cr ────────────────────────────────────────────────────────

test('< ₹3 Crore → below_3cr', () => {
  assert.equal(headingToDepositRange('< ₹3 Crore'), 'below_3cr');
});

test('< 3 Crore (no rupee glyph) → below_3cr', () => {
  assert.equal(headingToDepositRange('< 3 Crore'), 'below_3cr');
});

test('below 3 cr → below_3cr', () => {
  assert.equal(headingToDepositRange('below 3 cr'), 'below_3cr');
});

test('Less than ₹3 crore → below_3cr', () => {
  assert.equal(headingToDepositRange('Less than ₹3 crore'), 'below_3cr');
});

test('under 3 crores → below_3cr', () => {
  assert.equal(headingToDepositRange('under 3 crores'), 'below_3cr');
});

test('case-insensitive: LESS THAN 3 CR → below_3cr', () => {
  assert.equal(headingToDepositRange('LESS THAN 3 CR'), 'below_3cr');
});

// ── 3cr_to_5cr ───────────────────────────────────────────────────────

test('≥ ₹3 Crore To < ₹5 Crores → 3cr_to_5cr', () => {
  assert.equal(headingToDepositRange('≥ ₹3 Crore To < ₹5 Crores'), '3cr_to_5cr');
});

test('3 cr to 5 cr → 3cr_to_5cr', () => {
  assert.equal(headingToDepositRange('3 cr to 5 cr'), '3cr_to_5cr');
});

test('3 crore – 5 crore (en-dash) → 3cr_to_5cr', () => {
  assert.equal(headingToDepositRange('3 crore – 5 crore'), '3cr_to_5cr');
});

test('3-5 cr (hyphen, no spaces) → 3cr_to_5cr', () => {
  assert.equal(headingToDepositRange('3-5 cr'), '3cr_to_5cr');
});

// ── 5cr_to_25cr ──────────────────────────────────────────────────────

test('5 to 25 cr → 5cr_to_25cr', () => {
  assert.equal(headingToDepositRange('5 to 25 cr'), '5cr_to_25cr');
});

test('₹5 Cr < ₹25 Cr → 5cr_to_25cr', () => {
  assert.equal(headingToDepositRange('₹5 Cr < ₹25 Cr'), '5cr_to_25cr');
});

// ── 25cr_to_50cr / 25cr_to_100cr precedence ──────────────────────────

test('25 to 50 cr → 25cr_to_50cr (finer wins over 25-to-100)', () => {
  assert.equal(headingToDepositRange('25 to 50 cr'), '25cr_to_50cr');
});

test('25 to 100 cr → 25cr_to_100cr (coarse bucket when no finer split named)', () => {
  assert.equal(headingToDepositRange('25 to 100 cr'), '25cr_to_100cr');
});

// ── 50cr_to_100cr ────────────────────────────────────────────────────

test('50 to 100 cr → 50cr_to_100cr', () => {
  assert.equal(headingToDepositRange('50 to 100 cr'), '50cr_to_100cr');
});

// ── 100cr_to_200cr ───────────────────────────────────────────────────

test('100 to 200 cr → 100cr_to_200cr', () => {
  assert.equal(headingToDepositRange('100 to 200 cr'), '100cr_to_200cr');
});

// ── 200cr_to_500cr ───────────────────────────────────────────────────

test('200 to 500 cr → 200cr_to_500cr', () => {
  assert.equal(headingToDepositRange('200 to 500 cr'), '200cr_to_500cr');
});

// ── 500cr_to_1000cr ──────────────────────────────────────────────────

test('500 to 1000 cr → 500cr_to_1000cr', () => {
  assert.equal(headingToDepositRange('500 to 1000 cr'), '500cr_to_1000cr');
});

test('500 to 1,000 cr (comma in thousand) → 500cr_to_1000cr', () => {
  assert.equal(headingToDepositRange('500 to 1,000 cr'), '500cr_to_1000cr');
});

// ── above_1000cr ─────────────────────────────────────────────────────

test('above 1000 cr → above_1000cr', () => {
  assert.equal(headingToDepositRange('above 1000 cr'), 'above_1000cr');
});

test('> ₹1000 cr → above_1000cr', () => {
  assert.equal(headingToDepositRange('> ₹1000 cr'), 'above_1000cr');
});

test('> ₹1,000 Cr → above_1000cr', () => {
  assert.equal(headingToDepositRange('> ₹1,000 Cr'), 'above_1000cr');
});

// ── above_100cr (when no finer bucket given) ─────────────────────────

test('above 100 cr (no further range) → above_100cr', () => {
  assert.equal(headingToDepositRange('above 100 cr'), 'above_100cr');
});

// ── Null / ambiguous / whitespace ────────────────────────────────────

test('null heading → null', () => {
  assert.equal(headingToDepositRange(null), null);
});

test('undefined heading → null', () => {
  assert.equal(headingToDepositRange(undefined), null);
});

test('empty string → null', () => {
  assert.equal(headingToDepositRange(''), null);
});

test('whitespace only → null', () => {
  assert.equal(headingToDepositRange('   \t\n  '), null);
});

test('non-string (number) → null', () => {
  assert.equal(headingToDepositRange(42), null);
});

test('heading with no amount range → null', () => {
  assert.equal(headingToDepositRange('Domestic / NRO / NRE FIXED DEPOSIT RATE'), null);
});

test('heading with currency but no range → null', () => {
  assert.equal(headingToDepositRange('₹ Crore'), null);
});

test('"Senior Citizen rates" alone (no amount) → null', () => {
  assert.equal(headingToDepositRange('Senior Citizen rates'), null);
});

// ── Whitespace tolerance ─────────────────────────────────────────────

test('leading/trailing whitespace tolerated', () => {
  assert.equal(headingToDepositRange('  < 3 crore  '), 'below_3cr');
});

test('extra internal whitespace tolerated', () => {
  assert.equal(headingToDepositRange('<    3    crore'), 'below_3cr');
});

// ── Real-world shapes seen in the field ──────────────────────────────

test('HDFC table[0] heading-area shape: "Tenor Bucket < ₹3 Crore" → below_3cr', () => {
  assert.equal(headingToDepositRange('Tenor Bucket < ₹3 Crore'), 'below_3cr');
});

test('HDFC table[2] heading-area shape: ">= ₹3 Crore To < ₹5 Crores" → 3cr_to_5cr', () => {
  assert.equal(headingToDepositRange('>= ₹3 Crore To < ₹5 Crores'), '3cr_to_5cr');
});

test('Axis-style "Deposits General — ₹ 5 crores and above" → above_1000cr-or-above_100cr (not deterministic) — currently returns null because pattern doesnt cleanly match a known bucket', () => {
  // This is an example of a heading we don't currently classify — operator decides default downstream
  assert.equal(headingToDepositRange('Deposits General — ₹ 5 crores and above'), null);
});

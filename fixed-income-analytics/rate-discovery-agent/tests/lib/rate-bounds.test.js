'use strict';

/**
 * Tests for lib/rate-bounds.js — Sprint 004 cohort #3 Phase B (loose sanity
 * band used by pack/build-pack.js to drop extraction-error slabs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRateInBounds, isSlabRateInBounds, boundsForVariant } = require('../../lib/rate-bounds');

test('boundsForVariant: returns regular bounds for unknown variant', () => {
  assert.deepEqual(boundsForVariant('not-a-variant'), { min: 0.1, max: 15 });
  assert.deepEqual(boundsForVariant(undefined), { min: 0.1, max: 15 });
});

test('boundsForVariant: variant-specific bands', () => {
  assert.deepEqual(boundsForVariant('regular'), { min: 0.1, max: 15 });
  assert.deepEqual(boundsForVariant('nre'),     { min: 0.1, max: 15 });
  assert.deepEqual(boundsForVariant('nro'),     { min: 0.1, max: 15 });
  assert.deepEqual(boundsForVariant('fcnr'),    { min: 0.0, max: 12 });
  assert.deepEqual(boundsForVariant('gift'),    { min: 0.0, max: 12 });
});

test('isRateInBounds: rejects extraction-error garbage', () => {
  // The actual cohort #3 garbage values
  assert.equal(isRateInBounds(15100, 'regular'), false);
  assert.equal(isRateInBounds(181365, 'regular'), false);
  assert.equal(isRateInBounds(247.5, 'regular'), false);
  assert.equal(isRateInBounds(12017.5, 'nre'), false);  // SBI NRE "Premature withdrawal" footnote leak
  assert.equal(isRateInBounds(0, 'regular'), false);     // below INR floor
});

test('isRateInBounds: accepts plausible rates', () => {
  assert.equal(isRateInBounds(3.5, 'regular'), true);
  assert.equal(isRateInBounds(9.5, 'regular'), true);
  assert.equal(isRateInBounds(11, 'regular'), true);     // wider than validation band on purpose
  assert.equal(isRateInBounds(4.5, 'fcnr'), true);
  assert.equal(isRateInBounds(0, 'fcnr'), true);          // FCNR floor is 0 (JPY-like)
});

test('isRateInBounds: passes through null / non-numeric', () => {
  assert.equal(isRateInBounds(null, 'regular'), true);
  assert.equal(isRateInBounds(undefined, 'regular'), true);
  assert.equal(isRateInBounds(NaN, 'regular'), true);
  assert.equal(isRateInBounds('5.0', 'regular'), true);   // strings not judged here
});

test('isSlabRateInBounds: rejects slab with any out-of-band rate', () => {
  const goodSlab = { rate_general_pct: 6.5, rate_senior_pct: 7.0, rate_super_senior_pct: 7.25 };
  assert.equal(isSlabRateInBounds(goodSlab, 'regular'), true);

  const generalOob = { rate_general_pct: 15100, rate_senior_pct: 7.0 };
  assert.equal(isSlabRateInBounds(generalOob, 'regular'), false);

  const seniorOob = { rate_general_pct: 6.5, rate_senior_pct: 12017.5 };
  assert.equal(isSlabRateInBounds(seniorOob, 'regular'), false);

  const superSeniorOob = { rate_general_pct: 6.5, rate_senior_pct: 7.0, rate_super_senior_pct: 999 };
  assert.equal(isSlabRateInBounds(superSeniorOob, 'regular'), false);
});

test('isSlabRateInBounds: passes through slabs with only the general rate populated', () => {
  // FCNR/GIFT slabs lack senior rates; null fields must not trigger rejection.
  const fcnrSlab = { rate_general_pct: 4.5, rate_senior_pct: null, rate_super_senior_pct: null, currency: 'USD' };
  assert.equal(isSlabRateInBounds(fcnrSlab, 'fcnr'), true);
});

test('isSlabRateInBounds: defensive against null / non-object input', () => {
  assert.equal(isSlabRateInBounds(null, 'regular'), true);
  assert.equal(isSlabRateInBounds(undefined, 'regular'), true);
  assert.equal(isSlabRateInBounds(42, 'regular'), true);
});

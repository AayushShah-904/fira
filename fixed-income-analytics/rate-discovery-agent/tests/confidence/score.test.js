'use strict';

// Sprint 008, Phase 5 — composite confidence scorer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVariantConfidence } = require('../../lib/confidence/score.js');

test('clean template, FULL cross-check, fresh => verified, high score', () => {
  const r = computeVariantConfidence({ extractionMethod: 'template', crossCheckAgreement: 'FULL', structuralBlocking: 0, structuralWarnings: 0, stale: false, measuredMethodErrorRate: 0.0 });
  assert.equal(r.tier, 'verified');
  assert.ok(r.score >= 95);
});

test('structural anomaly forces needs_review and big penalty', () => {
  const r = computeVariantConfidence({ extractionMethod: 'template', crossCheckAgreement: 'FULL', structuralBlocking: 1 });
  assert.equal(r.tier, 'needs_review');
  assert.ok(r.score <= 65);
});

test('cross-check DISAGREE forces needs_review', () => {
  const r = computeVariantConfidence({ extractionMethod: 'template', crossCheckAgreement: 'DISAGREE' });
  assert.equal(r.tier, 'needs_review');
});

test('no cross-check + low measured error => still verifiable', () => {
  const r = computeVariantConfidence({ extractionMethod: 'template', crossCheckAgreement: null, measuredMethodErrorRate: 0.02 });
  assert.equal(r.tier, 'verified');
});

test('no cross-check + high measured error => needs_review', () => {
  const r = computeVariantConfidence({ extractionMethod: 'static', crossCheckAgreement: null, measuredMethodErrorRate: 0.25 });
  assert.equal(r.tier, 'needs_review');
});

test('stale data cannot be verified even if otherwise clean', () => {
  const r = computeVariantConfidence({ extractionMethod: 'template', crossCheckAgreement: 'FULL', stale: true });
  assert.equal(r.tier, 'needs_review');
});

test('score is clamped to [0,100] and contributors recorded', () => {
  const r = computeVariantConfidence({ extractionMethod: 'static', crossCheckAgreement: 'DISAGREE', structuralBlocking: 2, stale: true, measuredMethodErrorRate: 1 });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(Array.isArray(r.contributors) && r.contributors.length > 0);
});

test('absent cross-check is penalized (treated as unknown, not good)', () => {
  const withFull = computeVariantConfidence({ extractionMethod: 'template', crossCheckAgreement: 'FULL' });
  const withNone = computeVariantConfidence({ extractionMethod: 'template', crossCheckAgreement: null });
  assert.ok(withNone.score < withFull.score);
});

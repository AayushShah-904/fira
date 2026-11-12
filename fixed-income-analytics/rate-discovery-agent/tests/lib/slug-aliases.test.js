'use strict';

/**
 * Tests for lib/slug-aliases.js — Sprint 004 Fix #9 (slug-alias registry layer).
 *
 * Verifies that aliasToCanonical() reads data/bank-slug-aliases.json and
 * returns the canonical slug for known alternates, and passes other slugs
 * through untouched. Also verifies pass-through behaviour for non-strings
 * (defensive against accidental callers passing null/undefined).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { aliasToCanonical, loadAliasMap, resetCacheForTests } = require('../../lib/slug-aliases');

test('aliasToCanonical returns canonical slug for known alternates', () => {
  resetCacheForTests();
  assert.equal(
    aliasToCanonical('nkgsb-co-operative-bank-ltd-mumbai'),
    'nkgsb-co-operative-bank-ltd',
  );
  assert.equal(
    aliasToCanonical('the-zoroastrian-co-operative-bank-ltd'),
    'zoroastrian-co-operative-bank-ltd',
  );
  assert.equal(
    aliasToCanonical('the-ahmedabad-mercantile-co-operative-bank-ltd'),
    'ahmedabad-mercantile-co-op-bank-ltd',
  );
  assert.equal(
    aliasToCanonical('nellore-district-co-operative-central-bank-ltd'),
    'sri-potti-sriramulu-nellore-district-cooperative-central-bank-ltd',
  );
});

test('aliasToCanonical passes through canonical / unknown slugs unchanged', () => {
  resetCacheForTests();
  assert.equal(aliasToCanonical('hdfc-bank-limited'), 'hdfc-bank-limited');
  assert.equal(aliasToCanonical('nkgsb-co-operative-bank-ltd'), 'nkgsb-co-operative-bank-ltd');
  assert.equal(aliasToCanonical('some-random-slug-xyz'), 'some-random-slug-xyz');
});

test('aliasToCanonical handles null / undefined / non-string defensively', () => {
  resetCacheForTests();
  assert.equal(aliasToCanonical(null), null);
  assert.equal(aliasToCanonical(undefined), undefined);
  assert.equal(aliasToCanonical(123), 123);
});

test('loadAliasMap returns a populated object', () => {
  resetCacheForTests();
  const m = loadAliasMap();
  assert.equal(typeof m, 'object');
  assert.ok(Object.keys(m).length >= 4, 'expected at least the 4 Fix #9 aliases');
});

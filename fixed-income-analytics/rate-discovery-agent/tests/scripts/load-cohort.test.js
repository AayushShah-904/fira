'use strict';

/**
 * Tests for scripts/utils/load-cohort.js — Sprint 4 Track B/C cohort loader.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// load-cohort.js hardcodes data/cohorts/ at module load time, so we test
// against an actual cohort fixture in the project's data/cohorts/ dir.
const { loadCohort, listCohorts, cohortPath, CohortLoadError } = require('../../scripts/utils/load-cohort');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COHORTS_DIR = path.join(PROJECT_ROOT, 'data', 'cohorts');

const fixtureFiles = [];

function writeFixture(name, content) {
  const p = path.join(COHORTS_DIR, `${name}.json`);
  fs.mkdirSync(COHORTS_DIR, { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  fixtureFiles.push(p);
  return p;
}

test.after(() => {
  for (const p of fixtureFiles) {
    try { fs.unlinkSync(p); } catch (_) { /* ok */ }
  }
});

test('loadCohort: smoke-1 cohort that ships with the repo loads cleanly', () => {
  const cohort = loadCohort('smoke-1');
  assert.ok(Array.isArray(cohort));
  assert.ok(cohort.length >= 1);
  assert.ok(cohort[0].bank_code);
});

test('loadCohort: throws CohortLoadError with "not_found" on missing cohort', () => {
  try {
    loadCohort('__definitely_not_a_real_cohort__');
    assert.fail('expected CohortLoadError');
  } catch (err) {
    assert.ok(err instanceof CohortLoadError);
    assert.equal(err.code, 'not_found');
  }
});

test('loadCohort: rejects path-traversal in cohort name', () => {
  for (const name of ['../passwords', 'sub/dir', 'a\\b', '../']) {
    try {
      loadCohort(name);
      assert.fail(`expected throw for "${name}"`);
    } catch (err) {
      assert.ok(err instanceof CohortLoadError, `got non-CohortLoadError for "${name}"`);
      assert.equal(err.code, 'invalid_shape');
    }
  }
});

test('loadCohort: invalid JSON → invalid_json error', () => {
  writeFixture('test-bad-json', '{ not actually json');
  try {
    loadCohort('test-bad-json');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof CohortLoadError);
    assert.equal(err.code, 'invalid_json');
  }
});

test('loadCohort: top-level non-array → invalid_shape error', () => {
  writeFixture('test-non-array', { banks: ['hdfc-bank-limited'] });
  try {
    loadCohort('test-non-array');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof CohortLoadError);
    assert.equal(err.code, 'invalid_shape');
    assert.match(err.message, /expected an array/);
  }
});

test('loadCohort: entry missing bank_code → invalid_shape', () => {
  writeFixture('test-missing-bank-code', [{ category: 'PSB', state: 'Maharashtra' }]);
  try {
    loadCohort('test-missing-bank-code');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof CohortLoadError);
    assert.equal(err.code, 'invalid_shape');
    assert.match(err.message, /bank_code is required/);
  }
});

test('loadCohort: defaults category/state to empty strings when absent', () => {
  writeFixture('test-minimal', [{ bank_code: 'minimal-bank' }]);
  const cohort = loadCohort('test-minimal');
  assert.equal(cohort.length, 1);
  assert.equal(cohort[0].bank_code, 'minimal-bank');
  assert.equal(cohort[0].category, '');
  assert.equal(cohort[0].state, '');
});

test('listCohorts: returns the smoke-1 fixture among others', () => {
  const cohorts = listCohorts();
  assert.ok(cohorts.includes('smoke-1'));
  // No file extensions in returned names.
  assert.ok(!cohorts.some((c) => c.endsWith('.json')));
});

test('cohortPath: resolves to data/cohorts/<name>.json', () => {
  const p = cohortPath('smoke-1');
  assert.ok(p.endsWith(path.join('data', 'cohorts', 'smoke-1.json')));
});

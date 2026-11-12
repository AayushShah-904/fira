'use strict';

/**
 * Load a named cohort from `data/cohorts/<name>.json`. Used by Sprint 4
 * Track B's `start-cohort.js` and Track C's `--cohort` flag in run-batch.
 *
 * Cohort file shape (array):
 *   [
 *     { "bank_code": "hdfc-bank-limited", "category": "Private Sector Bank (Indian)", "state": "Maharashtra" },
 *     ...
 *   ]
 *
 * Each entry MUST have `bank_code` (canonical slug). `category` and `state`
 * are recommended but not required — downstream code defaults to "" when
 * absent. The loader validates shape and surfaces clear errors so an
 * operator's first failed run never says "Cannot read property X of
 * undefined".
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COHORTS_DIR = path.join(PROJECT_ROOT, 'data', 'cohorts');

class CohortLoadError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'not_found' | 'invalid_json' | 'invalid_shape'
  }
}

function cohortPath(name) {
  // Reject any path-traversal attempts; only single-segment names allowed.
  if (!name || typeof name !== 'string') throw new CohortLoadError('cohort name is required', 'invalid_shape');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new CohortLoadError(`cohort name must be a single segment (got "${name}")`, 'invalid_shape');
  }
  return path.join(COHORTS_DIR, `${name}.json`);
}

/**
 * @param {string} name — cohort filename without extension (e.g., "top-200")
 * @returns {Array<{bank_code, category, state}>} validated cohort entries
 */
function loadCohort(name) {
  const file = cohortPath(name);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CohortLoadError(`cohort file not found: ${file}\n  ls data/cohorts/ to see available cohorts`, 'not_found');
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CohortLoadError(`cohort ${name}: invalid JSON: ${err.message}`, 'invalid_json');
  }
  if (!Array.isArray(parsed)) {
    throw new CohortLoadError(`cohort ${name}: expected an array, got ${typeof parsed}`, 'invalid_shape');
  }
  const entries = [];
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e || typeof e !== 'object') {
      throw new CohortLoadError(`cohort ${name}[${i}]: expected an object, got ${typeof e}`, 'invalid_shape');
    }
    if (!e.bank_code || typeof e.bank_code !== 'string') {
      throw new CohortLoadError(`cohort ${name}[${i}]: bank_code is required (got ${JSON.stringify(e.bank_code)})`, 'invalid_shape');
    }
    entries.push({
      bank_code: e.bank_code,
      category: e.category || '',
      state: e.state || '',
    });
  }
  return entries;
}

/** List available cohort names (no extensions). */
function listCohorts() {
  if (!fs.existsSync(COHORTS_DIR)) return [];
  return fs.readdirSync(COHORTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

module.exports = { loadCohort, listCohorts, cohortPath, CohortLoadError };

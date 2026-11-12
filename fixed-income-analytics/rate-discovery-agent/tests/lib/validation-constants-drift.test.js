'use strict';

/**
 * Drift check — asserts that the agent's CJS validation-constants module
 * stays in sync with the canonical TS module at packages/shared/src/validation/.
 *
 * Per ADR-014: the two are hand-mirrored (same pattern as parse-tenure.js ↔
 * tenure-maps.ts). This test catches the case where one was edited without
 * mirroring the change to the other.
 *
 * If this fails: open both files, update the numbers so they agree, run the
 * test again. The TS module is the source of truth — if you must pick, the TS
 * value wins.
 *
 * The TS module imports from packages/shared/dist (the built artifact). On a
 * fresh checkout the test will skip until `npm run build -w @bird/shared` has
 * run at least once. That's acceptable because the build is part of `npm
 * test`'s broader workflow.
 */

const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const cjs = require('../../scripts/utils/validation-constants');

const SHARED_DIST_PATH = path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'validation', 'index.js');
// Dynamic import on Windows requires a file:// URL, not a bare path.
const SHARED_DIST = pathToFileURL(SHARED_DIST_PATH).href;

const sharedAvailable = fs.existsSync(SHARED_DIST_PATH);

if (!sharedAvailable) {
  test('validation-constants drift (SKIPPED — packages/shared not built; run `npm run build -w @bird/shared`)', () => {
    // skip is not blocking — just informational.
  });
} else {
  test('VARIANT_RATE_RANGES match between TS and CJS', async () => {
    const ts = await import(SHARED_DIST);
    for (const variant of ['regular', 'nre', 'nro', 'fcnr', 'gift']) {
      assert.deepEqual(
        ts.VARIANT_RATE_RANGES[variant],
        cjs.VARIANT_RATE_RANGES[variant],
        `VARIANT_RATE_RANGES.${variant} drift: TS=${JSON.stringify(ts.VARIANT_RATE_RANGES[variant])} CJS=${JSON.stringify(cjs.VARIANT_RATE_RANGES[variant])}`,
      );
    }
  });

  test('LOW_YIELD_CURRENCIES match between TS and CJS', async () => {
    const ts = await import(SHARED_DIST);
    const tsKeys = Object.keys(ts.LOW_YIELD_CURRENCIES || {}).sort();
    const cjsKeys = Object.keys(cjs.LOW_YIELD_CURRENCIES || {}).sort();
    assert.deepEqual(tsKeys, cjsKeys, `LOW_YIELD_CURRENCIES key drift: TS=${tsKeys} CJS=${cjsKeys}`);
    for (const ccy of tsKeys) {
      assert.deepEqual(
        ts.LOW_YIELD_CURRENCIES[ccy],
        cjs.LOW_YIELD_CURRENCIES[ccy],
        `LOW_YIELD_CURRENCIES.${ccy} drift: TS=${JSON.stringify(ts.LOW_YIELD_CURRENCIES[ccy])} CJS=${JSON.stringify(cjs.LOW_YIELD_CURRENCIES[ccy])}`,
      );
    }
  });

  test('NO_SENIOR_VARIANTS match between TS and CJS', async () => {
    const ts = await import(SHARED_DIST);
    const tsArr = [...ts.NO_SENIOR_VARIANTS].sort();
    const cjsArr = [...cjs.NO_SENIOR_VARIANTS].sort();
    assert.deepEqual(tsArr, cjsArr, `NO_SENIOR_VARIANTS drift: TS=${tsArr} CJS=${cjsArr}`);
  });

  test('VARIANT_TENURE match between TS and CJS', async () => {
    const ts = await import(SHARED_DIST);
    for (const variant of ['regular', 'nre', 'nro', 'fcnr', 'gift']) {
      assert.deepEqual(
        ts.VARIANT_TENURE[variant],
        cjs.VARIANT_TENURE[variant],
        `VARIANT_TENURE.${variant} drift: TS=${JSON.stringify(ts.VARIANT_TENURE[variant])} CJS=${JSON.stringify(cjs.VARIANT_TENURE[variant])}`,
      );
    }
  });

  test('SENIOR_PREMIUM and SUPER_SENIOR_PREMIUM match between TS and CJS', async () => {
    const ts = await import(SHARED_DIST);
    assert.equal(ts.SENIOR_PREMIUM, cjs.SENIOR_PREMIUM);
    assert.equal(ts.SUPER_SENIOR_PREMIUM, cjs.SUPER_SENIOR_PREMIUM);
  });

  test('CRITICAL_OVERSHOOT matches between TS and CJS', async () => {
    const ts = await import(SHARED_DIST);
    assert.equal(ts.CRITICAL_OVERSHOOT, cjs.CRITICAL_OVERSHOOT);
  });

  test('Delta thresholds match between TS and CJS', async () => {
    const ts = await import(SHARED_DIST);
    assert.equal(ts.DEFAULT_DELTA_BPS, cjs.DEFAULT_DELTA_BPS);
    assert.equal(ts.HIGH_DELTA_BPS, cjs.HIGH_DELTA_BPS);
    const tsCats = [...ts.HIGH_DELTA_CATEGORIES].sort();
    const cjsCats = [...cjs.HIGH_DELTA_CATEGORIES].sort();
    assert.deepEqual(tsCats, cjsCats);
  });

  test('getRateRange returns same values for regular/nre/nro/fcnr/gift', async () => {
    const ts = await import(SHARED_DIST);
    for (const variant of ['regular', 'nre', 'nro', 'fcnr', 'gift']) {
      assert.deepEqual(
        ts.getRateRange('FD', variant),
        cjs.getRateRange('FD', variant),
        `getRateRange("FD", "${variant}") drift`,
      );
    }
  });

  test('getSeniorRange returns same values', async () => {
    const ts = await import(SHARED_DIST);
    assert.deepEqual(ts.getSeniorRange('FD', 'regular'), cjs.getSeniorRange('FD', 'regular'));
    assert.equal(ts.getSeniorRange('FD', 'fcnr'), cjs.getSeniorRange('FD', 'fcnr')); // both null
  });

  test('getSuperSeniorRange returns same values', async () => {
    const ts = await import(SHARED_DIST);
    assert.deepEqual(ts.getSuperSeniorRange('FD', 'regular'), cjs.getSuperSeniorRange('FD', 'regular'));
    assert.equal(ts.getSuperSeniorRange('FD', 'fcnr'), cjs.getSuperSeniorRange('FD', 'fcnr'));
  });

  test('getDeltaThreshold returns same values across bank categories', async () => {
    const ts = await import(SHARED_DIST);
    for (const cat of ['PSB', 'PVB', 'SFB', 'NBFC', 'LAB', 'SUCB', undefined]) {
      assert.deepEqual(
        ts.getDeltaThreshold(cat),
        cjs.getDeltaThreshold(cat),
        `getDeltaThreshold(${cat}) drift`,
      );
    }
  });
}

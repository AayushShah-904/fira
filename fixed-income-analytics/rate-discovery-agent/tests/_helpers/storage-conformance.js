'use strict';

/**
 * Conformance suite for the Storage adapter (lib/storage.js).
 *
 * Each driver-specific test file imports `runConformanceSuite` and calls it
 * with a factory that produces a fresh Storage instance per test.
 *
 *   runConformanceSuite('fs', () => makeStorageBackedByTmpFs());
 *   runConformanceSuite('memory', () => makeStorageBackedByMemory());
 *
 * Optional precheck: drivers that depend on external infrastructure (e.g.,
 * Azurite for azure-storage-blob) can pass a precheck that returns
 * `{ ok: false, reason }` to skip the whole suite cleanly when the
 * infrastructure isn't available.
 *
 *   runConformanceSuite('azure-blob (azurite)', makeAzureStorage, {
 *     precheck: async () => isAzuriteReachable()
 *       ? { ok: true }
 *       : { ok: false, reason: 'Azurite not running' },
 *   });
 *
 * Tests use only the public Storage API (no driver-specific behavior).
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  StorageNotFoundError,
  StorageParseError,
  StorageKeyError,
} = require('../../lib/storage');

function runConformanceSuite(label, makeStorage, options = {}) {
  test(`storage conformance — ${label}`, async (t) => {
    if (typeof options.precheck === 'function') {
      const result = await options.precheck();
      if (!result || !result.ok) {
        t.skip(result && result.reason ? result.reason : 'precheck failed');
        return;
      }
    }

    // ----- Round-trip JSON -----

    await t.test('writeJson + readJson round-trips an object', async () => {
      const s = await makeStorage();
      const data = { hello: 'world', n: 42, nested: { a: [1, 2, 3] } };
      await s.writeJson('output/latest/foo_config.json', data);
      const got = await s.readJson('output/latest/foo_config.json');
      assert.deepStrictEqual(got, data);
    });

    await t.test('writeJson + readJson round-trips an array', async () => {
      const s = await makeStorage();
      const data = [{ id: 1 }, { id: 2 }];
      await s.writeJson('data/list.json', data);
      assert.deepStrictEqual(await s.readJson('data/list.json'), data);
    });

    await t.test('readJson of missing key throws StorageNotFoundError', async () => {
      const s = await makeStorage();
      await assert.rejects(
        () => s.readJson('does/not/exist.json'),
        (err) => err instanceof StorageNotFoundError && err.key === 'does/not/exist.json'
      );
    });

    await t.test('readJson of corrupted JSON throws StorageParseError', async () => {
      const s = await makeStorage();
      await s.writeText('output/latest/broken.json', '{not valid json');
      await assert.rejects(
        () => s.readJson('output/latest/broken.json'),
        (err) => err instanceof StorageParseError
      );
    });

    // ----- Text -----

    await t.test('writeText + readText round-trip preserves UTF-8', async () => {
      const s = await makeStorage();
      const text = 'hello — namaste 🇮🇳 — café';
      await s.writeText('data/notes.txt', text);
      assert.strictEqual(await s.readText('data/notes.txt'), text);
    });

    await t.test('readText of missing key throws StorageNotFoundError', async () => {
      const s = await makeStorage();
      await assert.rejects(
        () => s.readText('missing.txt'),
        (err) => err instanceof StorageNotFoundError
      );
    });

    // ----- Binary -----

    await t.test('writeBinary + readBinary preserves bytes exactly', async () => {
      const s = await makeStorage();
      // Mix of all byte values: 0x00..0xFF
      const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      await s.writeBinary('output/latest/foo_source_abc123.pdf', buf);
      const got = await s.readBinary('output/latest/foo_source_abc123.pdf');
      assert.ok(Buffer.isBuffer(got), 'readBinary must return a Buffer');
      assert.strictEqual(got.length, 256);
      assert.strictEqual(Buffer.compare(got, buf), 0);
    });

    await t.test('writeBinary accepts Uint8Array', async () => {
      const s = await makeStorage();
      const u8 = new Uint8Array([1, 2, 3, 4, 5]);
      await s.writeBinary('data/u8.bin', u8);
      const got = await s.readBinary('data/u8.bin');
      assert.strictEqual(Buffer.compare(got, Buffer.from(u8)), 0);
    });

    await t.test('writeBinary rejects non-Buffer/Uint8Array', async () => {
      const s = await makeStorage();
      await assert.rejects(() => s.writeBinary('data/x.bin', 'a string'), TypeError);
      await assert.rejects(() => s.writeBinary('data/x.bin', 42), TypeError);
    });

    // ----- exists -----

    await t.test('exists returns false for missing key without throwing', async () => {
      const s = await makeStorage();
      assert.strictEqual(await s.exists('nope/nope.json'), false);
    });

    await t.test('exists returns true after a write', async () => {
      const s = await makeStorage();
      await s.writeText('data/x.txt', 'present');
      assert.strictEqual(await s.exists('data/x.txt'), true);
    });

    // ----- list -----

    await t.test('list returns full keys filtered by prefix', async () => {
      const s = await makeStorage();
      await s.writeJson('output/latest/a.json', { a: 1 });
      await s.writeJson('output/latest/b.json', { b: 2 });
      await s.writeJson('data/c.json', { c: 3 });

      const all = await s.list('output/latest/');
      assert.strictEqual(all.length, 2);
      assert.ok(all.includes('output/latest/a.json'));
      assert.ok(all.includes('output/latest/b.json'));
      assert.ok(!all.includes('data/c.json'));
    });

    await t.test('list with non-matching prefix returns []', async () => {
      const s = await makeStorage();
      await s.writeJson('output/latest/a.json', {});
      assert.deepStrictEqual(await s.list('nope/'), []);
    });

    await t.test('list with empty prefix returns all keys', async () => {
      const s = await makeStorage();
      await s.writeJson('a.json', {});
      await s.writeJson('b/c.json', {});
      const keys = await s.list('');
      assert.strictEqual(keys.length, 2);
    });

    // ----- delete -----

    await t.test('delete removes an existing key', async () => {
      const s = await makeStorage();
      await s.writeText('data/temp.txt', 'goodbye');
      assert.strictEqual(await s.exists('data/temp.txt'), true);
      await s.delete('data/temp.txt');
      assert.strictEqual(await s.exists('data/temp.txt'), false);
    });

    await t.test('delete of missing key is a no-op (does not throw)', async () => {
      const s = await makeStorage();
      await s.delete('never/existed.txt');
      // implicit: no throw, completes
    });

    // ----- key validation (driver-independent, but verified per driver) -----

    await t.test('key validation rejects uppercase', async () => {
      const s = await makeStorage();
      await assert.rejects(() => s.readJson('Output/latest/x.json'), StorageKeyError);
      await assert.rejects(() => s.writeText('Mixed/Case.txt', 'x'), StorageKeyError);
    });

    await t.test('key validation rejects leading slash', async () => {
      const s = await makeStorage();
      await assert.rejects(() => s.readText('/output/latest/x.json'), StorageKeyError);
    });

    await t.test('key validation rejects trailing slash', async () => {
      const s = await makeStorage();
      await assert.rejects(() => s.readJson('output/latest/'), StorageKeyError);
    });

    await t.test('key validation rejects forbidden characters', async () => {
      const s = await makeStorage();
      await assert.rejects(() => s.readJson('output/latest/file?v=1.json'), StorageKeyError);
      await assert.rejects(() => s.readJson('output/latest/file#frag.json'), StorageKeyError);
      await assert.rejects(() => s.readJson('output\\latest\\x.json'), StorageKeyError);
    });

    await t.test('key validation rejects empty segments', async () => {
      const s = await makeStorage();
      await assert.rejects(() => s.readJson('output//latest/x.json'), StorageKeyError);
    });

    await t.test('key validation rejects empty / non-string keys', async () => {
      const s = await makeStorage();
      await assert.rejects(() => s.readJson(''), StorageKeyError);
      await assert.rejects(() => s.readJson(null), StorageKeyError);
      await assert.rejects(() => s.readJson(undefined), StorageKeyError);
      await assert.rejects(() => s.readJson(42), StorageKeyError);
    });
  });
}

module.exports = { runConformanceSuite };

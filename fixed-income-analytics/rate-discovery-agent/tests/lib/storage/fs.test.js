'use strict';

/**
 * Conformance tests for the Storage adapter against the unstorage fs driver.
 *
 * IMPORTANT: every test gets a fresh os.tmpdir() subdirectory via mkdtempSync.
 * NEVER point this at the repo root — output/latest/ contains real, costly-to-recollect
 * scraped data that must not be touched by tests. The temp directory is cleaned up
 * after each test. See feedback_preserve_scraped_artifacts in user memory.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Storage } = require('../../../lib/storage');
const { runConformanceSuite } = require('../../_helpers/storage-conformance');

const { createStorage: createUnstorage } = require('unstorage');
const fsDriverModule = require('unstorage/drivers/fs');
const fsDriver = fsDriverModule.default || fsDriverModule;

// Track tmp dirs so we can clean up at the end
const createdDirs = [];

function makeStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bofia-storage-test-'));
  createdDirs.push(dir);
  return new Storage(createUnstorage({ driver: fsDriver({ base: dir }) }));
}

// Cleanup after the entire suite runs
test.after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // best-effort
    }
  }
});

runConformanceSuite('fs (tmp)', makeStorage);

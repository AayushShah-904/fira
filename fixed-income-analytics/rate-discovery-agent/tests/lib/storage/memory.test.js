'use strict';

/**
 * Conformance tests for the Storage adapter against the in-memory unstorage driver.
 * Pure Node, no filesystem, no Azure. Fastest suite.
 */

const { Storage } = require('../../../lib/storage');
const { runConformanceSuite } = require('../../_helpers/storage-conformance');

const { createStorage: createUnstorage } = require('unstorage');
const memoryDriverModule = require('unstorage/drivers/memory');
const memoryDriver = memoryDriverModule.default || memoryDriverModule;

function makeStorage() {
  // Fresh in-memory driver per test invocation — no cross-test bleed
  return new Storage(createUnstorage({ driver: memoryDriver() }));
}

runConformanceSuite('memory', makeStorage);

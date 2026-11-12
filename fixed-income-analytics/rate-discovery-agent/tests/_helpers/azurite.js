'use strict';

/**
 * Azurite test helper.
 *
 * Azurite is the local Azure Blob Storage emulator (npm: install -g azurite,
 * then run `azurite` to start). This helper:
 *
 *   - probeAzurite()      Quick TCP probe to detect whether Azurite is
 *                         reachable on its default blob port. Used by the
 *                         azure-blob conformance test to skip cleanly when
 *                         Azurite isn't running.
 *
 *   - makeAzureStorage()  Returns a fresh Storage instance pointed at a
 *                         unique container in Azurite. The container is
 *                         created on demand and tracked for cleanup.
 *
 *   - cleanupContainers() Deletes every container makeAzureStorage()
 *                         created during the suite. Call from test.after().
 *
 * Why per-call containers (rather than a shared one with key prefixing):
 *   the conformance suite expects each makeStorage() call to produce
 *   isolated state — its subtests use fixed keys like
 *   'output/latest/foo_config.json' that would collide across subtests
 *   otherwise. Containers are cheap in Azurite; ~22 created per suite
 *   run is fine. Mirrors the per-call mkdtempSync pattern used by the
 *   fs driver tests.
 *
 * Connection string uses the Azurite-documented dev account / well-known
 * key (it's a PUBLIC, hard-coded test credential — not a secret).
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');

const { Storage } = require('../../lib/storage');
const { createStorage: createUnstorage } = require('unstorage');
const azureBlobDriverModule = require('unstorage/drivers/azure-storage-blob');
const azureBlobDriver = azureBlobDriverModule.default || azureBlobDriverModule;

const AZURITE_HOST = process.env.AZURITE_HOST || '127.0.0.1';
const AZURITE_PORT = Number(process.env.AZURITE_PORT) || 10000;
const PROBE_TIMEOUT_MS = 500;

// Well-known public Azurite dev credentials. NOT a real secret.
// See https://learn.microsoft.com/azure/storage/common/storage-use-azurite
const AZURITE_ACCOUNT = 'devstoreaccount1';
const AZURITE_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEEmlCDXJQyV4/oFzrBPwGn6+0vO/nVcOqTo7Q9hJTczTW8IYGpJJpBdtBUxTbg==';
const AZURITE_CONNECTION_STRING =
  `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT};` +
  `AccountKey=${AZURITE_KEY};` +
  `BlobEndpoint=http://${AZURITE_HOST}:${AZURITE_PORT}/${AZURITE_ACCOUNT};`;

const createdContainers = [];

/** TCP probe — resolves true if Azurite's blob port accepts a connection. */
function probeAzurite() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(AZURITE_PORT, AZURITE_HOST);
  });
}

function uniqueContainerName() {
  // Azurite container name rules: 3-63 chars, lowercase alphanumeric or hyphens,
  // start with letter or digit, no consecutive hyphens.
  return `test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Create a fresh container in Azurite and return a Storage instance bound to it.
 * The container is recorded so cleanupContainers() can delete it after the suite.
 */
async function makeAzureStorage() {
  const containerName = uniqueContainerName();
  const blobService = BlobServiceClient.fromConnectionString(AZURITE_CONNECTION_STRING);
  await blobService.getContainerClient(containerName).create();
  createdContainers.push(containerName);

  return new Storage(createUnstorage({
    driver: azureBlobDriver({
      accountName: AZURITE_ACCOUNT,
      containerName,
      connectionString: AZURITE_CONNECTION_STRING,
    }),
  }));
}

/** Best-effort cleanup of every container makeAzureStorage() created. */
async function cleanupContainers() {
  if (createdContainers.length === 0) return;
  const blobService = BlobServiceClient.fromConnectionString(AZURITE_CONNECTION_STRING);
  const names = createdContainers.splice(0);
  await Promise.allSettled(
    names.map((name) => blobService.getContainerClient(name).delete()),
  );
}

module.exports = {
  probeAzurite,
  makeAzureStorage,
  cleanupContainers,
  AZURITE_HOST,
  AZURITE_PORT,
};

'use strict';

/**
 * Storage adapter — typed wrapper over `unstorage` per
 * sdlc/sprints/sprint-001-azure-foundation/design/storage-adapter.md.
 *
 * Public API:
 *   const { createStorage, Storage, StorageNotFoundError, ... } = require('./storage');
 *   const storage = createStorage();          // env-driven (BIRD_STORAGE)
 *   await storage.readJson('output/latest/foo.json');
 *
 * Three modes selected by BIRD_STORAGE env var:
 *   - 'local' (default): unstorage fs driver rooted at the repo
 *   - 'azure':           unstorage azure-storage-blob driver
 *   - tests construct Storage directly with any driver they want
 */

const path = require('path');

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

class StorageError extends Error {
  constructor(message, { key, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    if (key !== undefined) this.key = key;
    if (cause !== undefined) this.cause = cause;
  }
}

class StorageNotFoundError extends StorageError {}
class StorageAuthError extends StorageError {}
class StorageNetworkError extends StorageError {}
class StorageParseError extends StorageError {}
class StorageKeyError extends StorageError {}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

const FORBIDDEN_CHARS_RE = /[?#\\\x00-\x1f\x7f]/;
const DOUBLE_SLASH_RE = /\/\//;

function validateKey(key) {
  if (typeof key !== 'string') {
    throw new StorageKeyError(`Key must be a string, got ${typeof key}`);
  }
  if (key.length === 0) {
    throw new StorageKeyError('Key cannot be empty');
  }
  if (key.startsWith('/')) {
    throw new StorageKeyError(`Key cannot start with '/': ${key}`, { key });
  }
  if (key.endsWith('/')) {
    throw new StorageKeyError(`Key cannot end with '/' (use list() for prefixes): ${key}`, { key });
  }
  if (key !== key.toLowerCase()) {
    throw new StorageKeyError(`Key must be lowercase: ${key}`, { key });
  }
  if (FORBIDDEN_CHARS_RE.test(key)) {
    throw new StorageKeyError(`Key contains forbidden character (?, #, \\, or control): ${key}`, { key });
  }
  if (DOUBLE_SLASH_RE.test(key)) {
    throw new StorageKeyError(`Key contains empty segment (//): ${key}`, { key });
  }
}

function validatePrefix(prefix) {
  // Same as key, except trailing slash IS allowed (prefix terminator).
  if (typeof prefix !== 'string') {
    throw new StorageKeyError(`Prefix must be a string, got ${typeof prefix}`);
  }
  if (prefix.length === 0) return; // empty prefix means "list all"
  if (prefix.startsWith('/')) {
    throw new StorageKeyError(`Prefix cannot start with '/': ${prefix}`);
  }
  if (prefix !== prefix.toLowerCase()) {
    throw new StorageKeyError(`Prefix must be lowercase: ${prefix}`);
  }
  if (FORBIDDEN_CHARS_RE.test(prefix)) {
    throw new StorageKeyError(`Prefix contains forbidden character: ${prefix}`);
  }
  if (DOUBLE_SLASH_RE.test(prefix)) {
    throw new StorageKeyError(`Prefix contains empty segment (//): ${prefix}`);
  }
}

// ---------------------------------------------------------------------------
// Key translation: our forward-slash convention ↔ unstorage's colon-internal
// ---------------------------------------------------------------------------

function toUnstorageKey(key) {
  return key.replace(/\//g, ':');
}

function fromUnstorageKey(key) {
  return key.replace(/:/g, '/');
}

// ---------------------------------------------------------------------------
// Backend error mapping
// ---------------------------------------------------------------------------

function mapBackendError(err, key) {
  // Azure SDK errors carry statusCode; node fs errors carry code.
  const statusCode = err && (err.statusCode || err.status || (err.response && err.response.status));
  const code = err && err.code;

  if (statusCode === 401 || statusCode === 403 || code === 'EACCES' || code === 'EPERM') {
    return new StorageAuthError(`Auth/permission failure on key ${key}: ${err.message}`, { key, cause: err });
  }
  if (statusCode === 503 || statusCode === 504 || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'ENOTFOUND') {
    return new StorageNetworkError(`Network failure on key ${key}: ${err.message}`, { key, cause: err });
  }
  // Pass through anything else (programming bugs surface clearly)
  return err;
}

async function callBackend(fn, key) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw mapBackendError(err, key);
  }
}

// ---------------------------------------------------------------------------
// Storage class
// ---------------------------------------------------------------------------

class Storage {
  /**
   * @param {object} unstorageInstance - a configured unstorage instance
   *   (e.g., createUnstorage({ driver: fsDriver({...}) }))
   */
  constructor(unstorageInstance) {
    if (!unstorageInstance || typeof unstorageInstance.getItem !== 'function') {
      throw new TypeError('Storage requires a configured unstorage instance');
    }
    this._u = unstorageInstance;
  }

  // ----- JSON -----

  async readJson(key) {
    validateKey(key);
    const raw = await callBackend(() => this._u.getItem(toUnstorageKey(key)), key);
    if (raw === null || raw === undefined) {
      throw new StorageNotFoundError(`Key not found: ${key}`, { key });
    }
    if (typeof raw === 'object') {
      // unstorage may have already parsed JSON for us (it does for some drivers)
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new StorageParseError(`Invalid JSON at key ${key}: ${err.message}`, { key, cause: err });
    }
  }

  async writeJson(key, data) {
    validateKey(key);
    const serialized = JSON.stringify(data, null, 2);
    await callBackend(() => this._u.setItem(toUnstorageKey(key), serialized), key);
  }

  // ----- Text -----

  async readText(key) {
    validateKey(key);
    const raw = await callBackend(() => this._u.getItem(toUnstorageKey(key)), key);
    if (raw === null || raw === undefined) {
      throw new StorageNotFoundError(`Key not found: ${key}`, { key });
    }
    return typeof raw === 'string' ? raw : String(raw);
  }

  async writeText(key, text) {
    validateKey(key);
    if (typeof text !== 'string') {
      throw new TypeError(`writeText requires a string; got ${typeof text}`);
    }
    await callBackend(() => this._u.setItem(toUnstorageKey(key), text), key);
  }

  // ----- Binary -----

  async readBinary(key) {
    validateKey(key);
    const raw = await callBackend(() => this._u.getItemRaw(toUnstorageKey(key)), key);
    if (raw === null || raw === undefined) {
      throw new StorageNotFoundError(`Key not found: ${key}`, { key });
    }
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw);
    if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
    if (typeof raw === 'string') return Buffer.from(raw);
    throw new StorageError(`Unexpected raw type for key ${key}: ${typeof raw}`, { key });
  }

  async writeBinary(key, data) {
    validateKey(key);
    if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
      throw new TypeError(`writeBinary requires a Buffer or Uint8Array; got ${typeof data}`);
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await callBackend(() => this._u.setItemRaw(toUnstorageKey(key), buf), key);
  }

  // ----- Existence + listing + delete -----

  async exists(key) {
    validateKey(key);
    return callBackend(() => this._u.hasItem(toUnstorageKey(key)), key);
  }

  async list(prefix) {
    validatePrefix(prefix);
    const keys = await callBackend(() => this._u.getKeys(toUnstorageKey(prefix)), prefix);
    return keys.map(fromUnstorageKey);
  }

  async delete(key) {
    validateKey(key);
    // Idempotent: no throw if absent. unstorage's removeItem is already idempotent.
    await callBackend(() => this._u.removeItem(toUnstorageKey(key)), key);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

/**
 * Construct a Storage backed by the driver chosen via BIRD_STORAGE env var.
 * Tests should construct Storage directly with their own driver.
 */
function createStorage(options = {}) {
  const mode = options.mode || process.env.BIRD_STORAGE || 'local';

  // Lazy-require so tests using Memory / FS don't pay the Azure SDK import cost.
  const { createStorage: createUnstorage } = require('unstorage');

  if (mode === 'local') {
    const fsDriverModule = require('unstorage/drivers/fs');
    const fsDriver = fsDriverModule.default || fsDriverModule;
    const base = options.fsBase || path.resolve(__dirname, '..');
    return new Storage(createUnstorage({ driver: fsDriver({ base }) }));
  }

  if (mode === 'memory') {
    const memoryDriverModule = require('unstorage/drivers/memory');
    const memoryDriver = memoryDriverModule.default || memoryDriverModule;
    return new Storage(createUnstorage({ driver: memoryDriver() }));
  }

  throw new Error(`Unknown BIRD_STORAGE mode: ${mode} (expected 'local' or 'memory')`);
}

module.exports = {
  Storage,
  createStorage,
  StorageError,
  StorageNotFoundError,
  StorageAuthError,
  StorageNetworkError,
  StorageParseError,
  StorageKeyError,
  // Internal helpers exported for tests; not part of the public API.
  _internals: { validateKey, validatePrefix, toUnstorageKey, fromUnstorageKey },
};

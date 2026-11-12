'use strict';

const fs = require('fs');
const path = require('path');

const ALIAS_FILE = path.join(__dirname, '..', 'data', 'bank-slug-aliases.json');

let _cache = null;

function loadAliasMap() {
  if (_cache !== null) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8'));
    _cache = (raw && raw.aliases && typeof raw.aliases === 'object') ? raw.aliases : {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function aliasToCanonical(slug) {
  if (!slug || typeof slug !== 'string') return slug;
  const map = loadAliasMap();
  return Object.prototype.hasOwnProperty.call(map, slug) ? map[slug] : slug;
}

function resetCacheForTests() { _cache = null; }

module.exports = { aliasToCanonical, loadAliasMap, resetCacheForTests };

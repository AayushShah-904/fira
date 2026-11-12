'use strict';

/**
 * lib/parsers/index.js — Custom Parser Registry (Phase 3)
 *
 * Strategy Pattern dispatcher: maps a `custom_parser` key from bank-domains.json
 * to the specific parser module for that bank.
 *
 * How to add a new parser:
 *   1. Create lib/parsers/<bank-id>-parser.js implementing the parser contract
 *   2. Register it below in PARSER_REGISTRY
 *   3. Add "custom_parser": "<key>" to the bank's extraction hint in bank-domains.json
 *
 * Parser Contract:
 *   Every parser must export a single async function:
 *
 *   async function parse(html, opts)
 *     @param {string} html     — raw HTML body of the rate page
 *     @param {object} opts
 *     @param {string}   opts.variant   — 'nre' | 'nro' | 'regular' | 'fcnr'
 *     @param {string}   opts.url       — source URL (for logging)
 *     @param {object}   [opts.logger]  — optional logger with .info / .warn
 *     @returns {Promise<{ slabs: Array, effective_date: string|null, warnings: string[] }>}
 */

const PARSER_REGISTRY = {
  'idfc':      () => require('./idfc-parser'),
  'bom':       () => require('./bom-parser'),
  'cosmos':    () => require('./cosmos-parser'),
  'saraswat':  () => require('./saraswat-parser'),
};

/**
 * Resolve and call a custom parser.
 *
 * @param {string} parserKey   — the "custom_parser" value from bank-domains.json
 * @param {string} html        — raw HTML body
 * @param {object} opts        — { variant, url, logger }
 * @returns {Promise<{ slabs, effective_date, warnings }|null>}
 *   Returns null if parserKey is unknown (caller falls back to generic parser).
 */
async function runCustomParser(parserKey, html, opts) {
  const loader = PARSER_REGISTRY[parserKey];
  if (!loader) {
    const log = opts.logger || { warn: console.warn };
    log.warn(`[custom-parser] unknown parserKey="${parserKey}" — no custom parser registered`);
    return null;
  }
  const parser = loader();
  return parser.parse(html, opts);
}

/**
 * Returns true if a custom parser is registered for the given key.
 * Useful for the orchestrator to decide whether to attempt custom parsing.
 */
function hasCustomParser(parserKey) {
  return Object.prototype.hasOwnProperty.call(PARSER_REGISTRY, parserKey);
}

module.exports = { runCustomParser, hasCustomParser };

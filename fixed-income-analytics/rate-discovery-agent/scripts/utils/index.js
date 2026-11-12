/**
 * Barrel export for rate-discovery-agent utility modules.
 */
const { slugify } = require("./slugify");
const { parseTenure, TENURE_PRESETS, TENURE_UNIT_DAYS } = require("./parse-tenure");
const { validateRate, validateSlabs, RATE_BOUNDS } = require("./validate-rates");
const { CONFIG_DEFAULTS, mergeWithDefaults, stripDefaults } = require("./config-defaults");

module.exports = {
  slugify,
  parseTenure,
  TENURE_PRESETS,
  TENURE_UNIT_DAYS,
  validateRate,
  validateSlabs,
  RATE_BOUNDS,
  CONFIG_DEFAULTS,
  mergeWithDefaults,
  stripDefaults,
};

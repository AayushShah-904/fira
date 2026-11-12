/**
 * Default config values for bank discovery configs.
 * Used to fill in missing fields and strip defaults for compact storage.
 */

const CONFIG_DEFAULTS = {
  tenure_parser: "standard_indian",
  rate_multiplier: 1.0,
  senior_citizen_premium: "same_table",
  deposit_insurance: true,
  update_frequency: "monthly",
  selectors: { table: null, rows: null, effective_date: null },
  column_mapping: {},
  scraper_notes: {
    framework: null,
    bot_protection: null,
    data_format: null,
    rate_tables_on_page: null,
  },
};

/**
 * Deep-merge a partial config onto defaults.
 * Returns a full config with all fields populated.
 */
function mergeWithDefaults(partial) {
  const result = {};
  // Copy all keys from partial first
  for (const key of Object.keys(partial)) {
    result[key] = partial[key];
  }
  // Fill missing keys from defaults
  for (const [key, defaultVal] of Object.entries(CONFIG_DEFAULTS)) {
    if (!(key in result) || result[key] === undefined) {
      result[key] = deepClone(defaultVal);
    } else if (isPlainObject(defaultVal) && isPlainObject(result[key])) {
      // Merge sub-objects (one level deep)
      for (const [subKey, subDefault] of Object.entries(defaultVal)) {
        if (!(subKey in result[key]) || result[key][subKey] === undefined) {
          result[key][subKey] = subDefault;
        }
      }
    }
  }
  return result;
}

/**
 * Remove fields from a config that match their default values.
 * Returns a compact config with only non-default fields.
 */
function stripDefaults(config) {
  const result = {};
  for (const [key, value] of Object.entries(config)) {
    if (!(key in CONFIG_DEFAULTS)) {
      // Not a default-able field — always keep
      result[key] = value;
    } else if (!deepEqual(value, CONFIG_DEFAULTS[key])) {
      result[key] = value;
    }
    // else: matches default, omit
  }
  return result;
}

function isPlainObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function deepClone(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(deepClone);
  const result = {};
  for (const [k, v] of Object.entries(val)) result[k] = deepClone(v);
  return result;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(a[k], b[k]));
}

module.exports = { CONFIG_DEFAULTS, mergeWithDefaults, stripDefaults };

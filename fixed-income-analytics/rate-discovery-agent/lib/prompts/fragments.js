/**
 * Modular prompt fragments — SINGLE SOURCE OF TRUTH is docs/agent/*.md.
 *
 * Each fragment is an anchored section (`<!-- @fragment NAME -->` …
 * `<!-- @end NAME -->`) inside a markdown file under docs/agent/. This module
 * reads those sections so the same text serves (a) the automated pipeline
 * (build-prompt.js assembles only the fragments a mode needs) and (b) humans /
 * interactive agents who read the docs directly. CLAUDE.md is a lean router
 * that points here — there is no second copy to drift.
 *
 * To change a fragment, edit the corresponding docs/agent/*.md section, NOT
 * this file. build-prompt.js still saves 25-60% of tokens vs loading the whole
 * doc set, by selecting only the relevant fragments per mode.
 */

const fs = require("node:fs");
const path = require("node:path");

const DOCS_DIR = path.join(__dirname, "..", "..", "docs", "agent");
const _docCache = new Map();

function loadDoc(file) {
  if (!_docCache.has(file)) {
    _docCache.set(file, fs.readFileSync(path.join(DOCS_DIR, file), "utf-8"));
  }
  return _docCache.get(file);
}

/** Extract an anchored fragment section from a docs/agent/*.md file. */
function frag(file, name) {
  const doc = loadDoc(file);
  const m = doc.match(
    new RegExp(`<!-- @fragment ${name} -->\\r?\\n([\\s\\S]*?)\\r?\\n<!-- @end ${name} -->`)
  );
  if (!m) {
    throw new Error(`prompt fragment '${name}' not found in docs/agent/${file}`);
  }
  return m[1];
}

const IDENTITY = frag("core.md", "IDENTITY");
const RULES_CORE = frag("core.md", "RULES_CORE");
const EFFICIENCY_RULES = frag("discovery-workflow.md", "EFFICIENCY_RULES");
const STEP_FIND_WEBSITE = frag("discovery-workflow.md", "STEP_FIND_WEBSITE");
const STEP_FIND_RATE_PAGES = frag("discovery-workflow.md", "STEP_FIND_RATE_PAGES");
const STEP_SCRAPER_TYPE = frag("discovery-workflow.md", "STEP_SCRAPER_TYPE");
const STEP_EXTRACT_RATES = frag("discovery-workflow.md", "STEP_EXTRACT_RATES");
const STEP_NRI_FCNR = frag("nri-gift-ibu.md", "STEP_NRI_FCNR");
const STEP_GIFT_CITY = frag("nri-gift-ibu.md", "STEP_GIFT_CITY");
const CONFIG_SCHEMA = frag("schemas.md", "CONFIG_SCHEMA");
const RATE_SCHEMA = frag("schemas.md", "RATE_SCHEMA");
const OUTPUT_SLUG = frag("schemas.md", "OUTPUT_SLUG");
const BANK_TYPE_TABLE = frag("schemas.md", "BANK_TYPE_TABLE");
const LEARNINGS_FROM_FIELD = frag("field-learnings.md", "LEARNINGS_FROM_FIELD");

module.exports = {
  IDENTITY,
  EFFICIENCY_RULES,
  STEP_FIND_WEBSITE,
  STEP_FIND_RATE_PAGES,
  STEP_NRI_FCNR,
  STEP_GIFT_CITY,
  STEP_SCRAPER_TYPE,
  STEP_EXTRACT_RATES,
  CONFIG_SCHEMA,
  RATE_SCHEMA,
  BANK_TYPE_TABLE,
  RULES_CORE,
  OUTPUT_SLUG,
  LEARNINGS_FROM_FIELD,
  // Exposed for tooling/tests that want to read a fragment by (file, name).
  _frag: frag,
};

/**
 * Build mode-specific system prompts from fragments.
 *
 * Instead of loading the full docs/agent/ set for every mode, this assembles
 * only the relevant fragments (sourced from docs/agent/*.md via fragments.js):
 *   discover:    ~3200 tokens (25% savings)
 *   expand-nri:  ~1900 tokens (56% savings)
 *   rates-only:  ~1700 tokens (60% savings)
 */

const f = require("./fragments");

/** Bank types that offer NRI products. */
const NRI_BANK_TYPES = new Set(["PSB", "PVB", "FB", "SFB", "IBU"]);

/**
 * Build the system prompt for a given mode and bank context.
 *
 * @param {string} mode - "discover" | "expand-nri" | "rates-only"
 * @param {object} [ctx]
 * @param {string} [ctx.bankType] - Bank type code (PSB, PVB, SFB, etc.)
 * @param {boolean} [ctx.isIBU] - Whether this is an IFSC Banking Unit
 * @returns {string} Assembled system prompt
 */
function buildSystemPrompt(mode, { bankType, isIBU } = {}) {
  const parts = [f.IDENTITY];

  if (mode === "discover") {
    parts.push(f.EFFICIENCY_RULES);
    parts.push(f.LEARNINGS_FROM_FIELD);
    parts.push(f.STEP_FIND_WEBSITE);
    parts.push(f.STEP_FIND_RATE_PAGES);
    if (NRI_BANK_TYPES.has(bankType)) parts.push(f.STEP_NRI_FCNR);
    if (isIBU) parts.push(f.STEP_GIFT_CITY);
    parts.push(f.STEP_SCRAPER_TYPE);
    parts.push(f.STEP_EXTRACT_RATES);
    parts.push(f.CONFIG_SCHEMA);
    parts.push(f.BANK_TYPE_TABLE);
  } else if (mode === "expand-nri") {
    parts.push(f.STEP_NRI_FCNR);
    parts.push(f.STEP_EXTRACT_RATES);
    parts.push(f.CONFIG_SCHEMA);
  } else if (mode === "rates-only") {
    parts.push(f.STEP_SCRAPER_TYPE);
    parts.push(f.STEP_EXTRACT_RATES);
  }

  // Always include output schema and rules
  parts.push(f.RATE_SCHEMA);
  parts.push(f.RULES_CORE);
  parts.push(f.OUTPUT_SLUG);

  return parts.join("\n\n");
}

module.exports = { buildSystemPrompt };

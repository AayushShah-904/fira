/**
 * Two-tier model routing for the discovery agent.
 *
 * Tier 1 (mini): Cheap, fast — handles ~70% of banks.
 * Tier 2 (full): Capable, costlier — for complex pages or when mini fails.
 *
 * Routing logic:
 *   Pre-route to full model:
 *     - scraper_type is html_js (JS-rendered, needs Playwright interpretation)
 *     - bank-domains.json notes mention WAF/bot protection/CAPTCHA
 *     - mode is expand-nri (multi-page NRI discovery is harder)
 *     - IBU banks (GIFT City discovery is complex)
 *
 *   Post-run quality check (triggers retry with full model):
 *     - 0 rate slabs extracted
 *     - extraction_confidence is "none" or "low"
 *     - config has scraper_type "manual" but domain was known (unexpected failure)
 *     - agent returned success: false
 */

const fs = require("fs");
const path = require("path");

const { CURATED_EXTRACTION_METHODS: CURATED_ARRAY } = require("./extraction-methods");

// Sprint 002 #5 (L6 codification): discovery_status values that mean "operator
// has classified this bank as terminal; do NOT run the agent." The runner
// writes a synthetic config+summary derived from the registry entry instead.
const TERMINAL_DISCOVERY_STATUSES = new Set([
  'no_website_known',           // No online presence — agent would burn budget for no value.
  'website_known_no_rate_page', // Website exists but no usable rate page — registry already holds the truth.
  'pending_vision',             // Rate page is image/scanned-PDF — needs Vision API or operator transcription, agent re-discovery would just rediscover the same dead-end.
  // Sprint 009 Phase 9.4 (2026-06-05): banks whose site publishes
  // foreign-currency rates (BDT/USD/etc.), not INR FD. Excluded from the
  // INR pack by operator decision. AB Bank PLC was processed in the
  // top-50 cohort despite this label being set — caused $0.17 wasted
  // spend + 1 fake "failure" in the receipt totals.
  'foreign_currency_not_inr',
]);

// Operator-curated extraction_method values. Canonical list is in
// lib/extraction-methods.js (per ADR-012) — re-exposed here as a Set for
// the skip-gate's quick-lookup.
const CURATED_EXTRACTION_METHODS = new Set(CURATED_ARRAY);

/**
 * Determine the discovery action for a bank, given its registry entry.
 *
 * Returns one of:
 *   { skip: true, reason, registryEntry, discovery_status } — caller should
 *       short-circuit and write a synthetic config+summary from the registry,
 *       no agent invocation.
 *   { tier: 1|2, reason } — proceed to discovery with the indicated model.
 *
 * Callers that only care about the model tier can ignore `skip` and fall
 * through to the tier; the existing `selectInitialTier` keeps that legacy
 * contract.
 *
 * @param {object} ctx
 * @param {string} ctx.mode - "discover" | "expand-nri" | "rates-only"
 * @param {string} ctx.bankCode - Canonical bank slug
 * @param {string} [ctx.bankType] - PSB, PVB, SFB, etc.
 * @param {boolean} [ctx.isIBU] - Whether this is an IFSC Banking Unit
 * @param {string} ctx.projectRoot - Project root path
 */
function selectDiscoveryAction(ctx) {
  const { mode, bankCode, isIBU, projectRoot } = ctx;

  let registryEntry = null;
  try {
    const domainsFile = path.join(projectRoot, "data", "bank-domains.json");
    if (fs.existsSync(domainsFile)) {
      const domains = JSON.parse(fs.readFileSync(domainsFile, "utf-8"));
      registryEntry = domains[bankCode] || null;
    }
  } catch {
    // Non-fatal — fall through to default discovery
  }

  // M3 (sprint-004 2026-05-22): banks that declare an OCR hint
  // (extraction.*.type === "image_ocr") now have an automated extraction
  // path. The legacy `pending_vision` extraction_method marker should NOT
  // skip them — that marker means "no automated path exists", which is
  // no longer true once the operator has authored an OCR hint.
  const hasOcrHint = registryEntry && registryEntry.extraction
    && Object.values(registryEntry.extraction).some(
      (h) => h && typeof h === 'object' && h.type === 'image_ocr',
    );

  // Skip path — operator-confirmed terminal classification, OR operator has
  // already curated rate data for this bank. Only honor in "discover" mode;
  // explicit re-extraction modes bypass the skip so an operator can force a
  // re-run via `--rates-only` / `--expand-nri`.
  if (mode === "discover" && registryEntry) {
    if (registryEntry.discovery_status
        && TERMINAL_DISCOVERY_STATUSES.has(registryEntry.discovery_status)) {
      // OCR hint overrides the pending_vision discovery_status
      if (registryEntry.discovery_status === 'pending_vision' && hasOcrHint) {
        // fall through to discovery
      } else {
        return {
          skip: true,
          reason: `discovery_status=${registryEntry.discovery_status}`,
          discovery_status: registryEntry.discovery_status,
          registryEntry,
        };
      }
    }
    if (registryEntry.extraction_method
        && CURATED_EXTRACTION_METHODS.has(registryEntry.extraction_method)) {
      // OCR hint overrides the pending_vision extraction_method marker
      if (registryEntry.extraction_method === 'pending_vision' && hasOcrHint) {
        // fall through to discovery
      } else {
        return {
          skip: true,
          reason: `extraction_method=${registryEntry.extraction_method} (operator-curated)`,
          discovery_status: registryEntry.discovery_status || `curated:${registryEntry.extraction_method}`,
          registryEntry,
        };
      }
    }
  }

  // IBU banks always need the full model (complex GIFT City discovery)
  if (isIBU) return { tier: 2, reason: "IBU bank (GIFT City discovery)" };

  // NRI expansion involves multi-page discovery — harder for mini
  if (mode === "expand-nri") return { tier: 2, reason: "expand-nri mode" };

  // Registry hints for known-complex pages
  if (registryEntry) {
    if (registryEntry.scraper_type === "html_js") {
      return { tier: 2, reason: `scraper_type: html_js` };
    }
    const notes = (registryEntry.notes || "").toLowerCase();
    if (/waf|captcha|bot.?protect|cloudflare|imperva|radware|blocked/i.test(notes)) {
      return { tier: 2, reason: "WAF/bot protection noted" };
    }
  }

  // Everything else starts with mini
  return { tier: 1, reason: "default" };
}

/**
 * Legacy contract — returns { tier, reason } only. Callers that don't need
 * the skip path use this. Internally delegates to selectDiscoveryAction and
 * collapses the skip case to tier 1 (so callers that bypass selectDiscoveryAction
 * default to a real discovery attempt rather than silently skipping).
 *
 * @param {object} ctx — same as selectDiscoveryAction
 * @returns {{ tier: 1|2, reason: string }}
 */
function selectInitialTier(ctx) {
  const action = selectDiscoveryAction(ctx);
  const base = action.skip ? { tier: 1, reason: action.reason } : action;
  return applyForceTierEnv(base);
}

/**
 * Check the quality of an agent run's output to decide if retry is needed.
 *
 * @param {object} ctx
 * @param {object} ctx.agentResult - Return value from runAgent()
 * @param {string} ctx.runDir - Output directory for this run
 * @param {string} ctx.bankCode - Canonical bank slug
 * @param {boolean} ctx.domainWasKnown - Whether the domain was in bank-domains.json
 * @param {object} [ctx.priorSlabCounts] - { regular, nre, nro, fcnr, gift } slab counts from the prior run, used for drift detection
 * @param {object} [ctx.floorSlabCounts] - { regular, nre, nro, fcnr, gift } operator-curated minimums from data/expected-slab-floors.json
 * @param {string[]} [ctx.expectedVariants] - Variant names that this bank type is expected to produce (e.g. ['regular','nre','nro','fcnr'] for a PSB). Any variant in this list without an explicit prior/floor entry defaults to a required floor of 1 — i.e., 0 slabs on that variant triggers drift. Explicit floorSlabCounts[v]=0 opts a variant out.
 * @param {number} [ctx.driftThreshold=0.8] - Trigger drift retry when actual / max(prior,floor) < this ratio
 * @returns {{ pass: boolean, reason: string }}
 */
function checkQuality(ctx) {
  const { agentResult, runDir, bankCode, domainWasKnown, priorSlabCounts, floorSlabCounts, expectedVariants, driftThreshold = 0.8 } = ctx;

  // Agent itself failed (API error, max iterations, etc.)
  if (!agentResult.success) {
    return { pass: false, reason: `agent failed: ${(agentResult.finalText || agentResult.error || "").slice(0, 100)}` };
  }

  // Check if config was written
  const configPath = path.join(runDir, `${bankCode}_config.json`);
  if (!fs.existsSync(configPath)) {
    return { pass: false, reason: "no config file produced" };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return { pass: false, reason: "config file is invalid JSON" };
  }

  // Check rate file
  const ratesPath = path.join(runDir, `${bankCode}_rates.json`);
  if (!fs.existsSync(ratesPath)) {
    return { pass: false, reason: "no rates file produced" };
  }

  let rates;
  try {
    rates = JSON.parse(fs.readFileSync(ratesPath, "utf-8"));
  } catch {
    return { pass: false, reason: "rates file is invalid JSON" };
  }

  // Sprint 010 Phase 5 (2026-06-07) — partial_silent root cause fix.
  // Registry-skip / curated banks intentionally produce empty (or thin)
  // rate files because the truth lives in operator-curated artifacts
  // upstream, not in this run's extraction. Without this check, downstream
  // drift comparison fires on slabCount=0 vs prior=N, triggers an LLM retry
  // that has no chance of finding rates the registry already says don't
  // exist on the live site (axis-bank-limited cohort case: registry has
  // extraction_method='manual_pdf_transcription' → attempt 1 runs
  // registry_skip → drift fires → attempts 2/3 run gpt-4.1 + 6 fetch_pdf
  // calls that all 403 → partial_silent marker written → pack drops the
  // bank's variants). Treat as pass: the failure-classifier and pack-builder
  // use the same SKIP_OUTPUT_METHODS set to ignore these for their own
  // gating (lib/extraction-inspector.js, sprint 009 Phase 9.2). Drift gating
  // now matches. Must run BEFORE the scraper_type=manual check because a
  // curated bank can legitimately have manual_pdf_transcription + scraper_type:'manual'.
  const ratesMethod = rates.extraction_method;
  const configMethod = config.extraction_method;
  const skipMethod = ratesMethod === 'registry_skip'
    || configMethod === 'registry_skip'
    || (ratesMethod && CURATED_EXTRACTION_METHODS.has(ratesMethod))
    || (configMethod && CURATED_EXTRACTION_METHODS.has(configMethod));
  if (skipMethod) {
    return { pass: true, reason: `extraction_method=${ratesMethod || configMethod} (curated/registry_skip; drift checks suppressed)`, drifted: [] };
  }

  // If domain was known but config says "manual" — unexpected failure
  if (domainWasKnown && config.scraper_type === "manual") {
    return { pass: false, reason: "scraper_type is manual despite known domain" };
  }

  const slabCount = (rates.rate_slabs || []).length;
  const confidence = rates.extraction_confidence || config.discovery_metadata?.confidence;

  // 0 slabs is a failure unless the bank genuinely has no FD (payments banks)
  if (slabCount === 0 && config.scraper_type !== "manual") {
    return { pass: false, reason: `0 rate slabs extracted (confidence: ${confidence})` };
  }

  // Low confidence — the model isn't sure about the data
  if (confidence === "none" || confidence === "low") {
    return { pass: false, reason: `extraction confidence: ${confidence}` };
  }

  // Drift check vs operator-curated floors (bank-domains.json) and the prior
  // run's slab counts. AU SFB cloud regression (Sprint 4 smoke 2026-05-20):
  // cloud LLM stopped after the first amount-tier table, wrote "high
  // confidence" with 12 slabs vs local baseline 23. Confidence alone doesn't
  // catch this; the LLM doesn't know what it's missing. We compare the new
  // per-variant slab counts to max(prior, floor) per variant — when any
  // variant drops below driftThreshold * expected, retry.
  //
  // Floor-only signal (no prior in latestDir) fixes the first-cloud-run
  // chicken-and-egg: PNB cloud got 19 vs local 84, no prior on cloud, so
  // the prior-only check skipped silently. With expected_slab_count_min
  // seeded from local baselines, drift now fires on the first cloud run too.
  // M2.1 (sprint-004 2026-05-21): collect ALL drifted variants instead of
  // returning on the first hit. The legacy {pass, reason} shape stays for
  // back-compat (reason carries the first drift, matching prior behaviour);
  // the new `drifted` array enables variant-scoped partial_silent in
  // pack/build-pack.js so a single weak variant no longer suppresses the
  // healthy ones (Citibank case: regular@17 vs floor 34 cost us NRE+NRO=34
  // perfectly fine slabs).
  const expectedByVariant = mergeExpected(priorSlabCounts, floorSlabCounts, expectedVariants);
  const drifted = [];
  if (Object.keys(expectedByVariant).length > 0) {
    const variantSuffixes = { regular: "", nre: "_nre", nro: "_nro", fcnr: "_fcnr", gift: "_gift" };
    for (const [variant, { expected, source }] of Object.entries(expectedByVariant)) {
      if (!Number.isFinite(expected) || expected <= 0) continue;
      const suffix = variantSuffixes[variant];
      if (suffix === undefined) continue;
      const variantRatesFile = path.join(runDir, `${bankCode}${suffix}_rates.json`);
      let actual = 0;
      if (variant === "regular") {
        // domestic FD: rate_slabs from the main rates file we already loaded
        actual = slabCount;
      } else if (fs.existsSync(variantRatesFile)) {
        try {
          const variantRates = JSON.parse(fs.readFileSync(variantRatesFile, "utf-8"));
          actual = (variantRates.rate_slabs || []).length;
        } catch { /* leave actual=0 */ }
      }
      if (actual < driftThreshold * expected) {
        drifted.push({ variant, actual, expected, source });
      }
    }
  }
  if (drifted.length > 0) {
    const first = drifted[0];
    return {
      pass: false,
      reason: `slab drift on ${first.variant}: ${first.actual} < ${driftThreshold} * ${first.expected} (${first.source})`,
      drifted,
    };
  }

  return { pass: true, reason: "ok", drifted: [] };
}

/**
 * M4 (sprint-004 2026-05-21): RATE_FORCE_TIER env var lets the engine probe
 * (`scripts/engine-probe.js`) override the heuristic-selected initial tier.
 * Values: "1" (force gpt-4.1-mini) or "2" (force gpt-4.1). Anything else
 * is ignored. Documented here rather than inline so production callers
 * who don't read the env know to look for it during probe runs.
 */
function applyForceTierEnv(result) {
  const force = process.env.RATE_FORCE_TIER;
  if (force !== '1' && force !== '2') return result;
  const tier = parseInt(force, 10);
  return { ...result, tier, reason: `${result.reason} (probe override: RATE_FORCE_TIER=${force})` };
}

/**
 * Merge prior-run, floor (operator-curated), and bank-type-default expected
 * slab counts per variant. Returns { [variant]: { expected, source } } where
 * expected = max signal and source identifies which won.
 *
 * Sources, in precedence (highest expected wins on ties / max):
 *   - `prior`    : measured count from the previous successful run
 *   - `floor`    : operator-curated floor in data/expected-slab-floors.json
 *   - `expected` : default-1 for variants the bank TYPE is expected to
 *                  produce (e.g. PSB→regular+nre+nro+fcnr) but which have
 *                  no explicit prior/floor entry. This catches the silent-
 *                  ship-domestic-only failure mode that no per-bank floor
 *                  curation would catch on the bank's first run.
 *
 * Opt-out path: an explicit `floorSlabCounts[variant] = 0` exempts that
 * variant from the drift check entirely (used when a bank's NRO = domestic
 * and no separate NRO file is expected).
 */
function mergeExpected(priorSlabCounts, floorSlabCounts, expectedVariants) {
  const out = {};
  const prior = priorSlabCounts && typeof priorSlabCounts === "object" ? priorSlabCounts : {};
  const floor = floorSlabCounts && typeof floorSlabCounts === "object" ? floorSlabCounts : {};
  const defaults = Array.isArray(expectedVariants) ? expectedVariants : [];
  const variants = new Set([...Object.keys(prior), ...Object.keys(floor), ...defaults]);
  for (const v of variants) {
    const p = Number.isFinite(prior[v]) ? prior[v] : null;
    // Use `in` so an explicit 0 in floorSlabCounts is honored (opt-out).
    const hasFloor = floor && Object.prototype.hasOwnProperty.call(floor, v) && Number.isFinite(floor[v]);
    const f = hasFloor ? floor[v] : null;
    const isDefault = defaults.includes(v);
    if (p == null && f == null && !isDefault) continue;
    if (hasFloor && f === 0) {
      // Explicit opt-out. Skip drift check on this variant regardless of
      // defaults or prior. Caller short-circuits on expected <= 0.
      out[v] = { expected: 0, source: "floor-optout" };
      continue;
    }
    if (p != null && f != null) {
      out[v] = p >= f
        ? { expected: p, source: p === f ? "prior+floor" : "prior" }
        : { expected: f, source: "floor" };
    } else if (p != null) {
      out[v] = { expected: p, source: "prior" };
    } else if (f != null) {
      out[v] = { expected: f, source: "floor" };
    } else {
      out[v] = { expected: 1, source: "expected" };
    }
  }
  return out;
}

module.exports = {
  selectInitialTier,
  selectDiscoveryAction,
  checkQuality,
  TERMINAL_DISCOVERY_STATUSES,
  CURATED_EXTRACTION_METHODS,
};

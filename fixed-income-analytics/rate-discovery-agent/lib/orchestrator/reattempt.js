'use strict';

/**
 * Re-attempt-via-orchestrator for banks where the LLM-agent path wrote a
 * stub config but no rates were produced.
 *
 * Sprint 006 Phase A.4 deep fix / Step 1f. The Sprint 5 Phase 0.2 failure
 * inventory identified ~31 NSUCB/DCCB banks with `scraper_type: null` in
 * their configs that produced no rates. Investigation in Sprint 5 Phase A.4
 * showed `lib/actions/classify_rate_page.js:61-63` already drops unknown
 * cached_kind values — but the orchestrator was never RE-INVOKED for those
 * banks after the legacy LLM-agent path wrote the stub config. They've sat
 * idle.
 *
 * This module provides the env-gated re-attempt path. When `RDA_REATTEMPT_UNKNOWN=1`,
 * the runner inspects each bank's existing config + rates files; if rates
 * are empty AND the config has scraper_type unknown/null, it routes the
 * bank through the new lib/fetch/fetch_html.js + dispatcher path.
 *
 * Behavior is INTENTIONALLY ENV-GATED. We don't want this firing
 * automatically until Step 4 pilot migration is in flight and the operator
 * is watching the manifest for the resulting re-extractions. The flag
 * defaults OFF so existing runs are unaffected.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/fetch-layer-hardening.md
 *         (Phase A.4 deeper fix section)
 */

const fs = require('node:fs');
const path = require('node:path');

const FLAG_NAME = 'RDA_REATTEMPT_UNKNOWN';

/**
 * Decide whether a bank qualifies for re-attempt.
 *
 * Pure function — caller is responsible for reading the bank's config + rates
 * files and passing them in. Returns { eligible, reason } so the caller can
 * log the decision either way.
 *
 * @param {object} input
 * @param {object} input.config       parsed _config.json for the bank (may be null)
 * @param {object} input.rates        parsed _rates.json (regular variant) (may be null)
 * @param {string} [input.env]        env var value (default: process.env[FLAG_NAME])
 * @returns {{ eligible: boolean, reason: string, signals: object }}
 */
function shouldReattempt({ config, rates, env } = {}) {
  const envValue = env != null ? env : process.env[FLAG_NAME];
  const flagOn = envValue === '1' || envValue === 'true';
  const signals = {
    flag_on: flagOn,
    has_config: !!config,
    scraper_type: config ? config.scraper_type : null,
    has_rate_pages: !!(config && config.rate_pages && Object.values(config.rate_pages).some(Boolean)),
    extraction_method: rates ? (rates.extraction_method || (rates.warnings || []).join(',').match(/llm_inline_extraction|automatic_html_static|llm_fallback/)?.[0]) : null,
    rate_slabs_count: rates && Array.isArray(rates.rate_slabs) ? rates.rate_slabs.length : 0,
  };

  if (!flagOn) {
    return { eligible: false, reason: `${FLAG_NAME} not set`, signals };
  }
  if (!signals.has_config) {
    return { eligible: false, reason: 'no config file (never attempted)', signals };
  }
  if (signals.rate_slabs_count > 0) {
    return { eligible: false, reason: `rates already extracted (${signals.rate_slabs_count} slabs)`, signals };
  }
  if (!signals.has_rate_pages) {
    return { eligible: false, reason: 'no rate_pages declared — would need discovery first', signals };
  }
  // The target failure mode: scraper_type is null/unknown AND rates file empty AND config exists.
  if (signals.scraper_type == null || signals.scraper_type === 'unknown') {
    return {
      eligible: true,
      reason: 'config exists, scraper_type unknown/null, no rates extracted — re-attempt via new fetch+dispatcher',
      signals,
    };
  }
  // Less common: scraper_type was set (e.g., manual or html_js) but no rates. Don't re-attempt
  // automatically — manual means operator-curated, html_js was a real attempt that should be
  // re-fingered via author-template.js, not silently re-run.
  return {
    eligible: false,
    reason: `scraper_type="${signals.scraper_type}" already set — won't auto-re-attempt; use author-template.js manually`,
    signals,
  };
}

/**
 * Identify all banks in output/latest/ that qualify for re-attempt.
 *
 * @param {object} [opts]
 * @param {string} [opts.outputDir]  default: output/latest under repo root
 * @returns {Array<{ bank_code, decision }>}
 */
function listReattemptCandidates(opts = {}) {
  const outputDir = opts.outputDir || path.resolve(__dirname, '..', '..', 'output', 'latest');
  if (!fs.existsSync(outputDir)) return [];

  const configFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('_config.json') && !f.startsWith('_'));
  const candidates = [];
  for (const cf of configFiles) {
    const bankCode = cf.slice(0, -'_config.json'.length);
    const configPath = path.join(outputDir, cf);
    const ratesPath = path.join(outputDir, `${bankCode}_rates.json`);
    let config = null;
    let rates = null;
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* ignore */ }
    if (fs.existsSync(ratesPath)) {
      try { rates = JSON.parse(fs.readFileSync(ratesPath, 'utf-8')); } catch { /* ignore */ }
    }
    const decision = shouldReattempt({ config, rates });
    candidates.push({ bank_code: bankCode, decision });
  }
  return candidates;
}

/**
 * Re-attempt one bank via the new fetch + dispatcher path.
 *
 * Returns a summary of what was attempted; does NOT write to disk by default
 * (operator wires it into the runner when Step 4 migration starts).
 *
 * @param {object} args
 * @param {string} args.bank_code
 * @param {object} args.config           the bank's existing _config.json
 * @param {object} args.log
 * @param {function} [args._fetchHtml]   test injection
 * @param {function} [args._pickExtractor]  test injection
 * @returns {Promise<{
 *   bank_code, status, slabs, fetch_result?, extractor_result?, error?
 * }>}
 */
async function reattemptOne({ bank_code, config, log, _fetchHtml, _pickExtractor } = {}) {
  if (!bank_code || !config) {
    throw new Error('reattemptOne: bank_code and config are required');
  }
  // Lazy require to keep tests fast when stubbing
  const fetchHtmlFn = _fetchHtml || require('../fetch/fetch_html').fetchHtml;
  const pickExtractorFn = _pickExtractor || require('../extractors/dispatch').pickExtractor;

  const ratePageUrl = config.rate_page_urls && (config.rate_page_urls.fd || Object.values(config.rate_page_urls).find(Boolean));
  if (!ratePageUrl) {
    return { bank_code, status: 'no_rate_page', slabs: [] };
  }

  if (log?.info) log.info(`[reattempt] ${bank_code}: fetching ${ratePageUrl}`);
  const fetchResult = await fetchHtmlFn({ url: ratePageUrl, templateFetch: {}, log });
  if (fetchResult.status !== 'success' || !fetchResult.html) {
    return {
      bank_code,
      status: 'fetch_failed',
      slabs: [],
      fetch_result: fetchResult,
    };
  }

  const dispatch = pickExtractorFn({ templateId: null, kind: 'html_static', productContext: { bank_code } });
  if (!dispatch.extractor) {
    // No template + no fallback extractor in this Phase. Step 3a's _llm-fallback closes this.
    return {
      bank_code,
      status: 'no_extractor',
      slabs: [],
      fetch_result: fetchResult,
      dispatch_reason: dispatch.reason,
    };
  }
  const extractResult = dispatch.extractor({ html: fetchResult.html, templateExtract: {}, productContext: { bank_code } });
  return {
    bank_code,
    status: extractResult.slabs.length > 0 ? 'recovered' : 'no_slabs',
    slabs: extractResult.slabs,
    fetch_result: fetchResult,
    extractor_result: extractResult,
  };
}

module.exports = {
  FLAG_NAME,
  shouldReattempt,
  listReattemptCandidates,
  reattemptOne,
};

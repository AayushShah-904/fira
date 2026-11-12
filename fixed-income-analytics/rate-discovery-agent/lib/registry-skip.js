'use strict';

/**
 * Synthetic output writer for banks the tier-router decides to skip on the
 * basis of `discovery_status` in `bank-domains.json` (Sprint 002 #5 / L6).
 *
 * When an operator has marked a bank as terminal — `no_website_known` or
 * `website_known_no_rate_page` — re-running the LLM agent against it wastes
 * tool-call budget and AOAI cost. This module produces the same artifact
 * shape (`_config.json`, `_rates.json`, `<slug>.summary.json`) the agent
 * would have produced, derived from the registry entry. The failure
 * classifier then sees those artifacts and routes the bank to the right
 * tier-2 `failure_class` (`discovery_failed` or `partial_success`) without
 * any agent invocation.
 *
 * Effect: zero AOAI cost for skipped banks, but they still show up in
 * `_run_analysis.json` with the correct classification.
 */

const fs = require('node:fs');
const path = require('node:path');

const { safeWriteArtifact } = require('./safe-write');

const RATE_PAGE_KEYS = ['fd', 'fd_nre', 'fd_nro', 'fd_fcnr', 'fd_nri_combined', 'savings', 'rd'];

/**
 * Write the synthetic outputs for a skipped bank and return a summary
 * describing what was emitted (for logging).
 *
 * @param {object} ctx
 * @param {string} ctx.runDir          — per-run output directory
 * @param {string} ctx.bankCode        — canonical slug
 * @param {string} ctx.bankName        — full bank name (from input)
 * @param {string} [ctx.bankType]      — PSB / PVB / DCCB / ...
 * @param {string} [ctx.category]      — long category label
 * @param {string} ctx.runLabel        — used as the run_label inside summary
 * @param {object} ctx.registryEntry   — the matching entry from bank-domains.json
 * @param {string} ctx.discoveryStatus — registryEntry.discovery_status
 * @param {string} [ctx.modelTag]      — for cost-tracker symmetry; defaults to 'registry-skip'
 * @returns {{ wroteConfig: boolean, wroteRates: boolean, configPath: string, ratesPath: string, summaryPath: string }}
 */
function writeSkipOutputs(ctx) {
  const {
    runDir,
    bankCode,
    bankName,
    bankType = null,
    category = null,
    runLabel,
    registryEntry,
    discoveryStatus,
    modelTag = 'registry-skip',
  } = ctx;

  fs.mkdirSync(runDir, { recursive: true });

  const configPath = path.join(runDir, `${bankCode}_config.json`);
  const ratesPath = path.join(runDir, `${bankCode}_rates.json`);
  const summaryPath = path.join(runDir, `${bankCode}.summary.json`);

  const nowIso = new Date().toISOString();
  let config = null;

  // Only emit a config for `website_known_no_rate_page` — we have a website
  // to record. For `no_website_known`, the right answer is no config file
  // at all (matches the agent's behavior when no candidates are found),
  // which classifier branch 2 routes to `discovery_failed`.
  if (discoveryStatus === 'website_known_no_rate_page') {
    const domain = registryEntry.domain;
    const websiteUrl = domain ? (domain.startsWith('http') ? domain : `https://${domain}`) : null;
    const ratePages = Object.fromEntries(RATE_PAGE_KEYS.map((k) => [k, null]));
    if (registryEntry.rate_pages) {
      for (const k of RATE_PAGE_KEYS) {
        if (registryEntry.rate_pages[k]) ratePages[k] = registryEntry.rate_pages[k];
      }
    }
    config = {
      bank_code: bankCode,
      bank_name: bankName,
      bank_type: bankType,
      category,
      website: websiteUrl,
      scraper_type: 'manual',
      extraction_method: 'registry_skip',
      rate_page_urls: ratePages,
      selectors: {},
      column_mapping: {},
      expected_slab_count: 0,
      notes: registryEntry.notes || 'Operator-classified: website known but no rate page available.',
      scraper_notes: {
        framework: null,
        bot_protection: null,
        data_format: null,
        rate_tables_on_page: 0,
      },
      discovery_metadata: {
        discovered_at: nowIso,
        discovery_method: 'registry_skip',
        confidence: registryEntry.confidence || 'high',
      },
    };
    safeWriteArtifact({
      path: configPath,
      incoming: config,
      kind: 'config',
      source: 'skip-gate',
    });
  }

  // Always emit a `_rates.json` — even with zero slabs — so downstream
  // consumers don't have to special-case missing rate files for skipped banks.
  const ratesDoc = {
    bank_code: bankCode,
    bank_name: bankName,
    product_type: 'FD',
    variant: 'regular',
    effective_date: null,
    source_url: config && config.rate_page_urls && config.rate_page_urls.fd
      ? config.rate_page_urls.fd
      : null,
    scraped_at: nowIso,
    extraction_method: 'registry_skip',
    extraction_confidence: 'none',
    rate_slabs: [],
    special_schemes: [],
    warnings: [
      `Bank skipped at discovery time: discovery_status=${discoveryStatus}. ${
        discoveryStatus === 'no_website_known'
          ? 'No website confirmed by operator. Re-run with --force or remove discovery_status to retry discovery.'
          : 'Website known but no usable rate page. Re-run with --rates-only mode after a rate page URL is added to the registry.'
      }`,
    ],
    errors: [],
  };
  safeWriteArtifact({
    path: ratesPath,
    incoming: ratesDoc,
    kind: 'rates',
    source: 'skip-gate',
  });

  // Synthetic summary — same shape as a real run but with no tool calls
  // and `discovery_method: "registry_skip"` so the analyzer can tell them
  // apart from real runs.
  const summaryDoc = {
    bank_code: bankCode,
    bank_name: bankName,
    category,
    mode: 'discover',
    run_label: runLabel,
    model: modelTag,
    wall_clock_ms: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    tool_call_count: 0,
    total_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    is_error: false,
    discovery_method: 'registry_skip',
    discovery_status: discoveryStatus,
    rate_limit_events: [],
    tool_calls: [],
  };
  safeWriteArtifact({
    path: summaryPath,
    incoming: summaryDoc,
    kind: 'summary',
    source: 'skip-gate',
  });

  return {
    wroteConfig: !!config,
    wroteRates: true,
    configPath,
    ratesPath,
    summaryPath,
  };
}

module.exports = { writeSkipOutputs };

'use strict';

/**
 * Action: classify_outcome — wrap the existing failure-classifier as an
 * action per Sprint 003 A6 contract.
 *
 * Thin adapter. The classifier already produces the two-tier taxonomy
 * (phase_outcomes triple + failure_class rollup) per Sprint 002 #2. This
 * action exposes it through the standard action input/output shape so the
 * orchestrator can call it after extraction completes.
 *
 * Input shape (full):
 *   {
 *     bank_code: string,                 // canonical slug
 *     run_dir: string,                   // directory containing per-bank artifacts
 *     agent_result?: object,             // optional { success, finalText?, model? } from agent loop
 *     domain_was_known?: boolean,        // whether bank-domains.json had an entry
 *     initial_tier?: 1|2,                // tier of the first attempt
 *     retry_attempted?: boolean,         // whether a Tier 2 retry ran after Tier 1
 *   }
 *
 * Output:
 *   {
 *     ok: true,
 *     failure_class: string,
 *     phase_outcomes: { website, rate_page, extraction },
 *     failure_signals: object,
 *   }
 *
 * The contract's Q10 answer says this action returns the classification only;
 * orchestrator writes the summary file (typically via a thin write_summary
 * step or commit_to_registry, depending on where summary lives).
 */

const { classifyResult } = require('../failure-classifier');
const { slugify: canonicalSlugify } = require('../../scripts/utils/slugify');

async function classifyOutcome(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('classifyOutcome: input must be an object');
  }
  const {
    bank_code,
    run_dir,
    agent_result,
    domain_was_known = false,
    initial_tier = 1,
    retry_attempted = false,
  } = input;

  if (!bank_code || typeof bank_code !== 'string') {
    throw new Error('classifyOutcome: input.bank_code is required');
  }
  const canonical = canonicalSlugify(bank_code);
  if (canonical !== bank_code) {
    throw new Error(`classifyOutcome: input.bank_code "${bank_code}" is not canonical`);
  }
  if (!run_dir || typeof run_dir !== 'string') {
    throw new Error('classifyOutcome: input.run_dir is required');
  }

  const classification = classifyResult({
    agentResult: agent_result || { success: true },
    runDir: run_dir,
    bankCode: bank_code,
    domainWasKnown: !!domain_was_known,
    initialTier: initial_tier,
    retryAttempted: !!retry_attempted,
  });

  return {
    ok: true,
    failure_class: classification.failure_class,
    phase_outcomes: classification.phase_outcomes,
    failure_signals: classification.failure_signals,
  };
}

module.exports = { classifyOutcome };

'use strict';

/**
 * Action: commit_rates — write a _rates.json (or variant) through safe-write
 * with three new gates: slug discipline, validate-rates as hard gate, and
 * rejected-payload capture for tracking + improvement.
 *
 * Sprint 003 #1a contract — see sdlc/sprints/sprint-003/design/action-contracts.md (A8).
 *
 * Closes deferred items A1 (validate-rates ungated) and A4 (slug discipline at
 * boundary, not via slug-guard.js post-hoc correction).
 *
 * Input:
 *   {
 *     bank_code:        string,                     // canonical slug
 *     variant:          "regular"|"nre"|"nro"|"fcnr"|"gift",
 *     payload:          object,                     // the full rates JSON to write
 *     extraction_method: string,                    // must pass isAllowed() from lib/extraction-methods.js
 *     output_dir:       string,                     // directory to write the canonical file (e.g., "output/latest")
 *     rejected_dir?:    string,                     // optional dir for rejected payloads (e.g., "output/runs/<ts>/_rejected")
 *     source?:          string,                     // safe-write source (default "agent")
 *     force?:           boolean,                    // safe-write force flag (default false)
 *     logger?:          object,                     // { warn, info, debug } — optional
 *   }
 *
 * Output (success):
 *   {
 *     ok: true,
 *     wrote: boolean,                  // false if validation failed OR safe-write deferred to pending
 *     deferred_to_pending: boolean,    // safe-write routed to .pending.json (curated target)
 *     pending_path?: string,
 *     validation: {
 *       passed: boolean,
 *       critical_count: number,        // = validateSlabs().errors.length
 *       warning_count: number,         // = validateSlabs().warnings.length
 *       flags: Array<{ severity, flag_type, slab_index?, details }>,
 *     },
 *     rejected_path?: string,          // where the rejected payload was captured (when validation fails)
 *     target_path: string,             // the canonical path the action targeted
 *   }
 *
 * Output (failure — slug mismatch):
 *   {
 *     ok: false,
 *     error_class: "slug_mismatch",
 *     error_message: string,
 *     log_entry: {
 *       bank_code_expected, bank_code_received,
 *       mismatched_fields: string[],
 *       payload_path_attempted: string,
 *       timestamp: string,
 *     }
 *   }
 *
 * Output (failure — other input error):
 *   throws — input contract violation; caller should catch and treat as orchestrator bug.
 */

const fs = require('node:fs');
const path = require('node:path');

const { safeWriteArtifact } = require('../safe-write');
const { validateSlabs, filterInvalidSlabs } = require('../../scripts/utils/validate-rates');
const { slugify: canonicalSlugify } = require('../../scripts/utils/slugify');
const { isAllowed, ALLOWED_EXTRACTION_METHODS } = require('../extraction-methods');

const VALID_VARIANTS = new Set(['regular', 'nre', 'nro', 'fcnr', 'gift']);

/**
 * Compute the per-bank rates filename for a given (bank_code, variant) pair.
 * Mirrors the convention in docs/agent/schemas.md (Output File Naming).
 */
function ratesFilenameFor(bankCode, variant) {
  if (variant === 'regular') return `${bankCode}_rates.json`;
  return `${bankCode}_${variant}_rates.json`;
}

/**
 * Convert validateSlabs() output into the contract's flag array shape.
 */
function flagsFromValidation(v) {
  const flags = [];
  for (const e of v.errors || []) {
    flags.push({ severity: 'critical', flag_type: 'validate-rates', details: e });
  }
  for (const w of v.warnings || []) {
    flags.push({ severity: 'warning', flag_type: 'validate-rates', details: w });
  }
  return flags;
}

/**
 * Compare slug fields in the payload against the canonical input.bank_code.
 * Returns list of mismatched fields (empty if everything matches).
 */
function checkSlugDiscipline(payload, expectedSlug) {
  const mismatched = [];
  if (!payload || typeof payload !== 'object') return mismatched;
  if (payload.bank_code && payload.bank_code !== expectedSlug) {
    mismatched.push('bank_code');
  }
  return mismatched;
}

async function commitRates(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('commitRates: input must be an object');
  }
  const {
    bank_code,
    variant,
    payload,
    extraction_method,
    output_dir,
    rejected_dir,
    source = 'agent',
    force = false,
    logger,
  } = input;

  // Input contract validation
  if (!bank_code || typeof bank_code !== 'string') {
    throw new Error('commitRates: input.bank_code is required (canonical slug)');
  }
  if (!VALID_VARIANTS.has(variant)) {
    throw new Error(`commitRates: input.variant must be one of ${[...VALID_VARIANTS].join(', ')} (got "${variant}")`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('commitRates: input.payload must be an object');
  }
  if (!extraction_method || !isAllowed(extraction_method)) {
    throw new Error(`commitRates: input.extraction_method "${extraction_method}" is not in ALLOWED_EXTRACTION_METHODS (${ALLOWED_EXTRACTION_METHODS.join(', ')})`);
  }
  if (!output_dir || typeof output_dir !== 'string') {
    throw new Error('commitRates: input.output_dir is required');
  }

  // Confirm bank_code is canonical (defends against caller passing a non-canonical slug)
  const canonical = canonicalSlugify(bank_code);
  if (canonical !== bank_code) {
    throw new Error(`commitRates: input.bank_code "${bank_code}" is not canonical (would slugify to "${canonical}")`);
  }

  const targetFilename = ratesFilenameFor(bank_code, variant);
  const targetPath = path.resolve(output_dir, targetFilename);

  // Gate 1: slug discipline at the boundary (Q12 answer; closes deferred A4)
  const mismatched = checkSlugDiscipline(payload, bank_code);
  if (mismatched.length > 0) {
    const logEntry = {
      bank_code_expected: bank_code,
      bank_code_received: payload.bank_code,
      mismatched_fields: mismatched,
      payload_path_attempted: targetPath,
      timestamp: new Date().toISOString(),
    };
    if (logger && logger.warn) {
      logger.warn(
        `commit_rates slug_mismatch bank=${bank_code} received="${payload.bank_code}" ` +
        `target=${targetFilename}`,
      );
    }
    return {
      ok: false,
      error_class: 'slug_mismatch',
      error_message: `payload.bank_code "${payload.bank_code}" does not match input.bank_code "${bank_code}"`,
      log_entry: logEntry,
    };
  }

  // Gate 2: validate-rates as hard gate (Q11 answer; closes deferred A1)
  // Cohort #3 Phase C1 (2026-05-23): drop below-floor / above-ceiling /
  // duplicate slabs BEFORE validation so Kotak-class noise (5 slabs at
  // 0.5-1% in cohort #3 — well below the 1.5% regular floor) doesn't ship
  // to the canonical `_rates.json`. The dropped count is logged for audit.
  const rawSlabs = Array.isArray(payload.rate_slabs) ? payload.rate_slabs : [];
  const filterResult = filterInvalidSlabs(rawSlabs, variant);
  const slabs = filterResult.filteredSlabs;
  const totalDropped = filterResult.droppedBelowFloor
    + filterResult.droppedAboveCeiling
    + filterResult.droppedDuplicate
    + (filterResult.droppedTenureOutOfBand || 0);
  if (totalDropped > 0) {
    payload.rate_slabs = slabs;
    if (logger && logger.warn) {
      logger.warn(
        `commit_rates slab_filter bank=${bank_code} variant=${variant} ` +
        `dropped_below_floor=${filterResult.droppedBelowFloor} ` +
        `dropped_above_ceiling=${filterResult.droppedAboveCeiling} ` +
        `dropped_tenure_out_of_band=${filterResult.droppedTenureOutOfBand || 0} ` +
        `dropped_duplicate=${filterResult.droppedDuplicate}`,
      );
    }
  }
  const v = validateSlabs(slabs, variant);
  const flags = flagsFromValidation(v);
  const validationReport = {
    passed: v.valid,
    critical_count: (v.errors || []).length,
    warning_count: (v.warnings || []).length,
    flags,
  };

  if (!v.valid) {
    // Capture rejected payload + full validation report (Q11 answer — write as much info as possible)
    let rejectedPath;
    if (rejected_dir) {
      try {
        fs.mkdirSync(rejected_dir, { recursive: true });
        rejectedPath = path.resolve(rejected_dir, `${bank_code}_${variant}.json`);
        const rejectedDocument = {
          rejected_at: new Date().toISOString(),
          reason: 'validate-rates critical errors',
          bank_code,
          variant,
          extraction_method,
          target_path_attempted: targetPath,
          validation: validationReport,
          caller_hint: `Refused canonical write to ${targetFilename}. Inspect critical errors and retry with corrected slabs or escalate.`,
          payload,
        };
        // safe-write-exempt: rejected-payload capture is an aggregator-like artifact under runs/<ts>/_rejected/, not a per-bank canonical write (ADR-012 explicitly excludes non-canonical outputs); intentional bypass.
        fs.writeFileSync(rejectedPath, JSON.stringify(rejectedDocument, null, 2) + '\n');
      } catch (err) {
        if (logger && logger.warn) {
          logger.warn(`commit_rates: failed to write rejected payload: ${err.message}`);
        }
        rejectedPath = undefined;
      }
    }
    if (logger && logger.warn) {
      logger.warn(
        `commit_rates validation failed bank=${bank_code} variant=${variant} ` +
        `critical=${validationReport.critical_count} warnings=${validationReport.warning_count}` +
        (rejectedPath ? ` rejected_path=${path.basename(rejectedPath)}` : ''),
      );
    }
    return {
      ok: true,
      wrote: false,
      deferred_to_pending: false,
      validation: validationReport,
      rejected_path: rejectedPath,
      target_path: targetPath,
    };
  }

  // Validation passed → route through safe-write.
  // Ensure the payload carries extraction_method for safe-write's lazy-tagging path.
  const incomingPayload = { ...payload, extraction_method };

  // Embed the validation block in the written JSON (warnings, no criticals).
  if (validationReport.warning_count > 0) {
    incomingPayload.validation = {
      passed: true,
      warning_count: validationReport.warning_count,
      flags: validationReport.flags,
    };
  }

  let safeWriteResult;
  try {
    safeWriteResult = safeWriteArtifact({
      path: targetPath,
      incoming: incomingPayload,
      kind: 'rates',
      source,
      force,
      logger,
    });
  } catch (err) {
    throw new Error(`commitRates: safeWriteArtifact failed: ${err.message}`);
  }

  return {
    ok: true,
    wrote: safeWriteResult.wrote,
    deferred_to_pending: !!safeWriteResult.deferredToPending,
    pending_path: safeWriteResult.pendingPath,
    validation: validationReport,
    target_path: targetPath,
  };
}

module.exports = { commitRates, ratesFilenameFor };

'use strict';

/**
 * Slug guard — enforce a single canonical bank slug across the per-bank
 * output artifacts the LLM agent writes.
 *
 * The orchestrator (run-discovery.js) derives the canonical slug from the
 * bank name via `scripts/utils/slugify.js`. The LLM agent is then told (via
 * prompt + CLAUDE.md) to use that slug everywhere. In practice the agent
 * sometimes strays — typical strays observed in the Sprint 001 DCCB run:
 *
 *   - Files named `<slug>_current_rates.json`, `_dds_rates.json`,
 *     `_rd_rates.json`, `_savings_rates.json` — the agent encountered
 *     non-FD products on the page and minted variant-suffixed files for
 *     them, polluting the per-bank output with non-canonical filenames.
 *   - JSON `bank_code` fields that disagree with the filename slug
 *     (rarer, but observed in the slug-ghost cohort).
 *
 * This module post-processes a run directory:
 *   - The allowlist of expected filenames for a given canonical slug is
 *     `<slug>{,_attempt2}.summary.json`, `<slug>.trace.jsonl`, `<slug>.log`,
 *     `<slug>_config.json`, `<slug>_rates.json`,
 *     `<slug>_{nre,nro,fcnr,gift}_rates.json`.
 *   - Anything else that starts with `<slug>_` and ends with `_rates.json`
 *     is a rogue product-variant file — move it to a `_rogue/` subdir for
 *     operator inspection and log a warning.
 *   - For each canonical JSON file, ensure `bank_code` field matches the
 *     expected slug. Mismatch → log warning + correct in place.
 *
 * Returns a small report so the caller can include it in the run summary.
 *
 * Sprint 002 #6 — slug-ghost fix.
 */

const fs = require('node:fs');
const path = require('node:path');

const { safeWriteArtifact } = require('./safe-write');

const KNOWN_FD_VARIANTS = ['nre', 'nro', 'fcnr', 'gift'];

/**
 * Map a per-bank artifact filename to a safe-write `kind`.
 *
 * Returns one of `'config' | 'rates' | 'summary' | null`. `null` means we
 * don't know how to route this through safe-write — the caller should fall
 * back to a direct write (preserving slug-guard's pre-ADR-012 behavior for
 * unrecognized companions like `.trace.jsonl` or `.log`).
 */
function inferArtifactKind(filename) {
  if (filename.endsWith('_config.json')) return 'config';
  if (filename.endsWith('_rates.json')) return 'rates';
  if (filename.endsWith('.summary.json')) return 'summary';
  return null;
}

function isCanonicalRateFilename(filename, slug) {
  if (filename === `${slug}_rates.json`) return true;
  for (const v of KNOWN_FD_VARIANTS) {
    if (filename === `${slug}_${v}_rates.json`) return true;
  }
  return false;
}

function isCanonicalNonRateFilename(filename, slug) {
  if (filename === `${slug}_config.json`) return true;
  if (filename === `${slug}.summary.json`) return true;
  if (filename === `${slug}_attempt2.summary.json`) return true;
  if (filename === `${slug}.trace.jsonl`) return true;
  if (filename === `${slug}_attempt2.trace.jsonl`) return true;
  if (filename === `${slug}.log`) return true;
  return false;
}

/**
 * Post-process a run directory for the given canonical slug.
 *
 * @param {object} ctx
 * @param {string} ctx.runDir   — directory to scan
 * @param {string} ctx.bankCode — canonical slug for this bank
 * @param {object} [ctx.logger] — optional logger with .warn/.info methods
 * @returns {{ rogueFilesMoved: string[], slugCorrections: Array<{file:string,from:string,to:string}>, otherBankFiles: string[] }}
 */
function enforceSlug(ctx) {
  const { runDir, bankCode } = ctx;
  const logger = ctx.logger || { warn: () => {}, info: () => {} };

  const report = {
    rogueFilesMoved: [],
    slugCorrections: [],
    otherBankFiles: [],
  };

  if (!fs.existsSync(runDir)) return report;

  const entries = fs.readdirSync(runDir);
  const rogueDir = path.join(runDir, '_rogue');

  for (const f of entries) {
    if (f === '_rogue') continue;
    const full = path.join(runDir, f);
    if (!fs.statSync(full).isFile()) continue;

    // Files that don't start with the canonical slug — could be another bank's
    // file (in shared latest/ mode this is normal) or an agent stray. Either
    // way: don't touch, just count.
    if (!f.startsWith(`${bankCode}_`) && !f.startsWith(`${bankCode}.`)) {
      report.otherBankFiles.push(f);
      continue;
    }

    // Rate file? Check canonical shape.
    if (f.endsWith('_rates.json')) {
      if (isCanonicalRateFilename(f, bankCode)) {
        // Canonical — also verify bank_code inside the JSON.
        correctBankCodeInPlace({ filePath: full, expected: bankCode, logger, report });
        continue;
      }
      // Rogue variant: <slug>_<something>_rates.json where <something> is not
      // in KNOWN_FD_VARIANTS. Move to _rogue/ for inspection.
      fs.mkdirSync(rogueDir, { recursive: true });
      const dst = path.join(rogueDir, f);
      fs.renameSync(full, dst);
      report.rogueFilesMoved.push(f);
      logger.warn(`slug-guard: moved rogue file '${f}' → _rogue/ (non-canonical product-variant suffix)`);
      continue;
    }

    // Non-rate canonical files: validate inner bank_code.
    if (isCanonicalNonRateFilename(f, bankCode)) {
      correctBankCodeInPlace({ filePath: full, expected: bankCode, logger, report });
      continue;
    }

    // Files that start with our slug but aren't recognized — leave alone but
    // note. Could be `<slug>_<future_extension>.json` we haven't taught the
    // guard about yet.
    report.otherBankFiles.push(f);
  }

  return report;
}

function correctBankCodeInPlace({ filePath, expected, logger, report }) {
  // Only JSON files have a parsable bank_code field.
  if (!filePath.endsWith('.json')) return;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    // Not parsable; leave it alone (don't compound an existing problem).
    return;
  }
  if (!doc || typeof doc !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(doc, 'bank_code')) return;
  if (doc.bank_code === expected) return;

  const before = doc.bank_code;
  doc.bank_code = expected;

  const filename = path.basename(filePath);
  const kind = inferArtifactKind(filename);

  if (kind) {
    // Route through safe-write so a slug-guard correction can't silently
    // overwrite an operator-curated artifact. If existing is curated,
    // safe-write defers the (bank_code-corrected) doc to <path>.pending.json.
    const result = safeWriteArtifact({
      path: filePath,
      incoming: doc,
      kind,
      source: 'slug-guard',
      logger,
    });
    if (result.deferredToPending) {
      // Curated artifact stayed put; we did NOT correct in place. Record the
      // attempt as a deferred correction so callers can see what happened.
      logger.warn(
        `slug-guard: bank_code correction for '${filename}' deferred to pending (existing is operator-curated)`,
      );
      return;
    }
  } else {
    // Unrecognized JSON companion (no ADR-012 routing path). Fall back to
    // the pre-migration direct write so slug-guard doesn't crash on, e.g.,
    // a future `<slug>_<thing>.json` we haven't taught the guard about.
    logger.warn(
      `slug-guard: unrecognized artifact kind for '${filename}'; falling back to direct fs.writeFileSync`,
    );
    // safe-write-exempt: fallback for unrecognized artifact kinds (no inferArtifactKind match); preserves pre-ADR-012 behavior so slug-guard doesn't crash on future per-bank JSON suffixes we haven't taught it.
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + '\n');
  }

  report.slugCorrections.push({
    file: filename,
    from: String(before),
    to: expected,
  });
  logger.warn(`slug-guard: corrected bank_code in '${filename}': '${before}' → '${expected}'`);
}

module.exports = {
  enforceSlug,
  isCanonicalRateFilename,
  isCanonicalNonRateFilename,
  inferArtifactKind,
  KNOWN_FD_VARIANTS,
};

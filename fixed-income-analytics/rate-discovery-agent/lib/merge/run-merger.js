'use strict';

/**
 * Sprint 009 Phase 5 — multi-bank merge runner.
 *
 * Reads `data/peer-runs/<cohort>.json` to find the cloud + local runs
 * for a split-execution cohort, walks every bank in either sub-cohort,
 * loads cloud and/or local per-variant artifacts from their per-run
 * dirs (`output/runs/<cloud_run_label>/` + `output/runs/<local_run_label>/`),
 * delegates to lib/merge/merge-bank.js for the field-level merge, and
 * writes the merged result to `output/latest/` via safeWriteArtifact
 * (ADR-012 honored — operator-curated outputs route to .pending.json).
 *
 * Cloud-side artifacts may also live in blob (`output:latest:<bank>...`)
 * when the cloud run executed in azure mode. The cloud run writes its
 * artifacts to BOTH output/latest/ (during the in-container run) and
 * output/runs/<label>/ (preserved snapshot). For local-on-disk merge
 * scenarios we read output/runs/<cloud_run_label>/ — but if the
 * operator already pulled blob → output/latest/ (the usual flow),
 * output/runs/<cloud_run_label>/ has the same data.
 *
 * Design: ../../sdlc/sprints/sprint-009/design/phase-5-merge-mechanism.md
 */

const fs = require('node:fs');
const path = require('node:path');
const { mergeArtifact } = require('./merge-bank');
const { safeWriteArtifact } = require('../safe-write');

const RATE_FILE_VARIANTS = Object.freeze(['', '_nre', '_nro', '_fcnr', '_gift']);

function readJsonSafe(p) {
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

/**
 * Resolve the per-run dir for a given run label. Returns absolute path
 * or null if the dir doesn't exist (no run on that side).
 */
function resolveRunDir(projectRoot, runLabel) {
  if (!runLabel) return null;
  const p = path.join(projectRoot, 'output', 'runs', runLabel);
  if (!fs.existsSync(p)) return null;
  return p;
}

/**
 * Per-bank merge of every rate-variant + the config. Writes to
 * `output/latest/` via safeWriteArtifact. Returns a per-bank decision
 * record for the run report.
 *
 * @param {object} args
 * @param {string} args.bankCode
 * @param {string|null} args.cloudRunDir
 * @param {string|null} args.localRunDir
 * @param {string|null} args.cloudRunId
 * @param {string|null} args.localRunId
 * @param {string}  args.latestDir
 * @param {object}  [args.logger]
 * @returns {{ bankCode, variants: Array, config: object, written: number, deferred: number, skipped: number }}
 */
function mergeOneBank({ bankCode, cloudRunDir, localRunDir, cloudRunId, localRunId, latestDir, logger }) {
  const result = {
    bank_code: bankCode,
    variants: [],
    config: null,
    written: 0,
    deferred: 0,
    skipped: 0,
  };

  // Per-variant rate files.
  for (const variant of RATE_FILE_VARIANTS) {
    const fname = `${bankCode}${variant}_rates.json`;
    const cloud = readJsonSafe(cloudRunDir ? path.join(cloudRunDir, fname) : null);
    const local = readJsonSafe(localRunDir ? path.join(localRunDir, fname) : null);
    if (!cloud && !local) continue; // neither side produced this variant
    const { merged, decisions } = mergeArtifact({ cloud, local, cloudRunId, localRunId });
    if (!merged) { result.skipped++; continue; }
    const target = path.join(latestDir, fname);
    const w = safeWriteArtifact({
      path: target,
      incoming: merged,
      kind: 'rates',
      source: 'merger',
      logger,
    });
    if (w.deferredToPending) result.deferred++;
    else result.written++;
    result.variants.push({ variant: variant || 'bare', cloud: !!cloud, local: !!local, decisions });
  }

  // Config file (one per bank — no variant suffix).
  const cfgName = `${bankCode}_config.json`;
  const cloudCfg = readJsonSafe(cloudRunDir ? path.join(cloudRunDir, cfgName) : null);
  const localCfg = readJsonSafe(localRunDir ? path.join(localRunDir, cfgName) : null);
  if (cloudCfg || localCfg) {
    const { merged, decisions } = mergeArtifact({ cloud: cloudCfg, local: localCfg, cloudRunId, localRunId });
    if (merged) {
      const target = path.join(latestDir, cfgName);
      const w = safeWriteArtifact({
        path: target,
        incoming: merged,
        kind: 'config',
        source: 'merger',
        logger,
      });
      if (w.deferredToPending) result.deferred++;
      else result.written++;
      result.config = { cloud: !!cloudCfg, local: !!localCfg, decisions };
    }
  }

  return result;
}

/**
 * Walk both sub-cohorts and merge all banks.
 *
 * @param {object} args
 * @param {Array}  args.cloudCohort   parsed cohort entries
 * @param {Array}  args.localCohort   parsed cohort entries
 * @param {string|null} args.cloudRunLabel
 * @param {string|null} args.localRunLabel
 * @param {string} args.projectRoot
 * @param {object} [args.logger]
 * @returns {{ banks: Array, summary: object }}
 */
function runMerger({ cloudCohort, localCohort, cloudRunLabel, localRunLabel, projectRoot, logger }) {
  const latestDir = path.join(projectRoot, 'output', 'latest');
  const cloudRunDir = resolveRunDir(projectRoot, cloudRunLabel);
  const localRunDir = resolveRunDir(projectRoot, localRunLabel);

  // Union of bank codes across both sub-cohorts.
  const banks = new Set();
  for (const e of (cloudCohort || [])) banks.add(e.bank_code);
  for (const e of (localCohort || [])) banks.add(e.bank_code);

  const perBank = [];
  let written = 0, deferred = 0, skipped = 0;

  for (const bankCode of banks) {
    const r = mergeOneBank({
      bankCode,
      cloudRunDir,
      localRunDir,
      cloudRunId: cloudRunLabel,
      localRunId: localRunLabel,
      latestDir,
      logger,
    });
    perBank.push(r);
    written += r.written;
    deferred += r.deferred;
    skipped += r.skipped;
  }

  return {
    banks: perBank,
    summary: {
      total_banks: banks.size,
      files_written: written,
      files_deferred_to_pending: deferred,
      files_skipped: skipped,
      cloud_run_dir: cloudRunDir,
      local_run_dir: localRunDir,
    },
  };
}

module.exports = { runMerger, mergeOneBank, resolveRunDir, RATE_FILE_VARIANTS };

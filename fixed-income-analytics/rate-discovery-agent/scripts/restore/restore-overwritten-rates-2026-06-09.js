#!/usr/bin/env node

/**
 * Sprint 010 Phase J recovery (2026-06-09).
 *
 * Restore the per-bank rate files that the n55y5dr 513-cohort destructively
 * overwrote with empty rate_slabs. The structural fix (lib/safe-write.js
 * empty-overwrite block) prevents recurrence; this one-shot recovers the
 * files already lost.
 *
 * Buckets restored (from logs/sprint-010/quality-report.json regression rows):
 *   R1: registry_skip overwrote banks with non-curated extraction_method but
 *       historically-transcribed slabs (curated-content, non-curated-tag).
 *       65 banks, 911 slabs.
 *   R2: cohort-failure path wrote llm_inline_extraction with rate_slabs:[]
 *       over previously-extracted files. 36 banks, 499 slabs.
 *   R6: registry_skip overwrote banks with discovery_status=recovered /
 *       single_headline_rate. 8 banks, 56 slabs.
 *
 * Method: for each (bank_code, variant) in the regression rows where the
 * current file has rate_slabs.length === 0 and HEAD has rate_slabs.length > 0,
 * run `git checkout HEAD -- <file>`. Skips R3 (partial degradation) and R4
 * (only 3 banks; manual review preferred).
 *
 * Idempotent — re-running on already-restored files is a no-op.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');
// Sprint 010 Phase K (2026-06-09): quality-aware decision instead of count-only.
// Catches the kerala-state-coop / chittoor-DCCB / sbpp class where the cohort's
// bad extractor emitted MORE garbage slabs than HEAD's clean data, and the
// count-only comparison would have skipped the recovery.
const { recoverHeadPreferred } = require('../../lib/rate-quality/garbage-detector');

const QUALITY_REPORT = path.join(__dirname, '..', '..', 'logs', 'sprint-010', 'quality-report.json');
const OUTPUT_LATEST = path.join(__dirname, '..', '..', 'output', 'latest');
const GIT_PATH_PREFIX = 'rate-discovery-agent/output/latest';

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function gitShow(relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

function gitCheckout(relPath) {
  execFileSync('git', ['checkout', 'HEAD', '--', relPath], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function localFilename(bankCode, variant) {
  return variant === 'regular' || variant === null || variant === undefined
    ? `${bankCode}_rates.json`
    : `${bankCode}_${variant}_rates.json`;
}

function main() {
  const aggressive = process.argv.includes('--aggressive');

  const report = readJsonSafe(QUALITY_REPORT);
  if (!report) {
    console.error(`could not read ${QUALITY_REPORT}`);
    process.exit(1);
  }
  const regressions = report.findings.filter((f) => f.class === 'REGRESSION');

  const stats = {
    examined: 0,
    restored: 0,
    skipped_head_empty: 0,
    skipped_no_head: 0,
    skipped_head_not_better: 0,
    skipped_r3_partial: 0,
    slabs_recovered: 0,
    banks_touched: new Set(),
    mode: aggressive ? 'aggressive (restore where HEAD > current)' : 'conservative (current must be empty)',
  };

  const restored = [];

  for (const reg of regressions) {
    stats.examined++;
    const filename = localFilename(reg.bank_code, reg.variant);
    const localPath = path.join(OUTPUT_LATEST, filename);
    const gitRelPath = `${GIT_PATH_PREFIX}/${filename}`;

    const current = readJsonSafe(localPath);
    const currentSlabs = Array.isArray(current?.rate_slabs) ? current.rate_slabs.length : 0;

    const headText = gitShow(gitRelPath);
    if (headText === null) {
      stats.skipped_no_head++;
      continue;
    }
    const head = JSON.parse(headText);
    const headSlabs = Array.isArray(head.rate_slabs) ? head.rate_slabs.length : 0;
    if (headSlabs === 0) {
      stats.skipped_head_empty++;
      continue;
    }

    // Sprint 010 Phase K (2026-06-09): quality-aware decision.
    // Conservative mode: restore ONLY for the (a) rule — current empty.
    // Aggressive mode: also use the (b) garbage-vs-clean and (c) both-clean-HEAD-has-more rules.
    const decision = recoverHeadPreferred(current, head);

    let shouldRestore = false;
    if (!aggressive) {
      // Conservative mode: only restore when current is empty
      shouldRestore = decision.prefer === 'head' && decision.reason === 'current_empty_head_nonempty';
      if (!shouldRestore) {
        stats.skipped_r3_partial++;
        continue;
      }
    } else {
      shouldRestore = decision.prefer === 'head';
      if (!shouldRestore) {
        stats.skipped_head_not_better++;
        continue;
      }
    }

    gitCheckout(gitRelPath);
    stats.restored++;
    stats.slabs_recovered += (headSlabs - currentSlabs);
    stats.banks_touched.add(reg.bank_code);
    restored.push({
      file: filename,
      bank_code: reg.bank_code,
      variant: reg.variant,
      current_slabs: currentSlabs,
      head_slabs: headSlabs,
      recovered_delta: headSlabs - currentSlabs,
      decision_reason: decision.reason,
      current_verdict: decision.current_verdict,
      head_verdict: decision.head_verdict,
      baseline: reg.baseline,
      method: head.extraction_method,
    });
  }

  console.log('=== Sprint 010 Phase J recovery ===');
  console.log(`mode                     : ${stats.mode}`);
  console.log(`regression rows examined : ${stats.examined}`);
  console.log(`files restored           : ${stats.restored}`);
  console.log(`unique banks touched     : ${stats.banks_touched.size}`);
  console.log(`slabs recovered (net)    : ${stats.slabs_recovered}`);
  console.log(`skipped: current has slabs (conservative-mode only) : ${stats.skipped_r3_partial}`);
  console.log(`skipped: HEAD not better than current               : ${stats.skipped_head_not_better}`);
  console.log(`skipped: HEAD also empty                            : ${stats.skipped_head_empty}`);
  console.log(`skipped: no HEAD entry                              : ${stats.skipped_no_head}`);

  // Detail log for the impl doc
  const detailPath = path.join(__dirname, '..', '..', 'logs', 'sprint-010', 'phase-j-recovery-detail.json');
  // safe-write-exempt: one-shot per-run audit log under logs/, not a per-bank artifact. Same pattern as scripts/analysis/*.json writes.
  fs.writeFileSync(detailPath, JSON.stringify({ stats: { ...stats, banks_touched: stats.banks_touched.size }, restored }, null, 2));
  console.log(`detail log               : ${detailPath}`);
}

main();

#!/usr/bin/env node

/**
 * Sprint 010 Phase 0 — restore rate files whose working-tree slab count
 * regressed below the git-HEAD-tracked version.
 *
 * Why this exists:
 *   The Sprint 009 cohort (executions 5kz1vm8 + fpecv10 + 9zulerb) wrote
 *   output/latest/*_rates.json files that contained fewer slabs than the
 *   pre-cohort tracked versions for 232 files across the registry. Those
 *   regressions caused the post-cohort pack to lose 1,979 slabs (-24 %)
 *   vs the 2026-05-28 baseline.
 *
 *   The regressed files were never committed — they sit in the working tree
 *   only, from the post-cohort `node cloud/sync.js pull`. So restoration is
 *   a simple per-file `git checkout HEAD --` for each file where the WT
 *   slab count is strictly less than HEAD's slab count.
 *
 * What this script does NOT do:
 *   - Touch files where WT > HEAD (genuine new extractions — keep them).
 *   - Touch files unchanged from HEAD.
 *   - Delete partial_silent.json markers — that's a separate concern;
 *     the markers are untracked anyway, so the operator can rm them or
 *     leave them as forensic breadcrumbs. The pack-builder will skip the
 *     marked variants either way; restoring the file is enough.
 *     Actually — we DO delete the markers below, because otherwise the
 *     restored files get skipped by the pack-builder's partial_silent
 *     loader. This is per the Phase 0 plan in
 *     sdlc/sprints/sprint-010/plan/sprint-010-scope.md.
 *
 * Usage:
 *   node scripts/restore/restore-regressed-rate-files.js [--dry-run]
 *
 * Exit codes:
 *   0  success
 *   1  one or more checkouts failed
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const DRY_RUN = process.argv.includes('--dry-run');

const REPO_ROOT_GUESS = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CWD_PREFIX = 'output/latest/';
// Repo-relative form for `git show` and `git checkout` (paths from repo root).
const REPO_RELATIVE = path.relative(REPO_ROOT_GUESS, PROJECT_ROOT).replace(/\\/g, '/');
const REPO_PREFIX = (REPO_RELATIVE ? REPO_RELATIVE + '/' : '') + CWD_PREFIX;

function slabsInFile(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    return (j.rate_slabs || []).length;
  } catch { return null; }
}

function listTrackedRateFiles() {
  const out = execSync(`git ls-files ${CWD_PREFIX}`, { encoding: 'utf-8', cwd: PROJECT_ROOT });
  return out.split('\n').filter(l => /_rates\.json$/.test(l) && !/legacy/.test(l));
}

function main() {
  const tracked = listTrackedRateFiles();
  const restorations = [];
  let totalHead = 0, totalWt = 0;

  for (const cwdRel of tracked) {
    const rel = cwdRel.slice(CWD_PREFIX.length);
    const repoPath = REPO_PREFIX + rel;
    const localPath = path.join(PROJECT_ROOT, cwdRel);

    let headJson;
    try { headJson = execSync(`git show HEAD:${repoPath}`, { encoding: 'utf-8' }); }
    catch { continue; }
    const headSlabs = slabsInFile(headJson);
    if (headSlabs == null) continue;
    totalHead += headSlabs;

    let wtJson = null;
    if (fs.existsSync(localPath)) {
      try { wtJson = fs.readFileSync(localPath, 'utf-8'); } catch {}
    }
    const wtSlabs = wtJson != null ? slabsInFile(wtJson) : 0;
    totalWt += (wtSlabs == null ? 0 : wtSlabs);

    if (wtSlabs == null || wtSlabs < headSlabs) {
      restorations.push({ cwdRel, repoPath, head: headSlabs, wt: wtSlabs || 0, recover: headSlabs - (wtSlabs || 0) });
    }
  }

  restorations.sort((a, b) => b.recover - a.recover);

  console.log(`Tracked rate files scanned: ${tracked.length}`);
  console.log(`Current sums — HEAD ${totalHead} / WT ${totalWt} (net ${totalWt - totalHead})`);
  console.log(`Files to restore (WT < HEAD): ${restorations.length}`);
  console.log(`Total slabs to recover:       ${restorations.reduce((s, r) => s + r.recover, 0)}`);
  console.log('');

  if (DRY_RUN) {
    console.log('--dry-run: top 20 restorations that would happen:');
    for (const r of restorations.slice(0, 20)) {
      console.log(`  ${r.cwdRel.padEnd(60)} ${String(r.wt).padStart(4)} → ${String(r.head).padStart(4)} (+${r.recover})`);
    }
    process.exit(0);
  }

  // Group into a single `git checkout HEAD -- <files...>` invocation per batch
  // (git supports multiple paths). 100 files per batch keeps the command line sane.
  const BATCH = 30;
  let failed = 0;
  for (let i = 0; i < restorations.length; i += BATCH) {
    const batch = restorations.slice(i, i + BATCH).map(r => r.repoPath);
    const cmd = ['git', 'checkout', 'HEAD', '--', ...batch.map(p => `"${p}"`)].join(' ');
    try {
      execSync(cmd, { cwd: REPO_ROOT_GUESS, stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`  restored batch ${i + 1}..${Math.min(i + BATCH, restorations.length)} (${batch.length} files)`);
    } catch (err) {
      console.error(`  batch ${i + 1}..${Math.min(i + BATCH, restorations.length)} FAILED: ${err.message}`);
      failed += batch.length;
    }
  }

  // Delete stale partial_silent markers (untracked sidecars). Restoring the
  // rate file makes them lies; deleting also unblocks the pack-builder's
  // partial_silent skip from gating restored variants.
  const psFiles = fs.readdirSync(path.join(PROJECT_ROOT, 'output', 'latest'))
    .filter(n => n.endsWith('.partial_silent.json'));
  for (const ps of psFiles) {
    try { fs.unlinkSync(path.join(PROJECT_ROOT, 'output', 'latest', ps)); }
    catch (err) { console.error(`  failed to delete ${ps}: ${err.message}`); }
  }
  console.log(`Deleted ${psFiles.length} stale partial_silent.json marker(s).`);

  if (failed > 0) {
    console.error(`\n${failed} files failed to restore. Exit 1.`);
    process.exit(1);
  }
  console.log('\nDone. Run `node pack/build-pack.js` to rebuild the pack.');
}

main();

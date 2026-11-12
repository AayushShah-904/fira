#!/usr/bin/env node
'use strict';

/**
 * Phase 3b — promote sidecar candidates into output/latest/ via safe-write.
 *
 * Reads `extracted/<slug>__<variant>_rates.json` sidecars from the refresh run
 * dir and writes each into `output/latest/<slug>_<variant>_rates.json` through
 * `lib/safe-write.js`. The safe-write curated-overwrite check (ADR-012) routes
 * sidecars to `.pending.json` if the existing rates file is operator-curated.
 *
 * Two safety gates:
 *   --include-zero-slab    by default we skip candidates that yielded zero
 *                          slabs — overwriting a populated file with an empty
 *                          one is destructive. Pass this flag to override.
 *   --include-no-change    by default we promote only candidates whose diff
 *                          has at least one slab added/removed/changed OR a
 *                          newer effective_date than stored. Pass this flag to
 *                          promote unchanged candidates too (e.g., to refresh
 *                          extraction_method tagging on every variant).
 *
 * Run:
 *   node scripts/refresh/promote.js                       # dry-run by default; lists what would promote
 *   node scripts/refresh/promote.js --apply               # actually write
 *   node scripts/refresh/promote.js --slug state-bank-of-india --apply
 *   node scripts/refresh/promote.js --apply --include-zero-slab
 */

const fs = require('node:fs');
const path = require('node:path');

const { safeWriteArtifact } = require('../../lib/safe-write.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REFRESH_ROOT = path.join(REPO_ROOT, 'output', 'refresh');
const LATEST_DIR = path.join(REPO_ROOT, 'output', 'latest');

function parseArgs(argv) {
  const args = {
    runTs: null,
    slug: null,
    variant: null,
    apply: false,
    includeZeroSlab: false,
    includeNoChange: false,
    includeHeldBack: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-ts') args.runTs = argv[++i];
    else if (a === '--slug') args.slug = argv[++i];
    else if (a === '--variant') args.variant = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--include-zero-slab') args.includeZeroSlab = true;
    else if (a === '--include-no-change') args.includeNoChange = true;
    else if (a === '--include-held-back') args.includeHeldBack = true;
  }
  return args;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // safe-write-exempt: refresh-pipeline run-meta artifacts (_promote_plan.json, _promoted.json) under runs/<ts>/; per-bank canonical writes in this file go through safeWriteArtifact (line 237).
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function resolveRunTs(explicit) {
  if (explicit) return explicit;
  const pointer = path.join(REFRESH_ROOT, 'latest', '_run_ts.txt');
  if (fs.existsSync(pointer)) return fs.readFileSync(pointer, 'utf-8').trim();
  throw new Error('No run-ts and no latest pointer.');
}

function ratesFileName(bankCode, variant) {
  return variant === 'regular' ? `${bankCode}_rates.json` : `${bankCode}_${variant}_rates.json`;
}

function decideAction(diff, sidecar, args, gating) {
  const bankCode = sidecar && sidecar.bank_code;
  const variant = sidecar && sidecar.variant;
  if (gating && bankCode && variant) {
    const key = `${bankCode}::${variant}`;
    const held = gating.heldBack.get(key);
    if (held && !args.includeHeldBack) {
      return { promote: false, reason: `held_back:${held} (override with --include-held-back)` };
    }
  }
  const slabCount = (sidecar && sidecar.rate_slabs) ? sidecar.rate_slabs.length : 0;
  if (slabCount === 0 && !args.includeZeroSlab) {
    return { promote: false, reason: 'zero_slab_skip (override with --include-zero-slab)' };
  }
  // Freshness guard: never overwrite a stored rates file with a candidate
  // whose effective_date is older. Older ED with different slabs usually
  // means the extractor read a historical/comparison row or a stale CDN copy.
  // Compare lexicographically — only safe when both look like ISO dates.
  const storedEd = diff && diff.stored_effective_date;
  const candEd = sidecar && sidecar.effective_date;
  if (storedEd && candEd && /^\d{4}-\d{2}-\d{2}$/.test(storedEd) && /^\d{4}-\d{2}-\d{2}$/.test(candEd) && candEd < storedEd) {
    return { promote: false, reason: `older_effective_date_skip (cand:${candEd} < stored:${storedEd})` };
  }
  const summary = diff && diff.diff && diff.diff.summary;
  const hasSlabDelta = summary && (summary.slabs_added + summary.slabs_removed + summary.slabs_changed > 0);
  const newerEd =
    storedEd && candEd && /^\d{4}-\d{2}-\d{2}$/.test(storedEd) && /^\d{4}-\d{2}-\d{2}$/.test(candEd) &&
    candEd > storedEd;
  if (!hasSlabDelta && !newerEd && !args.includeNoChange) {
    return { promote: false, reason: 'no_change_skip (override with --include-no-change)' };
  }
  return { promote: true, reason: hasSlabDelta ? 'slab_delta' : (newerEd ? 'newer_effective_date' : 'forced_include') };
}

function loadGating(runDir) {
  const susPath = path.join(runDir, '_suspicious.json');
  const llmPath = path.join(runDir, '_llm_verification.json');
  const sus = readJsonSafe(susPath);
  const llm = readJsonSafe(llmPath);
  const heldBack = new Map();   // key: "<slug>::<variant>" → reason
  if (sus && Array.isArray(sus.suspicious)) {
    for (const s of sus.suspicious) {
      heldBack.set(`${s.bank_code}::${s.variant}`, 'sanity_flagged_no_llm_decision');
    }
  }
  if (llm && Array.isArray(llm.results)) {
    for (const r of llm.results) {
      if (!r || !r.entry) continue;
      const key = `${r.entry.bank_code}::${r.entry.variant}`;
      if (r.outcome === 'LLM_REPLACED' || r.outcome === 'LLM_CONFIRMS') {
        heldBack.delete(key);   // safe to promote
      } else if (r.outcome === 'LLM_STILL_SUSPICIOUS') {
        heldBack.set(key, 'llm_still_suspicious');
      } else if (r.outcome === 'LLM_REJECTED') {
        heldBack.set(key, 'llm_rejected');
      } else if (r.outcome === 'LLM_NO_DATA') {
        heldBack.set(key, 'llm_no_data');
      } else if (r.outcome === 'SKIPPED') {
        heldBack.set(key, 'llm_skipped');
      }
    }
  }
  return { heldBack, hasSuspicious: !!sus, hasLlm: !!llm };
}

async function main() {
  const args = parseArgs(process.argv);
  const runTs = resolveRunTs(args.runTs);
  const runDir = path.join(REFRESH_ROOT, runTs);
  const extractedDir = path.join(runDir, 'extracted');
  const diffsDir = path.join(runDir, 'diffs');
  if (!fs.existsSync(extractedDir)) throw new Error(`No extracted dir at ${extractedDir}`);

  const gating = loadGating(runDir);
  console.log(`promote: run_ts=${runTs}  apply=${args.apply}`);
  console.log(`  gating: suspicious=${gating.hasSuspicious}  llm=${gating.hasLlm}  held_back=${gating.heldBack.size}`);

  const sidecarFiles = fs.readdirSync(extractedDir).filter((f) => f.endsWith('.json'));
  let filtered = sidecarFiles;
  if (args.slug) {
    const prefix = `${args.slug}_`;
    filtered = filtered.filter((f) => f === ratesFileName(args.slug, 'regular') || f.startsWith(prefix));
  }
  if (args.variant) {
    filtered = filtered.filter((f) => {
      // Variant 'regular' sidecar lacks the variant suffix.
      if (args.variant === 'regular') return !/_(nre|nro|fcnr|gift)_rates\.json$/.test(f);
      return f.endsWith(`_${args.variant}_rates.json`);
    });
  }

  console.log(`  sidecars to consider: ${filtered.length}`);

  const actions = [];
  for (const file of filtered) {
    const sidecarPath = path.join(extractedDir, file);
    const sidecar = readJsonSafe(sidecarPath);
    if (!sidecar) continue;

    const variant = sidecar.variant || 'regular';
    const bankCode = sidecar.bank_code;
    const diffPath = path.join(diffsDir, `${bankCode}__${variant}.diff.json`);
    const diff = readJsonSafe(diffPath);

    const targetPath = path.join(LATEST_DIR, ratesFileName(bankCode, variant));
    const decision = decideAction(diff, sidecar, args, gating);

    actions.push({
      bank_code: bankCode,
      variant,
      bank_type: diff && diff.bank_type,
      slabs: sidecar.rate_slabs ? sidecar.rate_slabs.length : 0,
      sidecar_path: path.relative(REPO_ROOT, sidecarPath),
      target_path: path.relative(REPO_ROOT, targetPath),
      decision,
    });
  }

  const willPromote = actions.filter((a) => a.decision.promote);
  const skipped = actions.filter((a) => !a.decision.promote);

  console.log(`  will promote: ${willPromote.length}`);
  console.log(`  skipped:      ${skipped.length}`);

  // Skip reasons
  const skipReasons = {};
  for (const a of skipped) {
    const k = a.decision.reason.split(' ')[0];
    skipReasons[k] = (skipReasons[k] || 0) + 1;
  }
  console.log(`  skip reasons: ${JSON.stringify(skipReasons)}`);

  if (!args.apply) {
    console.log('  (dry-run — pass --apply to actually write)');
    const planPath = path.join(runDir, '_promote_plan.json');
    writeJson(planPath, {
      run_ts: runTs,
      apply: false,
      generated_at: new Date().toISOString(),
      counts: { considered: actions.length, will_promote: willPromote.length, skipped: skipped.length },
      skip_reasons: skipReasons,
      actions,
    });
    console.log(`  wrote plan: ${planPath}`);
    return;
  }

  // Apply
  const promoted = [];
  const deferred = [];
  const failed = [];

  for (const a of willPromote) {
    const sidecar = readJsonSafe(path.join(REPO_ROOT, a.sidecar_path));
    const targetPath = path.join(REPO_ROOT, a.target_path);
    try {
      const result = safeWriteArtifact({
        path: targetPath,
        incoming: sidecar,
        kind: 'rates',
        source: 'agent',
        logger: console,
      });
      if (result.wrote) {
        promoted.push({ ...a, defaulted_method: result.defaultedExtractionMethod || null });
      } else if (result.deferredToPending) {
        deferred.push({ ...a, pending_path: path.relative(REPO_ROOT, result.pendingPath), reason: result.reason });
      } else {
        failed.push({ ...a, error: 'safe-write returned neither wrote nor deferred' });
      }
    } catch (err) {
      failed.push({ ...a, error: err.message });
    }
  }

  const recordPath = path.join(runDir, '_promoted.json');
  writeJson(recordPath, {
    run_ts: runTs,
    apply: true,
    generated_at: new Date().toISOString(),
    counts: {
      considered: actions.length,
      promoted: promoted.length,
      deferred_to_pending: deferred.length,
      failed: failed.length,
      skipped: skipped.length,
    },
    skip_reasons: skipReasons,
    promoted,
    deferred,
    failed,
    skipped,
  });

  console.log(`promote: applied. promoted=${promoted.length} deferred=${deferred.length} failed=${failed.length}`);
  console.log(`  wrote: ${recordPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('promote: FAILED', err);
    process.exit(1);
  });
}

module.exports = { decideAction };

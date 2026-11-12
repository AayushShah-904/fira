#!/usr/bin/env node
'use strict';

/**
 * Pre-cohort cleanup for output/latest/.
 *
 * Phase 2b (sprint-004 2026-05-22) — pre-flight for pm-refresh-2026-q2.
 *
 * What it does:
 *   1. Optionally snapshots output/latest/ to output/runs/<label>/ for forensics
 *   2. Removes orphan retry files (*_attempt2.summary.json, *_attempt3.summary.json)
 *
 * What it does NOT touch:
 *   - Primary _rates.json / _config.json / .summary.json files
 *   - partial_silent.json markers (operator-curated; managed separately)
 *   - _batch_results_<category>.json batch summaries (operator may need them)
 *
 * Usage:
 *   node scripts/cleanup-output-latest.js [--write] [--snapshot <label>]
 *
 *   --write      Actually delete files. Without it, dry-run (lists what would go).
 *   --snapshot   Before deleting, copy current output/latest/ to output/runs/<label>/
 *                Combine with --write for a "snapshot then prune" workflow.
 *
 * Examples:
 *   node scripts/cleanup-output-latest.js
 *     → dry-run; lists orphan attempt files
 *
 *   node scripts/cleanup-output-latest.js --snapshot pre-pm-q2-2026-05-22 --write
 *     → snapshot to output/runs/pre-pm-q2-2026-05-22/ then prune orphans
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LATEST = path.join(ROOT, 'output', 'latest');
const RUNS = path.join(ROOT, 'output', 'runs');

function parseArgs(argv) {
  const out = { write: false, snapshot: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--write') out.write = true;
    else if (argv[i] === '--snapshot' && argv[i + 1]) {
      out.snapshot = argv[i + 1];
      i++;
    }
  }
  return out;
}

function listOrphans(dir) {
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir);
  return all.filter((f) => /_attempt[2-9]\.summary\.json$/.test(f));
}

function snapshotDir(srcDir, label) {
  const dest = path.join(RUNS, label);
  if (fs.existsSync(dest)) {
    throw new Error(`Snapshot destination already exists: ${dest}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const files = fs.readdirSync(srcDir);
  let copied = 0;
  for (const f of files) {
    const src = path.join(srcDir, f);
    const dst = path.join(dest, f);
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      // safe-write-exempt: orphan-file archival into output/cleaned-up/ (operator-triggered tooling), not a per-bank canonical write (ADR-012).
      fs.copyFileSync(src, dst);
      copied++;
    }
  }
  return { dest, copied };
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(LATEST)) {
    console.error(`output/latest/ not found: ${LATEST}`);
    process.exit(1);
  }

  console.log(`Scanning: ${LATEST}`);
  const orphans = listOrphans(LATEST);
  console.log(`Found ${orphans.length} orphan retry file(s).`);

  if (args.snapshot) {
    if (args.write) {
      const snap = snapshotDir(LATEST, args.snapshot);
      console.log(`SNAPSHOT WROTE → ${snap.dest} (${snap.copied} file(s))`);
    } else {
      console.log(`WOULD SNAPSHOT → output/runs/${args.snapshot}/  (use --write to do it)`);
    }
  }

  if (orphans.length === 0) {
    console.log('\nNo orphans to prune. Done.');
    return;
  }

  // Group orphans by primary bank slug for readability
  const byBank = new Map();
  for (const f of orphans) {
    const m = f.match(/^(.+?)_attempt(\d+)\.summary\.json$/);
    if (!m) continue;
    const [, slug, n] = m;
    if (!byBank.has(slug)) byBank.set(slug, []);
    byBank.get(slug).push({ file: f, attempt: parseInt(n, 10) });
  }

  console.log(`\n${args.write ? 'PRUNING' : 'WOULD PRUNE'} ${orphans.length} file(s) across ${byBank.size} bank(s):`);
  for (const [slug, files] of [...byBank.entries()].sort()) {
    const attempts = files.map((f) => `attempt${f.attempt}`).sort().join(', ');
    console.log(`  ${slug.padEnd(50)} [${attempts}]`);
    if (args.write) {
      for (const { file } of files) {
        fs.unlinkSync(path.join(LATEST, file));
      }
    }
  }

  console.log(`\n${args.write ? 'Pruned' : 'Dry-run summary:'} ${orphans.length} orphan file(s)${args.write ? '.' : ' (use --write to apply).'}`);
}

try {
  main();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}

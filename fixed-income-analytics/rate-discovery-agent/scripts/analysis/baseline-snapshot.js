#!/usr/bin/env node
'use strict';

// Sprint 005 / Phase 0.5 — baseline snapshot.
//
// Locks the current `output/latest/` directory and `pack/dist/rates-pack.json`
// into `tmp/baseline-pre-reset/` as the immutable ground truth that every
// Phase E per-bank migration parity check compares against.
//
// Pure copy — no production state touched. Re-runnable; refuses to clobber an
// existing snapshot unless --force is passed.
//
// Usage:
//   node scripts/analysis/baseline-snapshot.js [--force]

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const sources = [
  { kind: 'dir',  from: path.join(repoRoot, 'output', 'latest'), to: 'output-latest' },
  { kind: 'file', from: path.join(repoRoot, 'pack', 'dist', 'rates-pack.json'), to: 'rates-pack.json' },
  { kind: 'file', from: path.join(repoRoot, 'pack', 'dist', 'quality-report.json'), to: 'quality-report.json', optional: true },
  { kind: 'file', from: path.join(repoRoot, 'pack', 'dist', 'quality-report.md'),  to: 'quality-report.md',  optional: true },
  { kind: 'file', from: path.join(repoRoot, 'pack', 'dist', 'SUMMARY.json'),       to: 'SUMMARY.json',       optional: true },
  { kind: 'file', from: path.join(repoRoot, 'pack', 'dist', 'SUMMARY.md'),         to: 'SUMMARY.md',         optional: true },
  { kind: 'file', from: path.join(repoRoot, 'pack', 'quality-gate-accepts.json'),  to: 'quality-gate-accepts.json', optional: true },
];

const dest = path.join(repoRoot, 'tmp', 'baseline-pre-reset');
const force = process.argv.includes('--force');

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let fileCount = 0;
  let byteCount = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDirRecursive(s, d);
      fileCount += sub.fileCount;
      byteCount += sub.byteCount;
    } else if (entry.isFile()) {
      // safe-write-exempt: phase-0 baseline snapshot copy under tmp/baseline-pre-reset/; not a per-bank canonical artifact (ADR-012).
      fs.copyFileSync(s, d);
      fileCount += 1;
      byteCount += fs.statSync(d).size;
    }
  }
  return { fileCount, byteCount };
}

function main() {
  if (fs.existsSync(dest) && !force) {
    console.error(`Refusing to overwrite existing snapshot at ${dest}. Pass --force to replace.`);
    process.exit(1);
  }
  if (force && fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const manifest = {
    snapshot_taken_at: new Date().toISOString(),
    snapshot_taken_by: 'scripts/analysis/baseline-snapshot.js',
    sprint: '005',
    phase: '0.5',
    purpose: 'Pre-reset ground truth for Phase E per-bank parity checks (±1 slab, ±5bps).',
    sources: [],
  };

  for (const src of sources) {
    if (!fs.existsSync(src.from)) {
      if (src.optional) {
        manifest.sources.push({ from: src.from, to: src.to, status: 'missing-optional' });
        continue;
      }
      console.error(`Required source missing: ${src.from}`);
      process.exit(2);
    }
    const dstPath = path.join(dest, src.to);
    if (src.kind === 'dir') {
      const stats = copyDirRecursive(src.from, dstPath);
      manifest.sources.push({ from: src.from, to: src.to, status: 'copied', kind: 'dir', file_count: stats.fileCount, byte_count: stats.byteCount });
      console.log(`copied dir  ${src.from} -> ${dstPath} (${stats.fileCount} files, ${stats.byteCount} bytes)`);
    } else {
      // safe-write-exempt: phase-0 baseline snapshot copy under tmp/baseline-pre-reset/; not a per-bank canonical artifact (ADR-012).
      fs.copyFileSync(src.from, dstPath);
      const bytes = fs.statSync(dstPath).size;
      manifest.sources.push({ from: src.from, to: src.to, status: 'copied', kind: 'file', byte_count: bytes });
      console.log(`copied file ${src.from} -> ${dstPath} (${bytes} bytes)`);
    }
  }

  // safe-write-exempt: phase-0 analysis manifest under tmp/baseline-pre-reset/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(
    path.join(dest, 'SNAPSHOT_MANIFEST.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  console.log(`wrote ${path.join(dest, 'SNAPSHOT_MANIFEST.json')}`);
  console.log('baseline snapshot complete');
}

main();

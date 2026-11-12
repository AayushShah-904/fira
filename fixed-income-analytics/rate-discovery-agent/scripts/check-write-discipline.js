#!/usr/bin/env node
'use strict';

/**
 * Sprint 002 #15d — pre-commit / CI check for ADR-012's centralized write
 * path.
 *
 * Refuses any `fs.writeFileSync` or `fs.copyFileSync` call outside
 * `lib/safe-write.js` (the canonical writer) UNLESS the call has a
 * `safe-write-exempt:` comment on the same line or the line immediately
 * above explaining why the exemption is legitimate.
 *
 * Tests and `node_modules` are excluded (test fixtures legitimately use
 * fs.writeFileSync; we don't want to gunk those up).
 *
 * Usage:
 *   node scripts/check-write-discipline.js
 *
 * Exit codes:
 *   0 — all writes are policy-compliant (either inside safe-write.js or
 *       carry a safe-write-exempt comment).
 *   1 — one or more non-compliant writes found; details printed to stderr.
 *
 * Add to npm:
 *   "check:writes": "node scripts/check-write-discipline.js"
 *
 * Integration:
 *   - Run as a CI step in package.json `test` chain or as a separate job.
 *   - Optional pre-commit hook can call this against staged files.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SAFE_WRITE_FILE = 'lib/safe-write.js'; // posix-style; compared against forward-slash relPath
const EXEMPT_COMMENT = 'safe-write-exempt:';
const TARGET_CALLS = /\bfs\s*\.\s*(writeFileSync|copyFileSync)\s*\(/;

// Directories to scan; everything else (tests/, node_modules/, .git/, etc.) is skipped.
const SCAN_DIRS = ['lib', 'scripts', 'pack'];
const SCAN_FILES = ['run-discovery.js', 'run-pipeline.js', 'run-batch.js'];

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function gather() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(PROJECT_ROOT, d), files);
  for (const f of SCAN_FILES) {
    const full = path.join(PROJECT_ROOT, f);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

function checkFile(absPath) {
  const relPath = path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');

  // The canonical write helper is allowed to call fs.writeFileSync directly.
  if (relPath === SAFE_WRITE_FILE) return [];

  const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TARGET_CALLS.test(line)) continue;

    // Skip lines that are clearly inside comments — JSDoc continuations
    // (` * fs.writeFileSync(...)`) and single-line comments (`// fs.write...`).
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Allow if THIS line has the exempt comment
    if (line.includes(EXEMPT_COMMENT)) continue;
    // Allow if the IMMEDIATELY PRECEDING line has the exempt comment
    if (i > 0 && lines[i - 1].includes(EXEMPT_COMMENT)) continue;

    violations.push({
      file: relPath,
      line: i + 1,
      content: line.trim(),
    });
  }
  return violations;
}

function main() {
  const files = gather();
  const allViolations = [];
  for (const f of files) {
    for (const v of checkFile(f)) allViolations.push(v);
  }

  if (allViolations.length === 0) {
    console.log(`check-write-discipline: clean (${files.length} files scanned)`);
    process.exit(0);
  }

  console.error('check-write-discipline: VIOLATIONS — per ADR-012, all fs.writeFileSync / fs.copyFileSync');
  console.error('calls outside lib/safe-write.js must either route through safeWriteArtifact /');
  console.error('safeCopyArtifact OR carry a `// safe-write-exempt: <reason>` comment.');
  console.error('');
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}  ${v.content}`);
  }
  console.error('');
  console.error(`${allViolations.length} violation${allViolations.length === 1 ? '' : 's'} across ${new Set(allViolations.map((v) => v.file)).size} file(s).`);
  console.error('');
  console.error('Fix options:');
  console.error('  (a) Migrate the call to lib/safe-write.js — see ADR-012 + sdlc/sprints/sprint-002/plan/scope-addendum.md item #15.');
  console.error('  (b) If the write is legitimately out of scope (logs, traces, aggregator outputs, etc.),');
  console.error('      add a `// safe-write-exempt: <reason>` comment on the same line or the line above.');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { checkFile, gather };

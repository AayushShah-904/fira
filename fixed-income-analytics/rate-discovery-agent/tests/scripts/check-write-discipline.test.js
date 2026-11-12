'use strict';

/**
 * Tests for scripts/check-write-discipline.js (Sprint 002 #15d).
 *
 * Verifies the unit-level `checkFile(absPath)` against fixture files
 * with various combinations of compliant / non-compliant writes.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { checkFile } = require('../../scripts/check-write-discipline');

const tmpDirs = [];

function makeFixture(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-writes-'));
  tmpDirs.push(dir);
  // Mimic a project subdir so `path.relative(projectRoot, ...)` doesn't trip.
  // The check derives relPath from PROJECT_ROOT — fixtures live outside that,
  // so `relPath` here will be a long ../../ path, which still works for the
  // exempt-comment logic. Only `lib/safe-write.js` is special-cased on relPath.
  const file = path.join(dir, 'fixture.js');
  fs.writeFileSync(file, content);
  return file;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

test('clean file with no fs writes returns no violations', () => {
  const file = makeFixture(`
'use strict';
const x = 1;
console.log('hi');
`);
  assert.deepEqual(checkFile(file), []);
});

test('uncommented fs.writeFileSync is flagged', () => {
  const file = makeFixture(`
'use strict';
const fs = require('fs');
fs.writeFileSync('/tmp/x', 'hi');
`);
  const v = checkFile(file);
  assert.equal(v.length, 1);
  assert.match(v[0].content, /fs\.writeFileSync/);
});

test('uncommented fs.copyFileSync is flagged', () => {
  const file = makeFixture(`
const fs = require('fs');
fs.copyFileSync('/a', '/b');
`);
  assert.equal(checkFile(file).length, 1);
});

test('inline same-line safe-write-exempt comment passes', () => {
  const file = makeFixture(`
const fs = require('fs');
// safe-write-exempt: trace output
fs.writeFileSync('/tmp/trace.jsonl', 'data');
`);
  assert.deepEqual(checkFile(file), []);
});

test('exempt comment on the line above passes', () => {
  const file = makeFixture(`
const fs = require('fs');
// safe-write-exempt: aggregator output
fs.writeFileSync('/tmp/summary.json', '{}');
`);
  assert.deepEqual(checkFile(file), []);
});

test('exempt comment two lines above does NOT pass (only same-line or line-above counts)', () => {
  const file = makeFixture(`
// safe-write-exempt: too far up
const x = 1;
fs.writeFileSync('/tmp/a', 'b');
`);
  assert.equal(checkFile(file).length, 1);
});

test('JSDoc continuation lines (` * fs.writeFileSync(...)`) are skipped', () => {
  const file = makeFixture(`
/**
 * Example usage:
 *     fs.writeFileSync('trace.jsonl', data);
 */
const x = 1;
`);
  assert.deepEqual(checkFile(file), []);
});

test('single-line // comment containing fs.writeFileSync is skipped', () => {
  const file = makeFixture(`
// Old code we removed: fs.writeFileSync('/tmp', 'old');
const x = 1;
`);
  assert.deepEqual(checkFile(file), []);
});

test('multiple violations in one file are all reported', () => {
  const file = makeFixture(`
fs.writeFileSync('/a', 'b');
fs.writeFileSync('/c', 'd');
fs.copyFileSync('/e', '/f');
`);
  assert.equal(checkFile(file).length, 3);
});

test('mix of compliant and non-compliant is partially reported', () => {
  const file = makeFixture(`
// safe-write-exempt: OK
fs.writeFileSync('/a', 'b');
fs.writeFileSync('/c', 'd');
`);
  const v = checkFile(file);
  assert.equal(v.length, 1);
  assert.match(v[0].content, /\/c/);
});

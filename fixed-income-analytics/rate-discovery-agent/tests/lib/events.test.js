'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MODULE_PATH = '../../lib/events';

function loadFreshEventsModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

function captureStdout(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return true;
  };
  try { fn(); } finally { process.stdout.write = orig; }
  return lines;
}

test('formatBadge formats ATTEMPT, EXTRACTED, SKIPPED, and FAILED cleanly', () => {
  const { formatBadge } = loadFreshEventsModule();

  const attempt = formatBadge('ATTEMPT', { bank_code: 'hdfc-bank-limited', idx: 1, total: 10, mode: 'sequential' });
  assert.strictEqual(attempt, '[PROGRESS] [1/10] hdfc-bank-limited (sequential)');

  const extracted = formatBadge('EXTRACTED', { bank_code: 'yes-bank-limited', slab_count: 31, variants: { domestic: 31 }, scraper_type: 'html_static' });
  assert.strictEqual(extracted, '[EXTRACTED] yes-bank-limited | 31 slabs (domestic: 31) [html_static]');

  const skipped = formatBadge('SKIPPED', { bank_code: 'axis-bank-limited', reason: 'pre_filter' });
  assert.strictEqual(skipped, '[SKIPPED] axis-bank-limited | reason: pre_filter');

  const failed = formatBadge('FAILED', { bank_code: 'sbi', kind: 'timeout' });
  assert.strictEqual(failed, '[FAILED] sbi | kind: timeout');
});

test('emit writes clean status badge to stdout and updates state', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-test-'));
  try {
    const { emit, initBatch, _getState } = loadFreshEventsModule();
    initBatch({ total: 2, cohort: 'test-cohort', outputDir: tmpDir });

    const captured = captureStdout(() => {
      emit('ATTEMPT', { bank_code: 'yes-bank-limited', idx: 1, total: 2 });
      emit('EXTRACTED', { bank_code: 'yes-bank-limited', slab_count: 31, variants: { domestic: 31 } });
    });

    assert.strictEqual(captured.length, 2);
    assert.match(captured[0], /^\[PROGRESS\] /);
    assert.match(captured[1], /^\[EXTRACTED\] /);

    const state = _getState();
    assert.strictEqual(state.total, 2);
    assert.strictEqual(state.processed, 1);
    assert.strictEqual(state.succeeded, 1);
    assert.strictEqual(state.total_slabs, 31);
    assert.strictEqual(state.current_bank, 'yes-bank-limited');

    const progressFile = path.join(tmpDir, '_progress.json');
    assert.ok(fs.existsSync(progressFile), '_progress.json must exist');
    const diskProgress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    assert.strictEqual(diskProgress.succeeded, 1);
    assert.strictEqual(diskProgress.percent, 50);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('completeBatch marks batch completed and outputs summary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-test-complete-'));
  try {
    const { emit, initBatch, completeBatch, _getState } = loadFreshEventsModule();
    initBatch({ total: 1, outputDir: tmpDir });
    emit('EXTRACTED', { bank_code: 'test-bank', slab_count: 10 });

    const captured = captureStdout(() => completeBatch());
    assert.strictEqual(captured.length, 1);
    assert.match(captured[0], /^\[SUMMARY\] Batch finished: 1 succeeded/);

    const state = _getState();
    assert.strictEqual(state.status, 'completed');

    const progressFile = path.join(tmpDir, '_progress.json');
    const diskProgress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    assert.strictEqual(diskProgress.status, 'completed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('emit swallows stdout write errors safely without throwing', () => {
  const { emit } = loadFreshEventsModule();
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => { throw new Error('broken pipe'); };
  try {
    assert.doesNotThrow(() => emit('FAILED', { bank_code: 'b', kind: 'timeout' }));
  } finally {
    process.stdout.write = orig;
  }
});

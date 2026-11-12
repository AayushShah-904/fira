'use strict';

/**
 * Local-First Progress & Event Reporter.
 *
 * Emits clean, readable status badges to stdout for live terminal monitoring
 * (e.g. FIRA UI Admin terminal) and maintains an atomic _progress.json snapshot
 * for UI dashboards and background jobs.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LATEST_DIR = process.env.BIRD_LATEST_DIR || path.resolve(__dirname, '../output/latest');

let _envCtx = null;
let _batchState = {
  status: 'idle',
  total: 0,
  processed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  total_slabs: 0,
  current_bank: null,
  started_at: null,
  updated_at: null,
  output_dir: DEFAULT_LATEST_DIR,
};

function envContext() {
  if (_envCtx) return _envCtx;
  const ctx = {};
  const runLabel = process.env.RUN_LABEL;
  if (runLabel) ctx.run_label = runLabel;
  _envCtx = ctx;
  return ctx;
}

function initBatch({ total = 0, cohort = null, mode = 'discover', outputDir = DEFAULT_LATEST_DIR } = {}) {
  _batchState = {
    status: 'running',
    cohort,
    mode,
    total: Number(total) || 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    total_slabs: 0,
    current_bank: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    output_dir: outputDir || DEFAULT_LATEST_DIR,
  };
  writeProgressFile();
}

function writeProgressFile() {
  try {
    const dir = _batchState.output_dir || DEFAULT_LATEST_DIR;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, '_progress.json');
    const data = {
      ..._batchState,
      percent: _batchState.total > 0 ? Math.round((_batchState.processed / _batchState.total) * 100) : 0,
    };
    // safe-write-exempt: local batch progress file, non-rate artifact
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch {
    // Progress persistence must never crash discovery
  }
}

function formatBadge(name, payload = {}) {
  const bank = payload.bank_code || '';
  switch (name) {
    case 'ATTEMPT': {
      const idx = payload.idx !== undefined ? `[${payload.idx}/${payload.total || _batchState.total}] ` : '';
      const mode = payload.mode ? ` (${payload.mode})` : '';
      return `[PROGRESS] ${idx}${bank}${mode}`;
    }
    case 'EXTRACTED': {
      const slabs = payload.slab_count !== undefined ? `${payload.slab_count} slabs` : '';
      const variants = payload.variants ? ` (${Object.entries(payload.variants).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';
      const scraper = payload.scraper_type ? ` [${payload.scraper_type}]` : '';
      return `[EXTRACTED] ${bank} | ${slabs}${variants}${scraper}`;
    }
    case 'SKIPPED': {
      const reason = payload.reason ? ` | reason: ${payload.reason}` : '';
      return `[SKIPPED] ${bank}${reason}`;
    }
    case 'FAILED': {
      const kind = payload.kind ? ` | kind: ${payload.kind}` : '';
      const err = payload.error ? ` (${payload.error})` : '';
      return `[FAILED] ${bank}${kind}${err}`;
    }
    default:
      return `[${name}] ${bank ? bank + ' ' : ''}${JSON.stringify(payload)}`;
  }
}

function emit(name, payload = {}) {
  const ts = new Date().toISOString();
  _batchState.updated_at = ts;

  if (payload.bank_code) {
    _batchState.current_bank = payload.bank_code;
  }

  if (name === 'ATTEMPT') {
    if (payload.total && !_batchState.total) {
      _batchState.total = payload.total;
    }
  } else if (name === 'EXTRACTED') {
    _batchState.processed++;
    _batchState.succeeded++;
    if (payload.slab_count) {
      _batchState.total_slabs += Number(payload.slab_count) || 0;
    }
  } else if (name === 'FAILED') {
    _batchState.processed++;
    _batchState.failed++;
  } else if (name === 'SKIPPED') {
    _batchState.processed++;
    _batchState.skipped++;
  }

  writeProgressFile();

  const formatted = formatBadge(name, payload);
  try {
    process.stdout.write(formatted + '\n');
  } catch {
    // Never crash
  }

  return { event: name, ts, ...envContext(), ...payload, formatted };
}

function completeBatch() {
  _batchState.status = 'completed';
  _batchState.updated_at = new Date().toISOString();
  writeProgressFile();
  try {
    process.stdout.write(`[SUMMARY] Batch finished: ${_batchState.succeeded} succeeded, ${_batchState.failed} failed, ${_batchState.skipped} skipped (${_batchState.total_slabs} slabs total)\n`);
  } catch {}
}

function _resetEnvContext() {
  _envCtx = null;
  _batchState = {
    status: 'idle',
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    total_slabs: 0,
    current_bank: null,
    started_at: null,
    updated_at: null,
    output_dir: DEFAULT_LATEST_DIR,
  };
}

function _getState() {
  return { ..._batchState };
}

module.exports = { emit, initBatch, completeBatch, formatBadge, _resetEnvContext, _getState };

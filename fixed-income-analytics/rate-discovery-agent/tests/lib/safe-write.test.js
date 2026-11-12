'use strict';

/**
 * Tests for lib/safe-write.js — the centralized write path (ADR-012).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeWriteArtifact,
  safeCopyArtifact,
  ALLOWED_EXTRACTION_METHODS,
  CURATED_EXTRACTION_METHODS,
  AUTO_OVERWRITEABLE_METHODS,
} = require('../../lib/safe-write');

const tmpDirs = [];

function makeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-write-test-'));
  tmpDirs.push(d);
  return d;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

const silentLogger = { warn: () => {}, info: () => {} };

// ── Enum exposure ───────────────────────────────────────────────────

test('ALLOWED_EXTRACTION_METHODS is the union of curated + auto-overwriteable', () => {
  const total = AUTO_OVERWRITEABLE_METHODS.length + CURATED_EXTRACTION_METHODS.length;
  assert.equal(ALLOWED_EXTRACTION_METHODS.length, total);
});

test('curated and auto-overwriteable sets are disjoint', () => {
  const auto = new Set(AUTO_OVERWRITEABLE_METHODS);
  for (const m of CURATED_EXTRACTION_METHODS) {
    assert.equal(auto.has(m), false, `${m} should not be in both sets`);
  }
});

test('llm_inline_extraction is in auto-overwriteable (default for untagged writes)', () => {
  assert.ok(AUTO_OVERWRITEABLE_METHODS.includes('llm_inline_extraction'));
});

test('manual_image_transcription is in curated', () => {
  assert.ok(CURATED_EXTRACTION_METHODS.includes('manual_image_transcription'));
});

// ── Validation ──────────────────────────────────────────────────────

test('throws on unknown kind', () => {
  assert.throws(
    () => safeWriteArtifact({ path: '/tmp/x', incoming: {}, kind: 'bogus', source: 'agent' }),
    /unknown kind/,
  );
});

test('throws on unknown source', () => {
  const dir = makeDir();
  assert.throws(
    () => safeWriteArtifact({
      path: path.join(dir, 'x_config.json'),
      incoming: { extraction_method: 'automatic_html_static' },
      kind: 'config',
      source: 'bogus',
    }),
    /unknown source/,
  );
});

test('throws on path missing', () => {
  assert.throws(
    () => safeWriteArtifact({ incoming: {}, kind: 'config', source: 'agent' }),
    /path required/,
  );
});

test('throws on invalid extraction_method', () => {
  const dir = makeDir();
  assert.throws(
    () => safeWriteArtifact({
      path: path.join(dir, 'x_config.json'),
      incoming: { extraction_method: 'made_up_method' },
      kind: 'config',
      source: 'agent',
    }),
    /invalid extraction_method/,
  );
});

// ── Lazy migration ──────────────────────────────────────────────────

test('lazy-tags incoming config without extraction_method as llm_inline_extraction', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_config.json');
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', website: 'https://x.com' },
    kind: 'config',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
  assert.equal(r.defaultedExtractionMethod, 'llm_inline_extraction');
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.extraction_method, 'llm_inline_extraction');
});

test('summary writes do NOT need extraction_method', () => {
  const dir = makeDir();
  const r = safeWriteArtifact({
    path: path.join(dir, 'x.summary.json'),
    incoming: { bank_code: 'x', failure_class: 'success' },
    kind: 'summary',
    source: 'classifier',
  });
  assert.equal(r.wrote, true);
});

// ── Curated-overwrite protection ────────────────────────────────────

test('curated rates file is preserved; incoming goes to pending sidecar', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  // Operator-curated rates already in place
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'manual_image_transcription',
    rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }],
  }));
  // Agent tries to overwrite with a fresh discovery
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_html_static', rate_slabs: [] },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.deferredToPending, true);
  assert.match(r.reason, /^curated:manual_image_transcription/);
  // Original still in place
  const orig = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(orig.rate_slabs.length, 1);
  assert.equal(orig.extraction_method, 'manual_image_transcription');
  // Pending sidecar exists with the agent's payload
  const pending = JSON.parse(fs.readFileSync(target + '.pending.json', 'utf-8'));
  assert.equal(pending.extraction_method, 'automatic_html_static');
});

test('curated check fires for pending_vision too', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x', extraction_method: 'pending_vision', rate_slabs: [],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_pdf', rate_slabs: [] },
    kind: 'rates',
    source: 'agent',
  });
  assert.equal(r.deferredToPending, true);
});

test('operator source bypasses curated check (force-equivalent for manual transcriptions)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x', extraction_method: 'manual_image_transcription', rate_slabs: [{}],
  }));
  // Operator re-transcribes (different image, newer date)
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'manual_image_transcription',
      rate_slabs: [{ tenure_text: 'NEW' }],
    },
    kind: 'rates',
    source: 'operator',
  });
  assert.equal(r.wrote, true);
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.rate_slabs[0].tenure_text, 'NEW');
});

test('force: true bypasses curated check', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x', extraction_method: 'manual_image_transcription', rate_slabs: [{}],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'stale_needs_refresh', rate_slabs: [] },
    kind: 'rates',
    source: 'agent',
    force: true,
  });
  assert.equal(r.wrote, true);
});

test('auto extraction_method on existing → next auto write proceeds normally', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x', extraction_method: 'automatic_html_static', rate_slabs: [{ a: 1 }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_html_static', rate_slabs: [{ a: 2 }] },
    kind: 'rates',
    source: 'agent',
  });
  assert.equal(r.wrote, true);
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.rate_slabs[0].a, 2);
});

// ── Empty-overwrite block (Sprint 010 Phase J, 2026-06-09) ──────────

test('empty-overwrite blocked: registry_skip cannot clobber existing slabs (R1)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'dcb_rates.json');
  // Existing: extracted slabs via auto path, NOT a curated method
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'dcb-bank-limited',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: [
      { tenure_text: '7-14d', rate_general_pct: 3 },
      { tenure_text: '15-29d', rate_general_pct: 5.75 },
    ],
  }));
  // registry-skip writer would clobber this with empty slabs
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'dcb-bank-limited',
      extraction_method: 'registry_skip',
      rate_slabs: [],
      warnings: ['Bank skipped at discovery time'],
    },
    kind: 'rates',
    source: 'skip-gate',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.deferredToPending, true);
  assert.equal(r.reason, 'empty_overwrite_blocked');
  // Original preserved
  const orig = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(orig.rate_slabs.length, 2);
  assert.equal(orig.extraction_method, 'llm_inline_extraction');
  // Pending sidecar holds the incoming
  const pending = JSON.parse(fs.readFileSync(target + '.pending.json', 'utf-8'));
  assert.equal(pending.extraction_method, 'registry_skip');
});

test('empty-overwrite blocked: cohort-failure path cannot clobber existing slabs (R2)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'bank-of-ceylon_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'bank-of-ceylon',
    extraction_method: 'automatic_html_static',
    rate_slabs: Array.from({ length: 11 }, (_, i) => ({ tenure_text: `${i}` })),
  }));
  // Failure-path emits llm_inline_extraction with empty slabs
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'bank-of-ceylon',
      extraction_method: 'llm_inline_extraction',
      rate_slabs: [],
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.reason, 'empty_overwrite_blocked');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).rate_slabs.length, 11);
});

// ── Shrink-overwrite block (Sprint 011 A6/F4, 2026-07-07) ───────────

const shrinkSlabs = (n) => Array.from({ length: n }, (_, i) => (
  { tenure_text: `${i + 1}y`, rate_general_pct: 5 + (i % 4) * 0.25 }
));

test('shrink-overwrite blocked: teaser table cannot clobber a full ladder (Axis 2026-07-07 class)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'axis-bank-limited_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'axis-bank-limited',
    extraction_method: 'automatic_pdf',
    rate_slabs: shrinkSlabs(54),
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'axis-bank-limited',
      extraction_method: 'automatic_html_static',
      rate_slabs: shrinkSlabs(2),
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.deferredToPending, true);
  assert.equal(r.reason, 'shrink_overwrite_blocked');
  const orig = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(orig.rate_slabs.length, 54);
  const pending = JSON.parse(fs.readFileSync(target + '.pending.json', 'utf-8'));
  assert.equal(pending.rate_slabs.length, 2);
});

test('shrink-overwrite allows exactly-half and larger refreshes', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_pdf',
    rate_slabs: shrinkSlabs(10),
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_pdf', rate_slabs: shrinkSlabs(5) },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).rate_slabs.length, 5);
});

test('shrink-overwrite rule skips small existing ladders (<8 slabs)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    rate_slabs: shrinkSlabs(6),
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_html_static', rate_slabs: shrinkSlabs(2) },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
});

test('shrink-overwrite block bypassed by stale_needs_refresh existing method', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'stale_needs_refresh',
    rate_slabs: shrinkSlabs(20),
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_html_static', rate_slabs: shrinkSlabs(3) },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).rate_slabs.length, 3);
});

test('empty-overwrite block bypassed by stale_needs_refresh existing method', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  // Operator opted in for refresh-or-clear
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'stale_needs_refresh',
    rate_slabs: [{ tenure_text: 'stale' }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'llm_inline_extraction',
      rate_slabs: [],
    },
    kind: 'rates',
    source: 'agent',
  });
  assert.equal(r.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).rate_slabs.length, 0);
});

test('empty-overwrite block bypassed by operator source', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    rate_slabs: [{ tenure_text: '1y' }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'manual_data_entry',
      rate_slabs: [],
    },
    kind: 'rates',
    source: 'operator',
  });
  assert.equal(r.wrote, true);
});

test('empty-overwrite block bypassed by force:true', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    rate_slabs: [{ tenure_text: '1y' }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'registry_skip',
      rate_slabs: [],
    },
    kind: 'rates',
    source: 'skip-gate',
    force: true,
  });
  assert.equal(r.wrote, true);
});

test('empty-to-empty write is a normal overwrite (no protection needed)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    rate_slabs: [],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'registry_skip',
      rate_slabs: [],
    },
    kind: 'rates',
    source: 'skip-gate',
  });
  assert.equal(r.wrote, true);
});

test('partial degradation below half of a substantial ladder is blocked (rule 4, Sprint 011)', () => {
  // Historically only empty incoming was blocked; the slab-delta threshold
  // this test anticipated landed as rule 4 (A6/F4, 2026-07-07).
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    rate_slabs: Array.from({ length: 20 }, (_, i) => ({ tenure_text: `${i}` })),
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'automatic_html_static',
      rate_slabs: [{ tenure_text: 'only-one' }],
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.reason, 'shrink_overwrite_blocked');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).rate_slabs.length, 20);
});

// ── Sprint 010 Phase K — garbage-overwrite block + provenance history ──

test('garbage-overwrite blocked: garbage incoming over clean existing (the kerala-state case)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'kerala_rates.json');
  // Existing: clean FD data from automatic_html_js
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'kerala-state-coop',
    extraction_method: 'automatic_html_js',
    scraped_at: '2026-05-26T04:21:53.361Z',
    rate_slabs: [
      { tenure_text: '7 to 14 days', tenure_min_days: 7, tenure_max_days: 14, rate_general_pct: 4 },
      { tenure_text: '15 to 45 days', tenure_min_days: 15, tenure_max_days: 45, rate_general_pct: 5.5 },
      { tenure_text: '46 to 90 days', tenure_min_days: 46, tenure_max_days: 90, rate_general_pct: 6 },
    ],
  }));
  // Incoming: cohort's bad automatic_html_static pulled the loan table
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'kerala-state-coop',
      extraction_method: 'automatic_html_static',
      rate_slabs: [
        { tenure_text: '12.45', rate_general_pct: 510 },         // G2 + G1
        { tenure_text: 'KB MICRO FINANCE JLG', rate_general_pct: 10.95 }, // G3
        { tenure_text: '11.95', rate_general_pct: 10 },           // G2
      ],
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.deferredToPending, true);
  assert.equal(r.reason, 'garbage_overwrite_blocked');
  // Original preserved (slabs untouched, only history added)
  const kept = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(kept.rate_slabs.length, 3);
  assert.equal(kept.extraction_method, 'automatic_html_js');
  // Provenance recorded
  assert.ok(Array.isArray(kept._safe_write_history));
  assert.equal(kept._safe_write_history.length, 1);
  const h = kept._safe_write_history[0];
  assert.equal(h.rejected_reason, 'garbage_overwrite_blocked');
  assert.equal(h.attempted_source, 'agent');
  assert.equal(h.attempted_extraction_method, 'automatic_html_static');
  assert.equal(h.attempted_slab_count, 3);
  assert.equal(h.attempted_verdict, 'garbage');
  assert.equal(h.retained_extraction_method, 'automatic_html_js');
  assert.equal(h.retained_scraped_at, '2026-05-26T04:21:53.361Z');
  assert.equal(h.retained_slab_count, 3);
  assert.match(h.attempted_at, /^20\d\d-/); // ISO timestamp
});

test('garbage-overwrite block bypassed by operator source', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_js',
    rate_slabs: [{ tenure_text: '1y', rate_general_pct: 7 }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'manual_data_entry',
      rate_slabs: [
        { tenure_text: '1.', rate_general_pct: 91179 }, // would be garbage
      ],
    },
    kind: 'rates',
    source: 'operator',
  });
  assert.equal(r.wrote, true); // operator can override
});

test('garbage-overwrite block bypassed by force:true', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_js',
    rate_slabs: [{ tenure_text: '1y', rate_general_pct: 7 }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'automatic_html_static',
      rate_slabs: [{ tenure_text: '1.', rate_general_pct: 91179 }],
    },
    kind: 'rates',
    source: 'agent',
    force: true,
  });
  assert.equal(r.wrote, true);
});

test('clean-to-clean overwrite proceeds normally (no false positive)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_js',
    rate_slabs: [{ tenure_text: '7 days to 14 days', rate_general_pct: 4 }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'automatic_html_js',
      rate_slabs: [
        { tenure_text: '7 days to 14 days', rate_general_pct: 4.5 },
        { tenure_text: '15 days to 45 days', rate_general_pct: 5.5 },
      ],
    },
    kind: 'rates',
    source: 'agent',
  });
  assert.equal(r.wrote, true);
});

// ── History capture (provenance) ──

test('empty-overwrite rejection records history entry on retained file', () => {
  const dir = makeDir();
  const target = path.join(dir, 'y_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'y',
    extraction_method: 'automatic_html_static',
    scraped_at: '2026-05-15T10:00:00Z',
    rate_slabs: Array.from({ length: 7 }, (_, i) => ({ tenure_text: `slab-${i}`, rate_general_pct: 5 + i })),
  }));
  safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'y',
      extraction_method: 'registry_skip',
      rate_slabs: [],
    },
    kind: 'rates',
    source: 'skip-gate',
  });
  const kept = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(kept.rate_slabs.length, 7);
  assert.equal(kept._safe_write_history.length, 1);
  const h = kept._safe_write_history[0];
  assert.equal(h.rejected_reason, 'empty_overwrite_blocked');
  assert.equal(h.attempted_source, 'skip-gate');
  assert.equal(h.attempted_extraction_method, 'registry_skip');
  assert.equal(h.attempted_slab_count, 0);
  assert.equal(h.attempted_verdict, 'empty');
  assert.equal(h.retained_slab_count, 7);
  assert.equal(h.retained_scraped_at, '2026-05-15T10:00:00Z');
});

test('curated rejection records history entry on retained file', () => {
  const dir = makeDir();
  const target = path.join(dir, 'z_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'z',
    extraction_method: 'manual_image_transcription',
    rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }],
  }));
  safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'z',
      extraction_method: 'automatic_html_js',
      rate_slabs: [{ tenure_text: '1 year', rate_general_pct: 6.6 }],
    },
    kind: 'rates',
    source: 'agent',
  });
  const kept = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(kept.extraction_method, 'manual_image_transcription'); // unchanged
  assert.equal(kept._safe_write_history.length, 1);
  assert.match(kept._safe_write_history[0].rejected_reason, /^curated:/);
});

test('history array caps at SAFE_WRITE_HISTORY_MAX (oldest dropped)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'w_rates.json');
  // Seed an existing file with 19 pre-existing history entries
  const oldHistory = Array.from({ length: 19 }, (_, i) => ({
    attempted_at: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    attempted_source: 'agent',
    rejected_reason: 'empty_overwrite_blocked',
  }));
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'w',
    extraction_method: 'automatic_html_js',
    rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6 }],
    _safe_write_history: oldHistory,
  }));
  // Trigger 2 more rejections to push total to 21 then 22
  for (let i = 0; i < 2; i++) {
    safeWriteArtifact({
      path: target,
      incoming: { bank_code: 'w', extraction_method: 'registry_skip', rate_slabs: [] },
      kind: 'rates',
      source: 'skip-gate',
    });
  }
  const kept = JSON.parse(fs.readFileSync(target, 'utf-8'));
  // Cap is 20; oldest pruned. After first push: 20 (cap not exceeded yet).
  // After second push: 21 → trim to 20, oldest (2026-05-01) dropped.
  assert.equal(kept._safe_write_history.length, 20);
  assert.equal(kept._safe_write_history[0].attempted_at, '2026-05-02T00:00:00Z');
  // Latest entry is one of the new rejections
  assert.equal(kept._safe_write_history[19].rejected_reason, 'empty_overwrite_blocked');
  assert.equal(kept._safe_write_history[19].attempted_source, 'skip-gate');
});

test('successful overwrite does NOT add history entry (only rejections do)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'q_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'q',
    extraction_method: 'automatic_html_js',
    rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6 }],
  }));
  safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'q',
      extraction_method: 'automatic_html_js',
      rate_slabs: [
        { tenure_text: '7 days to 14 days', rate_general_pct: 4 },
        { tenure_text: '1 year', rate_general_pct: 6.5 },
      ],
    },
    kind: 'rates',
    source: 'agent',
  });
  const kept = JSON.parse(fs.readFileSync(target, 'utf-8'));
  // Wrote through; no history field added
  assert.equal(kept._safe_write_history, undefined);
  assert.equal(kept.rate_slabs.length, 2);
});

test('empty-overwrite block does not apply to config kind', () => {
  // Configs don't carry rate_slabs; the rule is rates-only.
  const dir = makeDir();
  const target = path.join(dir, 'x_config.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    selectors: { rate: '.rate' },
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'registry_skip', selectors: {} },
    kind: 'config',
    source: 'skip-gate',
  });
  assert.equal(r.wrote, true);
});

test('stale_needs_refresh on existing is auto-overwriteable', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x', extraction_method: 'stale_needs_refresh', rate_slabs: [],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_html_static', rate_slabs: [{}] },
    kind: 'rates',
    source: 'agent',
  });
  assert.equal(r.wrote, true);
});

// ── Sprint 011 item 21 — rates QC pass (lib/rates-qc.js) ────────────

test('rates QC: LLM write is deduped and garbage effective_date nulled before landing', () => {
  const dir = makeDir();
  const target = path.join(dir, 'bob_fcnr_rates.json');
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'bank-of-baroda',
      extraction_method: 'llm_inline_extraction',
      effective_date: '1st July 1995', // product-introduction legalese, not a rate date
      rate_slabs: [
        { tenure_text: '5y', currency: 'GBP', rate_general_pct: 4 },
        { tenure_text: '5y', currency: 'GBP', rate_general_pct: 4 }, // dup
        { tenure_text: '5y', currency: 'EUR', rate_general_pct: 2.5 },
      ],
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
  assert.equal(r.qcChanges.dupes_removed, 1);
  assert.equal(r.qcChanges.date_rejected, true);
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.rate_slabs.length, 2);
  assert.equal(written.effective_date, null);
  assert.ok(written.warnings.some((w) => /1st July 1995/.test(w)));
});

test('rates QC: non-LLM write gets ISO date normalisation but keeps duplicates', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'automatic_html_static',
      effective_date: '01.07.2025', // dotted DD.MM.YYYY, Indian convention
      rate_slabs: [
        { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 },
        { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 },
      ],
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
  assert.equal(r.qcChanges.date_normalised, true);
  assert.equal(r.qcChanges.dupes_removed, 0);
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.effective_date, '2025-07-01');
  assert.equal(written.rate_slabs.length, 2);
});

test('rates QC: curated incoming (manual_data_entry via operator) bypasses QC entirely', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'manual_data_entry',
      effective_date: '1st July 1995', // operator spelling preserved verbatim
      rate_slabs: [
        { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 },
        { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 },
      ],
    },
    kind: 'rates',
    source: 'operator',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
  assert.equal(r.qcChanges, null); // bypassed — no QC applied
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.effective_date, '1st July 1995');
  assert.equal(written.rate_slabs.length, 2);
  assert.equal(written.warnings, undefined);
});

test('rates QC: under-extraction appends quality_warning but QC itself does not block (small ladder, rule 4 out of scope)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  // Existing < 8 slabs so the rule-4 shrink block does not apply — isolates
  // the QC layer's warn-only contract.
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: Array.from({ length: 6 }, (_, i) => ({ tenure_text: `t${i}`, currency: 'USD' })),
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'llm_inline_extraction',
      rate_slabs: Array.from({ length: 2 }, (_, i) => ({ tenure_text: `t${i}`, currency: 'USD' })),
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true); // QC surfaces, never blocks
  assert.equal(r.qcChanges.under_extraction_suspected, true);
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.rate_slabs.length, 2);
  assert.ok(written.warnings.some((w) => /under_extraction_suspected/.test(w)));
});

test('rates QC: under-extraction warning rides the pending sidecar when rule 4 blocks the write', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: Array.from({ length: 20 }, (_, i) => ({ tenure_text: `t${i}`, currency: 'USD' })),
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'llm_inline_extraction',
      rate_slabs: Array.from({ length: 5 }, (_, i) => ({ tenure_text: `t${i}`, currency: 'USD' })),
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.reason, 'shrink_overwrite_blocked');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).rate_slabs.length, 20);
  const pending = JSON.parse(fs.readFileSync(target + '.pending.json', 'utf-8'));
  assert.equal(pending.rate_slabs.length, 5);
  assert.ok(pending.warnings.some((w) => /under_extraction_suspected/.test(w)));
});

test('rates QC: config kind is untouched by QC (rates-only pass)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_config.json');
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'llm_inline_extraction',
      effective_date: '01.07.2025', // not a real config field, but proves no rewrite
    },
    kind: 'config',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, true);
  assert.equal(r.qcChanges, null); // QC never ran — not a rates write
  const written = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.equal(written.effective_date, '01.07.2025');
});

test('rates QC: rejected write still carries the QC-cleaned payload into the pending sidecar', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_rates.json');
  // Existing curated file — incoming will be rejected by Rule 1
  fs.writeFileSync(target, JSON.stringify({
    bank_code: 'x',
    extraction_method: 'manual_image_transcription',
    rate_slabs: [{ tenure_text: '1y', rate_general_pct: 6.5 }],
  }));
  const r = safeWriteArtifact({
    path: target,
    incoming: {
      bank_code: 'x',
      extraction_method: 'llm_inline_extraction',
      effective_date: '8th June 2026',
      rate_slabs: [
        { tenure_text: '1y', currency: 'USD', rate_general_pct: 6 },
        { tenure_text: '1y', currency: 'USD', rate_general_pct: 6 }, // dup
      ],
    },
    kind: 'rates',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.deferredToPending, true);
  assert.equal(r.qcChanges.dupes_removed, 1);
  const pending = JSON.parse(fs.readFileSync(target + '.pending.json', 'utf-8'));
  assert.equal(pending.rate_slabs.length, 1);              // deduped
  assert.equal(pending.effective_date, '2026-06-08');      // normalised
});

// ── Atomic writes ───────────────────────────────────────────────────

test('write goes through temp-rename (no .tmp.* remnant on success)', () => {
  const dir = makeDir();
  const target = path.join(dir, 'x_config.json');
  safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_html_static' },
    kind: 'config',
    source: 'agent',
  });
  const remnants = fs.readdirSync(dir).filter((f) => /\.tmp\./.test(f));
  assert.equal(remnants.length, 0);
});

test('creates parent directories if missing', () => {
  const dir = makeDir();
  const target = path.join(dir, 'nested', 'deep', 'x_config.json');
  safeWriteArtifact({
    path: target,
    incoming: { bank_code: 'x', extraction_method: 'automatic_html_static' },
    kind: 'config',
    source: 'agent',
  });
  assert.ok(fs.existsSync(target));
});

// ── safeCopyArtifact ────────────────────────────────────────────────

test('safeCopyArtifact passes curated check through', () => {
  const dir = makeDir();
  const sourcePath = path.join(dir, 'src_rates.json');
  const targetPath = path.join(dir, 'dst_rates.json');
  fs.writeFileSync(sourcePath, JSON.stringify({
    bank_code: 'x', extraction_method: 'automatic_html_static', rate_slabs: [],
  }));
  fs.writeFileSync(targetPath, JSON.stringify({
    bank_code: 'x', extraction_method: 'manual_image_transcription', rate_slabs: [{}],
  }));
  const r = safeCopyArtifact({ sourcePath, targetPath, kind: 'rates', source: 'agent', logger: silentLogger });
  assert.equal(r.deferredToPending, true);
  // Curated target preserved
  const dst = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  assert.equal(dst.extraction_method, 'manual_image_transcription');
});

test('safeCopyArtifact passes-through non-JSON files (.log, .trace.jsonl)', () => {
  const dir = makeDir();
  const sourcePath = path.join(dir, 'x.log');
  const targetPath = path.join(dir, 'copy.log');
  fs.writeFileSync(sourcePath, 'plain text log line\n');
  const r = safeCopyArtifact({ sourcePath, targetPath, kind: 'summary', source: 'agent' });
  assert.equal(r.wrote, true);
  assert.equal(r.reason, 'non-json-passthrough');
  assert.equal(fs.readFileSync(targetPath, 'utf-8'), 'plain text log line\n');
});

test('safeCopyArtifact returns source-missing when source doesn\'t exist', () => {
  const dir = makeDir();
  const r = safeCopyArtifact({
    sourcePath: path.join(dir, 'nonexistent.json'),
    targetPath: path.join(dir, 'target.json'),
    kind: 'config',
    source: 'agent',
    logger: silentLogger,
  });
  assert.equal(r.wrote, false);
  assert.equal(r.reason, 'source-missing');
});

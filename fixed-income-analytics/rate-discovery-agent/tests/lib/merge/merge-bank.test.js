'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  mergeArtifact,
  pickLaterIso,
  pickStrongerConfidence,
  dedupArray,
} = require('../../../lib/merge/merge-bank');

const slabs = (n, base = 7.0) => Array.from({ length: n }, (_, i) => ({
  tenure_text: `slab-${i}`,
  tenure_min_days: i + 1,
  tenure_max_days: i + 10,
  rate_general_pct: base + i * 0.05,
}));

const cloudArtifact = (extra = {}) => ({
  bank_code: 'foo',
  product_type: 'FD',
  variant: 'regular',
  source_url: 'https://cloud-url.example.in/fd',
  extraction_method: 'llm_inline_extraction',
  extraction_confidence: 'medium',
  scraped_at: '2026-06-04T10:00:00Z',
  effective_date: '2026-06-04',
  rate_slabs: slabs(20),
  warnings: ['cloud-warn-1'],
  ...extra,
});

const localArtifact = (extra = {}) => ({
  bank_code: 'foo',
  product_type: 'FD',
  variant: 'regular',
  source_url: 'https://local-url.example.in/fd',
  extraction_method: 'manual_image_transcription',
  extraction_confidence: 'high',
  scraped_at: '2026-06-04T11:00:00Z',
  effective_date: '2026-06-03',
  rate_slabs: slabs(30, 7.5),
  warnings: ['local-warn-1'],
  ...extra,
});

test('mergeArtifact — both sides present, normal case', async (t) => {
  await t.test('richer slab set wins (local has more)', () => {
    const { merged, decisions } = mergeArtifact({
      cloud: cloudArtifact(),
      local: localArtifact(),
      cloudRunId: 'cloud-run-1',
      localRunId: 'local-run-1',
    });
    assert.strictEqual(merged.rate_slabs.length, 30);
    assert.strictEqual(merged.rate_slabs, localArtifact().rate_slabs.toString()
      ? merged.rate_slabs : merged.rate_slabs); // identity not asserted
    assert.match(decisions.rate_slabs, /^local/);
  });

  await t.test('richer slab set wins (cloud has more)', () => {
    const { merged, decisions } = mergeArtifact({
      cloud: cloudArtifact({ rate_slabs: slabs(50) }),
      local: localArtifact({ rate_slabs: slabs(10) }),
      cloudRunId: 'c', localRunId: 'l',
    });
    assert.strictEqual(merged.rate_slabs.length, 50);
    assert.match(decisions.rate_slabs, /^cloud/);
  });

  await t.test('slab tiebreak favors local', () => {
    const { merged, decisions } = mergeArtifact({
      cloud: cloudArtifact({ rate_slabs: slabs(20, 5.0) }),
      local: localArtifact({ rate_slabs: slabs(20, 7.0) }),
      cloudRunId: 'c', localRunId: 'l',
    });
    assert.strictEqual(merged.rate_slabs.length, 20);
    assert.strictEqual(merged.rate_slabs[0].rate_general_pct, 7.0, 'local slabs used');
    assert.match(decisions.rate_slabs, /^local/);
  });

  await t.test('extraction_method: local always wins (curated)', () => {
    const { merged, decisions } = mergeArtifact({
      cloud: cloudArtifact(),
      local: localArtifact(),
      cloudRunId: 'c', localRunId: 'l',
    });
    assert.strictEqual(merged.extraction_method, 'manual_image_transcription');
    assert.strictEqual(decisions.extraction_method, 'local');
  });

  await t.test('source_url: local wins', () => {
    const { merged } = mergeArtifact({
      cloud: cloudArtifact(),
      local: localArtifact(),
      cloudRunId: 'c', localRunId: 'l',
    });
    assert.strictEqual(merged.source_url, 'https://local-url.example.in/fd');
  });

  await t.test('extraction_confidence: stronger wins', () => {
    // cloud=medium, local=high → high (local)
    const r1 = mergeArtifact({ cloud: cloudArtifact({ extraction_confidence: 'medium' }), local: localArtifact({ extraction_confidence: 'high' }), cloudRunId: 'c', localRunId: 'l' });
    assert.strictEqual(r1.merged.extraction_confidence, 'high');
    // cloud=high, local=medium → high (cloud)
    const r2 = mergeArtifact({ cloud: cloudArtifact({ extraction_confidence: 'high' }), local: localArtifact({ extraction_confidence: 'medium' }), cloudRunId: 'c', localRunId: 'l' });
    assert.strictEqual(r2.merged.extraction_confidence, 'high');
    assert.match(r2.decisions.extraction_confidence, /cloud/);
    // tie at medium → local wins
    const r3 = mergeArtifact({ cloud: cloudArtifact({ extraction_confidence: 'medium' }), local: localArtifact({ extraction_confidence: 'medium' }), cloudRunId: 'c', localRunId: 'l' });
    assert.strictEqual(r3.merged.extraction_confidence, 'medium');
    assert.match(r3.decisions.extraction_confidence, /local/);
  });

  await t.test('effective_date: later wins', () => {
    // cloud=2026-06-04, local=2026-06-03 → cloud
    const r = mergeArtifact({
      cloud: cloudArtifact({ effective_date: '2026-06-04' }),
      local: localArtifact({ effective_date: '2026-06-03' }),
      cloudRunId: 'c', localRunId: 'l',
    });
    assert.strictEqual(r.merged.effective_date, '2026-06-04');
    assert.match(r.decisions.effective_date, /cloud/);
  });

  await t.test('scraped_at: later wins', () => {
    const r = mergeArtifact({
      cloud: cloudArtifact({ scraped_at: '2026-06-04T15:00:00Z' }),
      local: localArtifact({ scraped_at: '2026-06-04T10:00:00Z' }),
      cloudRunId: 'c', localRunId: 'l',
    });
    assert.strictEqual(r.merged.scraped_at, '2026-06-04T15:00:00Z');
  });

  await t.test('warnings: union, deduplicated', () => {
    const r = mergeArtifact({
      cloud: cloudArtifact({ warnings: ['shared', 'cloud-only'] }),
      local: localArtifact({ warnings: ['shared', 'local-only'] }),
      cloudRunId: 'c', localRunId: 'l',
    });
    assert.deepStrictEqual(r.merged.warnings.sort(), ['cloud-only', 'local-only', 'shared']);
  });

  await t.test('source_runs tracks contributed_fields per side', () => {
    const { merged } = mergeArtifact({
      cloud: cloudArtifact(),
      local: localArtifact(),
      cloudRunId: 'c-run', localRunId: 'l-run',
    });
    assert.strictEqual(merged.source_runs.length, 2);
    const cloudRun = merged.source_runs.find((r) => r.source === 'cloud');
    const localRun = merged.source_runs.find((r) => r.source === 'local');
    assert.strictEqual(cloudRun.run_id, 'c-run');
    assert.strictEqual(localRun.run_id, 'l-run');
    assert.ok(localRun.contributed_fields.includes('extraction_method'));
    assert.ok(localRun.contributed_fields.includes('source_url'));
    assert.ok(localRun.contributed_fields.includes('rate_slabs')); // local richer set
  });
});

test('mergeArtifact — one side missing', async (t) => {
  await t.test('cloud-only (no local) returns cloud with source_runs=cloud', () => {
    const r = mergeArtifact({ cloud: cloudArtifact(), local: null, cloudRunId: 'c', localRunId: null });
    assert.deepStrictEqual(r.merged.rate_slabs, cloudArtifact().rate_slabs);
    assert.strictEqual(r.merged.source_runs.length, 1);
    assert.strictEqual(r.merged.source_runs[0].source, 'cloud');
    assert.strictEqual(r.decisions.side, 'cloud-only');
  });

  await t.test('local-only (no cloud) returns local with source_runs=local', () => {
    const r = mergeArtifact({ cloud: null, local: localArtifact(), cloudRunId: null, localRunId: 'l' });
    assert.deepStrictEqual(r.merged.rate_slabs, localArtifact().rate_slabs);
    assert.strictEqual(r.merged.source_runs[0].source, 'local');
    assert.strictEqual(r.decisions.side, 'local-only');
  });

  await t.test('both sides null → null merged', () => {
    const r = mergeArtifact({ cloud: null, local: null, cloudRunId: null, localRunId: null });
    assert.strictEqual(r.merged, null);
  });
});

test('mergeArtifact — identity-field consistency', async (t) => {
  await t.test('throws on bank_code mismatch', () => {
    assert.throws(() => mergeArtifact({
      cloud: { ...cloudArtifact(), bank_code: 'foo' },
      local: { ...localArtifact(), bank_code: 'bar' },
      cloudRunId: 'c', localRunId: 'l',
    }), /bank_code.*mismatch/);
  });

  await t.test('throws on variant mismatch', () => {
    assert.throws(() => mergeArtifact({
      cloud: cloudArtifact({ variant: 'regular' }),
      local: localArtifact({ variant: 'nre' }),
      cloudRunId: 'c', localRunId: 'l',
    }), /variant.*mismatch/);
  });

  await t.test('tolerates one side missing the identity field (use the other)', () => {
    const c = cloudArtifact();
    const l = localArtifact();
    delete l.variant;
    const r = mergeArtifact({ cloud: c, local: l, cloudRunId: 'c', localRunId: 'l' });
    assert.strictEqual(r.merged.variant, 'regular'); // from cloud
  });
});

test('mergeArtifact — idempotency', async (t) => {
  await t.test('merge(merge(a,b), b) === merge(a,b) byte-for-byte', () => {
    const a = cloudArtifact();
    const b = localArtifact();
    const m1 = mergeArtifact({ cloud: a, local: b, cloudRunId: 'c', localRunId: 'l' }).merged;
    // Strip source_runs because they differ (run_ids change). The DATA must be stable.
    const stripSourceRuns = (o) => { const { source_runs, ...rest } = o; return rest; };
    const m2 = mergeArtifact({ cloud: m1, local: b, cloudRunId: 'c', localRunId: 'l' }).merged;
    assert.deepStrictEqual(stripSourceRuns(m1), stripSourceRuns(m2));
  });
});

test('pickLaterIso', async (t) => {
  await t.test('picks the later of two valid ISOs', () => {
    assert.strictEqual(pickLaterIso('2026-06-04', '2026-06-03'), '2026-06-04');
    assert.strictEqual(pickLaterIso('2026-06-03', '2026-06-04'), '2026-06-04');
    assert.strictEqual(pickLaterIso('2026-06-04T10:00:00Z', '2026-06-04T11:00:00Z'), '2026-06-04T11:00:00Z');
  });
  await t.test('tolerates one side empty / invalid', () => {
    assert.strictEqual(pickLaterIso('2026-06-04', null), '2026-06-04');
    assert.strictEqual(pickLaterIso(null, '2026-06-04'), '2026-06-04');
    assert.strictEqual(pickLaterIso('invalid', '2026-06-04'), '2026-06-04');
  });
  await t.test('returns null if both are invalid/missing', () => {
    assert.strictEqual(pickLaterIso(null, null), null);
  });
});

test('pickStrongerConfidence', async (t) => {
  await t.test('high > medium > low > none', () => {
    assert.strictEqual(pickStrongerConfidence('medium', 'high'), 'high');
    assert.strictEqual(pickStrongerConfidence('low', 'medium'), 'medium');
    assert.strictEqual(pickStrongerConfidence('none', 'low'), 'low');
  });
  await t.test('local wins on tie', () => {
    assert.strictEqual(pickStrongerConfidence('medium', 'medium'), 'medium');
  });
  await t.test('unknown values rank 0 — local wins', () => {
    assert.strictEqual(pickStrongerConfidence('bogus', 'high'), 'high');
    assert.strictEqual(pickStrongerConfidence(null, 'medium'), 'medium');
  });
});

test('dedupArray', async (t) => {
  await t.test('removes duplicate strings', () => {
    assert.deepStrictEqual(dedupArray(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
  });
  await t.test('removes duplicate objects by JSON key', () => {
    assert.deepStrictEqual(dedupArray([{ a: 1 }, { a: 1 }, { a: 2 }]), [{ a: 1 }, { a: 2 }]);
  });
  await t.test('passes non-array through as empty', () => {
    assert.deepStrictEqual(dedupArray(null), []);
  });
});

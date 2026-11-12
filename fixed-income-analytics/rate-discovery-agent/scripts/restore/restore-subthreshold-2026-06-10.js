#!/usr/bin/env node
// Recovery for the 29 sub-threshold regressed banks from the 550ptm4 cohort.
//
// Strategy:
//   Step A: git checkout HEAD -- for the 24 banks classified as head_full /
//           head_partial in subthreshold-audit-2026-06-10.json
//   Step B: reconstruct rate files for the 5 head_none banks from the
//           prev-pack snapshot at pack/dist/rates-pack.json (those slabs
//           were never committed; only the pack denormalization has them).
//
// Provenance: every reconstructed file gets a _reconstructed_from_pack
// block, and writes go through safeWriteArtifact with source='operator'.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { safeWriteArtifact } = require('../../lib/safe-write');

const ROOT = path.resolve(__dirname, '..', '..');
const LATEST = path.join(ROOT, 'output', 'latest');
const AUDIT = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'logs', 'sprint-010', 'subthreshold-audit-2026-06-10.json'), 'utf8'));
const PREV_PACK = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'pack', 'dist', 'rates-pack.json'), 'utf8'));

const VARIANT_FILE_SUFFIX = {
  regular: '_rates.json',
  nre: '_nre_rates.json',
  nro: '_nro_rates.json',
  fcnr: '_fcnr_rates.json',
  gift: '_gift_rates.json',
};

// ---------- Step A: git checkout HEAD for head_full + head_partial ----------

const headBanks = AUDIT.classifications.filter(c =>
  c.classification === 'head_full' || c.classification === 'head_partial');
const headFiles = [];
for (const c of headBanks) {
  for (const f of c.files) {
    // Only include files that exist in HEAD (head slab count >= 0 means we saw it)
    const headRel = `./output/latest/${f.file}`;
    try {
      execSync(`git cat-file -e HEAD:${headRel}`, { cwd: ROOT, stdio: 'ignore' });
      headFiles.push(headRel);
    } catch {
      // file not in HEAD; skip
    }
  }
}

console.log(`Step A — git checkout HEAD for ${headBanks.length} banks (${headFiles.length} files)`);
if (headFiles.length) {
  // chunk to avoid Windows command-line length limit
  const CHUNK = 30;
  for (let i = 0; i < headFiles.length; i += CHUNK) {
    const slice = headFiles.slice(i, i + CHUNK);
    execSync(`git checkout HEAD -- ${slice.map(s => `"${s}"`).join(' ')}`, { cwd: ROOT });
  }
  console.log(`  ✓ restored ${headFiles.length} files from HEAD`);
}

// ---------- Step B: reconstruct from prev pack for head_none ----------

const noneBanks = AUDIT.classifications.filter(c => c.classification === 'head_none');
console.log(`\nStep B — reconstruct from prev pack for ${noneBanks.length} banks`);

const prevPackBanks = new Map(PREV_PACK.banks.map(b => [b.bank_code, b]));
let reconstructedFiles = 0;
let reconstructedSlabs = 0;
for (const c of noneBanks) {
  const bank = prevPackBanks.get(c.bank_code);
  if (!bank) {
    console.log(`  ✗ ${c.bank_code}: not in prev pack — skipped`);
    continue;
  }
  const fd = bank.products?.fd || {};
  for (const variant of Object.keys(fd)) {
    const v = fd[variant];
    if (!Array.isArray(v.slabs) || v.slabs.length === 0) continue;
    const suffix = VARIANT_FILE_SUFFIX[variant];
    if (!suffix) {
      console.log(`  ! ${c.bank_code}: unknown variant '${variant}' — skipped`);
      continue;
    }
    const file = `${c.bank_code}${suffix}`;
    const filePath = path.join(LATEST, file);

    // Build a rate-file payload from the pack denormalization. Provenance
    // marker so future readers know this came from pack reconstruction.
    const payload = {
      bank_code: c.bank_code,
      scraped_at: v.scraped_at || null,
      source_url: v.source_url || null,
      effective_date: v.effective_date || null,
      extraction_method: v.extraction_method || 'reconstructed_from_pack',
      extraction_confidence: v.extraction_confidence || 'medium',
      run_method: v.run_method || null,
      stale: !!v.stale,
      rate_slabs: v.slabs,
      special_schemes: v.special_schemes || [],
      warnings: v.warnings || [],
      _reconstructed_from_pack: {
        recovered_at: new Date().toISOString(),
        recovered_from: 'pack/dist/rates-pack.json',
        prev_pack_generated_at: PREV_PACK.generated_at,
        reason: 'sub_threshold_regression_post_550ptm4_cohort',
      },
    };

    safeWriteArtifact({
      path: filePath,
      incoming: payload,
      kind: 'rates',
      source: 'operator',
    });
    reconstructedFiles++;
    reconstructedSlabs += v.slabs.length;
  }
}
console.log(`  ✓ reconstructed ${reconstructedFiles} files / ${reconstructedSlabs} slabs from prev pack`);

console.log('\nDone. Run `node pack/build-pack.js` to rebuild and verify totals.');

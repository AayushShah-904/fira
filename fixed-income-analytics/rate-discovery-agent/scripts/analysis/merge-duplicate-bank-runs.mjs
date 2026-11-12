#!/usr/bin/env node
// Two banks (Ahmedabad Mercantile, Zoroastrian) had a duplicate run under the
// LLM-emitted "the-..." slug AND under the seed-canonical slug. After
// pin-slugs-to-seed.mjs the rename collided, leaving both file sets in place.
// This script merges the unique-to-B fields into the canonical (A) files,
// then the operator should `git rm` the B files.

import { readFileSync, writeFileSync, existsSync } from "fs";

function loadIfExists(p) {
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function writeJson(p, j) {
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}

// ── Ahmedabad Mercantile ──────────────────────────────────────────
// A (canon): 11 slabs, no senior_pct, no warnings
// B (the-):  10 slabs, senior_pct on 5 long-tenure slabs, useful warnings
// Merge: copy B's senior_pct/super_senior_pct onto A's matching slabs;
//        copy B's warnings array onto A.
const aRatesPath = "output/latest/ahmedabad-mercantile-co-op-bank-ltd_rates.json";
const bRatesPath = "output/latest/the-ahmedabad-mercantile-co-operative-bank-ltd_rates.json";
const a = loadIfExists(aRatesPath);
const b = loadIfExists(bRatesPath);

if (a && b) {
  const bBySpan = new Map();
  for (const s of b.rate_slabs) bBySpan.set(`${s.tenure_min_days}-${s.tenure_max_days}`, s);

  let merged = 0;
  for (const aSlab of a.rate_slabs) {
    const key = `${aSlab.tenure_min_days}-${aSlab.tenure_max_days}`;
    const bSlab = bBySpan.get(key);
    if (!bSlab) continue;
    if (bSlab.rate_senior_pct != null && aSlab.rate_senior_pct == null) {
      aSlab.rate_senior_pct = bSlab.rate_senior_pct;
      merged++;
    }
    if (bSlab.rate_super_senior_pct != null && aSlab.rate_super_senior_pct == null) {
      aSlab.rate_super_senior_pct = bSlab.rate_super_senior_pct;
    }
  }

  if (Array.isArray(b.warnings) && b.warnings.length > 0 && (!a.warnings || a.warnings.length === 0)) {
    a.warnings = b.warnings;
  }

  writeJson(aRatesPath, a);
  console.log(`MERGE ahmedabad: copied senior_pct onto ${merged} slabs + ${b.warnings.length} warnings`);
} else {
  console.log(`SKIP  ahmedabad: a=${!!a} b=${!!b}`);
}

// ── Zoroastrian Co-operative ──────────────────────────────────────
// A (canon): 12 slabs, effective_date=null
// B (the-):  10 slabs, effective_date=2025-06-16, source_url present
// Merge: copy effective_date and source_url onto A if A lacks them.
const azPath = "output/latest/zoroastrian-co-operative-bank-ltd_rates.json";
const bzPath = "output/latest/the-zoroastrian-co-operative-bank-ltd_rates.json";
const az = loadIfExists(azPath);
const bz = loadIfExists(bzPath);

if (az && bz) {
  const before = { effective_date: az.effective_date, source_url: az.source_url };
  if (!az.effective_date && bz.effective_date) az.effective_date = bz.effective_date;
  if (!az.source_url && bz.source_url) az.source_url = bz.source_url;
  writeJson(azPath, az);
  console.log(`MERGE zoroastrian: effective_date ${before.effective_date} → ${az.effective_date}`);
} else {
  console.log(`SKIP  zoroastrian: a=${!!az} b=${!!bz}`);
}

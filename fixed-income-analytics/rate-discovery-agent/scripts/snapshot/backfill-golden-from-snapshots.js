#!/usr/bin/env node
'use strict';
//
// Activate the dormant golden gate from Phase-1 snapshots (Sprint 008, Phase 6).
//
// For each tests/golden-html/<bank>.expected.json that has a registry template
// AND an HTML snapshot, write the <bank>.html companion so the live golden
// assertion in tests/extractors/golden.test.js fires. To keep CI green and
// honest, a companion is written ONLY when the CURRENT template extraction over
// that HTML still reproduces the committed expected.json within tolerance — i.e.
// the bank has not drifted. Drifted / structurally-flagged banks are reported
// and left skipped (no fixture rewrite) unless --rebaseline is given.
//
// Usage:
//   node scripts/snapshot/backfill-golden-from-snapshots.js [--rebaseline] [--write]
//   (default: dry analysis; --write writes the .html companions + pins)

const fs = require('node:fs');
const path = require('node:path');
const { pickExtractor } = require('../../lib/extractors/dispatch.js');
const { runStructuralChecks } = require('../../lib/checks/structural-checks.js');
const store = require('../../lib/snapshot/snapshot-store.js');

const REPO = path.resolve(__dirname, '..', '..');
const GD = path.join(REPO, 'tests', 'golden-html');
const PINS = path.join(REPO, 'output', 'snapshots', 'golden-pins.json');
const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'bank-domains.json'), 'utf-8'));

const SLAB_TOL = 2;
const BPS_TOL = 5;
const KEY_DAYS = { '1y': 365, '2y': 730, '3y': 1095, '5y': 1825 };

function loadJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }
function rateAt(slabs, days) {
  for (const s of slabs) if (s.tenure_min_days != null && s.tenure_max_days != null && s.tenure_min_days <= days && days <= s.tenure_max_days) return s.rate_general_pct;
  for (const s of slabs) if (s.tenure_min_days === days) return s.rate_general_pct;
  return null;
}

function listFixtures() {
  return fs.readdirSync(GD).filter((f) => f.endsWith('.expected.json') && !f.includes('regression-cases')).map((f) => f.slice(0, -'.expected.json'.length));
}

function extractWith(bank, html, meta) {
  const tpl = reg[bank] && reg[bank].template;
  // The dispatcher resolves the EXTRACTOR MODULE name (template.extract.extractor,
  // e.g. _generic-html-3col), not the per-bank fingerprint template_id.
  const templateId = tpl && tpl.extract && tpl.extract.extractor;
  if (!templateId) return { ok: false, reason: 'no_extractor_module' };
  const dispatch = pickExtractor({ templateId, kind: 'html_static', productContext: { bank_code: bank, bank_type: meta && meta.bank_type } });
  if (!dispatch.extractor) return { ok: false, reason: `no_extractor:${dispatch.resolution}` };
  const companion = loadJsonSafe(path.join(GD, `${bank}.expected.extract.json`));
  const templateExtract = companion || (tpl && tpl.extract) || {};
  try {
    const result = dispatch.extractor({ html, templateExtract, productContext: { bank_code: bank, bank_type: meta && meta.bank_type } });
    return { ok: true, slabs: result.slabs || [] };
  } catch (err) { return { ok: false, reason: `extract_error:${(err.message || '').slice(0, 80)}` }; }
}

function matches(expected, slabs) {
  if (Math.abs(slabs.length - expected.slab_count) > SLAB_TOL) return { ok: false, why: `slab_count ${slabs.length} vs ${expected.slab_count}` };
  if (expected.key_rates) {
    for (const [label, er] of Object.entries(expected.key_rates)) {
      if (!er || er.general == null) continue;
      const days = KEY_DAYS[label]; if (!days) continue;
      const actual = rateAt(slabs, days);
      if (actual == null) continue;
      if (Math.abs(actual - er.general) * 100 > BPS_TOL) return { ok: false, why: `${label} ${actual} vs ${er.general}` };
    }
  }
  return { ok: true };
}

function main() {
  const rebaseline = process.argv.includes('--rebaseline');
  const write = process.argv.includes('--write') || rebaseline;
  const fixtures = listFixtures();
  const pins = new Set(loadJsonSafe(PINS) || []);
  const tally = { activated: 0, already: 0, rebaselined: 0, drift: 0, flagged: 0, no_snapshot: 0, no_template: 0, not_html: 0, extract_fail: 0 };
  const report = [];

  for (const bank of fixtures) {
    const expected = loadJsonSafe(path.join(GD, `${bank}.expected.json`));
    const meta = loadJsonSafe(path.join(GD, `${bank}.expected.meta.json`));
    const snap = store.getLatestSnapshot(bank, 'regular');
    if (!snap) { tally.no_snapshot++; continue; }
    if (snap.content_kind !== 'html') { tally.not_html++; report.push(`${bank}: snapshot is ${snap.content_kind} (PDF arm not wired)`); continue; }
    if (!(reg[bank] && reg[bank].template && reg[bank].template.extract && reg[bank].template.extract.extractor)) { tally.no_template++; continue; }

    const html = store.readBlob(snap).toString('utf-8');
    const ex = extractWith(bank, html, meta);
    if (!ex.ok) { tally.extract_fail++; report.push(`${bank}: ${ex.reason}`); continue; }

    const structural = runStructuralChecks(ex.slabs, { variant: 'regular', bankType: meta && meta.bank_type });
    const blocking = structural.filter((i) => i.severity === 'ANOMALY');
    const m = matches(expected, ex.slabs);

    if (m.ok) {
      const htmlPath = path.join(GD, `${bank}.html`);
      const exists = fs.existsSync(htmlPath);
      tally.activated++;
      if (exists) tally.already++;
      if (write && !exists) {
        // safe-write-exempt: golden test fixture HTML companion under tests/golden-html/, not a per-bank canonical artifact.
        fs.writeFileSync(htmlPath, html);
        pins.add(snap.blob_sha256);
      } else if (exists) {
        pins.add(snap.blob_sha256); // keep the curated companion; just pin its snapshot
      }
    } else if (blocking.length) {
      tally.flagged++; report.push(`${bank}: structurally flagged (${blocking.map((b) => b.check).join(',')}) — NOT activated`);
    } else if (rebaseline) {
      // re-baseline a clean-but-drifted bank: html+expected become a matched pair
      const newExpected = { ...expected, slab_count: ex.slabs.length, key_rates: {} };
      for (const [label, days] of Object.entries(KEY_DAYS)) { const r = rateAt(ex.slabs, days); if (r != null) newExpected.key_rates[label] = { general: r }; }
      newExpected.rebaselined_at = new Date().toISOString().slice(0, 10);
      // safe-write-exempt: golden expected fixture (test data) under tests/golden-html/, operator-gated --rebaseline.
      fs.writeFileSync(path.join(GD, `${bank}.expected.json`), JSON.stringify(newExpected, null, 2));
      // safe-write-exempt: golden test fixture HTML companion under tests/golden-html/.
      fs.writeFileSync(path.join(GD, `${bank}.html`), html);
      pins.add(snap.blob_sha256);
      tally.rebaselined++; report.push(`${bank}: REBASELINED (${m.why})`);
    } else {
      tally.drift++; report.push(`${bank}: drift (${m.why}) — left skipped (use --rebaseline to refresh)`);
    }
  }

  if (write) {
    fs.mkdirSync(path.dirname(PINS), { recursive: true });
    // safe-write-exempt: golden pin list under output/snapshots/, retention metadata not a per-bank artifact.
    fs.writeFileSync(PINS, JSON.stringify([...pins], null, 2));
  }

  console.log(`backfill-golden: ${fixtures.length} fixtures | activated ${tally.activated} (already ${tally.already}, newly ${tally.activated - tally.already})${write ? ' .html written' : ' — dry, pass --write'} | rebaselined ${tally.rebaselined} | drift ${tally.drift} | flagged ${tally.flagged} | no_snapshot ${tally.no_snapshot} | no_template ${tally.no_template} | not_html ${tally.not_html} | extract_fail ${tally.extract_fail}`);
  for (const r of report.slice(0, 40)) console.log('  ' + r);
}

if (require.main === module) main();

module.exports = { matches, rateAt };

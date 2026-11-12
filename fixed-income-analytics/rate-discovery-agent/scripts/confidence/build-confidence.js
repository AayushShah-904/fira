#!/usr/bin/env node
'use strict';
//
// Build per-variant confidence sidecars (Sprint 008, Phase 5).
//
// Computes the confidence signals for every output/latest variant and writes
// output/latest/_confidence/<bank>__<variant>.json. pack/build-pack.js reads
// these (behind BIRD_EMIT_CONFIDENCE) so the pack build itself stays LLM-free.
//
// Signals: structural checks (Phase 3), freshness (effective_date age),
// extraction method (registry), and — when present — the latest cross-check
// agreement (Phase 4) and the latest sampling-audit per-stratum error rate
// (Phase 2). Missing optional signals are simply omitted (treated as unknown).
//
// Usage: node scripts/confidence/build-confidence.js [--only slug,slug]

const fs = require('node:fs');
const path = require('node:path');
const { runStructuralChecks, computePeerStats } = require('../../lib/checks/structural-checks.js');
const { computeVariantConfidence } = require('../../lib/confidence/score.js');
const { classifyExtraction, slugAndVariant } = require('../audit/sample-correctness-audit.js');

const REPO = path.resolve(__dirname, '..', '..');
const LATEST = path.join(REPO, 'output', 'latest');
const CONF_DIR = path.join(LATEST, '_confidence');
const AUDIT_ROOT = path.join(REPO, 'output', 'audit');
const STALE_MONTHS = 18;

function loadJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }

function bankTypeOf(slug, cache) {
  if (cache.has(slug)) return cache.get(slug);
  let bt = null;
  try { bt = JSON.parse(fs.readFileSync(path.join(LATEST, `${slug}_config.json`), 'utf-8')).bank_type || null; } catch { /* none */ }
  cache.set(slug, bt); return bt;
}

// Most-recent cross-check.json → map of `bank|variant` → agreement.
function loadCrossCheck() {
  const map = new Map();
  if (!fs.existsSync(AUDIT_ROOT)) return map;
  const dirs = fs.readdirSync(AUDIT_ROOT).filter((d) => d.startsWith('crosscheck-')).sort();
  if (!dirs.length) return map;
  const cc = loadJsonSafe(path.join(AUDIT_ROOT, dirs[dirs.length - 1], 'cross-check.json'));
  for (const r of (cc && cc.results) || []) map.set(`${r.bank_code}|${r.variant}`, r.agreement);
  return map;
}

// Most-recent audit summary.json → map of stratum `bank_type | class` → error_rate.
function loadAuditErrorRates() {
  const map = new Map();
  if (!fs.existsSync(AUDIT_ROOT)) return map;
  const dirs = fs.readdirSync(AUDIT_ROOT).filter((d) => /^\d{4}-/.test(d)).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const sum = loadJsonSafe(path.join(AUDIT_ROOT, dirs[i], 'summary.json'));
    if (sum && Array.isArray(sum.strata)) { for (const s of sum.strata) map.set(s.stratum, s.error_rate); return map; }
  }
  return map;
}

function main() {
  const onlyArg = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'bank-domains.json'), 'utf-8'));
  const btCache = new Map();
  const crossCheck = loadCrossCheck();
  const auditErr = loadAuditErrorRates();

  const files = fs.readdirSync(LATEST).filter((f) => f.endsWith('_rates.json'));

  // peer stats for senior-premium outlier: build a banks-like array of regular variants
  const peerInput = [];
  for (const f of files) {
    const { slug, variant } = slugAndVariant(f);
    if (variant !== 'regular') continue;
    const d = loadJsonSafe(path.join(LATEST, f));
    if (d && Array.isArray(d.rate_slabs) && d.rate_slabs.length) peerInput.push({ bank_type: bankTypeOf(slug, btCache), products: { fd: { regular: { slabs: d.rate_slabs } } } });
  }
  const peerStats = computePeerStats(peerInput);

  fs.mkdirSync(CONF_DIR, { recursive: true });
  const now = new Date();
  const staleCut = new Date(now); staleCut.setMonth(staleCut.getMonth() - STALE_MONTHS);
  let written = 0; const tierCounts = { verified: 0, needs_review: 0 };

  for (const f of files) {
    const { slug, variant } = slugAndVariant(f);
    if (onlyArg && !onlyArg.has(slug)) continue;
    const d = loadJsonSafe(path.join(LATEST, f));
    if (!d || !Array.isArray(d.rate_slabs) || d.rate_slabs.length === 0) continue;
    const bankType = bankTypeOf(slug, btCache);
    const cls = classifyExtraction(reg[slug], d);

    const structural = runStructuralChecks(d.rate_slabs, { variant, bankType, peerStats: peerStats[bankType] });
    const structuralBlocking = structural.filter((i) => i.severity === 'ANOMALY').length;
    const structuralWarnings = structural.filter((i) => i.severity === 'WARN').length;

    let stale = false;
    if (typeof d.effective_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.effective_date) && new Date(d.effective_date) < staleCut) stale = true;

    const signals = {
      extractionMethod: cls,
      crossCheckAgreement: crossCheck.get(`${slug}|${variant}`) || null,
      structuralBlocking, structuralWarnings, stale,
      measuredMethodErrorRate: auditErr.has(`${bankType} | ${cls}`) ? auditErr.get(`${bankType} | ${cls}`) : null,
    };
    const conf = computeVariantConfidence(signals);
    tierCounts[conf.tier]++;

    const sidecar = { bank_code: slug, variant, ...conf, signals, generated_at: now.toISOString() };
    // safe-write-exempt: confidence sidecar under output/latest/_confidence/, derived aggregator artifact (not a per-bank rate/config file).
    fs.writeFileSync(path.join(CONF_DIR, `${slug}__${variant}.json`), JSON.stringify(sidecar, null, 2));
    written++;
  }

  console.log(`build-confidence: wrote ${written} sidecars to output/latest/_confidence/`);
  console.log(`  tiers: verified ${tierCounts.verified}, needs_review ${tierCounts.needs_review}`);
  console.log(`  signals used: cross-check ${crossCheck.size ? 'yes' : 'no'}, audit error-rates ${auditErr.size ? 'yes' : 'no'}`);
}

if (require.main === module) main();

module.exports = { loadCrossCheck, loadAuditErrorRates };

#!/usr/bin/env node
'use strict';

/**
 * Phase 4 — refresh report.
 *
 * Reads the refresh run's signals + diffs + extraction summary and writes
 * `report.md` (operator/PM facing) and `report.json` (machine-readable for
 * pack/build-pack.js or downstream tooling).
 *
 * Run:
 *   node scripts/refresh/report.js
 *   node scripts/refresh/report.js --run-ts 2026-05-13T17-29-11
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REFRESH_ROOT = path.join(REPO_ROOT, 'output', 'refresh');

const BANK_TYPE_ORDER = [
  'PSB', 'PVB', 'SFB', 'PB', 'FB', 'IBU',
  'RRB', 'SUCB', 'NSUCB', 'SSCB', 'NSSCB', 'DCCB',
  'LAB', 'FI', 'HFC', 'UNKNOWN',
];

function parseArgs(argv) {
  const args = { runTs: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--run-ts') args.runTs = argv[++i];
  }
  return args;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function resolveRunTs(explicit) {
  if (explicit) return explicit;
  const pointer = path.join(REFRESH_ROOT, 'latest', '_run_ts.txt');
  if (fs.existsSync(pointer)) return fs.readFileSync(pointer, 'utf-8').trim();
  throw new Error('No run-ts and no latest pointer.');
}

function bankTypeRank(t) {
  const i = BANK_TYPE_ORDER.indexOf(t || 'UNKNOWN');
  return i === -1 ? BANK_TYPE_ORDER.length : i;
}

function loadAllDiffs(diffsDir) {
  if (!fs.existsSync(diffsDir)) return [];
  return fs.readdirSync(diffsDir)
    .filter((f) => f.endsWith('.diff.json'))
    .map((f) => readJsonSafe(path.join(diffsDir, f)))
    .filter(Boolean);
}

function loadGating(runDir) {
  const susPath = path.join(runDir, '_suspicious.json');
  const llmPath = path.join(runDir, '_llm_verification.json');
  const sus = readJsonSafe(susPath);
  const llm = readJsonSafe(llmPath);
  const heldBack = new Map();
  if (sus && Array.isArray(sus.suspicious)) {
    for (const s of sus.suspicious) heldBack.set(`${s.bank_code}::${s.variant}`, 'sanity_flagged');
  }
  if (llm && Array.isArray(llm.results)) {
    for (const r of llm.results) {
      if (!r || !r.entry) continue;
      const key = `${r.entry.bank_code}::${r.entry.variant}`;
      if (r.outcome === 'LLM_REPLACED' || r.outcome === 'LLM_CONFIRMS') heldBack.delete(key);
      else if (r.outcome === 'LLM_STILL_SUSPICIOUS') heldBack.set(key, 'llm_still_suspicious');
      else if (r.outcome === 'LLM_REJECTED') heldBack.set(key, 'llm_rejected');
      else if (r.outcome === 'LLM_NO_DATA') heldBack.set(key, 'llm_no_data');
      else if (r.outcome === 'SKIPPED') heldBack.set(key, 'llm_skipped');
    }
  }
  return { heldBack };
}

function partition(diffs, gating) {
  const updated = [];     // verified — slab delta OR newer ED, NOT held back
  const heldBack = [];    // sanity gate flagged & LLM didn't clear them
  const noChange = [];    // candidate extracted, no slab delta
  const failed = [];      // extraction yielded 0 slabs

  for (const d of diffs) {
    const summary = d.diff && d.diff.summary;
    const slabsNext = summary ? summary.slabs_next : 0;
    const slabsDelta = summary ? (summary.slabs_added + summary.slabs_removed + summary.slabs_changed) : 0;
    const newerEd =
      d.candidate_effective_date && d.stored_effective_date &&
      d.candidate_effective_date > d.stored_effective_date;
    const key = `${d.bank_code}::${d.variant}`;
    const isHeld = gating && gating.heldBack && gating.heldBack.has(key);
    if (slabsNext === 0) { failed.push(d); continue; }
    if (isHeld) { heldBack.push({ ...d, held_reason: gating.heldBack.get(key) }); continue; }
    if (slabsDelta > 0 || newerEd) { updated.push(d); continue; }
    noChange.push(d);
  }
  return { updated, heldBack, noChange, failed };
}

function formatChangeRow(c) {
  const tenure = c.tenure_text || `${c.tenure_min_days || '?'}–${c.tenure_max_days || '?'}d`;
  const cc = c.currency ? `[${c.currency}] ` : '';
  const parts = [];
  for (const field of ['rate_general_pct', 'rate_senior_pct', 'rate_super_senior_pct']) {
    const ch = c.changes && c.changes[field];
    if (!ch) continue;
    const oldV = ch.old == null ? '–' : ch.old.toFixed(2);
    const newV = ch.new == null ? '–' : ch.new.toFixed(2);
    const bps = ch.delta_bps;
    const arrow = bps == null ? '' : bps > 0 ? `+${bps}bps` : `${bps}bps`;
    const label = field === 'rate_general_pct' ? 'gen' : field === 'rate_senior_pct' ? 'sr' : 'ssr';
    parts.push(`${label}: ${oldV}% → ${newV}% (${arrow})`);
  }
  return `${cc}${tenure} — ${parts.join('; ') || 'no rate change'}`;
}

function topMovers(updated, n = 15) {
  const flat = [];
  for (const d of updated) {
    for (const c of (d.diff && d.diff.changed) || []) {
      const general = c.changes && c.changes.rate_general_pct;
      if (!general || general.delta_bps == null) continue;
      flat.push({
        bank: d.bank_code,
        variant: d.variant,
        bank_type: d.bank_type,
        tenure: c.tenure_text,
        currency: c.currency || null,
        delta_bps: general.delta_bps,
        old: general.old,
        new: general.new,
      });
    }
  }
  flat.sort((a, b) => Math.abs(b.delta_bps) - Math.abs(a.delta_bps));
  return flat.slice(0, n);
}

function unreachableSummary(records) {
  const out = [];
  for (const r of records) {
    if (r.status !== 'unreachable') continue;
    out.push({
      bank: r.bank_code,
      variant: r.variant,
      bank_type: r.bank_type,
      reason: r.reason,
      source_url: r.source_url,
    });
  }
  return out;
}

function renderMarkdown({ runTs, signals, summary, partition, movers, unreachable, promotePlan }) {
  const lines = [];
  lines.push(`# Refresh report — ${runTs}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // ── Summary ───────────────────────────────────────────────
  lines.push('## Summary');
  lines.push('');
  lines.push('| Bucket | Count |');
  lines.push('|---|---:|');
  lines.push(`| Pairs in cohort | ${summary.cohort_pairs} |`);
  lines.push(`| Unchanged (no fetch-side delta) | ${summary.signal_status.unchanged || 0} |`);
  lines.push(`| Likely changed | ${summary.signal_status.likely_changed || 0} |`);
  lines.push(`| First-time check (signals_missing) | ${summary.signal_status.signals_missing || 0} |`);
  lines.push(`| Needs Playwright | ${summary.signal_status.needs_playwright || 0} |`);
  lines.push(`| Unreachable | ${summary.signal_status.unreachable || 0} |`);
  lines.push('');
  lines.push('After extraction + sanity gate + LLM verification:');
  lines.push('');
  lines.push('| Outcome | Count |');
  lines.push('|---|---:|');
  lines.push(`| **Verified updates** (safe to promote — variants counted separately) | **${partition.updated.length}** |`);
  lines.push(`| Held back — sanity gate or LLM flagged (manual review required) | ${partition.heldBack.length} |`);
  lines.push(`| Extracted, no rate change | ${partition.noChange.length} |`);
  lines.push(`| Extraction failed (0 slabs — existing rates preserved) | ${partition.failed.length} |`);
  lines.push('');
  if (promotePlan) {
    lines.push(`Promote plan: ${promotePlan.counts.will_promote} would promote, ${promotePlan.counts.skipped} skipped.`);
    lines.push('');
  }
  lines.push(`Across all updated pairs: **+${summary.total_added} added / -${summary.total_removed} removed / Δ${summary.total_changed} rate values changed**.`);
  lines.push('');

  // ── Top movers ────────────────────────────────────────────
  if (movers.length > 0) {
    lines.push('## Top movers (general FD rate)');
    lines.push('');
    lines.push('| Bank | Type | Variant | Tenure | Currency | Old → New | Δ |');
    lines.push('|---|---|---|---|---|---|---:|');
    for (const m of movers) {
      const sign = m.delta_bps > 0 ? `+${m.delta_bps}` : `${m.delta_bps}`;
      lines.push(`| ${m.bank} | ${m.bank_type || '–'} | ${m.variant} | ${m.tenure || ''} | ${m.currency || '–'} | ${m.old.toFixed(2)}% → ${m.new.toFixed(2)}% | ${sign}bps |`);
    }
    lines.push('');
  }

  // ── Updates by bank, grouped by bank_type ─────────────────
  lines.push('## Banks with rate updates');
  lines.push('');
  const byType = new Map();
  for (const d of partition.updated) {
    const t = d.bank_type || 'UNKNOWN';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(d);
  }
  const sortedTypes = [...byType.keys()].sort((a, b) => bankTypeRank(a) - bankTypeRank(b));
  for (const t of sortedTypes) {
    lines.push(`### ${t} (${byType.get(t).length} variant${byType.get(t).length === 1 ? '' : 's'})`);
    lines.push('');
    const rows = byType.get(t).slice().sort((a, b) => a.bank_code.localeCompare(b.bank_code) || a.variant.localeCompare(b.variant));
    for (const d of rows) {
      const s = d.diff.summary;
      const ed = d.candidate_effective_date || '–';
      const storedEd = d.stored_effective_date || '–';
      lines.push(`- **${d.bank_code}** \`${d.variant}\` — stored ED ${storedEd} → ${ed}, +${s.slabs_added}/-${s.slabs_removed}/Δ${s.slabs_changed}`);
      // Up to 5 illustrative changed rows
      const samples = (d.diff.changed || []).slice(0, 5);
      for (const c of samples) {
        lines.push(`  - ${formatChangeRow(c)}`);
      }
      if ((d.diff.changed || []).length > 5) {
        lines.push(`  - …and ${d.diff.changed.length - 5} more changed slab(s)`);
      }
    }
    lines.push('');
  }

  // ── Held back ─────────────────────────────────────────────
  if (partition.heldBack.length > 0) {
    lines.push(`## Held back (${partition.heldBack.length}) — manual review`);
    lines.push('');
    lines.push('Sanity gate flagged the deterministic candidate AND LLM verification could not produce a trustworthy alternative. Existing `output/latest/` rates are preserved.');
    lines.push('');
    const byReason = new Map();
    for (const d of partition.heldBack) {
      if (!byReason.has(d.held_reason)) byReason.set(d.held_reason, []);
      byReason.get(d.held_reason).push(d);
    }
    for (const [reason, list] of [...byReason.entries()].sort()) {
      lines.push(`### ${reason} (${list.length})`);
      lines.push('');
      const shown = list.slice().sort((a, b) => bankTypeRank(a.bank_type) - bankTypeRank(b.bank_type) || a.bank_code.localeCompare(b.bank_code));
      for (const d of shown) {
        lines.push(`- ${d.bank_type || '–'} **${d.bank_code}** \`${d.variant}\` — ${d.source_url || ''}`);
      }
      lines.push('');
    }
  }

  // ── Extraction failed ─────────────────────────────────────
  if (partition.failed.length > 0) {
    lines.push(`## Extraction failed (${partition.failed.length})`);
    lines.push('');
    lines.push('Body fetched and cached but extractor yielded 0 slabs — typically tables not in `<table>` form, paywall, or PDF parse glitch. Existing `output/latest/` rates preserved.');
    lines.push('');
    lines.push('| Bank | Type | Variant | Detection | Reason | URL |');
    lines.push('|---|---|---|---|---|---|');
    const failed = partition.failed.slice().sort((a, b) => bankTypeRank(a.bank_type) - bankTypeRank(b.bank_type) || a.bank_code.localeCompare(b.bank_code));
    for (const d of failed) {
      const warn = (d.warnings || [])[0] || '';
      lines.push(`| ${d.bank_code} | ${d.bank_type || '–'} | ${d.variant} | ${d.detection_status} | ${warn.replace(/\|/g, '\\|').slice(0, 80)} | ${d.source_url || ''} |`);
    }
    lines.push('');
  }

  // ── Unreachable ───────────────────────────────────────────
  if (unreachable.length > 0) {
    lines.push(`## Unreachable (${unreachable.length})`);
    lines.push('');
    const byReason = new Map();
    for (const u of unreachable) {
      if (!byReason.has(u.reason)) byReason.set(u.reason, []);
      byReason.get(u.reason).push(u);
    }
    for (const [reason, list] of [...byReason.entries()].sort()) {
      lines.push(`### ${reason} (${list.length})`);
      lines.push('');
      const shown = list.slice().sort((a, b) => bankTypeRank(a.bank_type) - bankTypeRank(b.bank_type) || a.bank.localeCompare(b.bank));
      for (const u of shown) {
        lines.push(`- ${u.bank_type || '–'} **${u.bank}** \`${u.variant}\` — ${u.source_url || '(no URL)'}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

function renderSummaryText({ runTs, summary, partition, movers }) {
  const out = [];
  out.push(`Refresh summary — ${runTs}`);
  out.push('='.repeat(60));
  out.push('');
  out.push(`Pairs in cohort:      ${summary.cohort_pairs}`);
  out.push(`Verified updates:     ${partition.updated.length}  (safe to promote)`);
  out.push(`  rate values changed:  ${summary.total_changed}`);
  out.push(`  slabs added:          ${summary.total_added}`);
  out.push(`  slabs removed:        ${summary.total_removed}`);
  out.push(`Held back:            ${partition.heldBack.length}  (sanity/LLM flagged — manual review)`);
  out.push(`Extracted, no change: ${partition.noChange.length}`);
  out.push(`Extraction failed:    ${partition.failed.length}  (0-slab; existing rates preserved)`);
  out.push(`Unreachable:          ${summary.signal_status.unreachable || 0}`);
  out.push('');
  out.push('Top movers (general FD rate, by absolute delta):');
  out.push('-'.repeat(60));
  for (const m of movers.slice(0, 15)) {
    const sign = m.delta_bps > 0 ? `+${m.delta_bps}` : `${m.delta_bps}`;
    const cur = m.currency ? `[${m.currency}] ` : '';
    out.push(`  ${(m.bank + '/' + m.variant).padEnd(48)} ${cur}${m.tenure || ''}: ${m.old.toFixed(2)}% -> ${m.new.toFixed(2)}% (${sign}bps)`);
  }
  out.push('');
  out.push('Updated banks by type:');
  out.push('-'.repeat(60));
  const byType = {};
  for (const d of partition.updated) {
    const t = d.bank_type || 'UNKNOWN';
    byType[t] = (byType[t] || 0) + 1;
  }
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${t.padEnd(8)} ${n}`);
  }
  out.push('');
  out.push('See report.txt for per-bank slab diffs and report.json for the machine-readable payload.');
  return out.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv);
  const runTs = resolveRunTs(args.runTs);
  const runDir = path.join(REFRESH_ROOT, runTs);

  const signals = readJsonSafe(path.join(runDir, '_change_signals.json'));
  if (!signals) throw new Error('Missing _change_signals.json — run detect-changes.js first.');
  const extractSummary = readJsonSafe(path.join(runDir, '_extract_summary.json'));
  if (!extractSummary) throw new Error('Missing _extract_summary.json — run extract-and-diff.js first.');
  const promotePlan = readJsonSafe(path.join(runDir, '_promote_plan.json'));

  const diffs = loadAllDiffs(path.join(runDir, 'diffs'));
  const gating = loadGating(runDir);
  const part = partition(diffs, gating);
  const movers = topMovers(part.updated, 20);
  const unreachable = unreachableSummary(signals.records);

  // Build flat summary numbers for the report header.
  const signalStatus = {};
  for (const r of signals.records) {
    signalStatus[r.status] = (signalStatus[r.status] || 0) + 1;
  }
  const totalAdded = part.updated.reduce((s, d) => s + d.diff.summary.slabs_added, 0);
  const totalRemoved = part.updated.reduce((s, d) => s + d.diff.summary.slabs_removed, 0);
  const totalChanged = part.updated.reduce((s, d) => s + d.diff.summary.slabs_changed, 0);
  const summary = {
    run_ts: runTs,
    cohort_pairs: signals.records.length,
    signal_status: signalStatus,
    extracted_ok: extractSummary.extracted_ok,
    zero_slab_count: part.failed.length,
    updated_count: part.updated.length,
    no_change_count: part.noChange.length,
    total_added: totalAdded,
    total_removed: totalRemoved,
    total_changed: totalChanged,
  };

  const md = renderMarkdown({ runTs, signals, summary, partition: part, movers, unreachable, promotePlan });
  // Write the long-form report as .txt — Norton's MD:HttpRequest heuristic
  // quarantines `.md` files with high URL density. Content is still
  // GFM-formatted; rename or `Open With` a markdown viewer for nice rendering.
  const reportPath = path.join(runDir, 'report.txt');
  // safe-write-exempt: refresh-pipeline operator-readable run report under runs/<ts>/; not a per-bank canonical write.
  fs.writeFileSync(reportPath, md);

  // Also emit a compact URL-free summary for at-a-glance reading.
  const summaryTxt = renderSummaryText({ runTs, summary, partition: part, movers });
  const summaryPath = path.join(runDir, 'summary.txt');
  // safe-write-exempt: refresh-pipeline operator-readable run summary under runs/<ts>/; not a per-bank canonical write.
  fs.writeFileSync(summaryPath, summaryTxt);

  const jsonPath = path.join(runDir, 'report.json');
  const reportJson = {
    summary,
    movers,
    updated: part.updated.map(d => ({
      bank_code: d.bank_code,
      bank_name: d.bank_name,
      bank_type: d.bank_type,
      variant: d.variant,
      stored_effective_date: d.stored_effective_date,
      candidate_effective_date: d.candidate_effective_date,
      slabs_added: d.diff.summary.slabs_added,
      slabs_removed: d.diff.summary.slabs_removed,
      slabs_changed: d.diff.summary.slabs_changed,
      changes: d.diff.changed,
    })),
    held_back: part.heldBack.map(d => ({
      bank_code: d.bank_code,
      bank_name: d.bank_name,
      bank_type: d.bank_type,
      variant: d.variant,
      held_reason: d.held_reason,
      source_url: d.source_url,
    })),
    extraction_failed: part.failed.map(d => ({
      bank_code: d.bank_code,
      bank_type: d.bank_type,
      variant: d.variant,
      detection_status: d.detection_status,
      source_url: d.source_url,
      warnings: d.warnings,
    })),
    unreachable,
  };
  // safe-write-exempt: refresh-pipeline machine-readable run report under runs/<ts>/; not a per-bank canonical write.
  fs.writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2) + '\n');

  console.log(`report: wrote ${reportPath}`);
  console.log(`report: wrote ${summaryPath}`);
  console.log(`report: wrote ${jsonPath}`);
  console.log(`  updated=${part.updated.length} no_change=${part.noChange.length} failed=${part.failed.length} unreachable=${unreachable.length}`);
  console.log(`  totals: +${totalAdded} / -${totalRemoved} / Δ${totalChanged}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('report: FAILED', err);
    process.exit(1);
  });
}

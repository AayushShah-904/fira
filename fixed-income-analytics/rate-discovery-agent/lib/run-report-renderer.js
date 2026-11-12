'use strict';

/**
 * Renders a `_run_analysis.json` payload into the operator-facing
 * `_run_report.md` markdown.
 *
 * Pure function — no fs access. Caller writes the returned string.
 *
 * Spec: sdlc/sprints/sprint-002/design/failure-class-taxonomy.md
 */

const DISPLAY_ORDER = [
  'success',
  'partial_success',
  'extraction_failed',
  'discovery_failed',
  'no_rates_expected',
  'agent_error',
  'unclassified',
];

const PHASE_DISPLAY_ORDER = {
  website: ['found_committed', 'reachable_uncommitted', 'candidates_all_failed', 'no_candidates'],
  rate_page: ['found', 'not_found', 'not_attempted'],
  extraction: ['succeeded', 'succeeded_low_confidence', 'failed', 'not_attempted'],
};

/**
 * @param {object} analysis - shape produced by run-aggregator.buildRunAnalysis
 * @returns {string} markdown
 */
function renderRunReport(analysis) {
  const lines = [];
  const totals = analysis.totals || {};
  const total = totals.dispatched || 0;

  lines.push(`# Run report — ${analysis.run_label}`);
  lines.push('');
  lines.push(`- **Category:** ${analysis.category || '(none)'}`);
  if (analysis.started_at) lines.push(`- **Started:** ${analysis.started_at}`);
  lines.push(`- **Ended:** ${analysis.ended_at}`);
  if (analysis.duration_ms != null) {
    lines.push(`- **Duration:** ${formatDuration(analysis.duration_ms)}`);
  }
  if (analysis.cost_usd_total != null) {
    lines.push(`- **Cost:** $${analysis.cost_usd_total.toFixed(2)}`);
  }
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  lines.push(
    `${totals.succeeded || 0} succeeded / ${totals.partial_success || 0} partial / ${totals.failed || 0} failed / ${total} dispatched`,
  );
  if ((totals.no_rates_expected || 0) > 0) {
    lines.push(`(${totals.no_rates_expected} banks classified as having no FD product — not failures.)`);
  }
  lines.push('');

  lines.push('## Failure-class breakdown');
  lines.push('');
  lines.push('| Class | Count | % of run | Exemplars |');
  lines.push('|---|---:|---:|---|');
  for (const cls of DISPLAY_ORDER) {
    const bucket = (analysis.by_failure_class || {})[cls];
    if (!bucket || bucket.count === 0) continue;
    const pct = total > 0 ? ((bucket.count / total) * 100).toFixed(1) : '0.0';
    const exemplars = (bucket.exemplars || []).join(', ') || '—';
    lines.push(`| \`${cls}\` | ${bucket.count} | ${pct}% | ${exemplars} |`);
  }
  // Append any unknown classes the analysis carries that aren't in the canonical order.
  const knownSet = new Set(DISPLAY_ORDER);
  for (const [cls, bucket] of Object.entries(analysis.by_failure_class || {})) {
    if (knownSet.has(cls) || !bucket || bucket.count === 0) continue;
    const pct = total > 0 ? ((bucket.count / total) * 100).toFixed(1) : '0.0';
    const exemplars = (bucket.exemplars || []).join(', ') || '—';
    lines.push(`| \`${cls}\` (unrecognized) | ${bucket.count} | ${pct}% | ${exemplars} |`);
  }
  lines.push('');

  if (analysis.by_phase_outcome) {
    lines.push('## Phase outcomes');
    lines.push('');
    lines.push('Independent counts per phase (banks may appear in multiple cells across rows since they pass through each phase once).');
    lines.push('');
    for (const phaseName of ['website', 'rate_page', 'extraction']) {
      const buckets = analysis.by_phase_outcome[phaseName];
      if (!buckets) continue;
      const cells = (PHASE_DISPLAY_ORDER[phaseName] || Object.keys(buckets))
        .map((k) => `${k}=${buckets[k] || 0}`)
        .join('  ');
      lines.push(`- **${phaseName}:** ${cells}`);
    }
    lines.push('');
  }

  lines.push('## Registry conflicts surfaced this run');
  lines.push('');
  const surfaced = analysis.registry_conflicts_surfaced || [];
  if (surfaced.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Bank | Field | Cached | Proposed | Confidence |');
    lines.push('|---|---|---|---|---|');
    for (const c of surfaced) {
      lines.push(
        `| \`${c.bank_code}\` | \`${c.field}\` | ${formatCell(c.cached_value)} | ${formatCell(c.proposed_value)} | ${c.proposed_confidence || '—'} |`,
      );
    }
  }
  lines.push('');

  const totalUnresolved = analysis.registry_conflicts_unresolved_total || 0;
  lines.push('## Unresolved conflict backlog');
  lines.push('');
  if (totalUnresolved === 0) {
    lines.push('_No outstanding pending changes._');
  } else {
    lines.push(
      `**${totalUnresolved}** pending changes remain unresolved across all runs. Full list in \`data/bank-domains-pending.json\` (operator review).`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function formatCell(v) {
  if (v === null || v === undefined) return '`null`';
  if (typeof v === 'string') return `\`${v}\``;
  return `\`${JSON.stringify(v)}\``;
}

module.exports = { renderRunReport };

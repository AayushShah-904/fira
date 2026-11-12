#!/usr/bin/env node
'use strict';

// Sprint 005 / Phase 0.2 — failure inventory.
//
// Cross-references three failure signal sources to produce a categorized
// punch-list of where the current pipeline breaks and how many banks each
// class represents:
//
//   1. tmp/baseline-pre-reset/output-latest/_batch_results_*.json
//        Per-cohort run outcomes (succeeded / failed / rate_limited / skipped).
//
//   2. tmp/baseline-pre-reset/quality-report.json
//        Pack quality-gate findings: REGRESSION, ANOMALY, WARN, etc.
//
//   3. tmp/analysis/clusters.json (from Phase 0.1)
//        Failure-cluster topology so we can attribute pack regressions to
//        structural categories rather than individual banks.
//
// Output: tmp/analysis/failures.md grouped by failure class, with per-class
// affected banks, root-cause hypothesis, and the Phase B/C/D component that
// owns the fix.

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const baselineDir = path.join(repoRoot, 'tmp', 'baseline-pre-reset');
const analysisDir = path.join(repoRoot, 'tmp', 'analysis');

function loadJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

function loadConfigForBank(bankCode) {
  return loadJsonSafe(path.join(baselineDir, 'output-latest', `${bankCode}_config.json`));
}

function loadRatesForBank(bankCode, variant) {
  const suffix = variant === 'regular' ? '_rates.json' : `_${variant}_rates.json`;
  return loadJsonSafe(path.join(baselineDir, 'output-latest', `${bankCode}${suffix}`));
}

function main() {
  fs.mkdirSync(analysisDir, { recursive: true });

  // 1. Batch results per cohort
  const batchDir = path.join(baselineDir, 'output-latest');
  const batchFiles = fs.readdirSync(batchDir).filter(f => f.startsWith('_batch_results_') && f.endsWith('.json'));
  const cohortStats = [];
  for (const bf of batchFiles) {
    const j = loadJsonSafe(path.join(batchDir, bf));
    if (!j) continue;
    cohortStats.push({
      file: bf,
      category: j.category,
      timestamp: j.timestamp,
      succeeded: j.succeeded || 0,
      failed: j.failed || 0,
      rate_limited: j.rate_limited || 0,
      skipped: j.skipped || 0,
      failed_banks: (j.results || []).filter(r => r.status !== 'success').map(r => ({ name: r.name, status: r.status, elapsed: r.elapsed_sec })),
    });
  }

  // 2. Pack findings
  const qr = loadJsonSafe(path.join(baselineDir, 'quality-report.json'));
  const findings = qr ? (qr.findings || []) : [];
  const findingsByClass = {};
  for (const f of findings) {
    if (!findingsByClass[f.class]) findingsByClass[f.class] = [];
    findingsByClass[f.class].push(f);
  }

  // 3. Cluster topology
  const clusters = loadJsonSafe(path.join(analysisDir, 'clusters.json'));
  const bankToFailureCluster = new Map();
  if (clusters) {
    for (const c of (clusters.failure_clusters || [])) {
      for (const m of c.members) bankToFailureCluster.set(m, c.signature_key);
    }
  }

  // Build failure-class taxonomy
  const classes = [];

  // -- A. Pack regressions: bank in baseline had N slabs, now has <N (or 0)
  const regressions = findingsByClass['REGRESSION'] || [];
  const regressionsByVariant = {};
  for (const r of regressions) {
    const v = r.variant || 'unknown';
    if (!regressionsByVariant[v]) regressionsByVariant[v] = [];
    regressionsByVariant[v].push(r);
  }
  classes.push({
    id: 'A-pack-regressions',
    title: 'Pack regressions (slab count dropped vs prior pack)',
    count_banks: new Set(regressions.map(r => r.bank_code)).size,
    count_findings: regressions.length,
    breakdown_by_variant: Object.fromEntries(Object.entries(regressionsByVariant).map(([v, arr]) => [v, arr.length])),
    samples: regressions.slice(0, 15).map(r => ({
      bank: r.bank_code, variant: r.variant, baseline: r.baseline, actual: r.actual,
      drop_pct: Math.round(((r.actual - r.baseline) / r.baseline) * 100),
      cluster: bankToFailureCluster.get(r.bank_code) || '(unclustered/success-bank)',
    })),
    root_cause_hypotheses: [
      'Engine regression: a code change after 2026-05-14 broke deterministic extraction for the variant. Most common: FCNR currency-matrix tables lose 30-70% of cells.',
      'Bank-side layout change: site re-themed between baseline and new pack runs. Less common; isolated to one or two banks per cycle.',
      'Stale URL: registry URL now returns 404; rates file is empty.',
    ],
    phase_owner: 'Phase C extractor authoring (per template) + Phase D regression-detection in golden tests',
  });

  // -- B. Pack anomalies (rate invariant violations)
  const anomalies = findingsByClass['ANOMALY'] || [];
  const anomGain = findingsByClass['ANOMALY_GAIN'] || [];
  const anomBySymptom = {};
  for (const a of [...anomalies, ...anomGain]) {
    const k = a.check || a.kind || 'unknown';
    if (!anomBySymptom[k]) anomBySymptom[k] = [];
    anomBySymptom[k].push(a);
  }
  classes.push({
    id: 'B-rate-anomalies',
    title: 'Rate anomalies (invariant violations in extracted data)',
    count_banks: new Set([...anomalies, ...anomGain].map(a => a.bank_code)).size,
    count_findings: anomalies.length + anomGain.length,
    breakdown_by_check: Object.fromEntries(Object.entries(anomBySymptom).map(([k, arr]) => [k, arr.length])),
    samples: [...anomalies, ...anomGain].slice(0, 15).map(a => ({
      bank: a.bank_code, variant: a.variant, check: a.check,
      detail: typeof a.detail === 'string' ? a.detail.slice(0, 80) : JSON.stringify(a.value || a.detail).slice(0, 80),
    })),
    root_cause_hypotheses: [
      'senior_below_general: column mapping inverted, OR senior column actually carries a different product (special non-senior tier the parser mistook for senior).',
      'super_senior_below_senior: same — three-column tables where columns 2 and 3 swap meanings.',
      'anomalous_gain: a variant just appeared with implausibly many slabs vs baseline; usually a new bank entering the pack, sometimes a deterministic re-extract finding cells the LLM previously missed (which is good but flagged for review).',
    ],
    phase_owner: 'Phase A column_map (per template) + Phase C extractor traceability assertions',
  });

  // -- C. Cohort failures: banks that errored out during the run
  const cohortFailed = [];
  for (const c of cohortStats) {
    for (const fb of c.failed_banks) cohortFailed.push({ ...fb, cohort: c.category });
  }
  const cohortFailedByCategory = {};
  for (const c of cohortStats) {
    if (c.failed > 0 || c.rate_limited > 0 || c.skipped > 0) {
      cohortFailedByCategory[c.category] = { failed: c.failed, rate_limited: c.rate_limited, skipped: c.skipped, succeeded: c.succeeded };
    }
  }
  classes.push({
    id: 'C-cohort-runtime-failures',
    title: 'Cohort-run failures (agent threw / timed out / rate-limited)',
    count_banks: new Set(cohortFailed.map(b => b.name)).size,
    count_findings: cohortFailed.length,
    breakdown_by_cohort: cohortFailedByCategory,
    samples: cohortFailed.slice(0, 15),
    root_cause_hypotheses: [
      'Playwright timeout — page took >60s to load (default global timeout, not per-bank).',
      'WAF challenge — Cloudflare/Akamai/CloudFront returned non-rate content, agent looped or gave up.',
      'Agent rate-limit — Azure OpenAI quota hit mid-cohort.',
      'Cost cap — orchestrator killed the bank after cost budget exhausted.',
    ],
    phase_owner: 'Phase B fetch-layer retry escalation + per-bank timeout overrides + challenge_detect.js',
  });

  // -- D. Cluster-driven failure modes (from Phase 0.1)
  const failureClusterClasses = [];
  if (clusters && clusters.failure_clusters) {
    for (const fc of clusters.failure_clusters) {
      if (fc.member_count < 3) break;
      const s = fc.signature;
      let owner = 'Phase B fetch hardening';
      let cause = '';
      if (s.scraper_type === 'html_js') {
        cause = 'JS-rendered page, default Playwright wait insufficient — page settles before tables render.';
        owner = 'Phase B fetch_html waitForFunction default + per-bank wait_for_selector hint';
      } else if (s.scraper_type === 'unknown') {
        cause = 'Discovery never assigned a scraper_type → fetch never attempted. Dispatcher bails early when scraper_type is null.';
        owner = 'Phase A dispatcher: default scraper_type to html_static when unknown, attempt fetch, classify from response';
      } else if (s.scraper_type === 'manual' && s.bank_type === 'IBU') {
        cause = 'IBU foreign-bank GIFT City units classified as manual — rate cards behind login or in PDFs not yet routed.';
        owner = 'Phase E stop-condition: route to manual-curation OR author dedicated IBU extractor';
      } else if (s.scraper_type === 'html_js' && s.bank_type === 'FB') {
        cause = 'Foreign bank with JS-rendered page → very likely WAF/auth block behind the JS.';
        owner = 'Phase B challenge_detect → stealth rung; if still blocked, Phase E manual';
      }
      failureClusterClasses.push({
        cluster_size: fc.member_count,
        signature: fc.signature_key,
        cause_hypothesis: cause,
        phase_owner: owner,
        members: fc.members.slice(0, 6),
      });
    }
  }
  classes.push({
    id: 'D-cluster-driven-failure-modes',
    title: 'Cluster-driven failure modes (from Phase 0.1)',
    cluster_classes: failureClusterClasses,
  });

  const result = {
    generated_at: new Date().toISOString(),
    inputs: {
      batch_results_files: batchFiles.length,
      pack_findings_total: findings.length,
      quality_verdict: qr ? qr.verdict : 'unknown',
    },
    classes,
  };

  // safe-write-exempt: phase-0 failure-inventory output under tmp/analysis/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(path.join(analysisDir, 'failures.json'), JSON.stringify(result, null, 2) + '\n');

  // Markdown report
  const md = [];
  md.push(`# Phase 0.2 — Failure inventory`);
  md.push(``);
  md.push(`Generated: ${result.generated_at}`);
  md.push(`Pack verdict: **${result.inputs.quality_verdict}**`);
  md.push(`Pack findings analyzed: ${result.inputs.pack_findings_total}`);
  md.push(`Cohort batch result files: ${result.inputs.batch_results_files}`);
  md.push(``);
  md.push(`## Headline`);
  md.push(``);
  md.push(`The current pack is **${result.inputs.quality_verdict}** because of failures spanning four distinct classes. Each class lists affected banks, root-cause hypothesis, and the Phase B/C/D component that owns the fix under the architectural reset.`);
  md.push(``);
  md.push(`| Class | Banks | Findings | Owner |`);
  md.push(`|---|---:|---:|---|`);
  for (const cls of classes) {
    md.push(`| ${cls.id} — ${cls.title} | ${cls.count_banks ?? '—'} | ${cls.count_findings ?? '—'} | ${cls.phase_owner || '(see breakdown)'} |`);
  }
  md.push(``);

  // Class A — regressions
  const A = classes.find(c => c.id === 'A-pack-regressions');
  md.push(`## A — Pack regressions (${A.count_banks} banks, ${A.count_findings} findings)`);
  md.push(``);
  md.push(`Variant breakdown: ${Object.entries(A.breakdown_by_variant).map(([v, n]) => `${v}=${n}`).join(', ')}`);
  md.push(``);
  md.push(`**Root-cause hypotheses:**`);
  for (const h of A.root_cause_hypotheses) md.push(`- ${h}`);
  md.push(``);
  md.push(`**Sample regressions (top 15):**`);
  md.push(``);
  md.push(`| Bank | Variant | Baseline | Actual | Drop | Failure cluster |`);
  md.push(`|---|---|---:|---:|---:|---|`);
  for (const s of A.samples) md.push(`| \`${s.bank}\` | ${s.variant} | ${s.baseline} | ${s.actual} | ${s.drop_pct}% | ${s.cluster} |`);
  md.push(``);
  md.push(`**Owner:** ${A.phase_owner}`);
  md.push(``);

  // Class B — anomalies
  const B = classes.find(c => c.id === 'B-rate-anomalies');
  md.push(`## B — Rate anomalies (${B.count_banks} banks, ${B.count_findings} findings)`);
  md.push(``);
  md.push(`Check breakdown: ${Object.entries(B.breakdown_by_check).map(([k, n]) => `${k}=${n}`).join(', ')}`);
  md.push(``);
  md.push(`**Root-cause hypotheses:**`);
  for (const h of B.root_cause_hypotheses) md.push(`- ${h}`);
  md.push(``);
  md.push(`**Sample anomalies (top 15):**`);
  md.push(``);
  md.push(`| Bank | Variant | Check | Detail |`);
  md.push(`|---|---|---|---|`);
  for (const s of B.samples) md.push(`| \`${s.bank}\` | ${s.variant} | ${s.check} | ${s.detail} |`);
  md.push(``);
  md.push(`**Owner:** ${B.phase_owner}`);
  md.push(``);

  // Class C — cohort runtime
  const C = classes.find(c => c.id === 'C-cohort-runtime-failures');
  md.push(`## C — Cohort-run failures (${C.count_banks} banks, ${C.count_findings} findings)`);
  md.push(``);
  md.push(`Breakdown by cohort:`);
  md.push(``);
  md.push(`| Cohort | Succeeded | Failed | Rate-limited | Skipped |`);
  md.push(`|---|---:|---:|---:|---:|`);
  for (const [cat, st] of Object.entries(C.breakdown_by_cohort)) {
    md.push(`| ${cat} | ${st.succeeded} | ${st.failed} | ${st.rate_limited} | ${st.skipped} |`);
  }
  md.push(``);
  md.push(`**Root-cause hypotheses:**`);
  for (const h of C.root_cause_hypotheses) md.push(`- ${h}`);
  md.push(``);
  md.push(`**Sample failed banks (top 15):**`);
  md.push(``);
  md.push(`| Bank | Cohort | Status | Elapsed (s) |`);
  md.push(`|---|---|---|---:|`);
  for (const s of C.samples) md.push(`| \`${s.name}\` | ${s.cohort} | ${s.status} | ${s.elapsed ?? '—'} |`);
  md.push(``);
  md.push(`**Owner:** ${C.phase_owner}`);
  md.push(``);

  // Class D — cluster-driven
  const D = classes.find(c => c.id === 'D-cluster-driven-failure-modes');
  md.push(`## D — Cluster-driven failure modes (from Phase 0.1)`);
  md.push(``);
  md.push(`These are failure clusters with ≥3 banks each. Fixing the cluster-root unblocks all members at once.`);
  md.push(``);
  for (const cc of D.cluster_classes) {
    md.push(`### Cluster size ${cc.cluster_size} — \`${cc.signature}\``);
    md.push(``);
    md.push(`- **Cause hypothesis:** ${cc.cause_hypothesis || '(see signature)'}`);
    md.push(`- **Owner:** ${cc.phase_owner}`);
    md.push(`- **Sample members:** ${cc.members.map(m => `\`${m}\``).join(', ')}`);
    md.push(``);
  }

  md.push(`## Cross-cutting observations`);
  md.push(``);
  md.push(`1. **Pack regressions and rate-anomalies are mostly the SAME problem with different symptoms.** A column-mapping bug in the FCNR extractor shows up as a regression (cell loss → fewer slabs) AND as an anomaly (senior_below_general when the senior column actually carries the super-senior product). Phase C extractor authoring with strict column_map closes both at once.`);
  md.push(``);
  md.push(`2. **The "unknown scraper_type" failure cluster (~31 banks across NSUCB / DCCB)** is a dispatch bug masquerading as a discovery failure. The agent gave up before fetching. Phase A's new dispatcher should default to html_static and attempt fetch, then re-classify based on what the page actually looks like.`);
  md.push(``);
  md.push(`3. **JS-rendered .bank.in pages cluster** (~20 banks across DCCB/NSUCB html_js): single Phase B fix — set a sane default \`waitForFunction\` that waits for a table containing a "%" sign. Today's Playwright wrapper waits for \`domcontentloaded\` which is too early for many .bank.in JS sites.`);
  md.push(``);
  md.push(`4. **IBU/manual cluster (9 banks)** is structurally hard — most foreign-bank GIFT units publish rates in login-gated PDFs. Phase E should accept this as a manual-curation stop condition rather than fight it.`);
  md.push(``);
  md.push(`5. **Cohort runtime failures are very rare in the captured baseline** — most failures show up in the pack as zero-slab regressions, not as runtime exceptions. The orchestrator is good at completing-without-erroring even when extraction fails. That's why silent-fallback observability (Phase D manifest) matters: today, a "successful run that produced no data" looks identical in batch_results to a "successful run that produced real data".`);
  md.push(``);

  // safe-write-exempt: phase-0 failure-inventory output under tmp/analysis/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(path.join(analysisDir, 'failures.md'), md.join('\n'));

  console.log(`pack verdict: ${result.inputs.quality_verdict}`);
  console.log(`pack findings: ${result.inputs.pack_findings_total}`);
  for (const cls of classes) {
    if (cls.count_banks != null) console.log(`  ${cls.id}: ${cls.count_banks} banks, ${cls.count_findings} findings`);
  }
  console.log(`wrote tmp/analysis/failures.{json,md}`);
}

main();

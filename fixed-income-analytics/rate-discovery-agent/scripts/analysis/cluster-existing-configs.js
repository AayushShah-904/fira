#!/usr/bin/env node
'use strict';

// Sprint 005 / Phase 0.1 — cluster existing 633 extractions by structural signature.
//
// Reads tmp/baseline-pre-reset/output-latest/*_config.json + paired _rates.json
// files (regular + nre + nro + fcnr + gift variants). For each bank, computes a
// structural signature drawn ONLY from artifacts we already have (no re-fetch).
// Banks with the same signature share a likely page template — those are the
// clusters Phase A's fingerprint algorithm and Phase C's extractor registry
// will use as ground truth.
//
// Signature components:
//   bank_type | scraper_type | extraction_method | slab_count_bucket | tenure_shape |
//   has_senior | has_super_senior | has_currency | variant_set | warning_class
//
// Emits:
//   tmp/analysis/clusters.json — machine-readable, all clusters + per-bank assignments
//   tmp/analysis/clusters.md   — operator-readable, clusters ≥3 banks first
//
// Usage:
//   node scripts/analysis/cluster-existing-configs.js

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const baselineDir = path.join(repoRoot, 'tmp', 'baseline-pre-reset', 'output-latest');
const outDir = path.join(repoRoot, 'tmp', 'analysis');

function loadJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function slabBucket(n) {
  if (!n) return '0';
  if (n <= 3) return '1-3';
  if (n <= 8) return '4-8';
  if (n <= 15) return '9-15';
  if (n <= 30) return '16-30';
  return '30+';
}

// Normalize a tenure_text into a structural shape, dropping numbers but keeping
// the structural keywords. Two banks that both publish "7 Days to 45 Days",
// "46 days to 90 days", ... collapse to the same shape vector, regardless of
// the exact numbers.
function tenureShape(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  // strip parentheticals (e.g. "(new slab)", "(444 days special)")
  const noparens = lower.replace(/\(.*?\)/g, ' ');
  // collapse numbers to N
  const denumbered = noparens.replace(/\d+(\.\d+)?/g, 'N');
  // canonicalize unit tokens
  return denumbered
    .replace(/\s+/g, ' ')
    .replace(/\byrs?\b/g, 'year')
    .replace(/\byears?\b/g, 'year')
    .replace(/\bmonths?\b/g, 'month')
    .replace(/\bmos?\b/g, 'month')
    .replace(/\bdays?\b/g, 'day')
    .replace(/\bd\b/g, 'day')
    .replace(/\bm\b/g, 'month')
    .replace(/\by\b/g, 'year')
    .replace(/\babove\b/g, '>')
    .replace(/\bup ?to\b/g, '<=')
    .replace(/\bless than\b/g, '<')
    .replace(/\bmore than\b/g, '>')
    .replace(/\bover\b/g, '>')
    .replace(/\band above\b/g, '+')
    .replace(/\bonwards?\b/g, '+')
    .replace(/\bto\b/g, '..')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reduce a per-bank set of tenure shapes to a fingerprint. We don't keep the
// individual shapes — the *pattern of patterns* is what makes a cluster.
function tenureShapeFingerprint(slabs) {
  if (!slabs || !slabs.length) return 'no-slabs';
  const shapes = slabs.map(s => tenureShape(s.tenure_text || ''));
  // dedupe + sort for cluster-stability
  const unique = [...new Set(shapes)].sort();
  // collapse very long lists; cluster-equivalent banks should have <8 unique shapes
  if (unique.length > 8) return `mixed(${unique.length})`;
  return unique.join('|');
}

function warningClass(rates) {
  if (!rates || !rates.warnings || !rates.warnings.length) return 'clean';
  const joined = rates.warnings.join(' ').toLowerCase();
  const flags = [];
  if (joined.includes('llm_fallback')) flags.push('llm');
  if (joined.includes('multi_table')) flags.push('multi-table');
  if (joined.includes('ambiguous_columns')) flags.push('amb-cols');
  if (joined.includes('cheerio_multi_table')) flags.push('cheerio-multi');
  if (joined.includes('senior')) flags.push('senior-issue');
  if (joined.includes('currency')) flags.push('currency-issue');
  if (joined.includes('tenure')) flags.push('tenure-issue');
  if (!flags.length) return 'other';
  return flags.join('+');
}

function bankCodeFromConfigPath(p) {
  return path.basename(p).replace(/_config\.json$/, '');
}

function variantFileNames(bankCode) {
  return {
    regular: `${bankCode}_rates.json`,
    nre:     `${bankCode}_nre_rates.json`,
    nro:     `${bankCode}_nro_rates.json`,
    fcnr:    `${bankCode}_fcnr_rates.json`,
    gift:    `${bankCode}_gift_rates.json`,
  };
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const allFiles = fs.readdirSync(baselineDir);
  const configFiles = allFiles.filter(f => f.endsWith('_config.json') && !f.startsWith('_'));

  const banks = [];
  for (const cf of configFiles) {
    const cfg = loadJsonSafe(path.join(baselineDir, cf));
    if (!cfg) continue;
    const bankCode = bankCodeFromConfigPath(cf);
    const variants = variantFileNames(bankCode);
    const ratesByVariant = {};
    for (const [variant, fname] of Object.entries(variants)) {
      const r = loadJsonSafe(path.join(baselineDir, fname));
      if (r) ratesByVariant[variant] = r;
    }

    const regular = ratesByVariant.regular || null;
    const slabs = regular ? regular.rate_slabs || [] : [];

    const hasSenior = slabs.some(s => s.rate_senior_pct != null);
    const hasSuperSenior = slabs.some(s => s.rate_super_senior_pct != null);
    const hasCurrency = Object.values(ratesByVariant).some(r =>
      (r.rate_slabs || []).some(s => s.currency)
    );
    const variantSet = Object.keys(ratesByVariant).sort().join('+') || 'none';

    // Domain TLD: a coarse but reliable proxy for site framework family.
    // .bank.in == RBI-mandated banking domain; sites under .bank.in cluster
    // strongly because they share the same registry-issued template family.
    let domainTld = 'other';
    if (cfg.website) {
      const w = cfg.website.toLowerCase();
      if (w.includes('.bank.in')) domainTld = '.bank.in';
      else if (w.match(/\.co\.in(\/|$)/)) domainTld = '.co.in';
      else if (w.match(/\.com(\/|$)/)) domainTld = '.com';
      else if (w.match(/\.org(\/|$)/)) domainTld = '.org';
      else if (w.match(/\.in(\/|$)/)) domainTld = '.in';
    }

    const slabCount = slabs.length;
    const success = slabCount > 0;

    // Two distinct signatures: one for failures (taxonomy of failure modes),
    // one for successes (structural clustering ignoring incidental wording).
    const failureSig = {
      kind:               'failure',
      bank_type:          cfg.bank_type || 'unknown',
      scraper_type:       cfg.scraper_type || 'unknown',
      extraction_method:  (regular && regular.extraction_method) || cfg.extraction_method || 'unknown',
      variant_set:        variantSet,
      warning_class:      warningClass(regular),
      domain_tld:         domainTld,
    };
    const failureKey = [
      'F', failureSig.bank_type, failureSig.scraper_type, failureSig.extraction_method,
      failureSig.variant_set, failureSig.warning_class, failureSig.domain_tld,
    ].join(' | ');

    // Structural signature deliberately DROPS extraction_method: two banks
    // with identical page structure end up with different extraction_methods
    // depending only on whether the deterministic parser happened to succeed
    // vs falling back to LLM. The structural cluster is the same — splitting
    // on extraction_method would understate cluster size and over-count
    // templates.
    const successSig = {
      kind:               'success',
      bank_type:          cfg.bank_type || 'unknown',
      scraper_type:       cfg.scraper_type || 'unknown',
      slab_bucket:        slabBucket(slabCount),
      has_senior:         hasSenior,
      has_super_senior:   hasSuperSenior,
      has_currency:       hasCurrency,
      variant_set:        variantSet,
      domain_tld:         domainTld,
      // diagnostic-only — what extraction_methods are mixed in this cluster
      _extraction_methods_observed: (regular && regular.extraction_method) || cfg.extraction_method || 'unknown',
    };
    const successKey = [
      'S', successSig.bank_type, successSig.scraper_type,
      successSig.slab_bucket, successSig.has_senior ? 'sr' : '-',
      successSig.has_super_senior ? 'ssr' : '-', successSig.has_currency ? 'ccy' : '-',
      successSig.variant_set, successSig.domain_tld,
    ].join(' | ');

    banks.push({
      bank_code: bankCode,
      bank_name: cfg.bank_name,
      bank_type: cfg.bank_type || 'unknown',
      state:     cfg.state || null,
      website:   cfg.website || null,
      rate_page: cfg.rate_page_urls ? cfg.rate_page_urls.fd : null,
      slab_count: slabCount,
      success,
      tenure_shape: tenureShapeFingerprint(slabs),  // recorded but not clustered on
      signature: success ? successSig : failureSig,
      signature_key: success ? successKey : failureKey,
    });
  }

  // group separately: failure clusters vs success clusters
  function makeClusters(filtered) {
    const m = new Map();
    for (const b of filtered) {
      if (!m.has(b.signature_key)) {
        m.set(b.signature_key, {
          signature_key: b.signature_key,
          signature: b.signature,
          member_count: 0,
          avg_slab_count: 0,
          members: [],
        });
      }
      const c = m.get(b.signature_key);
      c.members.push(b.bank_code);
      c.member_count += 1;
      c.avg_slab_count = ((c.avg_slab_count * (c.member_count - 1)) + b.slab_count) / c.member_count;
    }
    const arr = [...m.values()].sort((a, b) => b.member_count - a.member_count);
    for (const c of arr) c.avg_slab_count = Math.round(c.avg_slab_count * 10) / 10;
    return arr;
  }

  const failures = banks.filter(b => !b.success);
  const successes = banks.filter(b => b.success);
  const failureClusters = makeClusters(failures);
  const successClusters = makeClusters(successes);

  function summarize(label, arr, total) {
    return {
      label,
      total_banks: total,
      total_clusters: arr.length,
      clusters_ge_3: arr.filter(c => c.member_count >= 3).length,
      clusters_ge_5: arr.filter(c => c.member_count >= 5).length,
      clusters_ge_10: arr.filter(c => c.member_count >= 10).length,
      singletons: arr.filter(c => c.member_count === 1).length,
      coverage_top_10: total ? Math.round(arr.slice(0, 10).reduce((a, c) => a + c.member_count, 0) / total * 100) : 0,
      coverage_top_20: total ? Math.round(arr.slice(0, 20).reduce((a, c) => a + c.member_count, 0) / total * 100) : 0,
      coverage_top_30: total ? Math.round(arr.slice(0, 30).reduce((a, c) => a + c.member_count, 0) / total * 100) : 0,
    };
  }

  const result = {
    generated_at: new Date().toISOString(),
    source_dir: baselineDir,
    total_banks_analyzed: banks.length,
    successes: summarize('successes (≥1 slab)', successClusters, successes.length),
    failures:  summarize('failures (0 slabs)',  failureClusters,  failures.length),
    success_clusters: successClusters,
    failure_clusters: failureClusters,
  };

  // safe-write-exempt: phase-0 cluster-analysis output under tmp/analysis/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(path.join(outDir, 'clusters.json'), JSON.stringify(result, null, 2) + '\n');

  // emit human-readable markdown report
  const md = [];
  md.push(`# Phase 0.1 — Cluster analysis`);
  md.push(``);
  md.push(`Generated: ${result.generated_at}`);
  md.push(`Source: \`${path.relative(repoRoot, baselineDir)}\``);
  md.push(``);
  md.push(`## Top-line`);
  md.push(``);
  md.push(`- **Banks analyzed:** ${result.total_banks_analyzed}`);
  md.push(`- **Successes (≥1 slab):** ${result.successes.total_banks} → ${result.successes.total_clusters} clusters (${result.successes.clusters_ge_3} ≥3 banks, ${result.successes.singletons} singletons)`);
  md.push(`- **Failures (0 slabs):**  ${result.failures.total_banks} → ${result.failures.total_clusters} clusters (${result.failures.clusters_ge_3} ≥3 banks, ${result.failures.singletons} singletons)`);
  md.push(``);
  md.push(`## Coverage by top-N clusters`);
  md.push(``);
  md.push(`| Cohort | Top 10 | Top 20 | Top 30 |`);
  md.push(`|---|---:|---:|---:|`);
  md.push(`| Successes | ${result.successes.coverage_top_10}% | ${result.successes.coverage_top_20}% | ${result.successes.coverage_top_30}% |`);
  md.push(`| Failures  | ${result.failures.coverage_top_10}% | ${result.failures.coverage_top_20}% | ${result.failures.coverage_top_30}% |`);
  md.push(``);
  md.push(`## Interpretation`);
  md.push(``);
  md.push(`The architectural reset assumes ~30 templates cover the top 300 successful banks.`);
  md.push(``);
  md.push(`- If success top-30 ≥ 80% → assumption holds, Phase A/C extractor work is bounded.`);
  md.push(`- If success top-30 in 50-80% → workable but plan more singleton handling.`);
  md.push(`- If success top-30 ≤ 50% → corpus too fragmented, revisit before Phase A starts.`);
  md.push(``);
  md.push(`The signature here is intentionally **coarse and structural** — it drops the actual tenure_text wording (which fragments wildly even when pages share structure) and clusters on \`bank_type | scraper_type | extraction_method | slab_bucket | column_set | variant_set | domain_tld\`. The Phase A fingerprint, once we can re-fetch HTML, will produce finer clusters using DOM-tree + header-vector + framework hints — this analysis is a lower bound on cluster size, not an upper bound.`);
  md.push(``);

  function emitSuccessTable(clusters) {
    md.push(`## Success clusters ≥3 banks (Phase C extractor candidates)`);
    md.push(``);
    md.push(`| # | Size | Bank type | Scraper | Slabs(avg) | Cols | Variants | Domain | Representative |`);
    md.push(`|---|---:|---|---|---:|---|---|---|---|`);
    let n = 0;
    for (const c of clusters) {
      if (c.member_count < 3) break;
      n += 1;
      const s = c.signature;
      const cols = [s.has_senior ? 'sr' : '', s.has_super_senior ? 'ssr' : '', s.has_currency ? 'ccy' : ''].filter(Boolean).join('+') || '-';
      md.push(`| ${n} | ${c.member_count} | ${s.bank_type} | ${s.scraper_type} | ${c.avg_slab_count} | ${cols} | ${s.variant_set} | ${s.domain_tld || '-'} | \`${c.members[0]}\` |`);
    }
    md.push(``);
  }

  function emitFailureTable(clusters) {
    md.push(`## Failure clusters ≥3 banks (Phase B/C fix priorities)`);
    md.push(``);
    md.push(`| # | Size | Bank type | Scraper | Extraction | Variants | Warnings | Domain | Representative |`);
    md.push(`|---|---:|---|---|---|---|---|---|---|`);
    let n = 0;
    for (const c of clusters) {
      if (c.member_count < 3) break;
      n += 1;
      const s = c.signature;
      md.push(`| ${n} | ${c.member_count} | ${s.bank_type} | ${s.scraper_type} | ${s.extraction_method} | ${s.variant_set} | ${s.warning_class} | ${s.domain_tld || '-'} | \`${c.members[0]}\` |`);
    }
    md.push(``);
  }

  emitSuccessTable(successClusters);
  emitFailureTable(failureClusters);

  md.push(`## Success cluster members (top 20)`);
  md.push(``);
  for (let j = 0; j < Math.min(20, successClusters.length); j++) {
    const c = successClusters[j];
    if (c.member_count < 3) break;
    md.push(`### Success #${j + 1} — ${c.member_count} banks — \`${c.signature.bank_type}/${c.signature.scraper_type}\` (${c.signature.domain_tld})`);
    md.push(``);
    md.push(`- Signature: \`${c.signature_key}\``);
    md.push(`- Avg slabs: ${c.avg_slab_count}`);
    md.push(`- Members (first 15): ${c.members.slice(0, 15).map(m => `\`${m}\``).join(', ')}${c.members.length > 15 ? ` ... +${c.members.length - 15} more` : ''}`);
    md.push(``);
  }

  md.push(`## Failure cluster members (top 20)`);
  md.push(``);
  for (let j = 0; j < Math.min(20, failureClusters.length); j++) {
    const c = failureClusters[j];
    if (c.member_count < 3) break;
    md.push(`### Failure #${j + 1} — ${c.member_count} banks — \`${c.signature.bank_type}/${c.signature.scraper_type}\` warning=${c.signature.warning_class}`);
    md.push(``);
    md.push(`- Signature: \`${c.signature_key}\``);
    md.push(`- Members (first 15): ${c.members.slice(0, 15).map(m => `\`${m}\``).join(', ')}${c.members.length > 15 ? ` ... +${c.members.length - 15} more` : ''}`);
    md.push(``);
  }

  // safe-write-exempt: phase-0 cluster-analysis output under tmp/analysis/; not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(path.join(outDir, 'clusters.md'), md.join('\n'));

  console.log(`analyzed ${banks.length} banks (${successes.length} success / ${failures.length} failure)`);
  console.log(`SUCCESS: ${result.successes.total_clusters} clusters, top-30 cover ${result.successes.coverage_top_30}%`);
  console.log(`FAILURE: ${result.failures.total_clusters} clusters, top-30 cover ${result.failures.coverage_top_30}%`);
  console.log(`wrote tmp/analysis/clusters.{json,md}`);
}

main();

#!/usr/bin/env node
/**
 * Sprint 003 Week 2 Task #4 — measure LLM under-extraction scope against the
 * deterministic dispatcher, across every bank+variant for which the
 * 2026-05-13 refresh-pipeline cached a body.
 *
 * Method:
 *   1. Walk output/refresh/2026-05-13T17-29-11/fetched/*.html (PDFs skipped).
 *   2. For each cached body, read the corresponding output/latest/<slug>_<v>_rates.json
 *      as LLM ground truth.
 *   3. Run lib/actions/extract_html_table with hints.cached_body to get a
 *      deterministic-dispatcher slab count from the same HTML the LLM saw.
 *   4. Categorize each bank-variant by the comparison:
 *        - llm_only:      LLM > 0, dispatcher = 0   (dispatcher missed; LLM caught)
 *        - dispatcher_only: dispatcher > 0, LLM = 0 (dispatcher caught; LLM emitted none)
 *        - llm_more:      LLM > dispatcher          (LLM over-extracted OR captured
 *                                                    rows dispatcher missed)
 *        - dispatcher_more: dispatcher > LLM         (LLM under-extracted — focus of this task)
 *        - equal:         counts match
 *        - both_empty:    both produced zero slabs
 *
 * Output:
 *   sdlc/sprints/sprint-003/implementation/under-extraction-scope.json — machine-readable
 *   sdlc/sprints/sprint-003/implementation/under-extraction-scope.md   — human-readable
 *
 * NB: "dispatcher_more" does NOT prove the dispatcher is right — the over-
 * extraction class (AB Bank-style segment duplicates) shows up here too. Per-
 * bank inspection of the highest discrepancies is the qualitative follow-up.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractHtmlTable } = require('../../lib/actions/extract_html_table');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(REPO_ROOT, 'output', 'refresh', '2026-05-13T17-29-11', 'fetched');
const LATEST_DIR = path.join(REPO_ROOT, 'output', 'latest');
const OUT_DIR = path.join(REPO_ROOT, 'sdlc', 'sprints', 'sprint-003', 'implementation');

function ratesPath(bank, variant) {
  if (variant === 'regular') return path.join(LATEST_DIR, `${bank}_rates.json`);
  return path.join(LATEST_DIR, `${bank}_${variant}_rates.json`);
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function categorize(llm, det) {
  if (llm === 0 && det === 0) return 'both_empty';
  if (llm === 0 && det > 0) return 'dispatcher_only';
  if (llm > 0 && det === 0) return 'llm_only';
  if (llm === det) return 'equal';
  if (det > llm) return 'dispatcher_more';
  return 'llm_more';
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.error(`Cache directory not found: ${CACHE_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.html'));
  console.log(`Scanning ${files.length} cached HTML files...`);

  const results = [];
  let processed = 0;
  for (const file of files) {
    processed++;
    // filename pattern: <bank-slug>__<variant>.html
    const match = file.match(/^(.+?)__(regular|nre|nro|fcnr|gift)\.html$/);
    if (!match) continue;
    const [, bank, variant] = match;

    const cachedHtml = fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8');
    const llmJson = readJsonSafe(ratesPath(bank, variant));
    const llmCount = llmJson && Array.isArray(llmJson.rate_slabs) ? llmJson.rate_slabs.length : 0;
    const bankType = (llmJson && llmJson.bank_type) || '';

    // Run A3 v2 with cached_body. For html_static kind (dispatcher accepts
    // both since cached_body bypasses fetch).
    let detCount = 0;
    let detResult = null;
    let detError = null;
    try {
      detResult = await extractHtmlTable({
        url: 'https://placeholder/' + file,
        kind: 'html_static',
        product_type: 'FD',
        variant,
        hints: { cached_body: cachedHtml },
      });
      detCount = detResult && detResult.slabs ? detResult.slabs.length : 0;
    } catch (err) {
      detError = err.message.slice(0, 200);
    }

    results.push({
      bank,
      variant,
      bank_type: bankType,
      llm_count: llmCount,
      dispatcher_count: detCount,
      diff: detCount - llmCount,
      category: categorize(llmCount, detCount),
      dispatcher_warnings: detResult && detResult.warnings ? detResult.warnings : (detResult === null ? ['rejected_or_zero'] : []),
      dispatcher_error: detError,
    });

    if (processed % 50 === 0) console.log(`  ...${processed}/${files.length}`);
  }

  // Aggregate
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  }

  const dispatcherMore = results.filter(r => r.category === 'dispatcher_more').sort((a, b) => b.diff - a.diff);
  const llmMore = results.filter(r => r.category === 'llm_more').sort((a, b) => a.diff - b.diff);
  const dispatcherOnly = results.filter(r => r.category === 'dispatcher_only').sort((a, b) => b.dispatcher_count - a.dispatcher_count);
  const llmOnly = results.filter(r => r.category === 'llm_only').sort((a, b) => b.llm_count - a.llm_count);

  const sumDiff = (arr) => arr.reduce((s, r) => s + Math.abs(r.diff), 0);

  console.log(`\nBy category:`);
  for (const [k, v] of Object.entries(byCategory)) console.log(`  ${k}: ${v}`);
  console.log(`\nDispatcher_more total extra slabs: ${sumDiff(dispatcherMore)}`);
  console.log(`LLM_more total extra slabs:        ${sumDiff(llmMore)}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // safe-write-exempt: aggregator analysis output; not a per-bank canonical artifact.
  fs.writeFileSync(
    path.join(OUT_DIR, 'under-extraction-scope.json'),
    JSON.stringify({
      run_at: new Date().toISOString(),
      cache_dir: path.relative(REPO_ROOT, CACHE_DIR),
      banks_compared: results.length,
      by_category: byCategory,
      totals: {
        dispatcher_more_extra_slabs: sumDiff(dispatcherMore),
        llm_more_extra_slabs: sumDiff(llmMore),
      },
      results,
    }, null, 2) + '\n',
  );

  // Render markdown
  const md = renderMarkdown({ results, byCategory, dispatcherMore, llmMore, dispatcherOnly, llmOnly });
  // safe-write-exempt: aggregator analysis report; not a per-bank canonical artifact.
  fs.writeFileSync(path.join(OUT_DIR, 'under-extraction-scope.md'), md);

  console.log(`\nWrote: ${path.relative(REPO_ROOT, path.join(OUT_DIR, 'under-extraction-scope.json'))}`);
  console.log(`Wrote: ${path.relative(REPO_ROOT, path.join(OUT_DIR, 'under-extraction-scope.md'))}`);
}

function renderMarkdown({ results, byCategory, dispatcherMore, llmMore, dispatcherOnly, llmOnly }) {
  const lines = [];
  lines.push('# Sprint 003 Task #4 — dispatcher vs LLM extraction gap (measurement, not verdict)');
  lines.push('');
  lines.push(`**Run:** ${new Date().toISOString()}`);
  lines.push(`**Method:** ran \`lib/actions/extract_html_table\` (deterministic dispatcher, A3 v2) against every \`output/refresh/2026-05-13T17-29-11/fetched/<bank>__<variant>.html\` cached body and compared the slab count to the LLM-emitted count in \`output/latest/\`.`);
  lines.push(`**Sample:** ${results.length} bank-variant pairs across regular/nre/nro/fcnr/gift.`);
  lines.push('');
  lines.push('**Framing:** this measurement identifies *improvement targets* for both the dispatcher and the LLM harness, not a verdict on which extractor is "better". Both components are in our control and improvable. Categories below are buckets of work, not labels of winners and losers.');
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  lines.push('| Category | Pairs | What this is and what to do about it |');
  lines.push('|---|---:|---|');
  const labels = {
    equal: 'LLM and dispatcher agree on count. Baseline — no improvement signal here.',
    both_empty: 'Both produced zero slabs. Often PDF/image pages or extraction-failed pages. Improvement: PDF/Vision path (A4/A5) or rate-page rediscovery.',
    llm_only: 'LLM extracted slabs; dispatcher returned 0. **Dispatcher improvement target** — usually column-mapping mismatch, multi-table page where the regex picker missed the rate table, or selector-aware picking needed.',
    dispatcher_only: 'Dispatcher extracted slabs; LLM emitted 0. **LLM-harness improvement target** — prompt/budget/discovery failure where the LLM dropped a viable extraction.',
    llm_more: 'LLM > dispatcher. Either LLM caught rows the regex missed (dispatcher improvement target) OR LLM over-extracted from non-rate rows (LLM-harness improvement target). Per-bank inspection routes the case.',
    dispatcher_more: 'Dispatcher > LLM. Either LLM under-extracted (LLM-harness improvement target — e.g., missed special-tenure slabs) OR dispatcher picked up segment duplicates (dispatcher improvement target — needs canonical-table selector).',
  };
  for (const k of ['equal', 'dispatcher_more', 'llm_more', 'dispatcher_only', 'llm_only', 'both_empty']) {
    if (byCategory[k] != null) lines.push(`| ${k} | ${byCategory[k]} | ${labels[k]} |`);
  }
  lines.push('');

  const sumDiff = (arr) => arr.reduce((s, r) => s + Math.abs(r.diff), 0);
  lines.push('**Total dispatcher-extra slabs across `dispatcher_more`:** ' + sumDiff(dispatcherMore));
  lines.push('**Total LLM-extra slabs across `llm_more`:** ' + sumDiff(llmMore));
  lines.push('');
  lines.push('Both totals are mixed: each direction holds a blend of "the other extractor missed real rows" and "this extractor picked up noise". Per-bank inspection of the top N of each is what disambiguates.');
  lines.push('');

  lines.push('## Top 25 banks where dispatcher returned MORE slabs than LLM (potential under-extraction)');
  lines.push('');
  lines.push('| Bank | Variant | Type | LLM | Dispatcher | Δ |');
  lines.push('|---|---|---|---:|---:|---:|');
  for (const r of dispatcherMore.slice(0, 25)) {
    lines.push(`| \`${r.bank}\` | ${r.variant} | ${r.bank_type || '-'} | ${r.llm_count} | ${r.dispatcher_count} | +${r.diff} |`);
  }
  lines.push('');

  if (dispatcherOnly.length > 0) {
    lines.push('## Banks where the LLM emitted ZERO slabs but the dispatcher found some');
    lines.push('');
    lines.push('| Bank | Variant | Type | Dispatcher count |');
    lines.push('|---|---|---|---:|');
    for (const r of dispatcherOnly.slice(0, 25)) {
      lines.push(`| \`${r.bank}\` | ${r.variant} | ${r.bank_type || '-'} | ${r.dispatcher_count} |`);
    }
    lines.push('');
  }

  if (llmMore.length > 0) {
    lines.push('## Top 25 banks where LLM returned MORE slabs than dispatcher');
    lines.push('');
    lines.push('| Bank | Variant | Type | LLM | Dispatcher | Δ |');
    lines.push('|---|---|---|---:|---:|---:|');
    for (const r of llmMore.slice(0, 25)) {
      lines.push(`| \`${r.bank}\` | ${r.variant} | ${r.bank_type || '-'} | ${r.llm_count} | ${r.dispatcher_count} | ${r.diff} |`);
    }
    lines.push('');
  }

  if (llmOnly.length > 0) {
    lines.push('## Banks where the dispatcher returned ZERO (LLM had slabs)');
    lines.push('');
    lines.push('| Bank | Variant | Type | LLM count | Notes |');
    lines.push('|---|---|---|---:|---|');
    for (const r of llmOnly.slice(0, 25)) {
      const note = (r.dispatcher_warnings && r.dispatcher_warnings[0]) || '';
      lines.push(`| \`${r.bank}\` | ${r.variant} | ${r.bank_type || '-'} | ${r.llm_count} | ${note} |`);
    }
    lines.push('');
  }

  lines.push('## Caveats');
  lines.push('');
  lines.push('1. **Dispatcher_more does NOT prove under-extraction**: the dispatcher\'s naive "pick-all-rate-bearing-rows" heuristic produces over-extraction on banks with multiple customer segments (AB Bank style) or mirror tables (general+senior shown as separate tables). Capital SFB-style cases (LLM missed 4 special-tenure rows) are mixed in here with structural-duplicate cases.');
  lines.push('2. **LLM_more does NOT prove the dispatcher is broken**: the LLM may have caught rows in tables the regex parser failed on, OR transcribed PDF content into HTML responses, OR captured operator-curated manual rates.');
  lines.push('3. **The scope this run can establish**: how many banks have non-zero diff (the universe of candidates needing per-bank inspection). The Capital SFB case (slabs 7 vs 11) shows up here; so does AB Bank (8 vs 23). Both need different fixes — the former is a real LLM miss to plug in A3, the latter is a schema gap.');
  lines.push('4. **Banks not in this run**: any bank whose body was not cached on 2026-05-13 (97 unreachable + 65 extraction-failed + banks not in the cohort) cannot be measured here; under-extraction scope on those is unknown.');

  return lines.join('\n') + '\n';
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

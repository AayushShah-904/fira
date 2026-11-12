#!/usr/bin/env node
'use strict';

// Show Axis Bank rates in matrix form (tenure × deposit_range) per
// (variant, age_tier). Reads from output/latest/axis-bank-limited_*.json.
// Used during M2.6 verification — see sdlc/sprints/sprint-004/implementation/engine-fixes-m2.md.

const fs = require('fs');

const dom = JSON.parse(fs.readFileSync('output/latest/axis-bank-limited_rates.json', 'utf8'));
const nre = JSON.parse(fs.readFileSync('output/latest/axis-bank-limited_nre_rates.json', 'utf8'));

const RANGES = ['below_3cr', '3cr_to_5cr', '5cr_to_25cr', '25cr_to_50cr', '50cr_to_100cr', '100cr_to_200cr', '200cr_to_500cr', '500cr_to_1000cr', 'above_1000cr'];
const RANGE_HDR = {
  'below_3cr': '<3cr',
  '3cr_to_5cr': '3-5cr',
  '5cr_to_25cr': '5-25cr',
  '25cr_to_50cr': '25-50cr',
  '50cr_to_100cr': '50-100cr',
  '100cr_to_200cr': '100-200cr',
  '200cr_to_500cr': '200-500cr',
  '500cr_to_1000cr': '500-1000cr',
  'above_1000cr': '>1000cr',
};

function buildMatrix(slabs, tierFilter) {
  const matrix = new Map();
  for (const s of slabs) {
    if (tierFilter === 'general' && s.rate_general_pct == null) continue;
    if (tierFilter === 'senior' && s.rate_senior_pct == null) continue;
    const key = s.tenure_min_days + '|' + s.tenure_max_days;
    if (!matrix.has(key)) {
      matrix.set(key, { tenure_text: s.tenure_text, min: s.tenure_min_days, max: s.tenure_max_days, rates: {} });
    }
    matrix.get(key).rates[s.deposit_range] = tierFilter === 'general' ? s.rate_general_pct : s.rate_senior_pct;
  }
  return [...matrix.values()].sort((a, b) => a.min - b.min);
}

function render(title, rows) {
  console.log();
  console.log('=== ' + title + ' ===');
  const head = 'Tenure'.padEnd(34) + ' ' + RANGES.map(r => RANGE_HDR[r].padStart(9)).join(' ');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    const tenureStr = r.tenure_text.slice(0, 33).padEnd(34);
    const cells = RANGES.map(rg => {
      const v = r.rates[rg];
      return (v == null ? '-' : v.toString()).padStart(9);
    }).join(' ');
    console.log(tenureStr + ' ' + cells);
  }
}

const domGen = buildMatrix(dom.rate_slabs, 'general');
const domSr  = buildMatrix(dom.rate_slabs, 'senior');
const nreGen = buildMatrix(nre.rate_slabs, 'general');

render(`AXIS — Regular / Domestic / General age tier (${domGen.length} tenures × 9 deposit ranges)`, domGen);
render(`AXIS — Domestic / Senior Citizen age tier (${domSr.length} tenures × 9 deposit ranges)`, domSr);
render(`AXIS — NRE / General age tier (${nreGen.length} tenures × 9 deposit ranges) — NRE has no senior premium per RBI`, nreGen);

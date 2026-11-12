'use strict';

/**
 * Curate a stratified diagnostic sample of DCCBs for Sprint 002 item #3.
 *
 * Reads the Sprint 001 DCCB forensic snapshot, derives the v2 phase_outcomes
 * per bank, joins to the master CSV for state/region, and selects ~35 banks
 * (~10% of 350) covering:
 *   - reachable_uncommitted    (highest-leverage — what did agent reject?)
 *   - candidates_all_failed    (confirm "no website" pattern across regions)
 *   - found_committed_manual   (agent committed but flagged manual)
 *   - found_committed (success) (control — verify local reproducibility)
 *   - no_candidates            (rare; include if available)
 *
 * Within each cohort, prefer geographic spread across India's macro regions
 * (North / South / East / West / NorthEast / Central).
 *
 * Output: prints the proposal as a markdown table to stdout. Read-only; no
 * runs triggered.
 */

const fs = require('fs');
const path = require('path');

const FORENSIC_DIR = 'C:/sw/BharatOmni/UFA/agent-data-backup/fixed-income-yield-advisor/output/latest';
const MASTER_CSV = path.resolve(__dirname, '..', '..', 'data', 'Indian_Banks_Comprehensive_List_RBI.csv');

// --- Region mapping ---
const REGION = {
  // North
  'Delhi': 'North', 'Punjab': 'North', 'Haryana': 'North', 'Rajasthan': 'North',
  'Uttar Pradesh': 'North', 'Uttarakhand': 'North', 'Himachal Pradesh': 'North',
  'Jammu and Kashmir': 'North', 'Jammu & Kashmir': 'North', 'Ladakh': 'North',
  'Chandigarh': 'North',
  // South
  'Karnataka': 'South', 'Tamil Nadu': 'South', 'Kerala': 'South',
  'Andhra Pradesh': 'South', 'Telangana': 'South', 'Puducherry': 'South',
  // West
  'Maharashtra': 'West', 'Gujarat': 'West', 'Goa': 'West',
  'Dadra and Nagar Haveli': 'West', 'Daman and Diu': 'West',
  // East
  'West Bengal': 'East', 'Odisha': 'East', 'Bihar': 'East', 'Jharkhand': 'East',
  // North East
  'Assam': 'NorthEast', 'Arunachal Pradesh': 'NorthEast', 'Manipur': 'NorthEast',
  'Meghalaya': 'NorthEast', 'Mizoram': 'NorthEast', 'Nagaland': 'NorthEast',
  'Sikkim': 'NorthEast', 'Tripura': 'NorthEast',
  // Central
  'Madhya Pradesh': 'Central', 'Chhattisgarh': 'Central',
};

function regionOf(state) {
  if (!state) return 'Unknown';
  return REGION[state.trim()] || `Other(${state.trim()})`;
}

// --- Read master CSV (simple, no quoted-field weirdness in this file) ---
function readMaster() {
  const text = fs.readFileSync(MASTER_CSV, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    rows.push({
      name: cols[1] && cols[1].trim(),
      category: cols[2] && cols[2].trim(),
      state: cols[3] && cols[3].trim(),
      city: cols[4] && cols[4].trim(),
    });
  }
  return rows;
}

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- Classify each bank using v2 phase_outcomes logic (inline) ---
function classify(slug) {
  const finalSummaryFile = fs.existsSync(path.join(FORENSIC_DIR, slug + '_attempt2.summary.json'))
    ? slug + '_attempt2.summary.json'
    : (fs.existsSync(path.join(FORENSIC_DIR, slug + '.summary.json')) ? slug + '.summary.json' : null);
  if (!finalSummaryFile) return null;

  const j = JSON.parse(fs.readFileSync(path.join(FORENSIC_DIR, finalSummaryFile), 'utf-8'));
  const tc = j.tool_calls || [];
  const fetchOk = tc.filter((t) => /fetch_url|webfetch/i.test(t.name || '') && !t.is_error).length;
  const fetchErr = tc.filter((t) => /fetch_url|webfetch/i.test(t.name || '') && t.is_error).length;

  let cfg = null;
  if (fs.existsSync(path.join(FORENSIC_DIR, slug + '_config.json'))) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(FORENSIC_DIR, slug + '_config.json'), 'utf-8')); } catch { /* ignore */ }
  }
  let rates = null;
  if (fs.existsSync(path.join(FORENSIC_DIR, slug + '_rates.json'))) {
    try { rates = JSON.parse(fs.readFileSync(path.join(FORENSIC_DIR, slug + '_rates.json'), 'utf-8')); } catch { /* ignore */ }
  }

  // Phase 1
  let website;
  if (cfg && cfg.website && cfg.website !== '?' && cfg.scraper_type && cfg.scraper_type !== 'manual') {
    website = 'found_committed';
  } else if (cfg && cfg.website && cfg.scraper_type === 'manual') {
    website = 'found_committed_manual';
  } else if (fetchOk > 0) {
    website = 'reachable_uncommitted';
  } else if (fetchErr > 0) {
    website = 'candidates_all_failed';
  } else {
    website = 'no_candidates';
  }

  return {
    slug,
    website,
    fetch_ok: fetchOk,
    fetch_err: fetchErr,
    tool_calls: tc.length,
    config_exists: !!cfg,
    rates_slabs: rates ? (rates.rate_slabs || []).length : 0,
    extraction_confidence: rates ? rates.extraction_confidence : null,
  };
}

// --- Stratified sampling ---
const TARGET_PER_COHORT = {
  reachable_uncommitted: 15,
  candidates_all_failed: 12,
  found_committed_manual: 4,
  found_committed: 3,
  no_candidates: 1,
};

function pickStratified(byCohort, regions) {
  const picked = [];
  for (const [cohort, target] of Object.entries(TARGET_PER_COHORT)) {
    const pool = byCohort[cohort] || [];
    if (pool.length === 0) continue;

    // Group pool by region, then round-robin pick across regions to maximize spread.
    const byRegion = {};
    for (const item of pool) {
      const r = regionOf(item.state);
      if (!byRegion[r]) byRegion[r] = [];
      byRegion[r].push(item);
    }
    // Sort within each region by slug for determinism
    for (const r of Object.keys(byRegion)) byRegion[r].sort((a, b) => a.slug.localeCompare(b.slug));

    const regionsOrdered = Object.keys(byRegion).sort();
    let count = 0;
    let pass = 0;
    while (count < target && pass < 50) {
      let progress = false;
      for (const r of regionsOrdered) {
        if (count >= target) break;
        if (byRegion[r].length === 0) continue;
        const item = byRegion[r].shift();
        picked.push({ ...item, cohort, region: r });
        count += 1;
        progress = true;
      }
      pass += 1;
      if (!progress) break;
    }
  }
  return picked;
}

function selectSample() {
  const master = readMaster();
  const dccbsInMaster = master.filter((r) => r.category === 'District Central Co-operative Bank');

  const bySlug = new Map();
  for (const r of dccbsInMaster) {
    bySlug.set(slugify(r.name), r);
  }

  const byCohort = {};
  for (const [slug, meta] of bySlug) {
    const c = classify(slug);
    if (!c) continue;
    if (!byCohort[c.website]) byCohort[c.website] = [];
    byCohort[c.website].push({ ...c, name: meta.name, state: meta.state, city: meta.city });
  }

  return pickStratified(byCohort);
}

if (require.main === module) {
  const picks = selectSample();
  console.log('# DCCB diagnostic sample — Sprint 002 #3 proposal');
  console.log();
  console.log(`Total: ${picks.length} banks (target 35). Sample stratified by v2 phase_outcomes cohort and regionally spread.`);
  console.log();
  console.log('Cohort distribution:');
  const counts = {};
  for (const p of picks) counts[p.cohort] = (counts[p.cohort] || 0) + 1;
  for (const [c, n] of Object.entries(counts)) console.log(`- ${c}: ${n}`);
  console.log();
  console.log('| # | Slug | Cohort | Region | State | Cloud-run signals |');
  console.log('|---:|---|---|---|---|---|');
  picks.forEach((p, i) => {
    const sig = `fetch_ok=${p.fetch_ok}, fetch_err=${p.fetch_err}, slabs=${p.rates_slabs}`;
    console.log(`| ${i + 1} | \`${p.slug}\` | ${p.cohort} | ${p.region} | ${p.state || '?'} | ${sig} |`);
  });
}

module.exports = { selectSample };

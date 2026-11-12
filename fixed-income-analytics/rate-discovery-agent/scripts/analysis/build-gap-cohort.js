'use strict';
// Build the gap cohort: banks in the 500-cohort with NO template and NO output/latest
// rate data. Annotates each with name (from RBI CSV via slugify), category, state/city,
// any prior Tier-2 attempt (output/tier2 file + its warnings), and the registry domain.
// Emits tmp/cohorts/gap-100.json and prints a breakdown.
const fs = require('node:fs');
const path = require('node:path');
const { slugify } = require('../utils/slugify');
const REPO = path.resolve(__dirname, '..', '..');
const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'bank-domains.json'), 'utf-8'));
const cohort = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'cohorts', 'pm-refresh-2026-q2.json'), 'utf-8'));
const list = cohort.cohort || cohort.banks || cohort;
const LATEST = path.join(REPO, 'output', 'latest');
const TIER2 = path.join(REPO, 'output', 'tier2');
const VARIANTS = ['', '_gift', '_fcnr', '_nre', '_nro'];

// slug -> {name, state, city} from the RBI master CSV
const csv = fs.readFileSync(path.join(REPO, 'data', 'Indian_Banks_Comprehensive_List_RBI.csv'), 'utf-8').split(/\r?\n/);
const nameBySlug = {};
for (let i = 1; i < csv.length; i++) {
  const cols = csv[i].split(',');
  if (cols.length < 4) continue;
  const name = (cols[1] || '').trim();
  if (!name) continue;
  nameBySlug[slugify(name)] = { name, state: (cols[3] || '').trim(), city: (cols[4] || '').trim() };
}

function hasTemplate(e) { return !!(e && (e.template || e.template_fcnr || e.template_gift)); }
function hasData(slug) {
  for (const v of VARIANTS) {
    const p = path.join(LATEST, `${slug}${v}_rates.json`);
    if (!fs.existsSync(p)) continue;
    try { if ((JSON.parse(fs.readFileSync(p, 'utf-8')).rate_slabs || []).length > 0) return true; } catch {}
  }
  return false;
}
function priorTier2(slug) {
  for (const v of VARIANTS) {
    const p = path.join(TIER2, `${slug}${v}_rates.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { method: j.tier2_method || null, conf: j.extraction_confidence || null, warnings: j.warnings || [], source_url: j.source_url || null };
    } catch {}
  }
  return null;
}

const gap = [];
for (const b of list) {
  const e = reg[b.bank_code];
  if (hasTemplate(e) || hasData(b.bank_code)) continue;
  const meta = nameBySlug[b.bank_code] || {};
  gap.push({
    slug: b.bank_code,
    name: meta.name || b.bank_code.replace(/-/g, ' '),
    category: b.category,
    state: b.state || meta.state || null,
    city: meta.city || null,
    registry_domain: (e && e.domain) || null,
    registry_fd: (e && e.rate_pages && e.rate_pages.fd) || null,
    prior_tier2: priorTier2(b.bank_code),
  });
}

fs.mkdirSync(path.join(REPO, 'tmp', 'cohorts'), { recursive: true });
// safe-write-exempt: gitignored tmp/ cohort aggregator output, not a per-bank canonical artifact.
fs.writeFileSync(path.join(REPO, 'tmp', 'cohorts', 'gap-100.json'), JSON.stringify({ generated_at: new Date().toISOString(), cohort: gap }, null, 2));

const byCat = {}; let withPrior = 0, namedFromCsv = 0;
for (const g of gap) {
  byCat[g.category] = (byCat[g.category] || 0) + 1;
  if (g.prior_tier2) withPrior++;
  if (nameBySlug[g.slug]) namedFromCsv++;
}
console.log(`GAP banks: ${gap.length}`);
console.log(`  with a prior Tier-2 attempt (output/tier2 file): ${withPrior}`);
console.log(`  name resolved from RBI CSV: ${namedFromCsv}/${gap.length}`);
console.log('By category:');
Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
console.log('\nWrote tmp/cohorts/gap-100.json');

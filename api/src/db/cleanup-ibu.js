/**
 * Cleanup script for IBU banks & rates:
 * 1. Dedupe IBU banks that differ only by em-dash formatting ("Axis Bank IBU" vs "Axis Bank – IBU")
 * 2. Remove rates misclassified as 'domestic' on IBU-category banks (these should be IBU USD/etc)
 *
 * Usage: node api/src/db/cleanup-ibu.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fdrates.db');

function normIbuName(s) {
  return s.toLowerCase()
    // strip common suffixes
    .replace(/\s*(limited|ltd\.?|private|pvt\.?|p\.?l\.?c\.?|co\.?|corp\.?|corporation|company)\s*/gi, ' ')
    // strip IBU / Gift City / Bank markers
    .replace(/\s*(ibu|gift\s*city|bank|banking)\s*/gi, ' ')
    // strip punctuation and dashes (including em-dash, en-dash)
    .replace(/[.,()–—\-&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = OFF');

// Step 1: Dedupe IBU banks
const ibuBanks = db.prepare(`
  SELECT b.id, b.name FROM banks b
  JOIN bank_categories c ON c.id = b.category_id
  WHERE c.code = 'IBU' AND b.is_active = 1
  ORDER BY b.id
`).all();

const groups = {};
for (const b of ibuBanks) {
  const key = normIbuName(b.name);
  if (!groups[key]) groups[key] = [];
  groups[key].push(b);
}

const dupeGroups = Object.entries(groups).filter(([, v]) => v.length > 1);
console.log(`Found ${dupeGroups.length} IBU duplicate groups\n`);

let banksDeleted = 0;
let ratesMoved = 0;

db.transaction(() => {
  for (const [, group] of dupeGroups) {
    group.sort((a, b) => a.id - b.id);
    const keep = group[0];
    const drop = group.slice(1);

    for (const d of drop) {
      const existingKeys = new Set(db.prepare(
        `SELECT product_type || '|' || tenure_days_min || '|' || tenure_days_max as k
         FROM fd_rates WHERE bank_id = ?`
      ).all(keep.id).map(r => r.k));

      const dupeRates = db.prepare(`SELECT * FROM fd_rates WHERE bank_id = ?`).all(d.id);
      for (const r of dupeRates) {
        const k = r.product_type + '|' + r.tenure_days_min + '|' + r.tenure_days_max;
        if (existingKeys.has(k)) continue;
        db.prepare(`
          INSERT INTO fd_rates (bank_id, product_type, tenure_days_min, tenure_days_max, tenure_label,
            rate_general, rate_senior, rate_bulk_1cr, rate_staff, min_amount, max_amount, compounding,
            effective_from, effective_to, source_url, verified, verified_at, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(keep.id, r.product_type, r.tenure_days_min, r.tenure_days_max, r.tenure_label,
               r.rate_general, r.rate_senior, r.rate_bulk_1cr, r.rate_staff, r.min_amount, r.max_amount,
               r.compounding, r.effective_from, r.effective_to, r.source_url, r.verified, r.verified_at, r.notes);
        existingKeys.add(k);
        ratesMoved++;
      }

      db.prepare(`UPDATE OR IGNORE watchlist_banks SET bank_id = ? WHERE bank_id = ?`).run(keep.id, d.id);
      db.prepare(`DELETE FROM watchlist_banks WHERE bank_id = ?`).run(d.id);
      db.prepare(`DELETE FROM fd_rates WHERE bank_id = ?`).run(d.id);
      db.prepare(`DELETE FROM banks WHERE id = ?`).run(d.id);
      banksDeleted++;
      console.log(`Merged: "${d.name}" → "${keep.name}"`);
    }
  }

  // Step 2: Remove misclassified 'domestic' rates from IBU banks
  const misclassified = db.prepare(`
    SELECT r.id, b.name, r.rate_general, r.tenure_label
    FROM fd_rates r JOIN banks b ON b.id = r.bank_id
    JOIN bank_categories c ON c.id = b.category_id
    WHERE c.code = 'IBU' AND r.product_type IN ('domestic','nre','nro','tax_saver')
  `).all();

  console.log(`\nRemoving ${misclassified.length} misclassified INR rates from IBU banks:`);
  for (const r of misclassified.slice(0, 5)) {
    console.log(`  ${r.name.slice(0,30)}: ${r.rate_general}% ${r.tenure_label}`);
  }
  if (misclassified.length > 5) console.log(`  ... and ${misclassified.length - 5} more`);

  db.prepare(`
    DELETE FROM fd_rates WHERE id IN (
      SELECT r.id FROM fd_rates r
      JOIN banks b ON b.id = r.bank_id
      JOIN bank_categories c ON c.id = b.category_id
      WHERE c.code = 'IBU' AND r.product_type IN ('domestic','nre','nro','tax_saver')
    )
  `).run();

  console.log(`\n═══ Summary ═══`);
  console.log(`IBU banks merged:  ${banksDeleted}`);
  console.log(`Rates moved:       ${ratesMoved}`);
  console.log(`Misclassified rates removed: ${misclassified.length}`);
})();

db.pragma('foreign_keys = ON');
const finalBanks = db.prepare(`SELECT COUNT(*) as c FROM banks b JOIN bank_categories c ON c.id = b.category_id WHERE c.code = 'IBU' AND b.is_active = 1`).get().c;
const totalBanks = db.prepare('SELECT COUNT(*) as c FROM banks').get().c;
const totalRates = db.prepare('SELECT COUNT(*) as c FROM fd_rates').get().c;
console.log(`\nIBU banks now: ${finalBanks}`);
console.log(`Total banks: ${totalBanks}`);
console.log(`Total rates: ${totalRates}`);

db.close();

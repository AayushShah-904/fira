/**
 * Merge duplicate banks that differ only by suffix (Limited, Ltd., etc.)
 * or minor formatting. Moves rates to the older bank (lower id) and deletes
 * the duplicate. Also updates the import script's matching behaviour.
 *
 * Usage: node api/src/db/dedupe-banks.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fdrates.db');

function norm(s) {
  return s.toLowerCase()
    .replace(/\s*(limited|ltd\.?|private|pvt\.?|p\.?l\.?c\.?|co\.?|corp\.?|corporation|company|bank|banking)\s*/gi, ' ')
    .replace(/[.,()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = OFF'); // we'll manually ensure FK integrity

// Find all banks, group by normalized name + category_id
const banks = db.prepare('SELECT id, name, short_name, category_id FROM banks ORDER BY id').all();
const groups = {};
for (const b of banks) {
  const key = norm(b.name) + '|' + b.category_id;
  if (!groups[key]) groups[key] = [];
  groups[key].push(b);
}

const dupeGroups = Object.entries(groups).filter(([, v]) => v.length > 1);
console.log(`Found ${dupeGroups.length} duplicate groups\n`);

let merged = 0;
let deleted = 0;
let ratesMoved = 0;

db.transaction(() => {
  for (const [key, group] of dupeGroups) {
    // Keep the lower-id bank (has our verified data)
    group.sort((a, b) => a.id - b.id);
    const keep = group[0];
    const drop = group.slice(1);

    for (const d of drop) {
      // Move fd_rates: insert only rates that don't already exist for the keep bank
      const existingKeys = new Set(db.prepare(
        `SELECT product_type || '|' || tenure_days_min || '|' || tenure_days_max as k
         FROM fd_rates WHERE bank_id = ?`
      ).all(keep.id).map(r => r.k));

      const dupeRates = db.prepare(
        `SELECT * FROM fd_rates WHERE bank_id = ?`
      ).all(d.id);

      let insertedForThis = 0;
      for (const r of dupeRates) {
        const k = r.product_type + '|' + r.tenure_days_min + '|' + r.tenure_days_max;
        if (existingKeys.has(k)) continue; // skip duplicate tenure slab
        db.prepare(`
          INSERT INTO fd_rates (bank_id, product_type, tenure_days_min, tenure_days_max, tenure_label,
            rate_general, rate_senior, rate_bulk_1cr, rate_staff, min_amount, max_amount, compounding,
            effective_from, effective_to, source_url, verified, verified_at, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(keep.id, r.product_type, r.tenure_days_min, r.tenure_days_max, r.tenure_label,
               r.rate_general, r.rate_senior, r.rate_bulk_1cr, r.rate_staff, r.min_amount, r.max_amount,
               r.compounding, r.effective_from, r.effective_to, r.source_url, r.verified, r.verified_at, r.notes);
        existingKeys.add(k);
        insertedForThis++;
      }

      // Move watchlist entries
      db.prepare(`UPDATE OR IGNORE watchlist_banks SET bank_id = ? WHERE bank_id = ?`).run(keep.id, d.id);
      db.prepare(`DELETE FROM watchlist_banks WHERE bank_id = ?`).run(d.id);

      // Delete duplicate's rates and the bank
      db.prepare(`DELETE FROM fd_rates WHERE bank_id = ?`).run(d.id);
      db.prepare(`DELETE FROM banks WHERE id = ?`).run(d.id);

      ratesMoved += insertedForThis;
      deleted++;
      console.log(`Merged: "${d.name}" → "${keep.name}"  (+${insertedForThis} new rates)`);
    }
    merged++;
  }
})();

db.pragma('foreign_keys = ON');

const finalBanks = db.prepare('SELECT COUNT(*) as c FROM banks').get().c;
const finalRates = db.prepare('SELECT COUNT(*) as c FROM fd_rates').get().c;

console.log(`\n═══ Summary ═══`);
console.log(`Duplicate groups merged: ${merged}`);
console.log(`Duplicate banks deleted: ${deleted}`);
console.log(`Rates moved to kept banks: ${ratesMoved}`);
console.log(`Final banks: ${finalBanks}`);
console.log(`Final rates: ${finalRates}`);

db.close();

/**
 * Import rates-pack.json into FIA database.
 * Merges with existing data: our hand-verified rates take priority.
 * Adds new bank categories, banks, and rate slabs from the pack.
 *
 * Usage: node api/src/db/import-rates-pack.js <path-to-rates-pack.json>
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { importRatesPack } = require('../services/importer');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fdrates.db');
const PACK_PATH = process.argv[2] || path.join(__dirname, '../../../../Database from Samir/dist/rates-pack.json');

if (!fs.existsSync(PACK_PATH)) {
  console.error(`Pack file not found: ${PACK_PATH}`);
  process.exit(1);
}

const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
console.log(`\nLoaded rates-pack.json: ${pack.banks.length} banks, generated ${pack.generated_at}\n`);

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  try {
    const stats = importRatesPack(db, pack);

    // Print results
    console.log('\n═══ Import Results ═══');
    console.log(`Banks added:        ${stats.banksAdded}`);
    console.log(`Banks matched:      ${stats.banksMatched} (already existed)`);
    console.log(`Banks skipped:      ${stats.banksSkipped} (no category match or no rates)`);
    console.log(`Rates added:        ${stats.ratesAdded}`);
    console.log(`Rates updated:      ${stats.ratesUpdated}`);
    console.log(`Rates skipped:      ${stats.ratesSkipped} (already existed)`);
    console.log(`Rates kept (ours):  ${stats.ratesOurVerifiedKept} (our verified data preserved)`);
    console.log(`Rate differences:   ${stats.ratesDiffFound}`);

    // Final counts
    const totalBanks = db.prepare('SELECT COUNT(*) as c FROM banks').get().c;
    const totalRates = db.prepare('SELECT COUNT(*) as c FROM fd_rates').get().c;
    console.log(`\n═══ Final Database ═══`);
    console.log(`Total banks: ${totalBanks}`);
    console.log(`Total rates: ${totalRates}`);

  } catch (err) {
    console.error('Import failed:', err);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();

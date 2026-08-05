#!/usr/bin/env node
// seed-from-scraped.js
// Reads scraped-rates.json (output of scrape-rates.js) and upserts
// the rate data into the fd_rates table.
//
// Run:
//   node src/db/seed-from-scraped.js
//   node src/db/seed-from-scraped.js --file scraped-dccb-rates.json
//   node src/db/seed-from-scraped.js --dry-run   # preview without writing
//   node src/db/seed-from-scraped.js --bank SBI   # single bank only

const { getDb } = require('./connection');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : 'scraped-rates.json';
const INPUT_FILE = path.join(__dirname, fileArg);

function seedFromScraped() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`File not found: ${INPUT_FILE}`);
    console.error('Run scrape-rates.js first.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const singleBank = args.includes('--bank') ? args[args.indexOf('--bank') + 1] : null;

  const scraped = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const db = getDb();

  console.log(`📥 Seeding from scraped rates...`);
  if (dryRun) console.log('   (dry run — no database writes)\n');

  const insertRate = db.prepare(`
    INSERT OR REPLACE INTO fd_rates(
      bank_id, product_type, tenure_days_min, tenure_days_max, tenure_label,
      rate_general, rate_senior, compounding, effective_from, source_url,
      verified, notes
    ) VALUES(
      @bank_id, @product_type, @tenure_days_min, @tenure_days_max, @tenure_label,
      @rate_general, @rate_senior, @compounding, @effective_from, @source_url,
      @verified, @notes
    )
  `);

  let totalInserted = 0;
  let totalSkipped = 0;
  let banksProcessed = 0;

  const bankShorts = singleBank ? [singleBank] : Object.keys(scraped);

  for (const short of bankShorts) {
    const entry = scraped[short];
    if (!entry || !entry.rates || entry.rates.length === 0) {
      continue;
    }

    // Look up bank_id by short_name or full name
    const bank = db.prepare('SELECT id, name FROM banks WHERE short_name=? OR name=?').get(short, entry.name || short);
    if (!bank) {
      console.log(`  ⚠ Bank not found in DB: "${short}" — skipping ${entry.rates.length} rates`);
      totalSkipped += entry.rates.length;
      continue;
    }

    let inserted = 0;
    const today = new Date().toISOString().split('T')[0];

    if (!dryRun) {
      db.transaction(() => {
        for (const rate of entry.rates) {
          // Validate required fields
          if (!rate.rate_general || !rate.tenure_days_min || !rate.tenure_days_max) {
            totalSkipped++;
            continue;
          }

          try {
            insertRate.run({
              bank_id: bank.id,
              product_type: rate.product_type || 'domestic',
              tenure_days_min: rate.tenure_days_min,
              tenure_days_max: rate.tenure_days_max,
              tenure_label: rate.tenure_label || `${rate.tenure_days_min}–${rate.tenure_days_max} days`,
              rate_general: rate.rate_general,
              rate_senior: rate.rate_senior ?? null,
              compounding: 'quarterly',
              effective_from: today,
              source_url: entry.url || null,
              verified: 0,  // scraped rates are unverified until manual review
              notes: `Scraped ${entry.scraped_at?.split('T')[0] || today}`,
            });
            inserted++;
          } catch (err) {
            console.log(`    ✗ ${short} rate error: ${err.message.slice(0, 50)}`);
            totalSkipped++;
          }
        }
      })();
    } else {
      inserted = entry.rates.length;
    }

    console.log(`  ✓ ${bank.name} (${short}): ${inserted} rates${dryRun ? ' (dry run)' : ''}`);
    totalInserted += inserted;
    banksProcessed++;
  }

  console.log(`\n✅ Done. ${banksProcessed} banks, ${totalInserted} rates inserted, ${totalSkipped} skipped.`);

  if (!dryRun) {
    const totalRates = db.prepare('SELECT COUNT(*) as c FROM fd_rates').get();
    console.log(`   Total rates in DB: ${totalRates.c}`);
  }
}

try {
  seedFromScraped();
  process.exit(0);
} catch (e) {
  console.error('Seed from scraped failed:', e);
  process.exit(1);
}

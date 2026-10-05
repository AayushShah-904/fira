import { seedBanksRegistry } from '../database/seed.js';
import { scrapeAllBanks } from './index.js';

async function main() {
  console.log('=== FIRA Scraper Pipeline Execution ===');
  seedBanksRegistry();

  const isOffline = process.argv.includes('--offline') || true;
  console.log(`Starting extraction cycle (Mode: ${isOffline ? 'OFFLINE_FIXTURE' : 'LIVE'})`);

  const results = await scrapeAllBanks(isOffline);
  console.log('\n--- Scraping Execution Summary ---');
  console.table(results);
  console.log('FIRA Scraper Pipeline Finished Successfully!');
}

main().catch(err => {
  console.error('Scraper runner error:', err);
  process.exit(1);
});

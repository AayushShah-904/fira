import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Repository from './repository.js';
import getDatabase from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function seedBanksRegistry() {
  getDatabase(); // Ensure schema exists
  const registryPath = path.resolve(__dirname, '../../data/banks_registry.json');
  if (!fs.existsSync(registryPath)) {
    console.error('Error: data/banks_registry.json not found');
    return;
  }

  const banks = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  console.log(`Seeding ${banks.length} banks into SQLite...`);

  for (const bank of banks) {
    Repository.upsertBank(bank);
  }

  console.log('Bank registry seeding complete!');
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seedBanksRegistry();
}

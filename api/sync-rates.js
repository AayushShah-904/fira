#!/usr/bin/env node
/**
 * sync-rates.js
 * Downloads the latest rates-pack.json from Azure Blob Storage
 * and imports it into the local production database.
 *
 * Usage (on VM):  cd /opt/fira/api && node sync-rates.js
 *
 * Requires in /opt/fira/api/.env:
 *   RATES_PACK_URL, AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET
 *   DB_PATH=/opt/fira/data/fira.db  (optional — defaults to data/fdrates.db)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// Load .env
const envFile = path.resolve(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const trimmed = line.replace(/\r/, '').trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  });
}

const log = (msg) => console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);

async function main() {
  const ratesPackUrl = process.env.RATES_PACK_URL;
  if (!ratesPackUrl) { console.error('ERROR: RATES_PACK_URL not set in .env'); process.exit(1); }

  const cleanUrl = ratesPackUrl.split('?')[0];
  log('Downloading rates-pack from: ' + cleanUrl);

  // Authenticate with Azure
  let headers = {};
  try {
    const { DefaultAzureCredential } = require('@azure/identity');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken('https://storage.azure.com/.default');
    headers = { 'Authorization': 'Bearer ' + tokenResponse.token, 'x-ms-version': '2023-11-03' };
    log('Entra ID token acquired.');
  } catch (authErr) {
    console.error('ERROR: Failed to acquire Azure token:', authErr.message);
    process.exit(1);
  }

  // Download
  const res = await fetch(cleanUrl, { headers });
  if (!res.ok) { console.error('ERROR: HTTP ' + res.status); process.exit(1); }
  const packData = await res.json();
  log('Downloaded: ' + (packData.banks?.length ?? 0) + ' banks. Generated: ' + (packData.generated_at ?? 'unknown'));

  // Save snapshot
  const snapshotDir = path.resolve(__dirname, 'logs');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, 'rates-pack-latest.json'), JSON.stringify(packData, null, 2));
  log('Snapshot saved.');

  // Open DB
  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.resolve(__dirname, 'data', 'fdrates.db');
  if (!fs.existsSync(dbPath)) { console.error('ERROR: Database not found at ' + dbPath); process.exit(1); }
  log('Using database: ' + dbPath);

  // Import
  log('Running database import...');
  const { getDb } = require('./src/db/connection');
  const { importRatesPack } = require('./src/services/importer');
  const db = getDb();
  const stats = importRatesPack(db, packData);

  log('[SYSTEM] Database sync complete.');
  log('  - Banks added: ' + stats.banksAdded);
  log('  - Banks matched: ' + stats.banksMatched);
  log('  - Rates added: ' + stats.ratesAdded);
  log('  - Rates updated: ' + stats.ratesUpdated);
  log('  - Rates kept (ours): ' + stats.ratesOurVerifiedKept);
  log('Done.');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });

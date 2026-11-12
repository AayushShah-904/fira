#!/usr/bin/env node
'use strict';

/**
 * sync-rates-to-fira.js
 *
 * Automates the full pipeline:
 *   output/latest/*.json  →  pack/dist/rates-pack.json  →  fira-main fdrates.db
 *
 * Steps:
 *   1. Build rates-pack.json from output/latest/ (via pack/build-pack.js)
 *   2. Import rates-pack.json into fira-main's SQLite DB (via fira-main/api/src/db/import-rates-pack.js)
 *   3. Print a summary of what changed.
 *
 * Usage:
 *   node sync-rates-to-fira.js                         # full sync
 *   node sync-rates-to-fira.js --dry-run               # build pack but skip DB write
 *   node sync-rates-to-fira.js --fira-db <path>        # override DB path
 *   node sync-rates-to-fira.js --skip-build            # skip step 1, reuse existing pack/dist/rates-pack.json
 *
 * npm shortcuts (add to package.json):
 *   npm run sync:fira
 *   npm run sync:fira:dry
 */

const path = require('path');
const fs   = require('fs');
const { spawnSync } = require('child_process');

// ─── Path Resolution ─────────────────────────────────────────────────────────

const AGENT_ROOT  = __dirname;                                         // rate-discovery-agent/
const siblingFiraMain = path.resolve(AGENT_ROOT, '../../fira-main');
const monorepoRoot    = path.resolve(AGENT_ROOT, '../..');
const FIRA_ROOT       = fs.existsSync(siblingFiraMain) ? siblingFiraMain : monorepoRoot;

const PACK_BUILDER  = path.join(AGENT_ROOT, 'pack', 'build-pack.js');
const PACK_OUTPUT   = path.join(AGENT_ROOT, 'pack', 'dist', 'rates-pack.json');
const FIRA_IMPORTER = path.join(FIRA_ROOT,  'api', 'src', 'db', 'import-rates-pack.js');
const FIRA_DB       = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(FIRA_ROOT,  'api', 'data', 'fdrates.db');

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const SKIP_BUILD = args.includes('--skip-build');
const firaDbArg  = args.includes('--fira-db') ? args[args.indexOf('--fira-db') + 1] : null;
const RESOLVED_DB = firaDbArg ? path.resolve(firaDbArg) : FIRA_DB;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function banner(text) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}`);
}

function step(num, text) {
  console.log(`\n[Step ${num}] ${text}`);
}

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); }

function runScript(scriptPath, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,       // node
    [scriptPath],
    {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',     // pipe stdout/stderr directly to our terminal
    }
  );
  return result;
}

// ─── Preflight Checks ─────────────────────────────────────────────────────────

function preflight() {
  banner('sync-rates-to-fira  |  Local Rates → fira-main DB');

  console.log('\nConfiguration:');
  console.log(`  Rate-discovery root : ${AGENT_ROOT}`);
  console.log(`  fira-main root      : ${FIRA_ROOT}`);
  console.log(`  Pack output         : ${PACK_OUTPUT}`);
  console.log(`  Target DB           : ${RESOLVED_DB}`);
  console.log(`  Dry-run             : ${DRY_RUN}`);
  console.log(`  Skip pack build     : ${SKIP_BUILD}`);

  // Verify fira-main exists
  if (!fs.existsSync(FIRA_ROOT)) {
    fail(`fira-main directory not found at: ${FIRA_ROOT}`);
    fail('Make sure fira-main and rate-discovery-agent are siblings in the same parent folder.');
    process.exit(1);
  }

  // Verify importer exists
  if (!fs.existsSync(FIRA_IMPORTER)) {
    fail(`Importer script not found at: ${FIRA_IMPORTER}`);
    process.exit(1);
  }

  // Verify pack builder exists
  if (!fs.existsSync(PACK_BUILDER)) {
    fail(`Pack builder not found at: ${PACK_BUILDER}`);
    process.exit(1);
  }

  // Verify DB exists (warn but don't abort — it might be created fresh)
  if (!fs.existsSync(RESOLVED_DB)) {
    warn(`fira-main DB not found at: ${RESOLVED_DB}`);
    warn(`It will be created fresh if fira-main has never been run yet.`);
    warn(`Run 'npm run dev' in fira-main/api/ at least once to initialise the DB first.`);
  }

  // Verify output/latest has rate files
  const latestDir = path.join(AGENT_ROOT, 'output', 'latest');
  if (!fs.existsSync(latestDir)) {
    fail(`No output/latest/ directory found at: ${latestDir}`);
    fail(`Run the rate-discovery agent first to produce rate files.`);
    process.exit(1);
  }
  const rateFiles = fs.readdirSync(latestDir).filter(f => f.endsWith('_rates.json'));
  if (rateFiles.length === 0) {
    fail(`No *_rates.json files found in output/latest/.`);
    fail(`Run the rate-discovery agent first.`);
    process.exit(1);
  }
  ok(`Found ${rateFiles.length} rate file(s) in output/latest/`);
}

// ─── Step 1: Build the Rates Pack ─────────────────────────────────────────────

function buildPack() {
  if (SKIP_BUILD) {
    step(1, 'Skipping pack build (--skip-build flag set)');
    if (!fs.existsSync(PACK_OUTPUT)) {
      fail(`No existing pack found at: ${PACK_OUTPUT}`);
      fail(`Remove --skip-build to generate it.`);
      process.exit(1);
    }
    const stat = fs.statSync(PACK_OUTPUT);
    ok(`Using existing pack: ${PACK_OUTPUT} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }

  step(1, 'Building rates-pack.json from output/latest/ ...');
  console.log();

  const result = runScript(PACK_BUILDER);

  if (result.status !== 0) {
    fail(`build-pack.js failed with exit code ${result.status}`);
    process.exit(1);
  }

  // Verify output was written
  if (!fs.existsSync(PACK_OUTPUT)) {
    fail(`build-pack.js exited OK but rates-pack.json was not created at: ${PACK_OUTPUT}`);
    process.exit(1);
  }

  const stat  = fs.statSync(PACK_OUTPUT);
  const pack  = JSON.parse(fs.readFileSync(PACK_OUTPUT, 'utf8'));
  const count = pack.banks ? pack.banks.length : '?';
  ok(`rates-pack.json built: ${count} banks, ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

// ─── Step 2: Import into fira-main DB or Upload to Azure Blob ──────────────────

function importPack() {
  if (DRY_RUN) {
    step(2, 'DRY RUN — skipping database import/upload');
    console.log();
    warn('Pack was built but NOT written to the database or uploaded (--dry-run).');
    warn(`To apply changes, run without --dry-run.`);
    return;
  }

  const isCloud = process.env.BIRD_STORAGE === 'azure';

  if (isCloud) {
    step(2, 'Uploading rates-pack.json to Azure Blob Storage ...');
    console.log();

    const publishScript = path.join(AGENT_ROOT, 'pack', 'publish.js');
    const result = spawnSync(
      process.execPath,
      [publishScript],
      {
        cwd: AGENT_ROOT,
        env: process.env,
        stdio: 'inherit',
      }
    );

    if (result.status !== 0) {
      fail(`publish.js failed with exit code ${result.status}`);
      process.exit(1);
    }

    ok('Upload to Azure Blob Storage complete.');
    return;
  }

  step(2, 'Importing rates-pack.json into fira-main database ...');
  console.log();

  // Pass the pack path as argv[2] and the DB path via env var,
  // exactly as import-rates-pack.js expects them.
  const result = spawnSync(
    process.execPath,
    [FIRA_IMPORTER, PACK_OUTPUT],
    {
      cwd: path.dirname(FIRA_IMPORTER),
      env: { ...process.env, DB_PATH: RESOLVED_DB },
      stdio: 'inherit',
    }
  );

  if (result.status !== 0) {
    fail(`import-rates-pack.js failed with exit code ${result.status}`);
    process.exit(1);
  }

  ok('Import complete.');
}

// ─── Step 3: Final Summary ─────────────────────────────────────────────────────

function printSummary() {
  banner('Sync Complete');

  if (DRY_RUN) {
    console.log('\n  Mode: DRY RUN — no modifications were made.');
    console.log(`  Pack : ${PACK_OUTPUT}`);
    console.log('\n  To apply for real, run:');
    console.log('    node sync-rates-to-fira.js\n');
    return;
  }

  const isCloud = process.env.BIRD_STORAGE === 'azure';

  if (isCloud) {
    console.log('\n  ✅ Rates pack has been successfully published to Azure Blob Storage!');
    console.log(`  Pack location: ${PACK_OUTPUT}`);
    console.log('\n  Next steps:');
    console.log('    1. fira-main will fetch this file from Azure Blob Storage');
    console.log('    2. The local database on fira-main will be updated dynamically.\n');
    return;
  }

  console.log('\n  ✅ Rates are now in the local fira-main database!');
  console.log(`\n  DB location : ${RESOLVED_DB}`);
  console.log('\n  Next steps:');
  console.log('    1. Start (or restart) the fira-main API:');
  console.log('         cd fira-main/api && npm run dev');
  console.log('    2. Open the website:');
  console.log('         http://localhost:5173');
  console.log('    3. Verify rates appear correctly on the site.\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const startTime = Date.now();

  preflight();
  buildPack();
  importPack();
  printSummary();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Total time: ${elapsed}s\n`);
}

main();

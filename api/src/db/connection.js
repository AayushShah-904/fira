const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/fdrates.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH, {
    verbose: process.env.NODE_ENV === 'development' ? console.log : null,
  });

  // Apply schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);

  // Performance tuning
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -64000');
  _db.pragma('foreign_keys = ON');

  // ── Migrations ──────────────────────────────────────────────
  const userCols = _db.prepare("PRAGMA table_info(users)").all();
  if (!userCols.find(c => c.name === 'email_verified')) {
    _db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
    console.log('  ✓ Migrated: added email_verified to users');
  }
  const bankCols = _db.prepare("PRAGMA table_info(banks)").all();
  if (!bankCols.find(c => c.name === 'deposit_retail')) {
    _db.exec("ALTER TABLE banks ADD COLUMN deposit_retail INTEGER NOT NULL DEFAULT 0");
    console.log('  ✓ Migrated: added deposit_retail to banks');
  }
  if (!userCols.find(c => c.name === 'onboarding_answer')) {
    _db.exec("ALTER TABLE users ADD COLUMN onboarding_answer TEXT");
    console.log('  ✓ Migrated: added onboarding_answer to users');
  }
  if (!userCols.find(c => c.name === 'onboarding_seen')) {
    _db.exec("ALTER TABLE users ADD COLUMN onboarding_seen INTEGER NOT NULL DEFAULT 0");
    console.log('  ✓ Migrated: added onboarding_seen to users');
  }

  console.log(`✓ Database ready at ${DB_PATH}`);
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Graceful shutdown
process.on('exit', closeDb);
process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });

module.exports = { getDb, closeDb };

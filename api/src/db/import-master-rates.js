const Database = require('better-sqlite3');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || '/opt/fira/data/fira.db';
console.log('--- STARTING MASTER GRANULAR RATES IMPORT ---');
console.log('Database path:', dbPath);

const db = new Database(dbPath);

const gzPath = path.resolve(__dirname, 'master-rates.json.gz');
if (!fs.existsSync(gzPath)) {
  console.error('master-rates.json.gz not found at', gzPath);
  process.exit(1);
}

const gzBuf = fs.readFileSync(gzPath);
const jsonStr = zlib.gunzipSync(gzBuf).toString('utf8');
const pack = JSON.parse(jsonStr);

console.log('Master pack loaded: Total rates to process:', pack.rates.length);

const norm = (s) => (s || '')
  .toLowerCase()
  .replace(/\s*(limited|ltd\.?|private|pvt\.?|bank|banking|branch|head\s*office)\s*/gi, '')
  .replace(/[^a-z0-9]/g, '');

const allBanks = db.prepare('SELECT id, category_id, name, short_name FROM banks').all();
const catRows = db.prepare('SELECT id, code FROM bank_categories').all();
const catCodeById = Object.fromEntries(catRows.map(c => [c.id, c.code]));

const bankMap = {};
for (const b of allBanks) {
  const isIbu = catCodeById[b.category_id] === 'IBU';
  const prefix = isIbu ? 'ibu|' : 'dom|';
  bankMap[prefix + norm(b.name)] = b.id;
  if (b.short_name) {
    bankMap[prefix + norm(b.short_name)] = b.id;
  }
}

const SLUG_ALIASES = {
  'axis-bank-limited': { name: 'Axis Bank', isIbu: false },
  'axis-bank-ibu': { name: 'Axis Bank IBU', isIbu: true },
  'icici-bank-limited': { name: 'ICICI Bank', isIbu: false },
  'icici-bank-ibu': { name: 'ICICI Bank IBU', isIbu: true },
  'yes-bank-limited': { name: 'Yes Bank', isIbu: false },
  'yes-bank-ibu': { name: 'Yes Bank IBU', isIbu: true },
  'canara-bank': { name: 'Canara Bank', isIbu: false },
  'canara-bank-ibu': { name: 'Canara Bank IBU', isIbu: true },
  'idfc-first-bank-limited': { name: 'IDFC First Bank', isIbu: false },
  'idfc-first-bank-ibu': { name: 'IDFC First Bank IBU', isIbu: true },
  'bank-of-maharashtra': { name: 'Bank of Maharashtra', isIbu: false },
  'bank-of-maharashtra-ibu': { name: 'Bank of Maharashtra IBU', isIbu: true },
  'rbl-bank-limited': { name: 'RBL Bank Ltd.', isIbu: false },
  'rbl-bank-ibu': { name: 'RBL Bank IBU', isIbu: true },
  'au-small-finance-bank-limited': { name: 'AU Small Finance Bank', isIbu: false },
  'indian-overseas-bank': { name: 'Indian Overseas Bank', isIbu: false },
  'saraswat-co-operative-bank-ltd': { name: 'Saraswat Co-operative Bank Ltd.', isIbu: false },
  'cosmos-co-operative-bank-ltd': { name: 'Cosmos Co-operative Bank Ltd.', isIbu: false },
  'bank-of-baroda': { name: 'Bank of Baroda', isIbu: false },
  'bank-of-baroda-ibu': { name: 'Bank of Baroda IBU', isIbu: true },
  'bandhan-bank-limited': { name: 'Bandhan Bank', isIbu: false },
  'state-bank-of-india': { name: 'State Bank of India', isIbu: false },
  'state-bank-of-india-ibu': { name: 'State Bank of India IBU', isIbu: true },
  'hdfc-bank-limited': { name: 'HDFC Bank', isIbu: false },
  'hdfc-bank-ibu': { name: 'HDFC Bank IBU', isIbu: true },
};

function resolveBankId(slug) {
  const isIbu = slug.includes('ibu') || slug.includes('gift');
  const prefix = isIbu ? 'ibu|' : 'dom|';
  
  if (SLUG_ALIASES[slug]) {
    const alias = SLUG_ALIASES[slug];
    const b = allBanks.find(x => x.name.toLowerCase().includes(alias.name.toLowerCase()) && (isIbu ? catCodeById[x.category_id] === 'IBU' : catCodeById[x.category_id] !== 'IBU'));
    if (b) return b.id;
  }

  const cleanedSlug = norm(slug);
  if (bankMap[prefix + cleanedSlug]) return bankMap[prefix + cleanedSlug];

  for (const b of allBanks) {
    if (isIbu && catCodeById[b.category_id] !== 'IBU') continue;
    if (!isIbu && catCodeById[b.category_id] === 'IBU') continue;
    const n = norm(b.name);
    if (n.includes(cleanedSlug) || cleanedSlug.includes(n)) {
      return b.id;
    }
  }
  return null;
}

const insertRate = db.prepare(`
  INSERT INTO fd_rates (bank_id, product_type, tenure_days_min, tenure_days_max, tenure_label, rate_general, rate_senior, compounding, effective_from, source_url, verified)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'quarterly', ?, ?, ?)
  ON CONFLICT(bank_id, product_type, tenure_days_min, tenure_days_max) DO UPDATE SET
    rate_general = excluded.rate_general,
    rate_senior = COALESCE(excluded.rate_senior, fd_rates.rate_senior),
    tenure_label = excluded.tenure_label,
    effective_from = COALESCE(excluded.effective_from, fd_rates.effective_from),
    source_url = COALESCE(excluded.source_url, fd_rates.source_url),
    verified = 1
`);

let inserted = 0;
let skipped = 0;

db.transaction(() => {
  for (const r of pack.rates) {
    const bankId = resolveBankId(r.bank_code);
    if (!bankId) {
      skipped++;
      continue;
    }

    try {
      insertRate.run(
        bankId,
        r.product_type,
        r.tenure_days_min,
        r.tenure_days_max,
        r.tenure_label,
        r.rate_general,
        r.rate_senior || null,
        r.effective_from || null,
        r.source_url || null,
        1
      );
      inserted++;
    } catch (e) {
      skipped++;
    }
  }
})();

console.log(`\nImport complete! Successfully inserted/updated ${inserted} granular slabs across all banks! (Skipped unmapped: ${skipped})`);
const totalRates = db.prepare('SELECT count(*) as c FROM fd_rates').get().c;
console.log('Total active FD rates in production database:', totalRates);

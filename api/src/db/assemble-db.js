/**
 * assemble-db.js
 * Assembles chunk_*.txt files into /opt/fira/data/fira.db
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const targetPath = process.env.DB_PATH || '/opt/fira/data/fira.db';
const chunksDir = path.join(__dirname, 'chunks');

console.log('Assembling chunks from:', chunksDir);
const files = fs.readdirSync(chunksDir).filter(f => f.startsWith('chunk_') && f.endsWith('.txt')).sort();
console.log('Found ' + files.length + ' chunks.');

let b64 = '';
for (const f of files) {
  b64 += fs.readFileSync(path.join(chunksDir, f), 'utf8');
}
console.log('Concatenated base64 length: ' + b64.length);

const gzBuf = Buffer.from(b64, 'base64');
const dbBuf = zlib.gunzipSync(gzBuf);

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, dbBuf);
console.log('Successfully written database to: ' + targetPath + ' (size: ' + (dbBuf.length / 1024 / 1024).toFixed(2) + ' MB)');

const Database = require('better-sqlite3');
const db = new Database(targetPath);
console.log('Verification:');
console.log('  - Categories:', db.prepare('SELECT count(*) as c FROM bank_categories').get().c);
console.log('  - Banks:', db.prepare('SELECT count(*) as c FROM banks').get().c);
console.log('  - FD Rates:', db.prepare('SELECT count(*) as c FROM fd_rates').get().c);
console.log('  - Users:', db.prepare('SELECT count(*) as c FROM users').get().c);

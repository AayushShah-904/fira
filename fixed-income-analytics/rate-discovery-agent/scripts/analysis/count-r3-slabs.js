#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const files = [
  'kotak-mahindra-bank-ibu_gift_rates.json',
  'kotak-mahindra-bank-ibu_rates.json',
  'punjab-national-bank-ibu_gift_rates.json',
  'punjab-national-bank-ibu_rates.json',
  'idfc-first-bank-ibu_gift_rates.json',
  'idfc-first-bank-ibu_rates.json',
  'indian-bank-ibu_gift_rates.json',
  'indian-bank-ibu_rates.json',
  'slice-small-finance-bank-limited_rates.json',
  'the-bihar-state-co-operative-bank-ltd_rates.json',
  'sberbank_rates.json',
];
let total = 0;
for (const f of files) {
  const abs = path.resolve(__dirname, '..', '..', 'output', 'latest', f);
  try {
    const d = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const n = Array.isArray(d.rate_slabs) ? d.rate_slabs.length : 0;
    console.log(String(n).padStart(4), f);
    total += n;
  } catch (e) {
    console.log('   -', f, '(error:', e.message, ')');
  }
}
console.log('total:', total);

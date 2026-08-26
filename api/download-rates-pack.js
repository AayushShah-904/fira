// Run from: fira-main/api/  =>  node download-rates-pack.js
const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.replace(/\r/, '').split('=');
    if (k && !k.startsWith('#') && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}
async function run() {
  const cleanUrl = (process.env.RATES_PACK_URL || '').split('?')[0];
  if (!cleanUrl) throw new Error('RATES_PACK_URL not set');
  console.log('Downloading:', cleanUrl);
  const { DefaultAzureCredential } = require('@azure/identity');
  const cred = new DefaultAzureCredential();
  const token = await cred.getToken('https://storage.azure.com/.default');
  console.log('Token acquired.');
  const res = await fetch(cleanUrl, { headers: { Authorization: 'Bearer ' + token.token, 'x-ms-version': '2023-11-03' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + await res.text());
  const pack = await res.json();
  const outPath = path.resolve(__dirname, 'logs', 'rates-pack-latest.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2));
  console.log('Saved to', outPath, '| Banks:', pack.banks?.length, '| Generated:', pack.generated_at || '?');
  const cohort = ['yes-bank-limited','axis-bank-limited','au-small-finance-bank-limited','icici-bank-limited','rbl-bank-limited','idfc-first-bank-limited','canara-bank','indian-overseas-bank','bank-of-maharashtra','saraswat-co-operative-bank-ltd','cosmos-co-operative-bank-ltd'];
  console.log('\n=== NRI Cohort Summary ===');
  for (const id of cohort) {
    const b = pack.banks?.find(x => x.bank_code === id);
    if (!b) { console.log('  ' + id + ': NOT FOUND'); continue; }
    const parts = [];
    for (const [pt, pd] of Object.entries(b.products || {})) {
      for (const [st, sd] of Object.entries(pd || {})) {
        if (!sd) continue;
        const n = (sd.slabs || sd.rates || []).length;
        if (n) parts.push(pt+'/'+st+':'+n+'('+sd.effective_date+')');
      }
    }
    console.log('  ' + id + ': ' + (parts.join(' | ') || 'no slabs'));
  }
}
run().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

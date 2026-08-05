require('dotenv').config();
const { DefaultAzureCredential } = require('@azure/identity');
// using global fetch
// In Node 26/18+ global fetch is available.

async function main() {
  const ratesPackUrl = process.env.RATES_PACK_URL;
  if (!ratesPackUrl) {
    console.error('RATES_PACK_URL not set');
    return;
  }
  const cleanUrl = ratesPackUrl.split('?')[0];
  console.log('Downloading from:', cleanUrl);

  const credential = new DefaultAzureCredential();
  const tokenResponse = await credential.getToken('https://storage.azure.com/.default');
  
  const res = await fetch(cleanUrl, {
    headers: {
      'Authorization': `Bearer ${tokenResponse.token}`,
      'x-ms-version': '2023-11-03'
    }
  });

  if (!res.ok) {
    console.error('Fetch failed:', res.status, await res.text());
    return;
  }

  const data = await res.json();
  const yBanks = data.banks.filter(x => x.bank_code && (x.bank_code.toLowerCase().startsWith('y') || x.bank_code.toLowerCase().includes('yes')));
  console.log('Matching Banks:', yBanks.map(x => x.bank_code));
  if (yBanks.length > 0) {
    console.log('First matched bank:', JSON.stringify(yBanks[0], null, 2));
  }
}

main().catch(console.error);

const fs = require('fs');
const path = 'D:/College/Intership/Bharatomni Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/data/bank-domains.json';

const data = JSON.parse(fs.readFileSync(path, 'utf8'));

// 1. Fix IBU Banks
const ibuUpdates = {
  "yes-bank-ibu": "/nri/nri-deposits/nre-fixed-deposit",
  "axis-bank-ibu": "/docs/default-source/interest-rates/",
  "icici-bank-ibu": "/nri-banking/deposits/fcnr-rfc/fcnr-rfc-interest-rates",
  "rbl-bank-ibu": "/interest-rates",
  "idfc-first-bank-ibu": "/nri-banking/nri-fixed-deposit/fcnr-deposit/interest-rates",
  "canara-bank-ibu": "/pages/deposit-interest-rates",
  "bank-of-maharashtra-ibu": "/fcnr-deposits"
};

for (const [bank, url] of Object.entries(ibuUpdates)) {
  if (data[bank]) {
    data[bank].rate_pages = data[bank].rate_pages || {};
    data[bank].rate_pages.fd_gift = url;
    // ensure it's not marked as manual or unreachable
    if (data[bank].discovery_status === 'unreachable') delete data[bank].discovery_status;
    console.log(`Updated IBU URL for ${bank}`);
  }
}

// 2. Fix Cosmos Bank missing FCNR
if (data["cosmos-co-operative-bank-ltd"]) {
  data["cosmos-co-operative-bank-ltd"].rate_pages = data["cosmos-co-operative-bank-ltd"].rate_pages || {};
  if (!data["cosmos-co-operative-bank-ltd"].rate_pages.fd_fcnr) {
     data["cosmos-co-operative-bank-ltd"].rate_pages.fd_fcnr = "/nri-banking/fcnr-deposit";
     console.log('Updated Cosmos FCNR URL');
  }
}

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('Successfully patched bank-domains.json');

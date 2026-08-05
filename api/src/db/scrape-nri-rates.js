#!/usr/bin/env node
// scrape-nri-rates.js
// Scrapes NRE, NRO, FCNR, and Gift City IBU FD rates.
// These are on separate pages from domestic rates.
//
// Run:
//   node src/db/scrape-nri-rates.js
//   node src/db/scrape-nri-rates.js --resume
//   node src/db/scrape-nri-rates.js --bank "SBI"
//   node src/db/scrape-nri-rates.js --type ibu   # only Gift City

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'scraped-nri-rates.json');

// ─── BANK NRI URL MAP ─────────────────────────────────────────────────────────
// Each bank can have multiple product URLs

const BANKS = [
  // ── PSBs — NRE/NRO/FCNR ──
  { short:'SBI', urls:[
    { url:'https://sbi.co.in/web/interest-rates/deposit-rates/nre-term-deposits', products:['nre'] },
    { url:'https://sbi.co.in/web/interest-rates/deposit-rates/nro-term-deposits', products:['nro'] },
    { url:'https://sbi.co.in/web/interest-rates/deposit-rates/fcnr-b-term-deposits', products:['fcnr_usd'] },
  ]},
  { short:'PNB', urls:[
    { url:'https://www.pnbindia.in/interest-rates-on-deposits.html', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'BOB', urls:[
    { url:'https://www.bankofbaroda.in/interest-rate-and-service-charges/deposits-interest-rates', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'Canara', urls:[
    { url:'https://canarabank.com/nri-deposits', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'BOI', urls:[
    { url:'https://bankofindia.co.in/nri/nre-deposit', products:['nre'] },
    { url:'https://bankofindia.co.in/nri/fcnr-deposit', products:['fcnr_usd'] },
  ]},
  { short:'Indian Bank', urls:[
    { url:'https://indianbank.in/departments/deposit-rates/', products:['nre','nro','fcnr_usd'] },
  ]},

  // ── PVBs — NRE/NRO/FCNR ──
  { short:'HDFC', urls:[
    { url:'https://www.hdfcbank.com/personal/borrow/loan-against-assets/nri-fd-interest-rates', products:['nre','nro'] },
    { url:'https://www.hdfcbank.com/personal/save/deposits/nri-fixed-deposit/nre-fixed-deposit', products:['nre'] },
  ]},
  { short:'ICICI', urls:[
    { url:'https://www.icicibank.com/nri-banking/deposits/nre-fixed-deposit', products:['nre'] },
    { url:'https://www.icicibank.com/nri-banking/deposits/nro-fixed-deposit', products:['nro'] },
    { url:'https://www.icicibank.com/nri-banking/deposits/fcnr-deposit', products:['fcnr_usd'] },
  ]},
  { short:'Axis', urls:[
    { url:'https://www.axisbank.com/nri-banking/deposits/nre-fixed-deposits', products:['nre'] },
    { url:'https://www.axisbank.com/nri-banking/deposits/fcnr-deposits', products:['fcnr_usd'] },
  ]},
  { short:'Kotak', urls:[
    { url:'https://www.kotak.com/en/nri/deposits/nre-term-deposit.html', products:['nre'] },
    { url:'https://www.kotak.com/en/nri/deposits/fcnr-deposit.html', products:['fcnr_usd'] },
  ]},
  { short:'IndusInd', urls:[
    { url:'https://www.indusind.com/in/en/nri/deposits.html', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'Federal', urls:[
    { url:'https://www.federalbank.co.in/nri-deposits', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'IDFC First', urls:[
    { url:'https://www.idfcfirstbank.com/nri-banking/deposits/nre-fixed-deposit', products:['nre'] },
    { url:'https://www.idfcfirstbank.com/nri-banking/deposits/fcnr-deposit', products:['fcnr_usd'] },
  ]},
  { short:'Yes Bank', urls:[
    { url:'https://www.yesbank.in/nri-banking/deposits/nre-fixed-deposit', products:['nre'] },
    { url:'https://www.yesbank.in/nri-banking/deposits/fcnr-deposit', products:['fcnr_usd'] },
  ]},
  { short:'DCB', urls:[
    { url:'https://www.dcbbank.com/nri/nre-deposits', products:['nre'] },
    { url:'https://www.dcbbank.com/nri/fcnr-deposits', products:['fcnr_usd'] },
  ]},
  { short:'RBL', urls:[
    { url:'https://www.rblbank.com/nri-banking/deposits', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'Bandhan', urls:[
    { url:'https://www.bandhanbank.com/nri-deposits', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'SIB', urls:[
    { url:'https://www.southindianbank.com/nri/deposits', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'KVB', urls:[
    { url:'https://www.kvb.co.in/nri/nre-deposits/', products:['nre'] },
    { url:'https://www.kvb.co.in/nri/fcnr-deposits/', products:['fcnr_usd'] },
  ]},
  { short:'CSB', urls:[
    { url:'https://www.csb.co.in/nri-banking', products:['nre','nro','fcnr_usd'] },
  ]},
  { short:'J&K Bank', urls:[
    { url:'https://www.jkbank.com/nri/deposits.php', products:['nre','nro','fcnr_usd'] },
  ]},

  // ── SFBs — NRE/FCNR ──
  { short:'AU SFB', urls:[
    { url:'https://www.aubank.in/nri-banking', products:['nre','fcnr_usd'] },
  ]},
  { short:'Ujjivan SFB', urls:[
    { url:'https://www.ujjivansfb.in/nri-banking', products:['nre'] },
  ]},
  { short:'ESAF SFB', urls:[
    { url:'https://www.esafbank.com/nri-banking', products:['nre'] },
  ]},
  { short:'Equitas SFB', urls:[
    { url:'https://www.equitasbank.com/nri-banking', products:['nre'] },
  ]},

  // ── GIFT CITY IBUs ──
  { short:'HDFC IBU', type:'ibu', urls:[
    { url:'https://www.hdfcbank.com/personal/save/deposits/gift-city-ibu-deposit', products:['ibu_usd'] },
    { url:'https://giftcity.hdfcbank.com/deposits', products:['ibu_usd','ibu_gbp','ibu_eur'] },
  ]},
  { short:'ICICI IBU', type:'ibu', urls:[
    { url:'https://giftcity.icicibank.com/personal-banking/deposits/fixed-deposit', products:['ibu_usd','ibu_gbp','ibu_eur'] },
    { url:'https://www.icicibank.com/nri-banking/deposits/gift-city-deposit', products:['ibu_usd'] },
  ]},
  { short:'Axis IBU', type:'ibu', urls:[
    { url:'https://www.axisbank.com/nri-banking/gift-city-banking', products:['ibu_usd','ibu_gbp','ibu_eur'] },
    { url:'https://giftcity.axisbank.com/deposits', products:['ibu_usd','ibu_gbp','ibu_eur'] },
  ]},
  { short:'SBI IBU', type:'ibu', urls:[
    { url:'https://ifsc.statebank/interest-rates', products:['ibu_usd','ibu_gbp','ibu_eur'] },
    { url:'https://sbi.co.in/web/nri/deposits/gift-city-ibu', products:['ibu_usd'] },
  ]},
  { short:'Kotak IBU', type:'ibu', urls:[
    { url:'https://www.kotak.com/en/nri/gift-city-banking.html', products:['ibu_usd','ibu_gbp','ibu_eur'] },
    { url:'https://giftcity.kotak.com/deposits', products:['ibu_usd','ibu_gbp','ibu_eur'] },
  ]},
  { short:'Yes IBU', type:'ibu', urls:[
    { url:'https://www.yesbank.in/nri-banking/gift-city', products:['ibu_usd'] },
  ]},
  { short:'IndusInd IBU', type:'ibu', urls:[
    { url:'https://www.indusind.com/in/en/nri/gift-city-banking.html', products:['ibu_usd'] },
  ]},
  { short:'Federal IBU', type:'ibu', urls:[
    { url:'https://www.federalbank.co.in/gift-city-ibu', products:['ibu_usd','ibu_gbp','ibu_eur'] },
  ]},
  { short:'IDFC First IBU', type:'ibu', urls:[
    { url:'https://www.idfcfirstbank.com/nri-banking/gift-city-ibu', products:['ibu_usd','ibu_eur'] },
  ]},
  { short:'BOB IBU', type:'ibu', urls:[
    { url:'https://www.bankofbaroda.in/nri/gift-city-ibu', products:['ibu_usd'] },
  ]},
  { short:'BOI IBU', type:'ibu', urls:[
    { url:'https://bankofindia.co.in/nri/gift-city-deposit', products:['ibu_usd'] },
  ]},
  { short:'DBS IBU', type:'ibu', urls:[
    { url:'https://www.dbs.com/in/nri/gift-city-ibu.page', products:['ibu_usd'] },
  ]},
  { short:'StanChart IBU', type:'ibu', urls:[
    { url:'https://www.sc.com/in/nri-banking/gift-city/', products:['ibu_usd'] },
  ]},
  { short:'HSBC IBU', type:'ibu', urls:[
    { url:'https://www.hsbc.co.in/nri/products/gift-city/', products:['ibu_usd','ibu_gbp','ibu_eur'] },
  ]},
];

// ─── RATE EXTRACTOR ──────────────────────────────────────────────────────────

async function extractRates(page, expectedProducts) {
  return await page.evaluate((products) => {
    const rates = [];

    function isLoanTable(table) {
      let ctx = '';
      let el = table.previousElementSibling;
      for (let i = 0; i < 5 && el; i++) { ctx += ' ' + (el.textContent || '').toLowerCase(); el = el.previousElementSibling; }
      const parent = table.parentElement;
      if (parent?.previousElementSibling) ctx += ' ' + parent.previousElementSibling.textContent.toLowerCase();
      const header = (table.querySelector('tr')?.textContent || '').toLowerCase();
      ctx += ' ' + header;
      if (/\bloan\b|\badvance\b|\blending\b|\boverdraft\b/.test(ctx) && !/\bdeposit\b|\bfd\b|\bterm deposit\b/.test(ctx)) return true;
      return false;
    }

    // Detect product type from page context
    function detectProduct(table) {
      let ctx = '';
      let el = table.previousElementSibling;
      for (let i = 0; i < 5 && el; i++) { ctx += ' ' + (el.textContent || '').toLowerCase(); el = el.previousElementSibling; }
      const caption = table.querySelector('caption');
      if (caption) ctx += ' ' + caption.textContent.toLowerCase();
      const header = (table.querySelector('tr')?.textContent || '').toLowerCase();
      ctx += ' ' + header;

      if (/\bfcnr\b/.test(ctx)) {
        if (/\bgbp\b|pound|sterling/.test(ctx)) return 'fcnr_gbp';
        if (/\beur\b|euro/.test(ctx)) return 'fcnr_eur';
        if (/\bcad\b|canadian/.test(ctx)) return 'fcnr_cad';
        if (/\baud\b|australian/.test(ctx)) return 'fcnr_aud';
        return 'fcnr_usd';
      }
      if (/\bibu\b|\bgift\s*city\b|\bifsc\b/.test(ctx)) {
        if (/\bgbp\b|pound|sterling/.test(ctx)) return 'ibu_gbp';
        if (/\beur\b|euro/.test(ctx)) return 'ibu_eur';
        if (/\baed\b|dirham/.test(ctx)) return 'ibu_aed';
        return 'ibu_usd';
      }
      if (/\bnro\b/.test(ctx)) return 'nro';
      if (/\bnre\b/.test(ctx)) return 'nre';
      // Default to first expected product
      return products[0] || 'nre';
    }

    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length < 2) continue;
      if (!/\d+\.\d+/.test(table.textContent)) continue;
      if (isLoanTable(table)) continue;

      const product = detectProduct(table);

      const headerCells = rows[0].querySelectorAll('th, td');
      let tenureCol = -1, genRateCol = -1, seniorRateCol = -1;
      headerCells.forEach((cell, i) => {
        const t = cell.textContent.toLowerCase().trim();
        if (/tenure|period|slab|duration|maturity/i.test(t) && tenureCol === -1) tenureCol = i;
        if (/general|regular|normal|rate.*interest|interest.*rate|rate\s*%|roi/i.test(t) && genRateCol === -1) genRateCol = i;
        if (/senior|elderly|citizen/i.test(t) && seniorRateCol === -1) seniorRateCol = i;
      });
      if (tenureCol === -1 && headerCells.length >= 2) tenureCol = 0;
      if (genRateCol === -1 && headerCells.length >= 2) genRateCol = 1;

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].querySelectorAll('td');
        if (cells.length < 2) continue;
        const tenureText = cells[tenureCol]?.textContent?.trim() || '';
        const genText = cells[genRateCol]?.textContent?.trim() || '';
        const genMatch = genText.match(/(\d+\.?\d*)\s*%?/);
        if (!genMatch) continue;
        const genRate = parseFloat(genMatch[1]);
        // NRE/NRO: 2-10%, FCNR/IBU: 0.5-8%
        const maxRate = /fcnr|ibu/.test(product) ? 8 : 10;
        if (genRate < 0.5 || genRate > maxRate) continue;

        let seniorRate = null;
        if (seniorRateCol >= 0 && cells[seniorRateCol]) {
          const srMatch = cells[seniorRateCol].textContent.match(/(\d+\.?\d*)\s*%?/);
          if (srMatch) { const sr = parseFloat(srMatch[1]); if (sr >= genRate && sr <= maxRate + 0.5) seniorRate = sr; }
        }

        if (tenureText.length > 0 && tenureText.length < 120) {
          rates.push({
            tenure_label: tenureText.replace(/\s+/g, ' '),
            rate_general: genRate,
            rate_senior: seniorRate,
            product_type: product,
          });
        }
      }
    }

    // Also try extracting from page text if no tables found
    if (rates.length === 0) {
      const text = document.body.innerText;
      const lines = text.split('\n');
      for (const line of lines) {
        const rateMatch = line.match(/(\d+\.?\d+)\s*%/);
        const tenureMatch = line.match(/(\d+\s*(?:day|month|year|week)[s]?\s*(?:to|-|–)?\s*(?:\d+\s*(?:day|month|year)[s]?)?)/i);
        if (rateMatch && tenureMatch) {
          const rate = parseFloat(rateMatch[1]);
          if (rate >= 1 && rate <= 10) {
            rates.push({
              tenure_label: tenureMatch[1].trim(),
              rate_general: rate,
              rate_senior: null,
              product_type: products[0] || 'nre',
            });
          }
        }
      }
    }

    return rates;
  }, expectedProducts);
}

function parseTenureDays(text) {
  const t = text.toLowerCase().trim();
  let m;
  if ((m = t.match(/^(\d+)\s*days?$/))) return { min: +m[1], max: +m[1] };
  if ((m = t.match(/(\d+)\s*days?\s*(?:to|-|–)\s*(\d+)\s*days?/))) return { min: +m[1], max: +m[2] };
  if ((m = t.match(/(\d+)\s*year[s]?\s*(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*year/))) return { min: +m[1]*365, max: +m[2]*365 };
  if ((m = t.match(/(\d+)\s*year[s]?\s*(?:and above|& above)/))) return { min: +m[1]*365, max: +m[1]*365+1825 };
  if ((m = t.match(/(\d+)\s*month[s]?\s*(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*(month|year)/)))
    return { min: +m[1]*30, max: m[3].startsWith('year') ? +m[2]*365 : +m[2]*30 };
  if ((m = t.match(/^(\d+)\s*year[s]?$/))) return { min: +m[1]*365, max: +m[1]*365 };
  if ((m = t.match(/^(\d+)\s*month[s]?$/))) return { min: +m[1]*30, max: +m[1]*30 };
  return null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const singleBank = args.includes('--bank') ? args[args.indexOf('--bank') + 1] : null;
  const typeFilter = args.includes('--type') ? args[args.indexOf('--type') + 1] : null;

  let results = {};
  if (resume && fs.existsSync(OUTPUT_FILE)) {
    results = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    console.log(`Resuming — ${Object.keys(results).length} already done`);
  }

  let banksToProcess = BANKS;
  if (singleBank) banksToProcess = BANKS.filter(b => b.short === singleBank);
  if (typeFilter) banksToProcess = banksToProcess.filter(b => typeFilter === 'ibu' ? b.type === 'ibu' : b.type !== 'ibu');
  if (resume) banksToProcess = banksToProcess.filter(b => !results[b.short]);

  console.log(`\nScraping NRI/FCNR/IBU rates for ${banksToProcess.length} banks...\n`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm,ico}', r => r.abort());

  let done = 0, withRates = 0, failed = 0;

  for (const bank of banksToProcess) {
    const label = bank.short.padEnd(20);
    process.stdout.write(`  [${done+failed+1}/${banksToProcess.length}] ${label}`);

    try {
      let allRates = [];

      for (const urlEntry of bank.urls) {
        try {
          const resp = await page.goto(urlEntry.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
          if (!resp || resp.status() >= 400) continue;
          await page.waitForTimeout(1500);

          // Try clicking NRI/deposit tabs
          try {
            const tab = await page.$('a:has-text("NRE"), a:has-text("NRO"), a:has-text("FCNR"), a:has-text("Interest Rate"), button:has-text("Interest Rate")');
            if (tab) { await tab.click(); await page.waitForTimeout(1000); }
          } catch (_) {}

          const rates = await extractRates(page, urlEntry.products);
          allRates.push(...rates);
        } catch (_) { continue; }
      }

      // Dedup and post-process
      const processed = [];
      const seen = new Set();
      for (const r of allRates) {
        const tenure = parseTenureDays(r.tenure_label);
        const key = `${r.product_type}-${tenure?.min}-${tenure?.max}-${r.rate_general}`;
        if (seen.has(key)) continue;
        seen.add(key);
        processed.push({
          ...r,
          tenure_days_min: tenure?.min || null,
          tenure_days_max: tenure?.max || null,
        });
      }

      results[bank.short] = {
        type: bank.type || 'nri',
        scraped_at: new Date().toISOString(),
        rates: processed,
      };

      if (processed.length > 0) {
        const products = [...new Set(processed.map(r => r.product_type))];
        console.log(`✓ ${processed.length} rates (${products.join(', ')})`);
        withRates++;
      } else {
        console.log(`○ 0 rates`);
      }
      done++;
    } catch (err) {
      console.log(`✗ ${err.message.split('\n')[0].slice(0, 50)}`);
      failed++;
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    await page.waitForTimeout(300 + Math.random() * 500);
  }

  await browser.close();

  const totalRates = Object.values(results).reduce((s, b) => s + (b.rates?.length || 0), 0);
  const byProduct = {};
  Object.values(results).forEach(b => (b.rates || []).forEach(r => { byProduct[r.product_type] = (byProduct[r.product_type] || 0) + 1; }));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅ Done. ${done} processed, ${failed} failed.`);
  console.log(`   ${withRates} banks with rates, ${totalRates} total rows.`);
  console.log(`   By product:`, Object.entries(byProduct).map(([k,v]) => `${k}:${v}`).join(', '));
  console.log(`   Results: ${OUTPUT_FILE}`);
  console.log(`\nTo seed: node src/db/seed-from-scraped.js --file scraped-nri-rates.json`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

#!/usr/bin/env node
// scrape-nri-deep.js
// Deep scraper for NRI products — clicks through tabs, scrolls,
// waits for JS rendering, and captures full page text for parsing.
// Falls back to text-based rate extraction when tables aren't found.
//
// Uses visible browser (non-headless) for better JS compatibility.
//
// Run:
//   node src/db/scrape-nri-deep.js
//   node src/db/scrape-nri-deep.js --bank "HDFC"

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');

const OUTPUT_FILE = path.join(__dirname, 'scraped-nri-deep.json');

// ─── BANKS WITH NRI PRODUCT PAGES ────────────────────────────────────────────

const BANKS = [
  // PSBs
  { short:'SBI', pages:[
    { url:'https://sbi.co.in/web/interest-rates/deposit-rates/nre-term-deposits', product:'nre' },
    { url:'https://sbi.co.in/web/interest-rates/deposit-rates/nro-term-deposits', product:'nro' },
    { url:'https://sbi.co.in/web/interest-rates/deposit-rates/fcnr-b-term-deposits', product:'fcnr_usd' },
  ]},
  { short:'PNB', pages:[
    { url:'https://www.pnbindia.in/interest-rates-on-deposits.html', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},
  { short:'BOB', pages:[
    { url:'https://www.bankofbaroda.in/interest-rate-and-service-charges/deposits-interest-rates', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},
  { short:'BOI', pages:[
    { url:'https://bankofindia.co.in/interest-rate', product:'nre', tabs:['NRE','FCNR'] },
  ]},

  // PVBs
  { short:'HDFC', pages:[
    { url:'https://www.hdfcbank.com/personal/save/deposits/fixed-deposit/fd-interest-rate', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},
  { short:'ICICI', pages:[
    { url:'https://www.icicibank.com/Personal-Banking/account-deposit/fixed-deposit/interest-rates.page', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},
  { short:'Axis', pages:[
    { url:'https://www.axisbank.com/fixed-deposit-interest-rate', product:'nre', tabs:['NRE','FCNR'] },
  ]},
  { short:'Kotak', pages:[
    { url:'https://www.kotak.com/en/rates/interest-rates.html', product:'nre', tabs:['NRE','FCNR'] },
  ]},
  { short:'IndusInd', pages:[
    { url:'https://www.indusind.com/in/en/personal/fixed-deposit/interest-rates.html', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},
  { short:'Yes Bank', pages:[
    { url:'https://www.yesbank.in/personal-banking/yes-bank-deposits/fixed-deposits/interest-rates', product:'nre', tabs:['NRE','FCNR'] },
  ]},
  { short:'Federal', pages:[
    { url:'https://www.federalbank.co.in/deposits-interest-rate', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},
  { short:'IDFC First', pages:[
    { url:'https://www.idfcfirstbank.com/personal-banking/deposits/fixed-deposit/fd-interest-rates', product:'nre', tabs:['NRE','FCNR'] },
  ]},
  { short:'DCB', pages:[
    { url:'https://www.dcbbank.com/personal-banking/fd-interest-rates', product:'nre', tabs:['NRE','FCNR'] },
  ]},
  { short:'RBL', pages:[
    { url:'https://www.rblbank.com/fixed-deposit/fixed-deposit-interest-rates', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},
  { short:'Bandhan', pages:[
    { url:'https://www.bandhanbank.com/interest-rate', product:'nre', tabs:['NRE','FCNR'] },
  ]},
  { short:'CSB', pages:[
    { url:'https://www.csb.co.in/interest-rates', product:'nre', tabs:['NRE','NRO','FCNR'] },
  ]},

  // Gift City IBUs
  { short:'ICICI IBU', pages:[
    { url:'https://giftcity.icicibank.com/', product:'ibu_usd', tabs:['Deposit','Interest','Rate'] },
  ]},
  { short:'Axis IBU', pages:[
    { url:'https://giftcity.axisbank.com/', product:'ibu_usd', tabs:['Deposit','Interest','Rate'] },
  ]},
  { short:'SBI IBU', pages:[
    { url:'https://ifsc.statebank/', product:'ibu_usd', tabs:['Interest','Rate','Deposit'] },
  ]},
  { short:'Kotak IBU', pages:[
    { url:'https://giftcity.kotak.com/', product:'ibu_usd', tabs:['Deposit','Interest','Rate'] },
  ]},
  { short:'HDFC IBU', pages:[
    { url:'https://giftcity.hdfcbank.com/', product:'ibu_usd', tabs:['Deposit','Interest','Rate'] },
  ]},
  { short:'HSBC IBU', pages:[
    { url:'https://www.hsbc.co.in/nri/products/gift-city/', product:'ibu_usd' },
  ]},
];

// ─── TEXT-BASED RATE PARSER ──────────────────────────────────────────────────
// Extracts rates from raw page text using patterns

function parseRatesFromText(text, defaultProduct) {
  const rates = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Detect product from nearby text
  let currentProduct = defaultProduct;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();

    // Update product context
    if (/\bfcnr\b/.test(line)) {
      if (/\bgbp\b|pound/.test(line)) currentProduct = 'fcnr_gbp';
      else if (/\beur\b|euro/.test(line)) currentProduct = 'fcnr_eur';
      else if (/\bcad\b/.test(line)) currentProduct = 'fcnr_cad';
      else if (/\baud\b/.test(line)) currentProduct = 'fcnr_aud';
      else currentProduct = 'fcnr_usd';
    } else if (/\bnro\b/.test(line)) currentProduct = 'nro';
    else if (/\bnre\b/.test(line)) currentProduct = 'nre';
    else if (/\bibu\b|\bgift\s*city\b|\bifsc\b/.test(line)) {
      if (/\bgbp\b/.test(line)) currentProduct = 'ibu_gbp';
      else if (/\beur\b/.test(line)) currentProduct = 'ibu_eur';
      else currentProduct = 'ibu_usd';
    }

    // Skip loan sections
    if (/\bloan\b|\badvance\b|\boverdraft\b|\blending\b/.test(line)) continue;

    // Look for rate patterns: "X.XX%" with tenure nearby
    const rateMatches = lines[i].match(/(\d+\.?\d+)\s*%/g);
    if (!rateMatches) continue;

    // Look for tenure in the same line or adjacent lines
    const context = [lines[i-1] || '', lines[i], lines[i+1] || ''].join(' ');
    const tenureMatch = context.match(
      /(\d+\s*(?:days?|months?|years?)\s*(?:to|-|–|and\s*(?:above|upto))?\s*(?:less\s*than\s*)?\s*(?:\d+\s*(?:days?|months?|years?))?)/i
    );

    if (tenureMatch) {
      for (const rm of rateMatches) {
        const rate = parseFloat(rm);
        const maxRate = /fcnr|ibu/.test(currentProduct) ? 8 : 10;
        if (rate >= 1 && rate <= maxRate) {
          rates.push({
            tenure_label: tenureMatch[1].trim(),
            rate_general: rate,
            rate_senior: null,
            product_type: currentProduct,
          });
        }
      }
    }
  }

  return rates;
}

// ─── TABLE EXTRACTOR ─────────────────────────────────────────────────────────

async function extractFromPage(page, product) {
  // First try table extraction
  const tableRates = await page.evaluate((prod) => {
    const rates = [];
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length < 2 || !/\d+\.\d+/.test(table.textContent)) continue;

      // Skip loan tables
      let ctx = '';
      let el = table.previousElementSibling;
      for (let i = 0; i < 5 && el; i++) { ctx += ' ' + el.textContent.toLowerCase(); el = el.previousElementSibling; }
      const hdr = (table.querySelector('tr')?.textContent || '').toLowerCase();
      if (/\bloan\b|\badvance\b/.test(ctx + hdr) && !/\bdeposit\b|\bfd\b/.test(ctx + hdr)) continue;

      // Detect product
      let product = prod;
      if (/\bfcnr\b/.test(ctx + hdr)) product = 'fcnr_usd';
      else if (/\bnro\b/.test(ctx + hdr)) product = 'nro';
      else if (/\bnre\b/.test(ctx + hdr)) product = 'nre';
      else if (/\bibu\b|\bgift/i.test(ctx + hdr)) product = 'ibu_usd';

      const headerCells = rows[0].querySelectorAll('th, td');
      let tCol = -1, rCol = -1, sCol = -1;
      headerCells.forEach((c, i) => {
        const t = c.textContent.toLowerCase();
        if (/tenure|period|slab|duration/i.test(t) && tCol === -1) tCol = i;
        if (/general|regular|rate.*int|int.*rate|rate\s*%|roi/i.test(t) && rCol === -1) rCol = i;
        if (/senior|citizen/i.test(t) && sCol === -1) sCol = i;
      });
      if (tCol === -1) tCol = 0;
      if (rCol === -1) rCol = 1;

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].querySelectorAll('td');
        if (cells.length < 2) continue;
        const tenure = cells[tCol]?.textContent?.trim() || '';
        const rMatch = cells[rCol]?.textContent?.match(/(\d+\.?\d*)\s*%?/);
        if (!rMatch) continue;
        const rate = parseFloat(rMatch[1]);
        const max = /fcnr|ibu/.test(product) ? 8 : 10;
        if (rate < 0.5 || rate > max) continue;
        let sr = null;
        if (sCol >= 0 && cells[sCol]) {
          const sm = cells[sCol].textContent.match(/(\d+\.?\d*)/);
          if (sm && parseFloat(sm[1]) >= rate) sr = parseFloat(sm[1]);
        }
        rates.push({ tenure_label: tenure.replace(/\s+/g, ' ').slice(0, 100), rate_general: rate, rate_senior: sr, product_type: product });
      }
    }
    return rates;
  }, product);

  if (tableRates.length > 0) return tableRates;

  // Fallback: get full text and parse
  const text = await page.evaluate(() => document.body.innerText);
  return parseRatesFromText(text, product);
}

// ─── CLICK THROUGH TABS ─────────────────────────────────────────────────────

async function clickTab(page, tabText) {
  const selectors = [
    `a:has-text("${tabText}")`,
    `button:has-text("${tabText}")`,
    `li:has-text("${tabText}")`,
    `[role="tab"]:has-text("${tabText}")`,
    `span:has-text("${tabText}")`,
    `.tab:has-text("${tabText}")`,
    `.nav-link:has-text("${tabText}")`,
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(1500);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

function parseTenureDays(text) {
  const t = text.toLowerCase().trim();
  let m;
  if ((m = t.match(/^(\d+)\s*days?$/))) return { min: +m[1], max: +m[1] };
  if ((m = t.match(/(\d+)\s*days?\s*(?:to|-|–)\s*(\d+)\s*days?/))) return { min: +m[1], max: +m[2] };
  if ((m = t.match(/(\d+)\s*year[s]?\s*(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*year/))) return { min: +m[1]*365, max: +m[2]*365 };
  if ((m = t.match(/(\d+)\s*month[s]?\s*(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*(month|year)/)))
    return { min: +m[1]*30, max: m[3].startsWith('year') ? +m[2]*365 : +m[2]*30 };
  if ((m = t.match(/^(\d+)\s*year[s]?$/))) return { min: +m[1]*365, max: +m[1]*365 };
  if ((m = t.match(/^(\d+)\s*month[s]?$/))) return { min: +m[1]*30, max: +m[1]*30 };
  return null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const singleBank = args.includes('--bank') ? args[args.indexOf('--bank') + 1] : null;
  const resume = args.includes('--resume');

  let results = {};
  if (resume && fs.existsSync(OUTPUT_FILE)) {
    results = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  }

  let banksToProcess = singleBank ? BANKS.filter(b => b.short === singleBank) : BANKS;
  if (resume) banksToProcess = banksToProcess.filter(b => !results[b.short]);

  console.log(`\nDeep NRI/IBU scrape for ${banksToProcess.length} banks...\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-web-security'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    bypassCSP: true,
  });
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm,ico}', r => r.abort());

  let done = 0, withRates = 0;

  for (const bank of banksToProcess) {
    process.stdout.write(`  [${done+1}/${banksToProcess.length}] ${bank.short.padEnd(18)}`);
    let allRates = [];

    for (const pg of bank.pages) {
      try {
        await page.goto(pg.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2500);

        // Scroll down to load lazy content
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await page.waitForTimeout(1000);

        // Extract rates from initial view
        const initialRates = await extractFromPage(page, pg.product);
        allRates.push(...initialRates);

        // Click through tabs if specified
        if (pg.tabs) {
          for (const tab of pg.tabs) {
            const clicked = await clickTab(page, tab);
            if (clicked) {
              const tabProduct = tab.toLowerCase().includes('fcnr') ? 'fcnr_usd'
                : tab.toLowerCase().includes('nro') ? 'nro'
                : tab.toLowerCase().includes('nre') ? 'nre'
                : pg.product;
              const tabRates = await extractFromPage(page, tabProduct);
              allRates.push(...tabRates);
            }
          }
        }
      } catch (err) {
        // Page failed, continue to next
      }
    }

    // Dedup
    const seen = new Set();
    const processed = [];
    for (const r of allRates) {
      const tenure = parseTenureDays(r.tenure_label);
      const key = `${r.product_type}-${r.rate_general}-${tenure?.min}-${tenure?.max}`;
      if (seen.has(key)) continue;
      seen.add(key);
      processed.push({ ...r, tenure_days_min: tenure?.min || null, tenure_days_max: tenure?.max || null });
    }

    results[bank.short] = { scraped_at: new Date().toISOString(), rates: processed };

    if (processed.length > 0) {
      const products = [...new Set(processed.map(r => r.product_type))];
      console.log(`✓ ${processed.length} rates (${products.join(', ')})`);
      withRates++;
    } else {
      console.log(`○ 0`);
    }
    done++;

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    await page.waitForTimeout(500);
  }

  await browser.close();

  const totalRates = Object.values(results).reduce((s, b) => s + (b.rates?.length || 0), 0);
  const byProduct = {};
  Object.values(results).forEach(b => (b.rates || []).forEach(r => { byProduct[r.product_type] = (byProduct[r.product_type] || 0) + 1; }));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅ ${withRates}/${done} banks with rates, ${totalRates} total rows`);
  console.log(`   Products:`, Object.entries(byProduct).map(([k,v]) => `${k}:${v}`).join(', '));

  // Auto-seed into DB
  if (totalRates > 0) {
    console.log(`\nSeeding into DB...`);
    const db = getDb();
    const insertRate = db.prepare("INSERT OR REPLACE INTO fd_rates(bank_id, product_type, tenure_days_min, tenure_days_max, tenure_label, rate_general, rate_senior, compounding, effective_from, verified, notes) VALUES(?, ?, ?, ?, ?, ?, ?, 'quarterly', ?, 0, ?)");
    const today = new Date().toISOString().split('T')[0];
    let seeded = 0;
    db.transaction(() => {
      for (const [short, entry] of Object.entries(results)) {
        if (!entry.rates?.length) continue;
        const bank = db.prepare('SELECT id FROM banks WHERE short_name=?').get(short);
        if (!bank) continue;
        for (const r of entry.rates) {
          if (!r.tenure_days_min || !r.tenure_days_max || !r.rate_general) continue;
          if (/loan|advance/i.test(r.tenure_label)) continue;
          insertRate.run(bank.id, r.product_type, r.tenure_days_min, r.tenure_days_max, r.tenure_label, r.rate_general, r.rate_senior || null, today, 'Scraped NRI ' + today);
          seeded++;
        }
      }
    })();
    console.log(`   Seeded ${seeded} NRI rates into DB`);
    const nriCount = db.prepare("SELECT product_type, COUNT(*) as c FROM fd_rates WHERE product_type IN ('nre','nro','fcnr_usd','fcnr_gbp','fcnr_eur','ibu_usd','ibu_gbp','ibu_eur') GROUP BY product_type").all();
    nriCount.forEach(r => console.log(`   ${r.product_type}: ${r.c} rates`));
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

#!/usr/bin/env node
// scrape-rates.js
// Playwright-based FD rate scraper — NO API KEY REQUIRED
// Visits each bank's FD rate page, extracts rate tables directly from the DOM,
// and parses tenure/rate data using regex patterns.
//
// Setup:
//   cd api
//   npm install playwright --save-dev
//   npx playwright install chromium
//
// Run:
//   node src/db/scrape-rates.js
//   node src/db/scrape-rates.js --resume      # skip already-scraped banks
//   node src/db/scrape-rates.js --bank "SBI"  # single bank test
//
// Then seed:
//   node src/db/seed-from-scraped.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'scraped-rates.json');
const ERRORS_FILE = path.join(__dirname, 'scrape-errors.json');

// ─── BANK URL MAP ─────────────────────────────────────────────────────────────

const BANKS = [
  // ── PSBs ──
  { short:'SBI',          url:'https://sbi.co.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits' },
  { short:'PNB',          url:'https://www.pnbindia.in/interest-rates-on-deposits.html' },
  { short:'BOB',          url:'https://www.bankofbaroda.in/interest-rate-and-service-charges/deposits-interest-rates' },
  { short:'Canara',       url:'https://canarabank.com/interest-rates' },
  { short:'BOI',          url:'https://bankofindia.co.in/interest-rate' },
  { short:'UBI',          url:'https://www.unionbankofindia.co.in/english/interest-rate.aspx' },
  { short:'Central Bank', url:'https://www.centralbankofindia.co.in/en/interest-rate-on-deposits' },
  { short:'Indian Bank',  url:'https://indianbank.in/departments/deposit-rates/' },
  { short:'IOB',          url:'https://www.iob.in/en/domestic-nro-nre-retail-term-deposit-rates' },
  { short:'UCO',          url:'https://www.ucobank.com/English/InterestRates.aspx' },
  { short:'BOM',          url:'https://www.bankofmaharashtra.in/interest-rates' },

  // ── PVBs ──
  { short:'ICICI',        url:'https://www.icicibank.com/Personal-Banking/account-deposit/fixed-deposit/interest-rates.page' },
  { short:'Axis',         url:'https://www.axisbank.com/fixed-deposit-interest-rate' },
  { short:'Kotak',        url:'https://www.kotak.com/en/rates/interest-rates.html' },
  { short:'IndusInd',     url:'https://www.indusind.com/in/en/personal/fixed-deposit/interest-rates.html' },
  { short:'Federal',      url:'https://www.federalbank.co.in/deposits-interest-rate' },
  { short:'IDFC First',   url:'https://www.idfcfirstbank.com/personal-banking/deposits/fixed-deposit/fd-interest-rates' },
  { short:'Yes Bank',     url:'https://www.yesbank.in/personal-banking/yes-bank-deposits/fixed-deposits/interest-rates' },
  { short:'DCB',          url:'https://www.dcbbank.com/personal-banking/fd-interest-rates' },
  { short:'RBL',          url:'https://www.rblbank.com/fixed-deposit/fixed-deposit-interest-rates' },
  { short:'Bandhan',      url:'https://www.bandhanbank.com/interest-rate' },
  { short:'SIB',          url:'https://www.southindianbank.com/content/innerPages/deposit/domestic-fixed-deposit-rates.aspx' },
  { short:'Karnataka',    url:'https://www.karnatakabank.com/kb-fd' },
  { short:'KVB',          url:'https://www.kvb.co.in/interest-rates/deposit-rates/' },
  { short:'CUB',          url:'https://www.cityunionbank.com/interest-rates' },
  { short:'TMB',          url:'https://www.tmb.in/interest-rates.aspx' },
  { short:'CSB',          url:'https://www.csb.co.in/interest-rates' },
  { short:'J&K Bank',     url:'https://www.jkbank.com/interest-rates/deposit-rates.php' },

  // ── SFBs ──
  { short:'AU SFB',       url:'https://www.aubank.in/interest-rates' },
  { short:'Equitas SFB',  url:'https://www.equitasbank.com/fixed-deposits/interest-rates' },
  { short:'Suryoday SFB', url:'https://www.suryodaybank.com/interest-rates' },
  { short:'Ujjivan SFB',  url:'https://www.ujjivansfb.in/interest-rates' },
  { short:'Utkarsh SFB',  url:'https://www.utkarsh.bank/interest-rates' },
  { short:'ESAF SFB',     url:'https://www.esafbank.com/interest-rates' },
  { short:'Jana SFB',     url:'https://www.janabank.com/interest-rates/' },
  { short:'Shivalik SFB', url:'https://www.shivalikbank.com/interest-rates' },
  { short:'Unity SFB',    url:'https://www.unitysb.com/interest-rates' },
  { short:'Capital SFB',  url:'https://www.capitalbank.co.in/interest-rates' },

  // ── Scheduled UCBs ──
  { short:'Saraswat',         url:'https://www.saraswatbank.com/interest-rates' },
  { short:'SVC Bank',         url:'https://www.svcbank.com/interest-rates' },
  { short:'Cosmos Bank',      url:'https://www.cosmosbank.com/interest-rates' },
  { short:'TJSB Bank',        url:'https://www.tjsbbank.co.in/interest-rates' },
  { short:'Abhyudaya Bank',   url:'https://www.abhyudayabank.co.in/interest-rates' },
  { short:'Kalupur Bank',     url:'https://www.kalupurbank.com/interest-rates' },
  { short:'BCCB',             url:'https://www.bccb.in/interest-rates' },

  // ── State Co-op Banks ──
  { short:'Kerala Bank',      url:'https://www.keralabank.co.in/deposit-interest-rate' },
  { short:'GSCB Gujarat',     url:'https://www.gscb.org.in/interest-rates' },
  { short:'MSC Bank',         url:'https://www.mscbank.com/interest-rates' },
  { short:'HARCO Bank',       url:'https://www.harcobank.org.in/interest-rates' },
  { short:'KSCAB',            url:'https://www.kscab.org/interest-rates' },
  { short:'TNSC Bank',        url:'https://www.tamilnaduapexbank.com/interest-rates' },
  { short:'TSCAB',            url:'https://www.tscab.org/interest-rates' },
  { short:'OSCB',             url:'https://www.oscb.coop/interest-rates' },
  { short:'PSCB Punjab',      url:'https://www.pscb.in/interest-rates' },
  { short:'HPSCB',            url:'https://www.hpscb.com/interest-rates' },

  // ── DCCBs with known websites ──
  { short:'Kangra DCCB',      url:'https://www.kccb.in/interest-rates' },
  { short:'Pune DCCB',        url:'https://www.pdcc.bank.in/interest-rates' },
  { short:'Karimnagar DCCB',  url:'https://www.karimnagardccb.bank.in/interest-rates' },
  { short:'Krishna DCCB',     url:'https://www.krishnadccb.bank.in/interest-rates' },

  // ── NS-UCBs ──
  { short:'Varachha Bank',    url:'https://www.varachha.bank.in/interest-rates' },
  { short:'Indore Paraspar',  url:'https://www.indoreparaspar.com/interest-rates' },
];

// ─── TENURE PARSER ────────────────────────────────────────────────────────────

function parseTenureDays(text) {
  const t = text.toLowerCase().trim();

  // "444 days" / "555 days" — special schemes
  const exactDays = t.match(/^(\d+)\s*days?$/);
  if (exactDays) {
    const d = parseInt(exactDays[1]);
    return { min: d, max: d };
  }

  // "7 days to 14 days" / "15 days to 29 days"
  const dayRange = t.match(/(\d+)\s*days?\s*(?:to|-|–)\s*(\d+)\s*days?/);
  if (dayRange) return { min: parseInt(dayRange[1]), max: parseInt(dayRange[2]) };

  // "1 year to 2 years" / "1 year – less than 2 years"
  const yrRange = t.match(/(\d+)\s*year[s]?\s*(?:to|-|–|and above|&\s*above)/);
  if (yrRange) {
    const minYr = parseInt(yrRange[1]);
    const maxMatch = t.match(/(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*year/);
    const maxYr = maxMatch ? parseInt(maxMatch[1]) : minYr + 2;
    return { min: minYr * 365, max: maxYr * 365 };
  }

  // "6 months to 1 year" / "3 months to 6 months"
  const moRange = t.match(/(\d+)\s*month[s]?\s*(?:to|-|–)/);
  if (moRange) {
    const minMo = parseInt(moRange[1]);
    const maxMatch = t.match(/(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*(month|year)/);
    let maxDays;
    if (maxMatch) {
      maxDays = maxMatch[2].startsWith('year') ? parseInt(maxMatch[1]) * 365 : parseInt(maxMatch[1]) * 30;
    } else {
      maxDays = minMo * 30 + 180;
    }
    return { min: minMo * 30, max: maxDays };
  }

  // "1 year" exact
  const exactYr = t.match(/^(\d+)\s*year[s]?$/);
  if (exactYr) {
    const y = parseInt(exactYr[1]);
    return { min: y * 365, max: y * 365 };
  }

  // "6 months" exact
  const exactMo = t.match(/^(\d+)\s*month[s]?$/);
  if (exactMo) {
    const m = parseInt(exactMo[1]);
    return { min: m * 30, max: m * 30 };
  }

  // "46 days to 179 days" already caught above, but edge cases:
  // "above 5 years" / "5 years and above"
  const aboveYr = t.match(/(?:above|over)\s*(\d+)\s*year/);
  if (aboveYr) {
    const y = parseInt(aboveYr[1]);
    return { min: y * 365, max: y * 365 + 1825 };
  }

  return null;
}

// ─── RATE EXTRACTOR (DOM-based) ───────────────────────────────────────────────

async function extractRatesFromPage(page) {
  return await page.evaluate(() => {
    const rates = [];

    // ── Helper: check if context around a table indicates LOAN (not deposit) ──
    function isLoanTable(table) {
      // Check the table's own text for loan keywords
      const tableText = table.textContent.toLowerCase();
      // Check headings/elements ABOVE the table (previous siblings, parent headings)
      let ctx = '';
      let el = table.previousElementSibling;
      for (let i = 0; i < 5 && el; i++) {
        ctx += ' ' + (el.textContent || '').toLowerCase();
        el = el.previousElementSibling;
      }
      // Also check parent's preceding context
      const parent = table.parentElement;
      if (parent) {
        const prev = parent.previousElementSibling;
        if (prev) ctx += ' ' + (prev.textContent || '').toLowerCase();
      }
      // Check caption
      const caption = table.querySelector('caption');
      if (caption) ctx += ' ' + caption.textContent.toLowerCase();

      const loanKeywords = /\bloan\b|\badvance\b|\blending\b|\boverdraft\b|\bcash credit\b|\bgold loan\b|\bhousing loan\b|\bvehicle loan\b|\bpersonal loan\b|\bagri.*loan\b/;
      const depositKeywords = /\bdeposit\b|\bfd\b|\bfixed deposit\b|\bterm deposit\b|\bsaving\b|\brecurring\b/;

      // If context clearly says "loan" and NOT "deposit", skip it
      if (loanKeywords.test(ctx) && !depositKeywords.test(ctx)) return true;
      // If table header itself mentions loan
      const header = (table.querySelector('tr')?.textContent || '').toLowerCase();
      if (loanKeywords.test(header) && !depositKeywords.test(header)) return true;

      return false;
    }

    // Find all tables on the page
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length < 2) continue;

      const tableText = table.textContent;
      const hasPercentages = /\d+\.\d+/.test(tableText);
      if (!hasPercentages) continue;

      // SKIP tables that are clearly about loans, not deposits
      if (isLoanTable(table)) continue;

      // Determine column indices by scanning header
      const headerCells = rows[0].querySelectorAll('th, td');
      let tenureCol = -1, genRateCol = -1, seniorRateCol = -1;

      headerCells.forEach((cell, i) => {
        const t = cell.textContent.toLowerCase().trim();
        if (/tenure|period|slab|duration|deposit\s*period/i.test(t) && tenureCol === -1) tenureCol = i;
        if (/general|regular|normal|rate.*interest|interest.*rate|rate\s*%|roi/i.test(t) && genRateCol === -1) genRateCol = i;
        if (/senior|elderly|citizen/i.test(t) && seniorRateCol === -1) seniorRateCol = i;
      });

      // Fallback: if no tenure column found, assume col 0 is tenure
      if (tenureCol === -1 && headerCells.length >= 2) tenureCol = 0;
      // If no general rate column found, look for first column with percentages
      if (genRateCol === -1) {
        for (let i = 1; i < headerCells.length; i++) {
          genRateCol = i;
          break;
        }
      }

      // Parse data rows
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].querySelectorAll('td');
        if (cells.length < 2) continue;

        const tenureText = cells[tenureCol]?.textContent?.trim() || '';
        const genText = cells[genRateCol]?.textContent?.trim() || '';

        // Extract rate value
        const genMatch = genText.match(/(\d+\.?\d*)\s*%?/);
        if (!genMatch) continue;

        const genRate = parseFloat(genMatch[1]);
        // FD rates in India range from ~2.5% to ~9.5%. Anything above 10% is likely a loan rate.
        if (genRate < 2 || genRate > 10) continue;

        let seniorRate = null;
        if (seniorRateCol >= 0 && cells[seniorRateCol]) {
          const srMatch = cells[seniorRateCol].textContent.match(/(\d+\.?\d*)\s*%?/);
          if (srMatch) {
            const sr = parseFloat(srMatch[1]);
            if (sr >= genRate && sr <= 10.5) seniorRate = sr;
          }
        }

        if (tenureText.length > 0) {
          rates.push({
            tenure_label: tenureText.replace(/\s+/g, ' ').slice(0, 100),
            rate_general: genRate,
            rate_senior: seniorRate,
          });
        }
      }
    }

    // If no table found, try to extract from text patterns
    if (rates.length === 0) {
      const text = document.body.innerText;
      // Pattern: "1 year to 2 years ... 6.50%" etc
      const lines = text.split('\n');
      for (const line of lines) {
        const rateMatch = line.match(/(\d+\.?\d+)\s*%/);
        const tenureMatch = line.match(/(\d+\s*(?:day|month|year|week)[s]?\s*(?:to|-|–)?\s*(?:\d+\s*(?:day|month|year)[s]?)?)/i);
        if (rateMatch && tenureMatch) {
          const rate = parseFloat(rateMatch[1]);
          if (rate >= 2 && rate <= 15) {
            rates.push({
              tenure_label: tenureMatch[1].trim().slice(0, 100),
              rate_general: rate,
              rate_senior: null,
            });
          }
        }
      }
    }

    return rates;
  });
}

// ─── PAGE FETCHER ─────────────────────────────────────────────────────────────

async function fetchAndParse(page, url, bankName) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000); // wait for JS rendering

  // Try clicking "Interest Rates" / "FD Rates" tab if present
  try {
    const tab = await page.$('a:has-text("Interest Rate"), a:has-text("FD Rate"), a:has-text("Deposit Rate"), button:has-text("Interest Rate")');
    if (tab) {
      await tab.click();
      await page.waitForTimeout(2000);
    }
  } catch (_) {}

  // Try to expand any collapsed sections
  try {
    const expandBtns = await page.$$('button:has-text("View"), a:has-text("View All"), button:has-text("Show")');
    for (const btn of expandBtns.slice(0, 3)) {
      try { await btn.click(); await page.waitForTimeout(500); } catch (_) {}
    }
  } catch (_) {}

  const rawRates = await extractRatesFromPage(page);
  return rawRates;
}

// ─── FALLBACK URL FINDER ──────────────────────────────────────────────────────

async function tryFallbackUrls(page, primaryUrl) {
  const domain = new URL(primaryUrl).hostname.replace(/^www\./, '');
  const candidates = [
    `https://www.${domain}/interest-rates`,
    `https://www.${domain}/deposit-rates`,
    `https://www.${domain}/fd-interest-rates`,
    `https://${domain}/interest-rates`,
    `https://${domain}/deposits/interest-rates`,
  ];

  for (const url of candidates) {
    if (url === primaryUrl) continue;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      if (resp && resp.status() < 400) {
        await page.waitForTimeout(2000);
        const rates = await extractRatesFromPage(page);
        if (rates.length > 0) return { url, rates };
      }
    } catch (_) {}
  }
  return null;
}

// ─── POST-PROCESS RATES ───────────────────────────────────────────────────────

function postProcess(rawRates) {
  const processed = [];
  const seen = new Set();

  for (const r of rawRates) {
    const tenure = parseTenureDays(r.tenure_label);

    const entry = {
      tenure_label: r.tenure_label,
      tenure_days_min: tenure?.min || null,
      tenure_days_max: tenure?.max || null,
      rate_general: r.rate_general,
      rate_senior: r.rate_senior,
      product_type: 'domestic',
    };

    // Detect NRE/NRO from tenure label
    const label = r.tenure_label.toLowerCase();
    if (/\bnre\b/.test(label)) entry.product_type = 'nre';
    else if (/\bnro\b/.test(label)) entry.product_type = 'nro';
    else if (/\bfcnr\b/.test(label)) entry.product_type = 'fcnr_usd';

    // Dedup by tenure+rate
    const key = `${entry.tenure_days_min}-${entry.tenure_days_max}-${entry.rate_general}`;
    if (seen.has(key)) continue;
    seen.add(key);

    processed.push(entry);
  }

  return processed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const singleBank = args.includes('--bank') ? args[args.indexOf('--bank') + 1] : null;

  let results = {};
  let errors = {};
  if (resume && fs.existsSync(OUTPUT_FILE)) {
    results = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    console.log(`Resuming — ${Object.keys(results).length} banks already done`);
  }
  if (fs.existsSync(ERRORS_FILE)) {
    errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8'));
  }

  let banksToProcess = BANKS;
  if (singleBank) {
    banksToProcess = BANKS.filter(b => b.short === singleBank);
    if (!banksToProcess.length) {
      console.error(`Bank not found: ${singleBank}`);
      console.error('Available:', BANKS.map(b => b.short).join(', '));
      process.exit(1);
    }
  } else if (resume) {
    banksToProcess = BANKS.filter(b => !results[b.short]);
  }

  console.log(`Processing ${banksToProcess.length} banks (DOM-based parser, no API key needed)...\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Block images/fonts/media for speed
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm}', r => r.abort());

  let done = 0, failed = 0;

  for (const bank of banksToProcess) {
    process.stdout.write(`  [${done + failed + 1}/${banksToProcess.length}] ${bank.short.padEnd(20)} `);

    try {
      let rates = [];
      let usedUrl = bank.url;

      try {
        rates = await fetchAndParse(page, bank.url, bank.short);
      } catch (navErr) {
        // Primary URL failed, try fallbacks
        const fallback = await tryFallbackUrls(page, bank.url);
        if (fallback) {
          rates = fallback.rates;
          usedUrl = fallback.url;
        } else {
          throw navErr;
        }
      }

      // If primary had no rates, try fallbacks too
      if (rates.length === 0) {
        const fallback = await tryFallbackUrls(page, bank.url);
        if (fallback) {
          rates = fallback.rates;
          usedUrl = fallback.url;
        }
      }

      const processed = postProcess(rates);

      results[bank.short] = {
        url: usedUrl,
        scraped_at: new Date().toISOString(),
        rates: processed,
      };

      if (processed.length > 0) {
        console.log(`✓ ${processed.length} rates`);
      } else {
        console.log(`○ 0 rates (page loaded but no table found)`);
      }
      done++;

      // Remove from errors if previously failed
      delete errors[bank.short];

    } catch (err) {
      const msg = err.message.split('\n')[0].slice(0, 80);
      errors[bank.short] = { url: bank.url, error: msg, time: new Date().toISOString() };
      console.log(`✗ ${msg}`);
      failed++;
    }

    // Save progress after every bank
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));

    // Polite delay
    await page.waitForTimeout(1000 + Math.random() * 1500);
  }

  await browser.close();

  // Summary
  const totalRates = Object.values(results).reduce((sum, b) => sum + (b.rates?.length || 0), 0);
  const withRates = Object.values(results).filter(b => b.rates?.length > 0).length;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅ Done. ${done} succeeded, ${failed} failed.`);
  console.log(`   ${withRates} banks with rate data, ${totalRates} total rate rows.`);
  console.log(`   Results: ${OUTPUT_FILE}`);
  if (failed > 0) console.log(`   Errors:  ${ERRORS_FILE}`);
  console.log(`\nNext: node src/db/seed-from-scraped.js`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

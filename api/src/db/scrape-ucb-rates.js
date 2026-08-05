#!/usr/bin/env node
// scrape-ucb-rates.js
// Scrapes FD rates from UCB websites discovered from the CRCS PDF.
// Reads ucb-websites.json (extracted by extract-ucb-pdf.js) and visits
// each bank's website to find and parse FD rate tables.
//
// Run:
//   node src/db/scrape-ucb-rates.js
//   node src/db/scrape-ucb-rates.js --resume
//   node src/db/scrape-ucb-rates.js --limit 50
//   node src/db/scrape-ucb-rates.js --offset 100 --limit 50

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const UCB_FILE = path.join(__dirname, 'ucb-websites.json');
const OUTPUT_FILE = path.join(__dirname, 'scraped-ucb-rates.json');
const ERRORS_FILE = path.join(__dirname, 'scrape-ucb-errors.json');

const RATE_PATHS = [
  '/interest-rates',
  '/deposit-rates',
  '/',
];

async function extractRates(page) {
  return await page.evaluate(() => {
    const rates = [];

    // Check if context around a table indicates LOAN (not deposit)
    function isLoanTable(table) {
      let ctx = '';
      let el = table.previousElementSibling;
      for (let i = 0; i < 5 && el; i++) {
        ctx += ' ' + (el.textContent || '').toLowerCase();
        el = el.previousElementSibling;
      }
      const parent = table.parentElement;
      if (parent?.previousElementSibling) ctx += ' ' + parent.previousElementSibling.textContent.toLowerCase();
      const caption = table.querySelector('caption');
      if (caption) ctx += ' ' + caption.textContent.toLowerCase();
      const header = (table.querySelector('tr')?.textContent || '').toLowerCase();
      ctx += ' ' + header;

      const loanKW = /\bloan\b|\badvance\b|\blending\b|\boverdraft\b|\bcash credit\b|\bgold loan\b|\bhousing loan\b|\bvehicle loan\b|\bpersonal loan\b/;
      const depositKW = /\bdeposit\b|\bfd\b|\bfixed deposit\b|\bterm deposit\b|\bsaving\b|\brecurring\b/;
      if (loanKW.test(ctx) && !depositKW.test(ctx)) return true;
      return false;
    }

    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length < 2) continue;
      if (!/\d+\.\d+/.test(table.textContent)) continue;

      // Skip loan/advance tables
      if (isLoanTable(table)) continue;

      const headerCells = rows[0].querySelectorAll('th, td');
      let tenureCol = -1, genRateCol = -1, seniorRateCol = -1;
      headerCells.forEach((cell, i) => {
        const t = cell.textContent.toLowerCase().trim();
        if (/tenure|period|slab|duration|maturity/i.test(t) && tenureCol === -1) tenureCol = i;
        if (/general|regular|normal|rate.*interest|interest.*rate|rate\s*%|roi|rate\s*of/i.test(t) && genRateCol === -1) genRateCol = i;
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
        // FD rates in India: ~2.5% to ~9.5%. Above 10% is almost certainly a loan rate.
        if (genRate < 2 || genRate > 10) continue;
        let seniorRate = null;
        if (seniorRateCol >= 0 && cells[seniorRateCol]) {
          const srMatch = cells[seniorRateCol].textContent.match(/(\d+\.?\d*)\s*%?/);
          if (srMatch) { const sr = parseFloat(srMatch[1]); if (sr >= genRate && sr <= 10.5) seniorRate = sr; }
        }
        if (tenureText.length > 0 && tenureText.length < 120) {
          rates.push({ tenure_label: tenureText.replace(/\s+/g, ' '), rate_general: genRate, rate_senior: seniorRate });
        }
      }
    }
    return rates;
  });
}

function parseTenureDays(text) {
  const t = text.toLowerCase().trim();
  let m;
  if ((m = t.match(/^(\d+)\s*days?$/))) return { min: +m[1], max: +m[1] };
  if ((m = t.match(/(\d+)\s*days?\s*(?:to|-|–)\s*(\d+)\s*days?/))) return { min: +m[1], max: +m[2] };
  if ((m = t.match(/(\d+)\s*year[s]?\s*(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*year/))) return { min: +m[1]*365, max: +m[2]*365 };
  if ((m = t.match(/(\d+)\s*year[s]?\s*(?:and above|& above)/))) return { min: +m[1]*365, max: +m[1]*365+1825 };
  if ((m = t.match(/(\d+)\s*month[s]?\s*(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*(month|year)/))) {
    return { min: +m[1]*30, max: m[3].startsWith('year') ? +m[2]*365 : +m[2]*30 };
  }
  if ((m = t.match(/^(\d+)\s*year[s]?$/))) return { min: +m[1]*365, max: +m[1]*365 };
  if ((m = t.match(/^(\d+)\s*month[s]?$/))) return { min: +m[1]*30, max: +m[1]*30 };
  return null;
}

async function main() {
  if (!fs.existsSync(UCB_FILE)) {
    console.error('ucb-websites.json not found. Run extract-ucb-pdf.js first.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
  const offsetArg = args.includes('--offset') ? parseInt(args[args.indexOf('--offset') + 1]) : 0;

  let ucbs = JSON.parse(fs.readFileSync(UCB_FILE, 'utf8'));

  let results = {};
  let errors = {};
  if (resume && fs.existsSync(OUTPUT_FILE)) {
    results = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    const done = new Set(Object.keys(results));
    ucbs = ucbs.filter(u => !done.has(u.name));
    console.log(`Resuming — ${done.size} done, ${ucbs.length} remaining`);
  }
  if (fs.existsSync(ERRORS_FILE)) {
    try { errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8')); } catch (_) {}
  }

  ucbs = ucbs.slice(offsetArg);
  if (limitArg) ucbs = ucbs.slice(0, limitArg);

  console.log(`\nScraping ${ucbs.length} UCBs for FD rates...\n`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm,ico}', r => r.abort());

  let done = 0, withRates = 0, failed = 0;

  for (const ucb of ucbs) {
    const label = ucb.name.slice(0, 40).padEnd(42);
    process.stdout.write(`  [${done+failed+1}/${ucbs.length}] ${label}`);

    try {
      let rates = [];
      let foundUrl = null;
      const domain = ucb.website.replace(/^www\./, '');

      // Try www + non-www with each path — fast timeouts
      const urls = [
        ...RATE_PATHS.map(p => `https://www.${domain}${p}`),
        ...RATE_PATHS.map(p => `https://${domain}${p}`),
      ];
      for (const url of urls) {
        try {
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 6000 });
          if (!resp || resp.status() >= 400) continue;
          await page.waitForTimeout(1000);
          const pageRates = await extractRates(page);
          if (pageRates.length > 0) { rates = pageRates; foundUrl = url; break; }
        } catch (_) { continue; }
      }

      // Post-process
      const processed = [];
      const seen = new Set();
      for (const r of rates) {
        const tenure = parseTenureDays(r.tenure_label);
        const key = `${tenure?.min}-${tenure?.max}-${r.rate_general}`;
        if (seen.has(key)) continue;
        seen.add(key);
        processed.push({
          tenure_label: r.tenure_label,
          tenure_days_min: tenure?.min || null,
          tenure_days_max: tenure?.max || null,
          rate_general: r.rate_general,
          rate_senior: r.rate_senior,
          product_type: 'domestic',
        });
      }

      results[ucb.name] = {
        name: ucb.name,
        state: ucb.state,
        city: ucb.city,
        website: ucb.website,
        url: foundUrl,
        scraped_at: new Date().toISOString(),
        rates: processed,
      };
      if (processed.length > 0) { console.log(`✓ ${processed.length} rates`); withRates++; }
      else { console.log(`○ 0 rates`); }
      done++;
      delete errors[ucb.name];
    } catch (err) {
      errors[ucb.name] = { website: ucb.website, error: err.message.split('\n')[0].slice(0, 60), time: new Date().toISOString() };
      console.log(`✗ ${err.message.split('\n')[0].slice(0, 50)}`);
      failed++;
    }

    if ((done + failed) % 10 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
      fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));
    }
    await page.waitForTimeout(200 + Math.random() * 300);
  }

  await browser.close();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));

  const totalRates = Object.values(results).reduce((s, b) => s + (b.rates?.length || 0), 0);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅ Done. ${done} processed, ${failed} errors.`);
  console.log(`   ${withRates} UCBs with rates, ${totalRates} total rate rows.`);
  console.log(`   Results: ${OUTPUT_FILE}`);
  console.log(`\nTo seed: node src/db/seed-from-scraped.js --file scraped-ucb-rates.json`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

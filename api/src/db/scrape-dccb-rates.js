#!/usr/bin/env node
// scrape-dccb-rates.js
// Discovers and scrapes FD rates from DCCB websites.
// Most DCCBs follow predictable URL patterns for their domains.
//
// Strategy:
//   1. Try common domain patterns for each DCCB (e.g. {district}dccb.com)
//   2. Once a working domain is found, try common rate page paths
//   3. Extract rate tables from the DOM
//
// Run:
//   node src/db/scrape-dccb-rates.js
//   node src/db/scrape-dccb-rates.js --resume
//   node src/db/scrape-dccb-rates.js --state "Gujarat"
//   node src/db/scrape-dccb-rates.js --limit 50

const { chromium } = require('playwright');
const { getDb } = require('./connection');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'scraped-dccb-rates.json');
const ERRORS_FILE = path.join(__dirname, 'scrape-dccb-errors.json');

// ─── KNOWN DCCB DOMAINS (manually verified) ──────────────────────────────────
const KNOWN_DOMAINS = {
  'Kangra Central Co-operative Bank': 'kccb.in',
  'Kangra DCCB': 'kccb.in',
  'Pune District Central Co-operative Bank': 'pdcc.bank.in',
  'Pune DCCB': 'pdcc.bank.in',
  'Karimnagar District Co-operative Central Bank': 'karimnagardccb.bank.in',
  'Krishna District Co-operative Central Bank': 'krishnadccb.bank.in',
  'Ahmedabad District Co-operative Bank': 'adcbank.com',
  'Anand District Co-operative Bank': 'adcbank.net',
  'Banaskantha District Central Co-operative Bank': 'bdccb.com',
  'Surat District Co-operative Bank': 'sdcbank.co.in',
  'Mumbai District Central Co-operative Bank': 'mdccb.in',
  'Ahmednagar District Central Co-operative Bank': 'adcc.bank.in',
  'Indore District Central Co-operative Bank': 'indoredccb.com',
};

// ─── DOMAIN GUESSER ──────────────────────────────────────────────────────────

function guessDomains(bankName, city, state) {
  const candidates = [];
  const cityLower = (city || '').toLowerCase().replace(/[^a-z]/g, '');
  const districtMatch = bankName.match(/^(.+?)(?:\s+District|\s+Central|\s+Co-op)/i);
  const district = districtMatch ? districtMatch[1].toLowerCase().replace(/[^a-z]/g, '') : cityLower;

  if (!district) return candidates;

  // Common DCCB domain patterns
  const patterns = [
    `${district}dccb.com`,
    `${district}dccb.bank.in`,
    `${district}dcc.bank.in`,
    `${district}dccbank.com`,
    `${district}dccb.co.in`,
    `${district}dccb.org`,
    `${district}dccb.in`,
    `${district}centralcooperativebank.com`,
    `${district}ccb.com`,
    `${district}ccb.in`,
    `${district}cooperative.com`,
    `${district}dcc.com`,
    `www.${district}dccb.com`,
    `www.${district}dccb.bank.in`,
  ];

  // Also try city-based if different from district
  if (cityLower && cityLower !== district) {
    patterns.push(
      `${cityLower}dccb.com`,
      `${cityLower}dccb.bank.in`,
      `${cityLower}dcc.bank.in`,
    );
  }

  return [...new Set(patterns)];
}

// ─── RATE PAGE PATHS ─────────────────────────────────────────────────────────

const RATE_PATHS = [
  '/interest-rates',
  '/interest-rate',
  '/deposit-rates',
  '/fd-rates',
  '/fixed-deposit-rates',
  '/deposits/interest-rates',
  '/interest_rate.html',
  '/interest-rates.html',
  '/interest-rate.php',
  '/interest-rates.php',
  '/rates',
  '/',
];

// ─── RATE EXTRACTOR ──────────────────────────────────────────────────────────

async function extractRates(page) {
  return await page.evaluate(() => {
    const rates = [];
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length < 2) continue;

      const tableText = table.textContent;
      if (!/\d+\.\d+/.test(tableText)) continue;

      const headerCells = rows[0].querySelectorAll('th, td');
      let tenureCol = -1, genRateCol = -1, seniorRateCol = -1;

      headerCells.forEach((cell, i) => {
        const t = cell.textContent.toLowerCase().trim();
        if (/tenure|period|slab|duration|deposit.*period|maturity/i.test(t) && tenureCol === -1) tenureCol = i;
        if (/general|regular|normal|rate.*interest|interest.*rate|rate\s*%|roi|rate\s*of/i.test(t) && genRateCol === -1) genRateCol = i;
        if (/senior|elderly|citizen/i.test(t) && seniorRateCol === -1) seniorRateCol = i;
      });

      if (tenureCol === -1 && headerCells.length >= 2) tenureCol = 0;
      if (genRateCol === -1 && headerCells.length >= 2) {
        for (let i = 1; i < headerCells.length; i++) {
          const cellText = headerCells[i]?.textContent || '';
          if (/rate|%|interest|roi/i.test(cellText) || i === 1) {
            genRateCol = i;
            break;
          }
        }
      }

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].querySelectorAll('td');
        if (cells.length < 2) continue;

        const tenureText = cells[tenureCol]?.textContent?.trim() || '';
        const genText = cells[genRateCol]?.textContent?.trim() || '';

        const genMatch = genText.match(/(\d+\.?\d*)\s*%?/);
        if (!genMatch) continue;

        const genRate = parseFloat(genMatch[1]);
        if (genRate < 1 || genRate > 15) continue;

        let seniorRate = null;
        if (seniorRateCol >= 0 && cells[seniorRateCol]) {
          const srMatch = cells[seniorRateCol].textContent.match(/(\d+\.?\d*)\s*%?/);
          if (srMatch) {
            const sr = parseFloat(srMatch[1]);
            if (sr >= genRate && sr <= 15) seniorRate = sr;
          }
        }

        if (tenureText.length > 0 && tenureText.length < 120) {
          rates.push({
            tenure_label: tenureText.replace(/\s+/g, ' '),
            rate_general: genRate,
            rate_senior: seniorRate,
          });
        }
      }
    }
    return rates;
  });
}

// ─── TENURE PARSER ───────────────────────────────────────────────────────────

function parseTenureDays(text) {
  const t = text.toLowerCase().trim();
  const exactDays = t.match(/^(\d+)\s*days?$/);
  if (exactDays) { const d = parseInt(exactDays[1]); return { min: d, max: d }; }
  const dayRange = t.match(/(\d+)\s*days?\s*(?:to|-|–)\s*(\d+)\s*days?/);
  if (dayRange) return { min: parseInt(dayRange[1]), max: parseInt(dayRange[2]) };
  const yrRange = t.match(/(\d+)\s*year[s]?\s*(?:to|-|–|and above)/);
  if (yrRange) {
    const minYr = parseInt(yrRange[1]);
    const maxMatch = t.match(/(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*year/);
    return { min: minYr * 365, max: maxMatch ? parseInt(maxMatch[1]) * 365 : (minYr + 2) * 365 };
  }
  const moRange = t.match(/(\d+)\s*month[s]?\s*(?:to|-|–)/);
  if (moRange) {
    const minMo = parseInt(moRange[1]);
    const maxMatch = t.match(/(?:to|-|–)\s*(?:less than\s*)?(\d+)\s*(month|year)/);
    const maxDays = maxMatch ? (maxMatch[2].startsWith('year') ? parseInt(maxMatch[1]) * 365 : parseInt(maxMatch[1]) * 30) : minMo * 30 + 180;
    return { min: minMo * 30, max: maxDays };
  }
  const exactYr = t.match(/^(\d+)\s*year[s]?$/);
  if (exactYr) { const y = parseInt(exactYr[1]); return { min: y * 365, max: y * 365 }; }
  const exactMo = t.match(/^(\d+)\s*month[s]?$/);
  if (exactMo) { const m = parseInt(exactMo[1]); return { min: m * 30, max: m * 30 }; }
  return null;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const stateFilter = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;

  const db = getDb();
  let dccbs = db.prepare(`
    SELECT b.name, b.short_name, b.state, b.hq_city, b.website
    FROM banks b JOIN bank_categories c ON b.category_id=c.id
    WHERE c.code='DCCB' AND b.is_active=1
    ORDER BY b.state, b.name
  `).all();

  if (stateFilter) {
    dccbs = dccbs.filter(d => d.state.toLowerCase().includes(stateFilter.toLowerCase()));
  }
  if (limit) {
    dccbs = dccbs.slice(0, limit);
  }

  let results = {};
  let errors = {};
  if (resume && fs.existsSync(OUTPUT_FILE)) {
    results = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    const alreadyDone = new Set(Object.keys(results));
    dccbs = dccbs.filter(d => !alreadyDone.has(d.short_name) && !alreadyDone.has(d.name));
    console.log(`Resuming — ${alreadyDone.size} already done, ${dccbs.length} remaining`);
  }
  if (fs.existsSync(ERRORS_FILE)) {
    try { errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8')); } catch (_) {}
  }

  console.log(`\nScraping ${dccbs.length} DCCBs...\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm}', r => r.abort());

  let done = 0, withRates = 0, failed = 0;

  for (const dccb of dccbs) {
    const label = (dccb.short_name || dccb.name).slice(0, 30).padEnd(32);
    process.stdout.write(`  [${done + failed + 1}/${dccbs.length}] ${label}`);

    try {
      let rates = [];
      let foundUrl = null;

      // Build list of domains to try
      const knownDomain = KNOWN_DOMAINS[dccb.name] || KNOWN_DOMAINS[dccb.short_name];
      let domains = [];
      if (knownDomain) {
        domains.push(knownDomain);
      }
      if (dccb.website) {
        domains.push(dccb.website.replace(/^https?:\/\//, '').replace(/\/$/, ''));
      }
      domains = domains.concat(guessDomains(dccb.name, dccb.hq_city, dccb.state));
      domains = [...new Set(domains)];

      // Try each domain + path combination
      outer:
      for (const domain of domains.slice(0, 6)) { // limit to 6 domain attempts
        for (const ratePath of RATE_PATHS.slice(0, 5)) { // limit to 5 paths
          const url = `https://www.${domain.replace(/^www\./, '')}${ratePath}`;
          try {
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
            if (!resp || resp.status() >= 400) continue;
            await page.waitForTimeout(1500);

            const pageRates = await extractRates(page);
            if (pageRates.length > 0) {
              rates = pageRates;
              foundUrl = url;
              break outer;
            }
          } catch (_) {
            continue;
          }
        }
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

      const key = dccb.short_name || dccb.name;
      results[key] = {
        name: dccb.name,
        url: foundUrl,
        scraped_at: new Date().toISOString(),
        rates: processed,
      };

      if (processed.length > 0) {
        console.log(`✓ ${processed.length} rates (${foundUrl})`);
        withRates++;
      } else {
        console.log(`○ no rates found`);
      }
      done++;
      delete errors[key];

    } catch (err) {
      const key = dccb.short_name || dccb.name;
      const msg = err.message.split('\n')[0].slice(0, 60);
      errors[key] = { name: dccb.name, error: msg, time: new Date().toISOString() };
      console.log(`✗ ${msg}`);
      failed++;
    }

    // Save progress every 5 banks
    if ((done + failed) % 5 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
      fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));
    }

    // Polite delay
    await page.waitForTimeout(500 + Math.random() * 1000);
  }

  await browser.close();

  // Final save
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));

  const totalRates = Object.values(results).reduce((sum, b) => sum + (b.rates?.length || 0), 0);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`✅ Done. ${done} processed, ${failed} failed.`);
  console.log(`   ${withRates} DCCBs with rate data, ${totalRates} total rate rows.`);
  console.log(`   Results: ${OUTPUT_FILE}`);
  if (failed > 0) console.log(`   Errors:  ${ERRORS_FILE}`);
  console.log(`\nTo seed: node src/db/seed-from-scraped.js --file scraped-dccb-rates.json`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * Orch-2 debug: dump what `captureSectionContext` + `interpretSectionContext`
 * actually extract from HDFC's rendered FD page. Used to diagnose why the
 * automatic senior-exclusion and minimum-tenor rules didn't fire on the
 * real page after Orch-2's HTML hint routed NRE/NRO iterations to the
 * domestic URL.
 */

const cheerio = require('cheerio');
const { captureSectionContext, interpretSectionContext } = require('../../lib/actions/_cheerio_section_context');

const URL = process.argv[2] || 'https://www.hdfc.bank.in/fixed-deposit/fd-interest-rate';

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  console.log('Fetching:', URL);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  const html = await page.content();
  await browser.close();

  const $ = cheerio.load(html);
  const tables = $('table');
  console.log(`Found ${tables.length} tables.\n`);

  tables.each((idx, el) => {
    const $t = $(el);
    const rowCount = $t.find('tr').length;
    const colCount = $t.find('tr').first().find('th,td').length;
    console.log(`=== table[${idx}] (${rowCount} rows × ${colCount} cols) ===`);

    const firstRow = $t.find('tr').first().text().trim().replace(/\s+/g, ' ').slice(0, 100);
    const dataRow = $t.find('tr').eq(1).text().trim().replace(/\s+/g, ' ').slice(0, 100);
    console.log(`  first row: ${firstRow}`);
    console.log(`  data row : ${dataRow}`);

    const ctx = captureSectionContext($, $t, 3000);
    console.log(`  section_heading      : ${JSON.stringify(ctx.section_heading)}`);
    console.log(`  nearest_heading_text : ${JSON.stringify(ctx.nearest_heading_text)}`);
    console.log(`  effective_date_text  : ${JSON.stringify(ctx.effective_date_text)}`);
    console.log(`  notes (${ctx.notes.length}):`);
    for (const n of ctx.notes) console.log(`    - ${n}`);

    const interp = interpretSectionContext(ctx);
    console.log(`  fulfills_variants    : ${JSON.stringify(interp.fulfills_variants)} (is_default=${interp.fulfills_variants_is_default})`);
    console.log(`  senior_excluded_for  : ${JSON.stringify(interp.senior_excluded_for)}`);
    console.log(`  min_tenor_days_by_variant: ${JSON.stringify(interp.min_tenor_days_by_variant)}`);
    if (interp.raw_notes.length) {
      console.log(`  raw_notes (unrecognised):`);
      for (const r of interp.raw_notes) console.log(`    - ${r}`);
    }
    console.log();
  });
})().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
'use strict';

/**
 * Inspect HDFC's single FD page (which contains all variants — domestic + NRE
 * + NRO across <3cr and 3-5cr deposit ranges). Enumerate every <table> in
 * the rendered DOM and emit a per-table summary: nearest preceding heading,
 * row count, column count, sample rows. Used to design the orchestrator's
 * multi-table extraction (tier-header-propagation work from sprint-004
 * design).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const url = process.argv[2] || 'https://www.hdfc.bank.in/fixed-deposit/fd-interest-rate';

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
  console.log('Fetching:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  const tables = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table').forEach((tbl, idx) => {
      // Find nearest preceding heading-like text
      let heading = null;
      let walker = tbl;
      for (let depth = 0; depth < 6 && walker && walker.parentElement; depth++) {
        let sib = walker.previousElementSibling;
        while (sib && !heading) {
          const text = (sib.innerText || '').trim().replace(/\s+/g, ' ');
          if (text && text.length < 200 && (sib.matches('h1,h2,h3,h4,h5,h6,caption,strong,b') || /[A-Za-z]/.test(text))) {
            heading = text.slice(0, 150);
            break;
          }
          sib = sib.previousElementSibling;
        }
        if (heading) break;
        walker = walker.parentElement;
      }
      const rows = [];
      tbl.querySelectorAll('tr').forEach((tr) => {
        const cells = [];
        tr.querySelectorAll('th,td').forEach((c) => cells.push((c.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50)));
        if (cells.length) rows.push(cells);
      });
      out.push({
        index: idx,
        nearest_heading: heading || '(none found)',
        id: tbl.id || null,
        classes: tbl.className || null,
        rows_count: rows.length,
        cols_count: rows[0]?.length || 0,
        sample_header: rows[0] || null,
        sample_first_data_row: rows[1] || null,
        sample_last_row: rows[rows.length - 1] || null,
      });
    });
    return out;
  });

  console.log(`Found ${tables.length} tables on page.\n`);
  for (const t of tables) {
    console.log(`=== table[${t.index}] — ${t.rows_count} rows × ${t.cols_count} cols ===`);
    console.log(`  heading: ${t.nearest_heading.slice(0, 120)}`);
    if (t.id) console.log(`  id: ${t.id}`);
    if (t.classes) console.log(`  classes: ${String(t.classes).slice(0, 80)}`);
    if (t.sample_header) console.log(`  header: ${JSON.stringify(t.sample_header)}`);
    if (t.sample_first_data_row) console.log(`  first:  ${JSON.stringify(t.sample_first_data_row)}`);
    if (t.sample_last_row) console.log(`  last:   ${JSON.stringify(t.sample_last_row)}`);
    console.log();
  }

  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });

#!/usr/bin/env node
'use strict';

/**
 * Throwaway: render the HDFC NRE rate page in Playwright and dump the
 * fully-rendered HTML to /tmp so we can grep for the rate container
 * selector. Used during sprint-004 orchestrator-gap closing for the
 * HDFC NRE/NRO HTML hint authoring.
 *
 * Usage: node scripts/analysis/dump-hdfc-nre.js [url] [outpath]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const url = process.argv[2] || 'https://hdfc.bank.in/nri-banking/fixed-deposit-rupee-account/nre-fixed-deposit/rates';
const outPath = process.argv[3] || path.join(os.tmpdir(), 'hdfc-nre-rendered.html');

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  console.log('Fetching:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  // Scroll to trigger lazy content
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  const html = await page.content();
  // safe-write-exempt: analysis-script HTML dump under operator-supplied path, not a per-bank canonical artifact (ADR-012).
  fs.writeFileSync(outPath, html);
  console.log(`Wrote ${html.length} bytes to ${outPath}`);

  // Also dump a summary of likely rate containers by scanning for percentage signs in close proximity
  const containerSummary = await page.evaluate(() => {
    const results = [];
    // Find every element that contains percent signs AND tenure-like text
    const all = document.querySelectorAll('div, section, table, ul, ol, article');
    all.forEach((el) => {
      const text = el.innerText || '';
      if (!text) return;
      const pcts = (text.match(/\d+\.\d+\s*%/g) || []).length;
      if (pcts < 3) return; // require multiple rates to filter noise
      if (!/(day|month|year)/i.test(text)) return;
      // Avoid double-counting nested elements: prefer the smallest container
      const childCount = el.querySelectorAll('div, section, table, ul, ol, article').length;
      results.push({
        tagName: el.tagName,
        id: el.id || null,
        classes: el.className || null,
        percent_signs: pcts,
        text_length: text.length,
        nested_containers: childCount,
        text_sample: text.slice(0, 200).replace(/\s+/g, ' '),
      });
    });
    // Sort by text length ascending (smallest container first = most specific)
    return results.sort((a, b) => a.text_length - b.text_length).slice(0, 15);
  });
  console.log('Top 15 candidate rate containers (smallest specific first):');
  for (const c of containerSummary) {
    console.log(`  ${c.tagName}${c.id ? '#' + c.id : ''}${c.classes ? '.' + c.classes.toString().split(' ').slice(0,3).join('.') : ''} — ${c.percent_signs} rates, ${c.text_length} chars, ${c.nested_containers} nested`);
    console.log(`    sample: ${c.text_sample}`);
  }

  await browser.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

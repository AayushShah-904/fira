const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PDF_PATH = process.argv[2] || 'C:/Users/DELL/OneDrive - Bharatomni Technologies Pvt. Ltd/Communication site - Documents/03_Product/Roadmap/Unified Fixed Income Intelligence/ALL UCBs.pdf';
const OUTPUT = path.join(__dirname, 'ucb-list.json');

(async () => {
  console.log('Opening PDF:', PDF_PATH);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const fileUrl = 'file:///' + PDF_PATH.replace(/\\/g, '/').replace(/ /g, '%20');
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const text = await page.evaluate(() => document.body.innerText);
  await browser.close();

  console.log('Extracted text length:', text.length);
  console.log('---First 5000 chars---');
  console.log(text.slice(0, 5000));

  fs.writeFileSync(path.join(__dirname, 'ucb-raw-text.txt'), text);
  console.log('\nSaved raw text to ucb-raw-text.txt');
})();

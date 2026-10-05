import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { parseRate } from '../normalizer/rateParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_DIR = path.resolve(__dirname, '../../data/samples');

export function scrapeOfflineBank(bankId) {
  const fileMap = {
    sbi: 'sbi_rate_table.html',
    hdfc: 'hdfc_rates.html',
    icici: 'icici_rates.html',
    equitas: 'equitas_rates.html'
  };

  const fileName = fileMap[bankId];
  if (fileName) {
    const filePath = path.join(SAMPLES_DIR, fileName);
    if (fs.existsSync(filePath)) {
      const html = fs.readFileSync(filePath, 'utf8');
      const $ = cheerio.load(html);
      const rows = [];

      $('table tbody tr').each((_, el) => {
        const cols = $(el).find('td').map((i, c) => $(c).text().trim()).get();
        if (cols.length >= 2) {
          const tenure = cols[0];
          const rate_general = parseRate(cols[1]);
          const rate_senior = cols.length >= 3 ? parseRate(cols[2]) : null;

          if (tenure && rate_general !== null) {
            rows.push({ tenure, rate_general, rate_senior });
          }
        }
      });

      return { statusCode: 200, rows, isOfflineFixture: true };
    }
  }

  // Fallback synthetic rate generator for banks without static html fixture
  const syntheticSlabs = getSyntheticSlabsForBank(bankId);
  return { statusCode: 200, rows: syntheticSlabs, isOfflineFixture: true };
}

function getSyntheticSlabsForBank(bankId) {
  const baseRates = {
    pnb: { base: 6.75, seniorDiff: 0.50 },
    bob: { base: 6.85, seniorDiff: 0.50 },
    axis: { base: 7.10, seniorDiff: 0.50 },
    kotak: { base: 7.15, seniorDiff: 0.50 },
    au: { base: 8.00, seniorDiff: 0.50 },
    ujjivan: { base: 8.25, seniorDiff: 0.50 },
    bajaj: { base: 8.10, seniorDiff: 0.40 },
    shriram: { base: 8.40, seniorDiff: 0.50 }
  };

  const config = baseRates[bankId] || { base: 6.50, seniorDiff: 0.50 };
  const base = config.base;
  const s = config.seniorDiff;

  return [
    { tenure: '7 days to 45 days', rate_general: parseFloat((base - 3.20).toFixed(2)), rate_senior: parseFloat((base - 2.70).toFixed(2)) },
    { tenure: '46 days to 179 days', rate_general: parseFloat((base - 1.50).toFixed(2)), rate_senior: parseFloat((base - 1.00).toFixed(2)) },
    { tenure: '180 days to 364 days', rate_general: parseFloat((base - 0.50).toFixed(2)), rate_senior: parseFloat((base).toFixed(2)) },
    { tenure: '1 Year to < 2 Years', rate_general: base, rate_senior: parseFloat((base + s).toFixed(2)) },
    { tenure: '2 Years to 3 Years', rate_general: parseFloat((base + 0.20).toFixed(2)), rate_senior: parseFloat((base + 0.20 + s).toFixed(2)) },
    { tenure: '3 Years to 5 Years', rate_general: parseFloat((base - 0.10).toFixed(2)), rate_senior: parseFloat((base - 0.10 + s).toFixed(2)) },
    { tenure: '5 Years to 10 Years', rate_general: parseFloat((base - 0.25).toFixed(2)), rate_senior: parseFloat((base - 0.25 + s).toFixed(2)) }
  ];
}

export default scrapeOfflineBank;

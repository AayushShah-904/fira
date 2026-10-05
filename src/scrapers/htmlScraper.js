import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseRate } from '../normalizer/rateParser.js';

export async function scrapeHtmlBank(bankUrl) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  const response = await axios.get(bankUrl, { headers, timeout: 8000 });
  const html = response.data;
  const $ = cheerio.load(html);
  const rows = [];

  $('table').each((tableIdx, tableEl) => {
    $(tableEl).find('tr').each((rowIdx, rowEl) => {
      const cols = $(rowEl).find('th, td').map((i, el) => $(el).text().trim()).get();
      if (cols.length >= 2) {
        const tenureText = cols[0];
        const rateGeneral = parseRate(cols[1]);
        const rateSenior = cols.length >= 3 ? parseRate(cols[2]) : null;

        if (tenureText && rateGeneral !== null) {
          rows.push({
            tenure: tenureText,
            rate_general: rateGeneral,
            rate_senior: rateSenior
          });
        }
      }
    });
  });

  return { statusCode: response.status, rows, html };
}

export default scrapeHtmlBank;

const fs = require('fs');
const path = require('path');
const { extractEffectiveDate } = require('../lib/extract-date');
const { qcRatesPayload } = require('../lib/rates-qc');

const latestDir = path.join(__dirname, '..', 'output', 'latest');
const files = fs.readdirSync(latestDir).filter(f => f.endsWith('.json') && !f.includes('config') && !f.includes('summary'));

let updatedCount = 0;

console.log(`Scanning ${files.length} rate files in ${latestDir}...`);

for (const file of files) {
  const filePath = path.join(latestDir, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    continue;
  }

  // Run QC to calculate/update data_quality metadata
  if (data.effective_date) {
    const qcResult = qcRatesPayload(data, { extractionMethod: data.extraction_method || 'automatic_html_static' });
    fs.writeFileSync(filePath, JSON.stringify(qcResult.payload, null, 2), 'utf8');
    updatedCount++;
    continue;
  }

  // Combine available text sources
  const textParts = [];
  if (data.source_url) textParts.push(data.source_url);
  if (data.notes) textParts.push(data.notes);
  if (Array.isArray(data.warnings)) textParts.push(data.warnings.join(' '));
  if (Array.isArray(data.rate_slabs)) {
    data.rate_slabs.forEach(s => {
      if (s.source_row_text) textParts.push(s.source_row_text);
      if (s.tenure_text) textParts.push(s.tenure_text);
    });
  }

  const combinedText = textParts.join('\n');
  const extractedDate = extractEffectiveDate(combinedText, { pdfMode: true, sourceUrl: data.source_url, scrapedAt: data.scraped_at, fallbackToScrapedAt: true });

  if (extractedDate) {
    data.effective_date = extractedDate;
    
    // Run QC
    const qcResult = qcRatesPayload(data, { extractionMethod: data.extraction_method || 'automatic_html_static' });
    
    fs.writeFileSync(filePath, JSON.stringify(qcResult.payload, null, 2), 'utf8');
    console.log(`[UPDATED] ${file} ==> effective_date: ${qcResult.payload.effective_date}`);
    updatedCount++;
  } else {
    console.log(`[NO DATE MATCH] ${file}`);
  }
}

console.log(`\nRe-extraction complete! Updated ${updatedCount} files.`);

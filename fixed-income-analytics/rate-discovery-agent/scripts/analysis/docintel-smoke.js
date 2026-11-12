#!/usr/bin/env node
'use strict';

/**
 * M3 smoke test — exercise Azure Document Intelligence Layout API.
 *
 * Usage:
 *   node scripts/analysis/test-docintel-smoke.js <image-or-pdf-path-or-url>
 *
 * Env required:
 *   AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
 *   AZURE_DOCUMENT_INTELLIGENCE_KEY
 *
 * Reports page count, table count, and per-table (rows × cols). When the
 * input is a URL, uses the SDK's URL-based analyse method; otherwise reads
 * the file from disk.
 */

require('dotenv').config();
const fs = require('fs');
const { DocumentAnalysisClient, AzureKeyCredential } = require('@azure/ai-form-recognizer');

const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
if (!endpoint || !key) {
  console.error('Missing AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT or AZURE_DOCUMENT_INTELLIGENCE_KEY in env.');
  process.exit(1);
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/analysis/test-docintel-smoke.js <path-or-url>');
  process.exit(1);
}

(async () => {
  const client = new DocumentAnalysisClient(endpoint, new AzureKeyCredential(key));
  const isUrl = /^https?:\/\//.test(input);
  console.log(`Analysing ${isUrl ? 'URL' : 'file'}: ${input}`);
  const t0 = Date.now();

  let poller;
  if (isUrl) {
    poller = await client.beginAnalyzeDocumentFromUrl('prebuilt-layout', input);
  } else {
    if (!fs.existsSync(input)) {
      console.error(`File not found: ${input}`);
      process.exit(1);
    }
    poller = await client.beginAnalyzeDocument('prebuilt-layout', fs.readFileSync(input));
  }
  const result = await poller.pollUntilDone();
  const elapsedMs = Date.now() - t0;
  console.log(`\nElapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

  const pages = result.pages || [];
  const tables = result.tables || [];
  console.log(`Pages : ${pages.length}`);
  console.log(`Tables: ${tables.length}\n`);

  tables.forEach((t, i) => {
    console.log(`Table[${i}]: ${t.rowCount} rows × ${t.columnCount} cols`);
    // Sample first 3 cells for a sanity check
    const sample = (t.cells || []).slice(0, Math.min(t.columnCount * 2, 8));
    for (const c of sample) {
      const txt = (c.content || '').slice(0, 40).replace(/\s+/g, ' ');
      console.log(`    [${c.rowIndex},${c.columnIndex}] "${txt}"`);
    }
    console.log();
  });

  if (tables.length === 0 && pages.length > 0) {
    const firstWords = (pages[0].words || []).slice(0, 20).map((w) => w.content).join(' ');
    console.log('No tables. First 20 words on page 1:');
    console.log(`  "${firstWords}"`);
  }
})().catch((e) => {
  console.error('FAILED:', e.message || e);
  if (e.code === 'InvalidRequest' && /content type/i.test(e.message || '')) {
    console.error('Hint: ensure the URL returns image/* or application/pdf, not text/html.');
  }
  process.exit(1);
});

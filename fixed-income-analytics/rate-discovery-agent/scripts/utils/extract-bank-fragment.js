'use strict';

/**
 * Extract a single bank's entry from `data/bank-domains.json` and wrap it
 * with provenance metadata. Used by `cloud/sync.js`'s `uploadOneBank` to
 * push a per-bank registry fragment to blob alongside the per-bank rates,
 * so a mid-run crash leaves enough state in blob to debug or partial-
 * import any one completed bank without pulling the entire 1.9 MB
 * bank-domains.json.
 *
 * Per Sprint 4 Track B design (sdlc/sprints/sprint-004/design/
 * track-b-deployment-and-blob-upload.md §B2). The fragment is one-way —
 * blob receives it; nothing reads it back as authoritative.
 *
 * Output shape:
 *   {
 *     "_meta": {
 *       "bank_code":    "<slug>",
 *       "extracted_at": "<ISO-8601>",
 *       "source":       "bank-domains.json",
 *       "source_sha":   "<sha256 of source file at extraction time>"
 *     },
 *     ...<verbatim bank entry from bank-domains.json>...
 *   }
 *
 * Returns null when the bank is not present in the registry — the caller
 * (uploadOneBank) treats this as a skip, not an error.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

function extractBankFragment(domainsFile, bankCode) {
  if (!domainsFile || !bankCode) return null;
  let raw;
  try {
    raw = fs.readFileSync(domainsFile, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`extractBankFragment: ${domainsFile} is not valid JSON: ${err.message}`);
  }
  const entry = data[bankCode];
  if (!entry || typeof entry !== 'object') return null;
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  return {
    _meta: {
      bank_code: bankCode,
      extracted_at: new Date().toISOString(),
      source: 'bank-domains.json',
      source_sha: sha,
    },
    ...entry,
  };
}

module.exports = { extractBankFragment };

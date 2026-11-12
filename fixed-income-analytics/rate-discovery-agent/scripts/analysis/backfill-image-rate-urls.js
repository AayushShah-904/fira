#!/usr/bin/env node
'use strict';

/**
 * One-off backfill: point three image-rate-card co-op banks' rate_pages.fd at
 * the discovered rate IMAGE so bulk-author's OCR branch (IMG_RE) fires. Records
 * the prior value in fd_prev. Routes the whole-file write through
 * safeWriteArtifact (kind: 'registry-file') per the sanctioned write path.
 *
 *   rajkot-nagrik-sahakari-bank-ltd  → admin/uploads/banners.JPG (FD-page banner)
 *   janalaxmi-co-operative-bank-ltd-nashik → gallery_248.jpg (the real FD card;
 *       gallery_247 is a different table) + domain fixed to janalaxmi.bank.in
 *   the-tamil-nadu-state-apex-co-operative-bank-ltd → INTEREST_page-0001.jpg
 *       (known-good Tier-2-OCR validation case)
 *
 * Run: node scripts/analysis/backfill-image-rate-urls.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { safeWriteArtifact } = require('../../lib/safe-write');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'data', 'bank-domains.json');

const BACKFILL = {
  'rajkot-nagrik-sahakari-bank-ltd': {
    domain: 'rnsb.bank.in',
    fd: 'https://rnsb.bank.in/admin/uploads/banners.JPG',
  },
  'janalaxmi-co-operative-bank-ltd-nashik': {
    domain: 'janalaxmi.bank.in', // migrated from janalaxmibank.in
    fd: 'https://janalaxmi.bank.in/assets/uploads/gallery/gallery_248.jpg',
  },
  'the-tamil-nadu-state-apex-co-operative-bank-ltd': {
    domain: 'tnsc.bank.in',
    fd: 'https://www.tnsc.bank.in/jb-content/uploads/2026/03/INTEREST_page-0001.jpg',
  },
};

function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  const today = new Date().toISOString().slice(0, 10);
  let changed = 0;
  for (const [slug, cfg] of Object.entries(BACKFILL)) {
    const entry = registry[slug];
    if (!entry) { process.stderr.write(`skip (no entry): ${slug}\n`); continue; }
    entry.rate_pages = entry.rate_pages || {};
    if (entry.rate_pages.fd !== cfg.fd) {
      entry.rate_pages.fd_prev = entry.rate_pages.fd ?? null;
      entry.rate_pages.fd = cfg.fd;
      entry.rate_pages.fd_url_fixed_at = today;
    }
    if (cfg.domain && entry.domain !== cfg.domain) {
      entry.domain_prev = entry.domain;
      entry.domain = cfg.domain;
    }
    entry.scraper_type = 'image';
    process.stdout.write(`set ${slug}: domain=${entry.domain} fd=${entry.rate_pages.fd}\n`);
    changed++;
  }
  safeWriteArtifact({
    path: REGISTRY_PATH,
    incoming: registry,
    kind: 'registry-file',
    source: 'agent',
    logger: { info: (m) => process.stdout.write(m + '\n'), warn: (m) => process.stderr.write(m + '\n') },
  });
  process.stdout.write(`backfilled ${changed} bank(s)\n`);
}

main();

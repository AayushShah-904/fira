'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commitConfig } = require('../../../lib/actions/commit_config');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'commit-config-')); }

test('commitConfig writes canonical <slug>_config.json with full schema', async () => {
  const d = tmp();
  try {
    const result = await commitConfig({
      bank_code: 'state-bank-of-india',
      bank_name: 'State Bank of India',
      bank_type: 'PSB',
      category: 'Public Sector Bank',
      state: 'Maharashtra',
      website: 'https://sbi.bank.in',
      scraper_type: 'html_js',
      rate_page_urls: {
        fd: 'https://sbi.bank.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits',
        fd_nre: 'https://sbi.bank.in/web/...nre...',
        fd_nro: null,
        fd_fcnr: 'https://sbi.bank.in/web/...fcnr...',
      },
      output_dir: d,
      confidence: 'high',
    });
    assert.equal(result.ok, true);
    assert.equal(result.wrote, true);

    const written = JSON.parse(fs.readFileSync(path.join(d, 'state-bank-of-india_config.json'), 'utf8'));
    assert.equal(written.bank_code, 'state-bank-of-india');
    assert.equal(written.bank_name, 'State Bank of India');
    assert.equal(written.bank_type, 'PSB');
    assert.equal(written.category, 'Public Sector Bank');
    assert.equal(written.state, 'Maharashtra');
    assert.equal(written.website, 'https://sbi.bank.in');
    assert.equal(written.scraper_type, 'html_js');
    assert.equal(written.deposit_insurance, true);
    assert.equal(written.rate_page_urls.fd_nro, null, 'null preserved as operator signal');
    assert.equal(written.discovery_metadata.discovery_method, 'orchestrator');
    assert.equal(written.discovery_metadata.confidence, 'high');
    assert.equal(written.extraction_method, 'automatic_html_js', 'scraper_type=html_js → automatic_html_js');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('commitConfig: IBU bank gets deposit_insurance=false', async () => {
  const d = tmp();
  try {
    await commitConfig({
      bank_code: 'state-bank-of-india-ibu',
      bank_name: 'State Bank of India – IBU',
      bank_type: 'IBU',
      website: 'https://ifsc.statebank',
      scraper_type: 'html_static',
      rate_page_urls: { fd_gift: '/interest-rates' },
      output_dir: d,
    });
    const written = JSON.parse(fs.readFileSync(path.join(d, 'state-bank-of-india-ibu_config.json'), 'utf8'));
    assert.equal(written.deposit_insurance, false, 'IBU has no DICGC');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('commitConfig: throws on missing bank_code / bank_name / bank_type / output_dir', async () => {
  const d = tmp();
  try {
    await assert.rejects(commitConfig({ bank_name: 'x', bank_type: 'PSB', output_dir: d }), /bank_code/);
    await assert.rejects(commitConfig({ bank_code: 'x', bank_type: 'PSB', output_dir: d }), /bank_name/);
    await assert.rejects(commitConfig({ bank_code: 'x', bank_name: 'x', output_dir: d }), /bank_type/);
    await assert.rejects(commitConfig({ bank_code: 'x', bank_name: 'x', bank_type: 'PSB' }), /output_dir/);
    await assert.rejects(commitConfig({ bank_code: 'x', bank_name: 'x', bank_type: 'BOGUS', output_dir: d }), /bank_type/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('commitConfig: slug_mismatch when bank_code differs from slugify(bank_name)', async () => {
  const d = tmp();
  try {
    const result = await commitConfig({
      bank_code: 'nkgsb-co-operative-bank-ltd', // canonical CSV slug includes ', Mumbai'
      bank_name: 'NKGSB Co-operative Bank Ltd., Mumbai',
      bank_type: 'SUCB',
      website: 'https://example.bank.in',
      scraper_type: 'html_static',
      rate_page_urls: { fd: '/rates' },
      output_dir: d,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_class, 'slug_mismatch');
    assert.equal(result.log_entry.expected_slug, 'nkgsb-co-operative-bank-ltd-mumbai');
    assert.equal(result.log_entry.received_slug, 'nkgsb-co-operative-bank-ltd');
    assert.ok(!fs.existsSync(path.join(d, 'nkgsb-co-operative-bank-ltd_config.json')), 'no file written on slug mismatch');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('commitConfig: rate_page_urls null values preserved, undefined dropped', async () => {
  const d = tmp();
  try {
    await commitConfig({
      bank_code: 'test-bank-ltd',
      bank_name: 'Test Bank Ltd',
      bank_type: 'SUCB',
      website: 'https://test.bank.in',
      scraper_type: 'html_static',
      rate_page_urls: { fd: '/rates', fd_nre: null, fd_nro: undefined },
      output_dir: d,
    });
    const w = JSON.parse(fs.readFileSync(path.join(d, 'test-bank-ltd_config.json'), 'utf8'));
    assert.equal(w.rate_page_urls.fd, '/rates');
    assert.equal(w.rate_page_urls.fd_nre, null);
    assert.ok(!('fd_nro' in w.rate_page_urls), 'undefined dropped');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fingerprintPage, _internal } = require('../../../lib/templating/fingerprint');

// --- Synthetic page fixtures ---------------------------------------------

const wpCoopPageA = `
<!doctype html>
<html lang="en">
<head>
  <link rel="stylesheet" href="/wp-content/themes/coop-theme/style.css" />
</head>
<body class="wordpress wp-theme-coop">
  <div class="entry-content">
    <h2>Fixed Deposit Rates</h2>
    <table class="rate-table">
      <thead>
        <tr><th>Period</th><th>Rate of Interest</th><th>Sr. Citizen Rate</th></tr>
      </thead>
      <tbody>
        <tr><td>7-45 days</td><td>3.50%</td><td>4.00%</td></tr>
        <tr><td>46-90 days</td><td>4.25%</td><td>4.75%</td></tr>
        <tr><td>91-180 days</td><td>5.50%</td><td>6.00%</td></tr>
        <tr><td>181-365 days</td><td>6.25%</td><td>6.75%</td></tr>
        <tr><td>1-2 years</td><td>6.50%</td><td>7.00%</td></tr>
        <tr><td>2-5 years</td><td>6.75%</td><td>7.25%</td></tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;

// Same structure, different content, different bank name & rates.
const wpCoopPageB = `
<!doctype html>
<html lang="en">
<head>
  <link rel="stylesheet" href="/wp-content/themes/coop-theme/style.css" />
</head>
<body class="wordpress wp-theme-coop">
  <div class="entry-content">
    <h2>Deposit Rates wef 2026-01-15</h2>
    <table class="rate-table">
      <thead>
        <tr><th>Tenor</th><th>General</th><th>Senior Citizen</th></tr>
      </thead>
      <tbody>
        <tr><td>15 days</td><td>3.00%</td><td>3.50%</td></tr>
        <tr><td>30 days</td><td>3.75%</td><td>4.25%</td></tr>
        <tr><td>90 days</td><td>5.00%</td><td>5.50%</td></tr>
        <tr><td>180 days</td><td>6.00%</td><td>6.50%</td></tr>
        <tr><td>1 year</td><td>6.40%</td><td>6.90%</td></tr>
        <tr><td>3 years</td><td>6.75%</td><td>7.25%</td></tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;

// Different framework, multi-column FCNR currency matrix.
const aemFcnrPage = `
<!doctype html>
<html>
<head>
  <script src="/etc.clientlibs/foundation/aem.js"></script>
</head>
<body>
  <section data-component="fcnr-rates">
    <table class="fcnr-grid">
      <thead>
        <tr><th>Tenure</th><th>USD</th><th>GBP</th><th>EUR</th><th>JPY</th><th>CAD</th><th>AUD</th></tr>
      </thead>
      <tbody>
        <tr><td>1 year</td><td>5.50%</td><td>5.25%</td><td>3.10%</td><td>0.40%</td><td>4.80%</td><td>4.65%</td></tr>
        <tr><td>2 years</td><td>5.40%</td><td>5.15%</td><td>3.00%</td><td>0.50%</td><td>4.70%</td><td>4.55%</td></tr>
        <tr><td>3 years</td><td>5.30%</td><td>5.05%</td><td>2.95%</td><td>0.55%</td><td>4.60%</td><td>4.45%</td></tr>
        <tr><td>5 years</td><td>5.10%</td><td>4.90%</td><td>2.80%</td><td>0.65%</td><td>4.40%</td><td>4.25%</td></tr>
      </tbody>
    </table>
  </section>
</body>
</html>`;

// Page with no <table> at all.
const noTablePage = `
<!doctype html>
<html><body>
  <p>Fixed Deposit rates are not currently published online. Please visit a branch.</p>
</body></html>`;

// Page where the rate table is wrapped in an iframe (we still see body, no tables in main doc).
const iframeWrappedPage = `
<!doctype html>
<html><body>
  <h1>FD Rates</h1>
  <iframe src="/rates/embed" width="100%" height="600"></iframe>
</body></html>`;

// --- Tests ---------------------------------------------------------------

test('two WordPress-themed co-op pages with different rates produce the same template_hash (cluster collision)', () => {
  const a = fingerprintPage({ html: wpCoopPageA, url: 'https://example-a.bank.in/rates' });
  const b = fingerprintPage({ html: wpCoopPageB, url: 'https://example-b.bank.in/rates' });
  assert.equal(a.template_hash, b.template_hash, `expected hash collision, got A=${a.template_hash} B=${b.template_hash}`);
  assert.equal(a.reason, 'ok');
  assert.equal(b.reason, 'ok');
  // Sanity: the cluster captures the .bank.in axis and the 6-row slab bucket.
  assert.equal(a.structural_signature.domain_tld, '.bank.in');
  assert.equal(a.structural_signature.slab_bucket, '4-8');
});

test('AEM FCNR page diverges from the WP co-op page (cluster divergence)', () => {
  const wp = fingerprintPage({ html: wpCoopPageA, url: 'https://example.bank.in/rates' });
  const aem = fingerprintPage({ html: aemFcnrPage, url: 'https://example.com/fcnr' });
  assert.notEqual(wp.template_hash, aem.template_hash, 'AEM FCNR should not collide with co-op WP');
  assert(aem.structural_signature.framework_hint.includes('aem'), 'AEM signal should be detected');
});

test('domain TLD is recognized from URL', () => {
  assert.equal(_internal.pickDomainTld('https://abhyudaya.bank.in/rates'), '.bank.in');
  assert.equal(_internal.pickDomainTld('https://www.sbi.co.in/rates'), '.co.in');
  assert.equal(_internal.pickDomainTld('https://hdfc.com/rates'), '.com');
  assert.equal(_internal.pickDomainTld('https://example.org/'), '.org');
  assert.equal(_internal.pickDomainTld(''), 'unknown');
});

test('header synonyms normalize to the same canonical tokens', () => {
  const v1 = _internal.buildHeaderVector([['Period', 'Rate of Interest', 'Sr. Citizen Rate']]);
  const v2 = _internal.buildHeaderVector([['Tenor', 'General', 'Senior Citizen']]);
  assert.deepEqual(v1, v2);
  assert.deepEqual(v1, ['regular', 'senior', 'tenure']);
});

test('page with no <table> elements produces a stable no-rate-table signature', () => {
  const a = fingerprintPage({ html: noTablePage, url: 'https://x.bank.in/' });
  const b = fingerprintPage({ html: noTablePage, url: 'https://x.bank.in/' });
  assert.equal(a.reason, 'no-rate-table');
  assert.equal(a.template_hash, b.template_hash);
  assert.equal(a.candidate_tables.length, 0);
});

test('iframe presence is recorded in framework_hint', () => {
  const r = fingerprintPage({ html: iframeWrappedPage, url: 'https://x.bank.in/' });
  assert(r.structural_signature.framework_hint.includes('iframe'), 'iframe hint should be recorded');
});

test('non-html kinds produce kind-specific signatures', () => {
  const pdf = fingerprintPage({ kind: 'pdf-text', pdfText: '1 year 6.50\n2 years 6.75\n3 years 6.90', url: 'https://x.com/rates.pdf' });
  assert(pdf.template_hash.startsWith('sha1:'));
  assert.equal(pdf.reason, 'non-html:pdf-text');
  assert.equal(pdf.structural_signature.kind, 'pdf-text');

  const img = fingerprintPage({ kind: 'image', image: { width: 1200, height: 800, ocrConfidence: 0.85 }, url: 'https://x.com/rates.jpg' });
  assert.equal(img.structural_signature.kind, 'image');
  assert.equal(img.structural_signature.dimensions_bucket, 'medium');
  assert.equal(img.structural_signature.ocr_confidence_bucket, 'medium');
});

test('invalid kind throws', () => {
  assert.throws(() => fingerprintPage({ kind: 'invalid', url: 'x' }), /invalid kind/);
});

test('empty html produces empty-html reason without throwing', () => {
  const r = fingerprintPage({ html: '', url: 'https://x.bank.in/' });
  assert.equal(r.reason, 'empty-html');
  assert(r.template_hash.startsWith('sha1:'));
});

test('slab-row-count buckets are correct', () => {
  assert.equal(_internal.bucketRowCount(0), '0');
  assert.equal(_internal.bucketRowCount(1), '1-3');
  assert.equal(_internal.bucketRowCount(3), '1-3');
  assert.equal(_internal.bucketRowCount(8), '4-8');
  assert.equal(_internal.bucketRowCount(15), '9-15');
  assert.equal(_internal.bucketRowCount(30), '16-30');
  assert.equal(_internal.bucketRowCount(31), '30+');
});

test('table-region anchor is the highest-scoring table even with noise tables present', () => {
  const noisyPage = `
    <body>
      <table id="footnote"><tr><th>Card Rate</th></tr><tr><td>not a rate table — w.e.f.</td></tr></table>
      <table id="actual">
        <thead><tr><th>Tenure</th><th>Rate</th><th>Senior</th></tr></thead>
        <tbody>
          <tr><td>1y</td><td>6.5%</td><td>7%</td></tr>
          <tr><td>2y</td><td>6.6%</td><td>7.1%</td></tr>
          <tr><td>3y</td><td>6.7%</td><td>7.2%</td></tr>
        </tbody>
      </table>
    </body>`;
  const r = fingerprintPage({ html: noisyPage, url: 'https://x.bank.in/' });
  assert.equal(r.reason, 'ok');
  // The actual rate table should have outscored the noisy footnote table.
  assert(r.candidate_tables.length >= 2);
  assert(r.candidate_tables[0].score > r.candidate_tables[1].score, 'rate table should outrank noise table');
  // header vector reflects the actual table's headers (synonyms collapsed).
  assert.deepEqual(r.candidate_tables[0].header_vector, ['regular', 'senior', 'tenure']);
});

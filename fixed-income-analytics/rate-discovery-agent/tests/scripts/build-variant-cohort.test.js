'use strict';

// Sprint 011 Track A / Item 20 — cohort UNION rule + gap audit.
// All fixtures are synthetic in-memory objects; the real pack/dist and
// data/bank-domains.json are never touched.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVariantCohort,
  domainsKeyFor,
  entryPublishesVariant,
  parseArgs,
} = require('../../scripts/cohort/build-variant-cohort');

/** Minimal pack bank with n slabs for a variant. */
function packBank(bankCode, variant, slabCount) {
  return {
    bank_code: bankCode,
    products: { fd: { [variant]: { slabs: new Array(slabCount).fill({ rate: 5.0 }) } } },
  };
}

/** Minimal bank-domains entry with a URL under the given rate_pages key. */
function domainsEntry(fdKey, url) {
  return { domain: 'example.bank.in', rate_pages: { [fdKey]: url } };
}

/** Capture warn lines instead of printing. */
function warnCapture() {
  const lines = [];
  const warn = (msg) => lines.push(String(msg));
  return { lines, warn };
}

// -------------------------------------------------------------------------
// (a) Scope-doc synthetic: pack has 5 fcnr banks, domains has 7 fd_fcnr
//     entries with partial overlap → cohort 7, gap lists the 2 extras.
// -------------------------------------------------------------------------

test('UNION rule: 5 pack banks ∪ 7 domains banks (5 overlap) → cohort 7, gap 2', () => {
  const packCodes = ['bank-a', 'bank-b', 'bank-c', 'bank-d', 'bank-e'];
  const domainCodes = [...packCodes, 'bank-f', 'bank-g']; // 7, superset of pack

  const pack = { banks: packCodes.map((bc) => packBank(bc, 'fcnr', 3)) };
  const domains = Object.fromEntries(
    domainCodes.map((bc) => [bc, domainsEntry('fd_fcnr', `/rates/${bc}-fcnr.pdf`)]),
  );

  const { lines, warn } = warnCapture();
  const result = buildVariantCohort({ variant: 'fcnr', pack, domains, warn });

  assert.equal(result.cohort.length, 7);
  assert.deepEqual(result.cohort, [...domainCodes].sort());
  assert.deepEqual(result.inPack, packCodes);
  assert.equal(result.inDomains.length, 7);
  assert.deepEqual(result.gap, ['bank-f', 'bank-g']);

  // Operator-visible audit warning, exact style from the scope doc.
  assert.equal(lines[0], '[cohort-audit] 2 banks publish fcnr per bank-domains but have no pack data:');
  assert.deepEqual(lines.slice(1), ['  - bank-f', '  - bank-g']);
});

test('UNION rule: pack-only bank (no domains URL) still lands in cohort, not in gap', () => {
  const pack = { banks: [packBank('pack-only-bank', 'fcnr', 2)] };
  const domains = { 'domains-only-bank': domainsEntry('fd_fcnr', '/fcnr') };

  const { lines, warn } = warnCapture();
  const result = buildVariantCohort({ variant: 'fcnr', pack, domains, warn });

  assert.deepEqual(result.cohort, ['domains-only-bank', 'pack-only-bank']);
  assert.deepEqual(result.gap, ['domains-only-bank']);
  assert.equal(lines.length, 2);
});

test('gap empty → no [cohort-audit] warning emitted', () => {
  const pack = { banks: [packBank('bank-a', 'fcnr', 1)] };
  const domains = { 'bank-a': domainsEntry('fd_fcnr', '/fcnr') };

  const { lines, warn } = warnCapture();
  const result = buildVariantCohort({ variant: 'fcnr', pack, domains, warn });

  assert.deepEqual(result.gap, []);
  assert.equal(lines.length, 0);
});

test('null rate_pages URL does not count as publishing (yes-bank fd_nre: null shape)', () => {
  const pack = { banks: [] };
  const domains = {
    'null-url-bank': { domain: 'x.bank.in', rate_pages: { fd_nre: null, fd: '/fd' } },
  };
  const { warn } = warnCapture();
  const result = buildVariantCohort({ variant: 'nre', pack, domains, warn });
  assert.deepEqual(result.cohort, []);
  assert.deepEqual(result.inDomains, []);
});

// -------------------------------------------------------------------------
// (b) Extraction-hint-only bank: fulfills_product declares fd_fcnr but
//     there is no rate_pages.fd_fcnr entry (Axis-style declaration).
// -------------------------------------------------------------------------

test('extraction hint fulfills_product: fd_fcnr counts as publishing even without rate_pages.fd_fcnr', () => {
  const pack = { banks: [] };
  const domains = {
    'axis-like-bank': {
      domain: 'axis.example.in',
      rate_pages: { fd: '/deposits/fd-rates' }, // no fd_fcnr key at all
      extraction: {
        fd_image_ocr_fcnr: {
          type: 'image_ocr',
          fulfills_product: ['fd_fcnr'],
        },
      },
    },
  };

  const { lines, warn } = warnCapture();
  const result = buildVariantCohort({ variant: 'fcnr', pack, domains, warn });

  assert.deepEqual(result.cohort, ['axis-like-bank']);
  assert.deepEqual(result.inDomains, ['axis-like-bank']);
  assert.deepEqual(result.gap, ['axis-like-bank']);
  assert.equal(lines[0], '[cohort-audit] 1 banks publish fcnr per bank-domains but have no pack data:');
});

test('extraction hint fulfills_product as bare string is honoured too', () => {
  const domains = {
    'string-hint-bank': {
      rate_pages: {},
      extraction: { fd_pdf: { type: 'pdf', fulfills_product: 'fd_fcnr' } },
    },
  };
  const result = buildVariantCohort({ variant: 'fcnr', pack: { banks: [] }, domains, warn: () => {} });
  assert.deepEqual(result.inDomains, ['string-hint-bank']);
});

test('extraction hint for a DIFFERENT variant does not leak into the cohort', () => {
  const domains = {
    'nre-hint-bank': {
      rate_pages: {},
      extraction: { fd_pdf_nri: { type: 'pdf', fulfills_product: ['fd_nre', 'fd_nro'] } },
    },
  };
  const result = buildVariantCohort({ variant: 'fcnr', pack: { banks: [] }, domains, warn: () => {} });
  assert.deepEqual(result.cohort, []);
});

// -------------------------------------------------------------------------
// (c) Variant 'regular' maps to rate_pages.fd (not fd_regular / fd_).
// -------------------------------------------------------------------------

test("variant 'regular' maps to rate_pages.fd and pack products.fd.regular", () => {
  assert.equal(domainsKeyFor('regular'), 'fd');
  assert.equal(domainsKeyFor('fcnr'), 'fd_fcnr');
  assert.equal(domainsKeyFor('gift'), 'fd_gift');

  const pack = { banks: [packBank('pack-regular-bank', 'regular', 4)] };
  const domains = {
    'domains-fd-bank': domainsEntry('fd', '/interest-rates'),
    'fcnr-only-bank': domainsEntry('fd_fcnr', '/fcnr'), // must NOT match variant regular
  };

  const { warn } = warnCapture();
  const result = buildVariantCohort({ variant: 'regular', pack, domains, warn });

  assert.deepEqual(result.cohort, ['domains-fd-bank', 'pack-regular-bank']);
  assert.deepEqual(result.inDomains, ['domains-fd-bank']);
  assert.deepEqual(result.gap, ['domains-fd-bank']);
});

// -------------------------------------------------------------------------
// Guards + arg parsing
// -------------------------------------------------------------------------

test('empty slabs array in pack does not count as pack-has-data', () => {
  const pack = { banks: [packBank('zero-slab-bank', 'fcnr', 0)] };
  const result = buildVariantCohort({ variant: 'fcnr', pack, domains: {}, warn: () => {} });
  assert.deepEqual(result.inPack, []);
  assert.deepEqual(result.cohort, []);
});

test('unknown variant throws', () => {
  assert.throws(
    () => buildVariantCohort({ variant: 'bogus', pack: { banks: [] }, domains: {} }),
    /unknown variant "bogus"/,
  );
});

test('entryPublishesVariant handles malformed entries defensively', () => {
  assert.equal(entryPublishesVariant(null, 'fd_fcnr'), false);
  assert.equal(entryPublishesVariant({}, 'fd_fcnr'), false);
  assert.equal(entryPublishesVariant({ extraction: { x: null } }, 'fd_fcnr'), false);
});

test('parseArgs: --variant and --out in space and equals forms', () => {
  const a1 = parseArgs(['node', 'x', '--variant', 'fcnr', '--out', 'foo.json']);
  assert.equal(a1.variant, 'fcnr');
  assert.equal(a1.out, 'foo.json');
  const a2 = parseArgs(['node', 'x', '--variant=nre', '--out=bar.json']);
  assert.equal(a2.variant, 'nre');
  assert.equal(a2.out, 'bar.json');
  assert.throws(() => parseArgs(['node', 'x', '--nope']), /Unknown flag/);
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyOutcome } = require('../../../lib/actions/classify_outcome');

const tmpDirs = [];
function makeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-outcome-test-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => { for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });

test('happy path: classifies with a minimal run_dir', async () => {
  const run_dir = makeDir();
  // Write minimal artifacts the classifier expects
  fs.writeFileSync(path.join(run_dir, 'test-bank_config.json'), JSON.stringify({
    bank_code: 'test-bank', website: 'https://test.in', scraper_type: 'html_static',
    rate_page_urls: { fd: 'https://test.in/rates' },
  }));
  fs.writeFileSync(path.join(run_dir, 'test-bank_rates.json'), JSON.stringify({
    bank_code: 'test-bank',
    rate_slabs: [{ tenure_text: '7d-14d', rate_general_pct: 3.5 }],
    extraction_confidence: 'high',
  }));
  fs.writeFileSync(path.join(run_dir, 'test-bank.summary.json'), JSON.stringify({
    bank_code: 'test-bank',
    tool_calls: [
      { name: 'fetch_url', args: { url: 'https://test.in' }, isError: false },
      { name: 'fetch_url', args: { url: 'https://test.in/rates' }, isError: false },
    ],
  }));

  const r = await classifyOutcome({ bank_code: 'test-bank', run_dir, agent_result: { success: true } });
  assert.equal(r.ok, true);
  assert.ok(r.failure_class);
  assert.ok(r.phase_outcomes);
  assert.ok(['success', 'partial_success'].includes(r.failure_class));
});

test('throws on non-canonical bank_code', async () => {
  await assert.rejects(
    classifyOutcome({ bank_code: 'Test Bank', run_dir: '/tmp', agent_result: {} }),
    /not canonical/,
  );
});

test('throws on missing run_dir', async () => {
  await assert.rejects(
    classifyOutcome({ bank_code: 'test-bank', agent_result: {} }),
    /run_dir is required/,
  );
});

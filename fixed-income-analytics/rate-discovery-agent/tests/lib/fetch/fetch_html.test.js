'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchHtml, DEFAULT_ESCALATION } = require('../../../lib/fetch/fetch_html');

// --- Test helpers ---------------------------------------------------------

/**
 * Build a mock _runRung that returns a scripted result per rung in order.
 * Each entry in `script` is either:
 *   { kind: 'success', html, statusCode?, headers?, iframe_traversed? }
 *   { kind: 'challenge', html, statusCode?, vendor?, signal? }
 *   { kind: 'throw', message }
 *
 * Returns a runRung function + a `calls` array recording each invocation.
 */
function mockRunRung(script) {
  const calls = [];
  let i = 0;
  const runRung = async (args) => {
    calls.push({ rung: args.rung, browser: args.browser, url: args.url, templateFetch: args.templateFetch });
    const entry = script[i++];
    if (!entry) throw new Error(`mockRunRung: script exhausted at call ${i}`);
    if (entry.kind === 'throw') {
      const e = new Error(entry.message || 'mock_throw');
      throw e;
    }
    if (entry.kind === 'challenge') {
      // Return a body that challenge_detect will flag.
      return {
        statusCode: entry.statusCode || 200,
        headers: entry.headers || {},
        html: entry.html || '<html><body>Just a moment...</body></html>',
        ms: 10,
        iframe_traversed: false,
      };
    }
    // success
    return {
      statusCode: entry.statusCode || 200,
      headers: entry.headers || {},
      html: entry.html || '<html><body><table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1y</td><td>6.5%</td></tr><tr><td>2y</td><td>6.75%</td></tr><tr><td>3y</td><td>7.0%</td></tr></table></body></html>',
      ms: 10,
      iframe_traversed: !!entry.iframe_traversed,
    };
  };
  return { runRung, calls };
}

// --- Tests ----------------------------------------------------------------

test('default rung succeeds → returns html, final_strategy=default', async () => {
  const { runRung, calls } = mockRunRung([{ kind: 'success' }]);
  const r = await fetchHtml({ url: 'https://example.bank.in/rates', _runRung: runRung });
  assert.equal(r.status, 'success');
  assert.ok(r.html.includes('<table>'));
  assert.equal(r.final_strategy, 'default');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].outcome, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rung, 'default');
});

test('PDF URL short-circuits without launching a browser', async () => {
  const { runRung, calls } = mockRunRung([]);
  const r = await fetchHtml({ url: 'https://example.com/rates.pdf', _runRung: runRung });
  assert.equal(r.status, 'failed');
  assert.equal(r.html, null);
  assert.equal(calls.length, 0, 'no rung should have been invoked');
  assert.match(r.reason, /PDF/);
  assert.equal(r.attempts[0].rung, 'pdf-short-circuit');
});

test('challenge on default → jumps directly to stealth (skips firefox-between guard not relevant in default ordering)', async () => {
  // Default ordering: default → stealth → firefox → llm-fallback
  // Test: default returns a Cloudflare challenge body; stealth succeeds.
  //
  // Sprint 009 Phase 3 fixture fix: the prior fixture body
  // 'Just a moment Cloudflare...' did not match the post-Sprint-7
  // tightened Cloudflare regex (which requires the literal sequence
  // "Just a moment..." — Sprint 7's tightening closed a 72-bank
  // false-positive where cdnjs.cloudflare.com asset URLs leaked the
  // bare "cloudflare" word into legitimate pages). Real Cloudflare
  // challenge bodies use the literal title — fixture aligned.
  const { runRung, calls } = mockRunRung([
    { kind: 'challenge', html: '<html><head><title>Just a moment...</title></head><body>cf-chl-bypass</body></html>' },
    { kind: 'success' },
  ]);
  const r = await fetchHtml({ url: 'https://example.com/', _runRung: runRung });
  assert.equal(r.status, 'success');
  assert.equal(r.final_strategy, 'stealth');
  assert.equal(r.challenge_detected.vendor, 'cloudflare');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.rung), ['default', 'stealth']);
});

test('all rungs fail → returns status=failed, attempts populated', async () => {
  const { runRung, calls } = mockRunRung([
    { kind: 'throw', message: 'navigation_timeout' },
    { kind: 'throw', message: 'navigation_timeout' },
    { kind: 'throw', message: 'navigation_timeout' },
    // 4th rung is llm-fallback which short-circuits without calling _runRung
  ]);
  const r = await fetchHtml({ url: 'https://example.com/', _runRung: runRung });
  assert.equal(r.status, 'failed');
  assert.equal(r.final_strategy, 'llm-fallback');
  assert.equal(calls.length, 3, 'llm-fallback rung should not have invoked _runRung');
  assert.equal(r.attempts.filter((a) => a.outcome === 'error').length, 3);
  assert.equal(r.attempts[r.attempts.length - 1].rung, 'llm-fallback');
});

test('default succeeds with iframe_traversed=true → result reflects it', async () => {
  const { runRung } = mockRunRung([{ kind: 'success', iframe_traversed: true }]);
  const r = await fetchHtml({
    url: 'https://example.com/',
    templateFetch: { iframe_selector: 'iframe#rates' },
    _runRung: runRung,
  });
  assert.equal(r.status, 'success');
  assert.equal(r.iframe_traversed, true);
});

test('templateFetch.retry_escalation override is honored', async () => {
  const { runRung, calls } = mockRunRung([{ kind: 'success' }]);
  const r = await fetchHtml({
    url: 'https://example.com/',
    templateFetch: { retry_escalation: ['stealth'] }, // skip default entirely
    _runRung: runRung,
  });
  assert.equal(r.final_strategy, 'stealth');
  assert.equal(calls[0].rung, 'stealth');
});

test('templateFetch.wait_for_function is plumbed through to runRung', async () => {
  const { runRung, calls } = mockRunRung([{ kind: 'success' }]);
  const wait = `() => document.querySelectorAll('table tr').length >= 8`;
  await fetchHtml({
    url: 'https://example.com/',
    templateFetch: { wait_for_function: wait },
    _runRung: runRung,
  });
  assert.equal(calls[0].templateFetch.wait_for_function, wait);
});

test('challenge then second-rung challenge then firefox success → records both challenges, ends on firefox', async () => {
  const { runRung, calls } = mockRunRung([
    { kind: 'challenge', html: '<html>Just a moment...</html>' }, // default
    { kind: 'challenge', html: '<html>cf-chl-bypass</html>' },    // stealth
    { kind: 'success' },                                            // firefox
  ]);
  const r = await fetchHtml({ url: 'https://example.com/', _runRung: runRung });
  assert.equal(r.status, 'success');
  assert.equal(r.final_strategy, 'firefox');
  assert.equal(calls.length, 3);
});

test('challenge on default with non-default escalation order — jump-to-stealth only fires when stealth is later in queue', async () => {
  // Custom escalation: default → firefox → stealth → llm-fallback
  // After default challenge, jump-to-stealth should skip firefox and go directly to stealth.
  const { runRung, calls } = mockRunRung([
    { kind: 'challenge' }, // default
    { kind: 'success' },   // stealth (after jump skipping firefox)
  ]);
  const r = await fetchHtml({
    url: 'https://example.com/',
    templateFetch: { retry_escalation: ['default', 'firefox', 'stealth', 'llm-fallback'] },
    _runRung: runRung,
  });
  assert.equal(r.status, 'success');
  assert.equal(r.final_strategy, 'stealth');
  // firefox should appear in attempts as 'skipped_due_to_challenge_jump'
  const firefoxAttempt = r.attempts.find((a) => a.rung === 'firefox');
  assert.ok(firefoxAttempt);
  assert.equal(firefoxAttempt.outcome, 'skipped_due_to_challenge_jump');
});

test('thrown error on one rung does not prevent next rung from being tried', async () => {
  const { runRung, calls } = mockRunRung([
    { kind: 'throw', message: 'TimeoutError: navigation' },
    { kind: 'success' },
  ]);
  const r = await fetchHtml({ url: 'https://example.com/', _runRung: runRung });
  assert.equal(r.status, 'success');
  assert.equal(r.final_strategy, 'stealth');
  assert.equal(calls.length, 2);
  assert.equal(r.attempts[0].outcome, 'error');
  assert.match(r.attempts[0].error.message, /Timeout/);
});

test('llm-fallback in the middle of escalation order short-circuits remaining rungs', async () => {
  const { runRung, calls } = mockRunRung([
    { kind: 'throw', message: 'fail' },
    // never reached — llm-fallback in slot 2 short-circuits
  ]);
  const r = await fetchHtml({
    url: 'https://example.com/',
    templateFetch: { retry_escalation: ['default', 'llm-fallback', 'stealth', 'firefox'] },
    _runRung: runRung,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.final_strategy, 'llm-fallback');
  assert.equal(calls.length, 1, 'only default should have been called');
});

test('missing url throws', async () => {
  await assert.rejects(fetchHtml({}), /input.url is required/);
  await assert.rejects(fetchHtml({ url: null }), /input.url is required/);
});

test('challenge_detected is preserved across successful subsequent rungs', async () => {
  const { runRung } = mockRunRung([
    { kind: 'challenge', html: '<html>Just a moment...</html>' },
    { kind: 'success' },
  ]);
  const r = await fetchHtml({ url: 'https://example.com/', _runRung: runRung });
  assert.equal(r.status, 'success');
  assert.ok(r.challenge_detected, 'first-rung challenge should be carried in the result');
  assert.equal(r.challenge_detected.vendor, 'cloudflare');
});

test('DEFAULT_ESCALATION shape is stable', () => {
  assert.deepEqual(DEFAULT_ESCALATION, ['default', 'stealth', 'firefox', 'llm-fallback']);
});

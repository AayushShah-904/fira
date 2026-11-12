'use strict';

/**
 * Per-rung Playwright session helper for lib/fetch/fetch_html.js.
 *
 * Sprint 006 Phase B / Step 1a. NEW module (sibling to the existing
 * lib/actions/_playwright_session.js which has a different lifecycle —
 * one persistent session per bank for the orchestrator's HTTP calls).
 *
 * This helper creates a SHORT-LIVED session per escalation rung:
 *   rung 1 (default):  chromium + standard UA
 *   rung 2 (stealth):  chromium + playwright-extra + stealth plugin + UA rotation
 *   rung 3 (firefox):  firefox engine (no stealth — chromium-only)
 *
 * Tests inject a fake `_engineLoader` to avoid pulling in Playwright on
 * platforms where browser binaries aren't installed.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/fetch-layer-hardening.md
 */

const STEALTH_UA_POOL = [
  // Stable, recent Chrome on Windows desktop (most common)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Edge on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  // Chrome on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Firefox on Windows (used only as a UA fallback, not engine selection)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
];

function pickStealthUa() {
  return STEALTH_UA_POOL[Math.floor(Math.random() * STEALTH_UA_POOL.length)];
}

/**
 * Default engine loader. Lazy-requires the playwright module so unit tests
 * that inject a fake loader don't pay the require cost.
 *
 * @param {{rung: string, browser: string}} opts
 * @returns {{launch: function(object): Promise<Browser>}}
 */
function defaultEngineLoader({ rung, browser }) {
  if (rung === 'stealth') {
    if (browser !== 'chromium') {
      throw new Error(`stealth rung requires browser='chromium' (got '${browser}')`);
    }
    // eslint-disable-next-line global-require
    const { chromium } = require('playwright-extra');
    // eslint-disable-next-line global-require
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    chromium.use(StealthPlugin());
    return chromium;
  }
  // eslint-disable-next-line global-require
  const pw = require('playwright');
  const engine = pw[browser];
  if (!engine) throw new Error(`unknown browser engine '${browser}'`);
  return engine;
}

/**
 * Open a session, run a fetch, close. Single-shot — the caller wraps this
 * per rung in a try/finally so failures don't leak browser processes.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {string} args.rung               'default' | 'stealth' | 'firefox'
 * @param {string} args.browser            'chromium' | 'firefox' | 'webkit'
 * @param {object} args.templateFetch      template.fetch block (wait_for, click_to_reveal, etc.)
 * @param {number} args.timeoutMs
 * @param {string|null} args.capturePath   directory for HAR + screenshot on failure (null = no capture)
 * @param {object} args.log
 * @param {function} [args._engineLoader]  test injection
 * @returns {Promise<{statusCode, headers, html, ms, iframe_traversed}>}
 * @throws on navigation timeout, browser launch failure, etc.
 */
async function runRung(args) {
  const {
    url,
    rung,
    browser,
    templateFetch,
    timeoutMs,
    capturePath,
    log,
    _engineLoader = defaultEngineLoader,
  } = args;

  const t0 = Date.now();
  const engine = _engineLoader({ rung, browser });

  const launchOpts = {
    headless: true,
  };
  if (browser === 'chromium') {
    launchOpts.args = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ];
  }

  // Launch args — chromium-only flags are silently ignored on Firefox/WebKit
  // but cleaner to omit. The disable-blink-features arg is the load-bearing
  // anti-bot signal for default chromium runs.
  let browserInst;
  try {
    browserInst = await engine.launch(launchOpts);
  } catch (err) {
    if (browser === 'chromium' && !launchOpts.channel && err.message.includes("Executable doesn't exist")) {
      if (log?.warn) log.warn("Playwright browser not found. Retrying launch using system Google Chrome...");
      try {
        launchOpts.channel = 'chrome';
        browserInst = await engine.launch(launchOpts);
      } catch (err2) {
        if (log?.warn) log.warn("System Google Chrome launch failed. Retrying launch using system Microsoft Edge...");
        try {
          launchOpts.channel = 'msedge';
          browserInst = await engine.launch(launchOpts);
        } catch (err3) {
          throw err; // throw the original error if fallback fails
        }
      }
    } else {
      throw err;
    }
  }
  let iframeTraversed = false;
  try {
    const version = browserInst.version();
    const rawUa = rung === 'stealth' ? pickStealthUa() : STEALTH_UA_POOL[0];
    const userAgent = rawUa.replace(/Chrome\/[\d.]+/g, `Chrome/${version}`);

    const contextOpts = {
      userAgent,
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
      }
    };
    if (capturePath) {
      // HAR capture is recorded for the whole context; written on context.close().
      contextOpts.recordHar = { path: `${capturePath}.har`, omitContent: true };
    }
    const context = await browserInst.newContext(contextOpts);
    try {
      const page = await context.newPage();

      // Initial navigation. waitUntil='domcontentloaded' is intentionally cheap;
      // the real wait happens in waitForCondition below.
      let response;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        
        // Simulated human-like delay and mouse movements to bypass bot detectors
        await page.waitForTimeout(1000 + Math.random() * 1000);
        for (let i = 0; i < 3; i++) {
          const x = Math.floor(Math.random() * 800) + 100;
          const y = Math.floor(Math.random() * 600) + 100;
          await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
          await page.waitForTimeout(Math.random() * 300 + 100).catch(() => {});
        }
      } catch (err) {
        const e = new Error(`navigation_failed: ${err.message}`);
        e.cause = err;
        throw e;
      }

      // Optional click-to-reveal before waiting
      if (templateFetch.click_to_reveal && Array.isArray(templateFetch.click_to_reveal)) {
        for (const sel of templateFetch.click_to_reveal) {
          try {
            const loc = page.locator(sel).first();
            const count = await page.locator(sel).count();
            if (count > 0) {
              await loc.click({ timeout: 5000 });
              if (log?.info) log.info(`[fetch] clicked reveal selector: ${sel}`);
            }
          } catch (err) {
            if (log?.warn) log.warn(`[fetch] click-to-reveal "${sel}" failed: ${err.message}`);
          }
        }
        await page.waitForTimeout(800);
      }

      // Sprint 7 (2026-05-24): expand_accordions option. ICICI / other AEM
      // banks publish their full rate card inside collapsed accordions —
      // clicking every `[aria-expanded="false"]` element forces them open
      // BEFORE the wait condition checks for rate-shaped content. The body
      // text of ICICI's default render contains ZERO tenure phrases
      // (no "7 days", "1 year", etc.) until the accordion is expanded.
      if (templateFetch.expand_accordions) {
        try {
          const expanded = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
            let n = 0;
            for (const el of els) {
              try { el.click(); n++; } catch (_) { /* ignore individual failures */ }
            }
            return n;
          });
          if (log?.info) log.info(`[fetch] expand_accordions: clicked ${expanded} collapsed element(s)`);
          if (expanded > 0) await page.waitForTimeout(1500);
        } catch (err) {
          if (log?.warn) log.warn(`[fetch] expand_accordions failed: ${err.message}`);
        }
      }

      // Sprint 7 (2026-05-24): wait_for_network_idle option. For SPAs that
      // lazy-load via XHR after accordion expansion, give the network a
      // chance to settle before reading content. Bounded to avoid hanging
      // on pages with continuous background polling.
      if (templateFetch.wait_for_network_idle) {
        try {
          await page.waitForLoadState('networkidle', { timeout: 8000 });
          if (log?.info) log.info(`[fetch] network idle`);
        } catch (err) {
          if (log?.warn) log.warn(`[fetch] wait_for_network_idle did not settle in 8s: ${err.message}`);
        }
      }

      // The wait condition — explicit overrides win, then default-tables-with-pct.
      await waitForCondition(page, templateFetch, timeoutMs, log);

      // Iframe traversal: enumerate frames, switch context if iframe_selector set.
      let activeFrame = page;
      if (templateFetch.iframe_selector) {
        try {
          const elementHandle = await page.waitForSelector(templateFetch.iframe_selector, { timeout: 5000 }).catch(() => null);
          if (elementHandle) {
            const frame = await elementHandle.contentFrame();
            if (frame) {
              activeFrame = frame;
              iframeTraversed = true;
              if (log?.info) log.info(`[fetch] traversed into iframe: ${templateFetch.iframe_selector}`);
              // Re-wait inside the iframe for the rate region to render
              await waitForCondition(activeFrame, templateFetch, Math.min(timeoutMs, 15000), log).catch(() => {});
            }
          }
        } catch (err) {
          if (log?.warn) log.warn(`[fetch] iframe traversal failed: ${err.message}`);
        }
      }

      const html = await activeFrame.content();
      const statusCode = response ? response.status() : 0;
      const headers = response ? response.headers() : {};
      return {
        statusCode,
        headers,
        html,
        ms: Date.now() - t0,
        iframe_traversed: iframeTraversed,
      };
    } finally {
      // Always close the context — flushes HAR if recordHar was set.
      await context.close().catch(() => {});
    }
  } finally {
    await browserInst.close().catch(() => {});
  }
}

/**
 * Apply the wait condition. Order:
 *   1. wait_for_function (custom JS expression)
 *   2. wait_for_selector (CSS)
 *   3. DEFAULT_WAIT_FN (tables containing %) + settle window
 *
 * Sprint 7 (2026-05-24): default wait now has a two-stage shape. Stage 1 is
 * the basic "any rate-shaped content present" check (unchanged from Sprint 6).
 * Stage 2 waits for the table-row count to be STABLE for ~1.5s — this catches
 * lazy-loaded AEM/React pages (e.g., ICICI) where the initial render only has
 * a small summary table, and the full retail rate card streams in 2-4 seconds
 * later via AJAX. Without the settle window, the basic condition was satisfied
 * too early and we captured the partial-render HTML.
 */
async function waitForCondition(frame, templateFetch, timeoutMs, log) {
  const waitTimeout = Math.min(timeoutMs, 30000);

  if (templateFetch.wait_for_function) {
    try {
      await frame.waitForFunction(templateFetch.wait_for_function, { timeout: waitTimeout });
      return;
    } catch (err) {
      if (log?.warn) log.warn(`[fetch] wait_for_function timed out: ${err.message}`);
      // Don't throw — caller will see whatever rendered so far
    }
  }
  if (templateFetch.wait_for_selector) {
    try {
      await frame.waitForSelector(templateFetch.wait_for_selector, { state: 'visible', timeout: waitTimeout });
      return;
    } catch (err) {
      if (log?.warn) log.warn(`[fetch] wait_for_selector timed out: ${err.message}`);
    }
  }
  // Stage 1: basic condition — any rate-shaped content present.
  try {
    await frame.waitForFunction(
      `() => /%/.test(document.body.innerText) && document.querySelectorAll('table tr').length >= 3`,
      { timeout: waitTimeout },
    );
  } catch (err) {
    if (log?.warn) log.warn(`[fetch] default wait condition timed out: ${err.message}`);
    // Allow callers to see whatever was rendered — extract may still recover slabs
  }
  // Stage 2: settle window — wait for table-row count to be stable for 1.5s.
  // Bounded so a continuously-mutating page (e.g., live ticker) doesn't hang.
  // Per-template override via `templateFetch.settle_window_ms` (set to 0 to
  // disable when a fast bank doesn't need it). Default 1500ms.
  const settleWindowMs = Number.isInteger(templateFetch.settle_window_ms) ? templateFetch.settle_window_ms : 1500;
  if (settleWindowMs > 0) {
    const settleBudgetMs = Math.min(Math.max(timeoutMs - 5000, 3000), 10000);
    try {
      await frame.waitForFunction(
        `(targetStableMs) => {
          const cur = document.querySelectorAll('table tr').length;
          if (window.__rdaTrCount === undefined) {
            window.__rdaTrCount = cur;
            window.__rdaTrSettledSince = Date.now();
            return false;
          }
          if (cur !== window.__rdaTrCount) {
            window.__rdaTrCount = cur;
            window.__rdaTrSettledSince = Date.now();
            return false;
          }
          return (Date.now() - window.__rdaTrSettledSince) >= targetStableMs;
        }`,
        settleWindowMs,
        { timeout: settleBudgetMs, polling: 250 },
      );
    } catch (err) {
      if (log?.warn) log.warn(`[fetch] settle window did not converge in ${settleBudgetMs}ms (table-row count may still be changing — captured snapshot anyway): ${err.message}`);
    }
  }
}

module.exports = {
  runRung,
  defaultEngineLoader,
  _internal: { STEALTH_UA_POOL, pickStealthUa, waitForCondition },
};

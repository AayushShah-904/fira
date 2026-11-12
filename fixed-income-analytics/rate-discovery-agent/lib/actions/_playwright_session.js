'use strict';

/**
 * Playwright session helper for orchestrator-path actions.
 *
 * The orchestrator (Sprint 003 #1c) currently makes plain Node HTTP requests
 * from find_website / find_rate_page / classify_rate_page, which Indian-bank
 * WAFs reject (403 on HEAD, ECONNRESET on GET). This module exposes a
 * persisted Chromium session per bank that those actions can route through
 * via `_http.js`'s `httpRequest(..., { session })` overload (wired in
 * Phase 3 of option A+C — see
 * sdlc/sprints/sprint-003/design/option-a-c-implementation-plan.md).
 *
 * Lifecycle: per-bank. One session per `orchestrate(...)` invocation, closed
 * in a try/finally regardless of which action threw. Per-process or per-
 * action lifecycles were considered and rejected (cookie bleed risk and
 * 500ms+ startup cost respectively).
 *
 * Session.fetch() does `page.goto()` (default `waitUntil: 'domcontentloaded'`) +
 * (optional) auto-scroll + (optional) accordion expansion + `page.content()`.
 * Returns the same shape as `_http.js`'s httpRequest result:
 *   { statusCode, headers, body, truncated, finalUrl }
 *
 * Default `waitFor` is `'domcontentloaded'` (Step 1G of the to-80% strategy
 * doc, 2026-05-16). Cheap orchestrator sniffs (find_website, find_rate_page,
 * classify_rate_page) don't need to wait for full network idle — empirically
 * `networkidle` times out at 8s on hosts like bankofindia.bank.in where third-
 * party trackers never settle. Full-extraction callers can pass
 * `{ waitFor: 'networkidle' }` if their use case needs it.
 *
 * `_http.js` already supports a `session` option that delegates to this
 * module — that wiring lands in Phase 3.
 */

/**
 * Create a per-bank Playwright session. Caller MUST `await session.close()`
 * to release the browser process.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger] - { info, warn, debug }
 * @param {boolean} [opts.headless=true]
 * @returns {Promise<{fetch, close, _internals}>}
 */
async function createSession({ logger, headless = true } = {}) {
  const { chromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  try {
    chromium.use(StealthPlugin());
  } catch (_) {}
  const launchOpts = {
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  };
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (err) {
    if (!launchOpts.channel && err.message.includes("Executable doesn't exist")) {
      if (logger?.warn) logger.warn("Playwright browser not found. Retrying launch using system Google Chrome...");
      try {
        launchOpts.channel = 'chrome';
        browser = await chromium.launch(launchOpts);
      } catch (err2) {
        if (logger?.warn) logger.warn("System Google Chrome launch failed. Retrying launch using system Microsoft Edge...");
        try {
          launchOpts.channel = 'msedge';
          browser = await chromium.launch(launchOpts);
        } catch (err3) {
          throw err; // throw the original error if fallback fails
        }
      }
    } else {
      throw err;
    }
  }
  const version = browser.version();
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    }
  });
  const page = await context.newPage();

  if (logger?.debug) logger.debug('[_playwright_session] browser launched');

  let closed = false;

  return {
    /**
     * Navigate to URL and return the rendered HTML in `_http.js`-compatible shape.
     *
     * @param {string} url
     * @param {object} [opts]
     * @param {string} [opts.waitFor='domcontentloaded'] - playwright waitUntil
     * @param {number} [opts.timeoutMs=60000]
     * @param {boolean} [opts.scroll=true] - auto-scroll to trigger lazy load
     * @param {boolean} [opts.accordions=true] - expand accordion / details panels
     * @param {number} [opts.maxBytes=4*1024*1024] - body byte cap (rendered HTML can exceed plain-HTTP cap)
     * @returns {Promise<{statusCode, headers, body, truncated, finalUrl}>}
     */
    async fetch(url, { waitFor = 'domcontentloaded', timeoutMs = 60000, scroll = true, accordions = true, maxBytes = 6 * 1024 * 1024 } = {}) {
      if (closed) throw new Error('_playwright_session.fetch: session is closed');
      let response;
      try {
        response = await page.goto(url, { waitUntil: waitFor, timeout: timeoutMs });
        
        // Simulated human-like delay and mouse movements to bypass bot detectors
        await page.waitForTimeout(1000 + Math.random() * 1000);
        for (let i = 0; i < 3; i++) {
          const x = Math.floor(Math.random() * 800) + 100;
          const y = Math.floor(Math.random() * 600) + 100;
          await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
          await page.waitForTimeout(Math.random() * 300 + 100).catch(() => {});
        }
      } catch (err) {
        // networkidle timeout, navigation abort, etc. Re-throw as a fetch
        // error the caller can compare against Node http errors.
        const e = new Error(`playwright_navigation_failed: ${err.message}`);
        e.cause = err;
        throw e;
      }
      if (scroll) await autoScroll(page);
      if (accordions) await expandAccordions(page);

      const body = await page.content();
      const truncated = body.length > maxBytes;
      if (truncated && logger?.warn) {
        logger.warn(`_playwright_session: truncated body from ${url} at ${maxBytes} bytes (server sent ${body.length}+)`);
      }
      return {
        statusCode: response ? response.status() : 0,
        headers: response ? response.headers() : {},
        body: truncated ? body.slice(0, maxBytes) : body,
        truncated,
        finalUrl: page.url(),
      };
    },

    /** Close the browser. Idempotent. */
    async close() {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
        if (logger?.debug) logger.debug('[_playwright_session] browser closed');
      } catch (err) {
        if (logger?.warn) logger.warn(`[_playwright_session] close failed: ${err.message}`);
      }
    },

    /** For tests/debugging only. */
    _internals: { browser, context, page },
  };
}

/** Scroll to page bottom progressively to trigger lazy-loaded content. */
async function autoScroll(page) {
  let previousHeight = 0;
  for (let i = 0; i < 10; i++) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    if (currentHeight === previousHeight && i > 0) break;
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Expand collapsed accordions / details so their content shows up in
 * page.content(). Idempotent; safe on pages without accordions.
 */
async function expandAccordions(page) {
  await page.evaluate(() => {
    // Strategy 1: click visible accordion buttons (skip nav).
    const buttons = document.querySelectorAll(".accordion-button.collapsed, [data-bs-toggle='collapse'].collapsed");
    for (const btn of buttons) {
      if (btn.closest('nav, .navbar, header')) continue;
      try { btn.click(); } catch {}
    }
    // Strategy 2: force-show collapse panels.
    for (const el of document.querySelectorAll('.accordion-collapse, .collapse')) {
      if (el.closest('nav, .navbar, header')) continue;
      el.classList.add('show');
      el.style.display = '';
    }
    // Strategy 3: open <details>.
    for (const d of document.querySelectorAll('details:not([open])')) {
      try { d.open = true; } catch {}
    }
    // Strategy 4: click retail deposit tab/filter buttons (e.g. "Less than ₹3 Cr.", "< 3 Cr", "< 2 Cr")
    const retailTab = Array.from(document.querySelectorAll("button, [role='tab']")).find(b => {
      if (b.closest('nav, .navbar, header')) return false;
      const t = b.innerText.trim();
      return /less than (?:₹?\s*[23]\s*cr|2\s*crore)/i.test(t) || /^< ?[23] ?cr/i.test(t);
    });
    if (retailTab) {
      try { retailTab.click(); } catch {}
    }
  }).catch(() => {});
  await page.waitForTimeout(800);
}

module.exports = { createSession, _autoScroll: autoScroll, _expandAccordions: expandAccordions };

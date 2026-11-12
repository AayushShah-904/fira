// Usage: node scripts/fetch_rates_playwright.js <url> [options]
//
// Options:
//   --scroll                       Scroll to bottom to trigger lazy-loaded content
//   --tabs                         Click all tab elements and extract per-tab data (heuristic selectors)
//   --tab-selector <sel>           CSS selector for tab elements — overrides the heuristic when given
//   --accordions                   Expand all accordion/collapsible sections
//   --selects                      Iterate <select> dropdown options
//   --intercept                    Monitor XHR/fetch responses for JSON rate data
//   --wait-for-selector <sel>      Wait for this selector to be visible before extracting (M2.2)
//   --click-to-reveal <sel>        Click this element after page load to reveal rate content (M2.2)
//   --extract-selector <sel>       Narrow rate-table extraction to this CSS scope (M2.2)
//   --timeout <ms>                 Page load timeout (default: 60000)
//   --browser <name>               chromium | firefox | webkit (default: chromium)
//   --stealth                      Use playwright-extra + stealth plugin (chromium only)
//
// Fetches FD interest rate tables from JS-rendered bank pages using Playwright.

// ── Parse CLI arguments ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let url = "";
// --scroll and --accordions are now default-on. They're idempotent (no-op
// on pages that lack lazy loading / accordion panels) and unlock rates on
// the long tail of bank sites that hide content behind expand-buttons or
// lazy-load below the fold. Opt out with --no-scroll / --no-accordions.
let doScroll = true;
let doAccordions = true;
let doTabs = false;
let doSelects = false;
let doIntercept = false;
let pageTimeout = 60000;
let browserName = "chromium";
let doStealth = false;
// M2.2 (sprint-004): per-bank hint overrides. CLI-passed by lib/tools.js
// when bank-domains.json#<bank>.extraction.<rate_pages_key> declares them.
let waitForSelector = null;   // CSS selector to wait for before extracting (page rendered the rate table)
let clickToReveal = null;     // CSS selector to click after page load (e.g. "View rates" button)
let extractSelector = null;   // Narrow rate-table extraction scope to this selector
let tabSelector = null;       // CSS selector for tab elements — overrides the heuristic when given
let ignoreHttpsErrors = false; // Sprint 009 Phase 9.5: bypass TLS cert verification (per-bank opt-in via tls_skip_verify in bank-domains.json)

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--scroll") doScroll = true;
  else if (argv[i] === "--no-scroll") doScroll = false;
  else if (argv[i] === "--tabs") doTabs = true;
  else if (argv[i] === "--accordions") doAccordions = true;
  else if (argv[i] === "--no-accordions") doAccordions = false;
  else if (argv[i] === "--selects") doSelects = true;
  else if (argv[i] === "--intercept") doIntercept = true;
  else if (argv[i] === "--timeout" && argv[i + 1]) pageTimeout = parseInt(argv[++i], 10);
  else if (argv[i] === "--browser" && argv[i + 1]) browserName = argv[++i];
  else if (argv[i] === "--stealth") doStealth = true;
  else if (argv[i] === "--wait-for-selector" && argv[i + 1]) waitForSelector = argv[++i];
  else if (argv[i] === "--click-to-reveal" && argv[i + 1]) clickToReveal = argv[++i];
  else if (argv[i] === "--extract-selector" && argv[i + 1]) extractSelector = argv[++i];
  else if (argv[i] === "--tab-selector" && argv[i + 1]) { tabSelector = argv[++i]; doTabs = true; }
  else if (argv[i] === "--ignore-https-errors") ignoreHttpsErrors = true;
  else if (!argv[i].startsWith("--") && !url) url = argv[i];
}

// Lazy-require the engine. playwright-extra + stealth is only loaded when
// --stealth is set; everyone else stays on the vanilla `playwright` module
// so the 500+ banks that already work don't share a code path with the
// stealth-required outliers (SBI, BoI). Firefox/WebKit engines come from
// the vanilla module — stealth is chromium-only in playwright-extra.
let engine;
if (doStealth) {
  if (browserName !== "chromium") {
    console.error(`--stealth is only supported with --browser chromium (got: ${browserName})`);
    process.exit(2);
  }
  const { chromium: stealthChromium } = require("playwright-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  stealthChromium.use(StealthPlugin());
  engine = stealthChromium;
} else {
  const pw = require("playwright");
  engine = pw[browserName];
  if (!engine) {
    console.error(`Unknown --browser ${browserName} (expected chromium|firefox|webkit)`);
    process.exit(2);
  }
}

if (!url) url = "https://www.hdfc.bank.in/fixed-deposit/fd-interest-rate";

(async () => {
  console.log(`Fetching: ${url}`);
  console.log(`Engine: ${browserName}${doStealth ? " (+stealth)" : ""}`);
  const flags = [doScroll && "scroll", doTabs && "tabs", doAccordions && "accordions", doSelects && "selects", doIntercept && "intercept"].filter(Boolean);
  if (flags.length > 0) console.log(`Flags: ${flags.join(", ")}`);

  // Chromium-only launch args don't apply to Firefox/WebKit — Playwright
  // ignores unknown flags on non-Chromium engines but the cleaner contract
  // is to omit them.
  const launchOpts = { headless: true };
  if (browserName === "chromium") {
    launchOpts.args = [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ];
  }
  let browser;
  try {
    browser = await engine.launch(launchOpts);
  } catch (err) {
    if (browserName === "chromium" && !launchOpts.channel && err.message.includes("Executable doesn't exist")) {
      console.warn("Playwright browser not found. Retrying launch using system Google Chrome...");
      try {
        launchOpts.channel = "chrome";
        browser = await engine.launch(launchOpts);
      } catch (err2) {
        console.warn("System Google Chrome launch failed. Retrying launch using system Microsoft Edge...");
        try {
          launchOpts.channel = "msedge";
          browser = await engine.launch(launchOpts);
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
    locale: "en-IN",
    extraHTTPHeaders: {
      "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    // Sprint 009 Phase 9.5: per-bank tls_skip_verify flag flows from
    // bank-domains.json → lib/tools.js → --ignore-https-errors → this option.
    ignoreHTTPSErrors: ignoreHttpsErrors,
  });
  if (ignoreHttpsErrors) console.log("HTTPS cert errors will be ignored (tls_skip_verify=true).");
  const page = await context.newPage();

  // ── XHR/Fetch interception ──────────────────────────────────────
  const interceptedApis = [];
  if (doIntercept) {
    page.on("response", async (response) => {
      const respUrl = response.url();
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if (ct.includes("json") && (/\/api\/|rate|deposit|interest/i.test(respUrl))) {
        try {
          const data = await response.json();
          interceptedApis.push({ url: respUrl, data });
          console.log(`  Intercepted API: ${respUrl}`);
        } catch {}
      }
    });
  }

  // Detect PDF URLs — Playwright crashes on PDF downloads
  if (/\.pdf(\?|$)/i.test(url)) {
    console.log("URL points to a PDF file — Playwright cannot render PDFs.");
    console.log("JSON_OUTPUT:" + JSON.stringify({
      error: "PDF URL detected. Use a PDF parser instead of Playwright.",
      pdf_url: url,
      rate_slabs: [],
      html_tables: [],
    }));
    await browser.close();
    return;
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: pageTimeout });
  
  // Simulated human-like delay and mouse movements to bypass bot detectors
  await page.waitForTimeout(1000 + Math.random() * 1000);
  for (let i = 0; i < 3; i++) {
    const x = Math.floor(Math.random() * 800) + 100;
    const y = Math.floor(Math.random() * 600) + 100;
    await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
    await page.waitForTimeout(Math.random() * 300 + 100).catch(() => {});
  }

  // ── M2.2 hints: wait-for-selector and click-to-reveal ───────────
  if (waitForSelector) {
    try {
      await page.waitForSelector(waitForSelector, { timeout: Math.min(pageTimeout, 15000), state: "visible" });
      console.log(`Wait-for-selector hit: ${waitForSelector}`);
    } catch (err) {
      console.log(`Wait-for-selector "${waitForSelector}" timed out (${err.message}); continuing anyway.`);
    }
  }
  if (clickToReveal) {
    try {
      const el = page.locator(clickToReveal).first();
      const count = await page.locator(clickToReveal).count();
      if (count > 0) {
        await el.click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        console.log(`Clicked reveal selector: ${clickToReveal}`);
      } else {
        console.log(`Click-to-reveal selector "${clickToReveal}" matched 0 elements; skipping.`);
      }
    } catch (err) {
      console.log(`Click-to-reveal "${clickToReveal}" failed (${err.message}); continuing.`);
    }
  }

  // ── Lazy-load scrolling ─────────────────────────────────────────
  if (doScroll) {
    console.log("Scrolling to load lazy content...");
    let previousHeight = 0;
    for (let i = 0; i < 10; i++) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === previousHeight && i > 0) break;
      previousHeight = currentHeight;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
    }
    // Scroll back to top and settle
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
    console.log("Scroll complete.");
  }

  // ── Tab interaction ─────────────────────────────────────────────
  const tabsData = [];
  if (doTabs) {
    // M2.2: per-bank tabSelector overrides the heuristic when provided.
    const heuristicTabSelectors = "[role='tab'], .nav-tab, .nav-link, [data-toggle='tab'], [data-bs-toggle='tab']";
    const tabSelectors = tabSelector || heuristicTabSelectors;
    const tabCount = await page.locator(tabSelectors).count();
    if (tabCount > 1) {
      console.log(`Found ${tabCount} tabs${tabSelector ? ` (selector: ${tabSelector})` : ""}, clicking each...`);
      for (let t = 0; t < tabCount; t++) {
        const tab = page.locator(tabSelectors).nth(t);
        const label = (await tab.textContent().catch(() => "")).trim();
        try {
          await tab.click({ timeout: 2500 });
          await page.waitForTimeout(1000);
          // Extract tables visible after this tab click
          const tabTables = await extractAllTables(page, extractSelector);
          const tabText = await page.innerText("body").catch(() => "");
          const tabSlabs = parseRateSlabsFromText(tabText);
          tabsData.push({ label, tables: tabTables, rate_slabs: tabSlabs });
          console.log(`  Tab "${label}": ${tabTables.length} tables, ${tabSlabs.length} slabs`);
        } catch (err) {
          console.log(`  Tab "${label}": click failed (${err.message})`);
        }
      }
    } else {
      console.log(`No tabs found (or only 1)${tabSelector ? ` for selector "${tabSelector}"` : ""}.`);
    }
  }

  // ── Accordion expansion ─────────────────────────────────────────
  if (doAccordions) {
    const expanded = await page.evaluate(() => {
      let count = 0;
      // Strategy 1: Click all collapsed accordion buttons (scoped to visible content, skip nav)
      const collapsed = document.querySelectorAll(
        ".accordion-button.collapsed, [data-bs-toggle='collapse'].collapsed"
      );
      collapsed.forEach((btn) => {
        // Skip nav/menu items — only expand content accordions
        if (btn.closest("nav, .navbar, header")) return;
        try { btn.click(); count++; } catch {}
      });
      // Strategy 2: Force-show all accordion-collapse panels
      document.querySelectorAll(".accordion-collapse, .collapse").forEach((el) => {
        if (el.closest("nav, .navbar, header")) return;
        el.classList.add("show");
        el.style.display = "";
      });
      // Strategy 3: Open all <details> elements
      document.querySelectorAll("details:not([open])").forEach((d) => {
        d.open = true; count++;
      });
      return count;
    });
    await page.waitForTimeout(2000);
    console.log(`Accordions expanded: ${expanded} clicked + collapse panels force-shown.`);
  }

  // ── Select dropdown iteration ───────────────────────────────────
  const selectsData = [];
  if (doSelects) {
    const selectCount = await page.locator("select").count();
    if (selectCount > 0) {
      console.log(`Found ${selectCount} select element(s)...`);
      for (let s = 0; s < Math.min(selectCount, 3); s++) {
        const select = page.locator("select").nth(s);
        const options = await select.locator("option").allTextContents();
        const values = await select.locator("option").evaluateAll(
          (opts) => opts.map((o) => o.value),
        );
        console.log(`  Select ${s}: ${options.length} options`);
        for (let o = 0; o < options.length; o++) {
          try {
            await select.selectOption(values[o]);
            await page.waitForTimeout(800);
            const text = await page.innerText("body").catch(() => "");
            const slabs = parseRateSlabsFromText(text);
            if (slabs.length > 0) {
              selectsData.push({ select_index: s, option: options[o].trim(), value: values[o], rate_slabs: slabs });
              console.log(`    "${options[o].trim()}": ${slabs.length} slabs`);
            }
          } catch {}
        }
      }
    }
  }

  // ── Standard extraction (always runs) ───────────────────────────

  // Wait for rate content to render
  let hasTable = false;
  try {
    await page.waitForSelector("table", { timeout: 10000 });
    hasTable = true;
  } catch {
    // No <table> tags — data may be in divs/spans
  }

  const bodyText = await page.innerText("body");

  // Extract tables if present. M2.2: when extract_selector is given the
  // table picker narrows to that scope (e.g., for sites where rate data
  // lives in a <div> container with a known class).
  const tables = hasTable ? await extractAllTables(page, extractSelector) : [];

  // Parse rate slabs from body text
  const rateSlabs = parseRateSlabsFromText(bodyText);

  // Find effective dates
  const { extractEffectiveDate } = require("../lib/extract-date");
  const effectiveDate = extractEffectiveDate(bodyText);
  const dateMatches = effectiveDate ? [[null, effectiveDate]] : [];

  // ── Output ──────────────────────────────────────────────────────

  console.log("\n=== RESULTS ===");
  console.log(`Tables (HTML): ${tables.length}`);
  console.log(`Rate slabs parsed from text: ${rateSlabs.length}`);
  if (tabsData.length > 0) console.log(`Tabs extracted: ${tabsData.length}`);
  if (selectsData.length > 0) console.log(`Select options extracted: ${selectsData.length}`);
  if (interceptedApis.length > 0) console.log(`Intercepted APIs: ${interceptedApis.length}`);
  dateMatches.forEach((d) => console.log(`Effective date: ${d[1]}`));

  if (tables.length > 0) {
    tables.forEach((t) => {
      console.log(`\n--- HTML Table ${t.tableIndex} (${t.rowCount} rows) ---`);
      t.rows.slice(0, 25).forEach((row) => console.log(row.join(" | ")));
      if (t.rowCount > 25) console.log(`  ... (${t.rowCount - 25} more rows)`);
    });
  }

  console.log("\n--- Parsed Rate Slabs ---");
  rateSlabs.forEach((s) =>
    console.log(`${s.tenure_text} | ${s.rate_general_pct} | ${s.rate_senior_pct}`)
  );

  // Build output JSON
  // page_html: the rendered DOM after JS hydration. Lets downstream consumers
  // (lib/actions/extract_html_table.js) re-parse with cheerio when the
  // in-browser table picker mis-selects on complex multi-table layouts.
  const pageHtml = await page.content();
  const output = {
    url,
    scraped_at: new Date().toISOString(),
    effective_dates: dateMatches.map((d) => d[1]),
    tables,
    rate_slabs: rateSlabs,
    page_html: pageHtml,
  };
  if (tabsData.length > 0) output.tabs = tabsData;
  if (selectsData.length > 0) output.selects = selectsData;
  if (interceptedApis.length > 0) output.intercepted_apis = interceptedApis;

  // Sprint 002 #5 (L13 codification): when neither <table> elements nor the
  // text-pattern parser yielded rate slabs, include the rate-keyword-rich
  // lines from the rendered body so the LLM can extract structure itself.
  // This handles the "table rendered as styled divs" pattern observed at
  // nizamabad-district-co-operative-central-bank-ltd.
  if (tables.length === 0 && rateSlabs.length === 0) {
    const rateLines = bodyText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && /(%|\bdays?\b|\byears?\b|\bmonths?\b|\bdeposit\b|\binterest\b|\brate\b|\bp\.a\.\b)/i.test(l));
    // Cap at ~120 lines / 8 KB to stay within the LLM's context budget for
    // a single fetch result. The agent's prompt explains what to do with this.
    const capped = rateLines.slice(0, 120).join("\n").slice(0, 8000);
    if (capped.length > 0) {
      output.rendered_text_rate_lines = capped;
      output.rendered_text_note =
        "No <table> elements and no slabs matched by the text-pattern parser. " +
        "The lines above are rate-keyword-rich lines from the rendered body — " +
        "the page likely renders its rate data as styled <div>/<span> elements " +
        "(div-table pattern). Parse them yourself if you can identify a tabular " +
        "structure.";
    }
  }

  console.log("\n=== JSON_OUTPUT ===");
  console.log(JSON.stringify(output, null, 2));

  await browser.close();
})();

// ── Helper functions ────────────────────────────────────────────────

async function extractAllTables(page, scopeSelector) {
  return page.evaluate((scopeSelector) => {
    const results = [];

    // M2.2: if scopeSelector is given, narrow the search root to the first
    // matching element. Useful when the page has shell tables (nav, footer)
    // and the rate table lives in a known container (e.g. ".nri-rates").
    let root = document;
    if (scopeSelector) {
      const scoped = document.querySelector(scopeSelector);
      if (scoped) {
        root = scoped;
      }
      // If selector matches nothing, fall back to whole document — the
      // hint may be stale or apply to a sibling page; better to extract
      // something than nothing.
    }

    // 1. Standard <table> elements
    root.querySelectorAll("table").forEach((table, tableIndex) => {
      const rows = [];
      table.querySelectorAll("tr").forEach((tr) => {
        const cells = [];
        tr.querySelectorAll("th, td").forEach((cell) => {
          cells.push(cell.innerText.trim());
        });
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) results.push({ tableIndex, rowCount: rows.length, rows, source: "table" });
    });

    // 2. Div-based rate grids (common in React/Angular/Vue sites)
    // Look for repeated row-like structures with rate data
    if (results.length === 0) {
      const gridSelectors = [
        ".rate-table", ".rates-table", ".interest-rate",
        "[class*='rate-row']", "[class*='rate-grid']", "[class*='rate-card']",
        "[class*='deposit-rate']", "[class*='fd-rate']",
        ".table-responsive", "[class*='table-data']",
      ];
      for (const sel of gridSelectors) {
        const grids = root.querySelectorAll(sel);
        grids.forEach((grid, gi) => {
          const rows = [];
          // Try to find row-like children
          const rowEls = grid.querySelectorAll("[class*='row'], [class*='item'], [class*='slab'], tr, li");
          rowEls.forEach((row) => {
            const text = row.innerText.trim();
            // Must contain both a tenure-like term and a percentage
            if (/\d+\.\d+\s*%/.test(text) && /day|month|year|week/i.test(text)) {
              const cells = text.split(/\t|\n/).map((c) => c.trim()).filter(Boolean);
              if (cells.length >= 2) rows.push(cells);
            }
          });
          if (rows.length > 0) {
            results.push({ tableIndex: results.length, rowCount: rows.length, rows, source: "div:" + sel });
          }
        });
      }
    }

    return results;
  }, scopeSelector || null);
}

function parseRateSlabsFromText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const slabs = [];

  // Pattern 1: Tab-separated (tenure \t rate% \t senior_rate%)
  const tabPattern = /^(.+?(?:days?|months?|years?|year).+?)\t(\d+\.\d+\s*%)\t(\d+\.\d+\s*%)$/i;
  // Pattern 2: Tenure followed by rate percentages on same line
  const inlinePattern = /^(.+?(?:\d+\s*(?:days?|months?|years?|year))[^%]*?)\s+(\d+\.\d+)\s*%?\s+(\d+\.\d+)\s*%/i;
  // Pattern 3: Tenure and single rate
  const singleRatePattern = /^(.+?(?:\d+\s*(?:days?|months?|years?|year))[^%]*?)\s+(\d+\.\d+)\s*%/i;

  for (const line of lines) {
    let m = line.match(tabPattern);
    if (m) {
      slabs.push({
        tenure_text: m[1].trim(),
        rate_general_pct: m[2].replace(/\s*%/, ""),
        rate_senior_pct: m[3].replace(/\s*%/, ""),
      });
      continue;
    }
    m = line.match(inlinePattern);
    if (m) {
      slabs.push({
        tenure_text: m[1].trim(),
        rate_general_pct: m[2],
        rate_senior_pct: m[3],
      });
      continue;
    }
    m = line.match(singleRatePattern);
    if (m && !slabs.some((s) => s.tenure_text === m[1].trim())) {
      slabs.push({
        tenure_text: m[1].trim(),
        rate_general_pct: m[2],
        rate_senior_pct: null,
      });
    }
  }
  return slabs;
}

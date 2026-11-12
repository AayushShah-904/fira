\*\*PHASE 2 DEEP DIVE\*\*



\*\*Data Collection Pipeline\*\*



\*Indian Bank Interest Rate Aggregator\*



Scraping architecture, per-bank configurations, PDF parsing pipeline,

validation engine, scheduling, monitoring, and week-by-week deliverables



Version 1.0  •  March 2026



\*\*CONFIDENTIAL\*\*



\# \*\*1. Pipeline Architecture Overview\*\*



The data collection pipeline is the engine that powers the entire platform. It must reliably extract interest rate data from 60–70 financial institutions that publish in wildly different formats, validate that data against multiple sources, and load it into the versioned database schema designed in Phase 1. This section defines the architecture, technology choices, and design principles.



\## \*\*1.1 Design Principles\*\*



\- \*\*Configuration over code: \*\*Each bank’s scraping logic should be driven by a JSON/YAML configuration file, not hardcoded scraper logic. When a bank redesigns its website, you update a config file – not rewrite a scraper.



\- \*\*Fail gracefully: \*\*A single bank’s scraper failing should never bring down the entire pipeline. Each bank runs as an independent task with its own error handling, retry logic, and alerting.



\- \*\*Validate before publish: \*\*No scraped data reaches the public-facing database without passing through the multi-layer validation engine. Anomalous data is quarantined in a review queue.



\- \*\*Audit everything: \*\*Every scrape run, every data change, every validation decision is logged. This creates an audit trail for debugging, compliance, and user trust.



\- \*\*Respect the source: \*\*Implement rate limiting, respectful crawl delays, and proper User-Agent headers. RBI mandates public disclosure of rates, but aggressive scraping can still trigger IP blocks.



\## \*\*1.2 Technology Stack\*\*



The table below maps each technology to its role in the pipeline:



| \*\*Technology\*\* | \*\*Role\*\* | \*\*Key Features\*\* | \*\*Used For\*\* |

| --- | --- | --- | --- |

| Scrapy | Scraping framework | Async, middleware pipeline, retry logic, rate limiting, item pipelines | Core framework for all scraping |

| Playwright | Headless browser | JS rendering, network interception, multi-browser support | JS-rendered pages (HDFC, Kotak, Axis, IDFC First, Bajaj Finance) |

| BeautifulSoup | HTML parser | Lightweight, fast parsing, CSS selectors | Static HTML pages (SBI, BoB, PNB, Union Bank, Federal Bank) |

| pdfplumber | PDF parser (primary) | Text-based tables, char-level access, visual debugging | Primary PDF extraction (Canara, Indian Bank, BOI) |

| Camelot | PDF parser (fallback) | Lattice/stream modes, accuracy metrics, DataFrame output | Complex PDF layouts with clear borders |

| Tesseract OCR | Scanned PDF fallback | Open-source OCR engine, multi-language support | Scanned/image-based PDFs from older PSB circulars |

| PostgreSQL | Database | Versioned rate slabs, JSONB for flexible metadata, full-text search | Primary data store |

| Redis | Cache \& queue | Rate limiting counters, job queues, hot query cache | Scrape scheduling, deduplication, caching |

| Celery | Task scheduler | Periodic tasks, retry policies, distributed workers | Daily scrape orchestration, monitoring |

| Docker | Containerisation | Reproducible environments, browser binaries included | Deployment and CI/CD |



\## \*\*1.3 High-Level Data Flow\*\*



The pipeline operates in five stages that run sequentially for each bank:



\- Fetch: Download the rate page (HTML via HTTP or headless browser) or PDF rate card.



\- Parse: Extract tabular rate data from the downloaded content using the bank-specific configuration.



\- Normalise: Map bank-specific fields (column headers, tenure descriptions, rate formats) to the unified data model.



\- Validate: Run the extracted data through 7 validation layers. Pass clean data to the database; quarantine anomalous data.



\- Store: Write validated rate slabs to the database using the append-only versioning strategy. Log all changes.



Each stage is implemented as a Scrapy pipeline component (Item Pipeline), making it easy to add, remove, or reorder processing steps.



\# \*\*2. Web Scraping Infrastructure\*\*



This section covers the detailed scraper architecture, organised by the source format categories identified in Phase 1’s data source inventory.



\## \*\*2.1 Scraper Assignment by Source Type\*\*



Based on the Phase 1 source inventory, banks are grouped into five tiers by data format:



| \*\*Tier\*\* | \*\*Banks\*\* | \*\*Tool Stack\*\* | \*\*Approach\*\* | \*\*Count\*\* |

| --- | --- | --- | --- | --- |

| Tier 1: Static HTML | SBI, BoB, PNB, Union Bank, Federal Bank, Bandhan, AU SFB, Yes Bank | Scrapy + BeautifulSoup | HTTP GET + CSS selector parsing | ~8 banks |

| Tier 2: JS-Rendered | HDFC, Kotak, Axis, IndusInd, IDFC First, Bajaj Finance | Scrapy-Playwright | Headless Chromium, network intercept for API discovery | ~6 banks |

| Tier 3: PDF Dominant | Canara Bank, Indian Bank, BOI, PNB (partial), ICICI (partial) | requests + pdfplumber/Camelot | Download PDF, extract tables, normalise columns | ~5 banks |

| Tier 4: Mixed | ICICI, Ujjivan SFB, Shriram Finance, Equitas SFB | Scrapy + pdfplumber | HTML for some products, PDF for others | ~4 banks |

| Tier 5: Government | India Post, RBI bonds | requests + gazette PDF parsing | Ministry of Finance notifications, quarterly cycle | ~2 sources |



\## \*\*2.2 Static HTML Scraping (Tier 1)\*\*



This is the simplest and most efficient scraping approach. About 40% of banks serve rate data as plain HTML tables that can be fetched with a standard HTTP request and parsed with BeautifulSoup or lxml.



\### \*\*How It Works\*\*



\- Send an HTTP GET request to the bank’s rate page URL (from the per-bank config).



\- Parse the HTML response using BeautifulSoup with the CSS selectors defined in the config.



\- Extract the rate table rows. For each row, map columns to the unified schema using the column\_mapping config.



\- Parse tenure text into min/max days using the tenure\_parser defined in the config.



\- Pass the normalised RateSlabItem to the validation pipeline.



\### \*\*Key Challenges \*\*\*\*\&\*\*\*\* Solutions\*\*



\- \*\*Inconsistent table structures: \*\*SBI uses clean <table> elements. PNB mixes colspan/rowspan. Solution: Each bank’s config defines exactly which CSS selectors to use and how to handle merged cells.



\- \*\*Accordion/tab components: \*\*Some banks (e.g., Bank of Baroda) hide rate tables inside accordion sections that require a click to expand. Solution: For static HTML banks, check if the hidden content is actually present in the HTML but just display:none. If so, parse it directly. If it truly requires JS interaction, upgrade the bank to Tier 2.



\- \*\*Rate changes mid-page: \*\*Banks often display “with effect from \[date]” text near the table. Solution: Extract this date as the effective\_from for the rate slabs. The config includes a selector for the effective date text.



\## \*\*2.3 JavaScript-Rendered Scraping (Tier 2)\*\*



About 25% of banks use React, Angular, or other SPA frameworks that render rate data client-side. These require a headless browser to execute JavaScript before the rate tables appear in the DOM.



\### \*\*Primary Approach: Network Interception\*\*



Before building a full headless browser scraper, the first step for every Tier 2 bank is to inspect network traffic and look for the underlying API endpoint. Many SPAs load rate data via an XHR/fetch call to an internal JSON API. If found, you can call this API directly – which is 5–10x faster, more reliable, and less resource-intensive than rendering the full page.



\- Open the bank’s rate page in Chrome DevTools, go to the Network tab, and filter by XHR/Fetch.



\- Look for JSON responses containing rate data (search for numbers like “6.50” or “7.25”).



\- If found, document the endpoint URL, request headers, and any required parameters in the per-bank config.



\- Build a simple HTTP-based scraper that calls this API directly. This becomes a Tier 1 scraper with a different URL.



\*Pro tip: HDFC Bank’s React SPA loads FD rates from an internal API. Discovering this endpoint turns a 30-second Playwright scrape into a 2-second HTTP request. Always try this first.\*



\### \*\*Fallback: Headless Browser with Scrapy-Playwright\*\*



If no API endpoint is discovered, use Scrapy-Playwright to render the page in headless Chromium:



\- Configure Scrapy-Playwright as a download handler in the Scrapy project settings.



\- For each Tier 2 bank, the config specifies a js\_wait\_selector – the CSS selector to wait for before extracting data (e.g., the rate table container).



\- After the page renders, extract the HTML and parse it with BeautifulSoup using the same selector-based approach as Tier 1.



\- Use Playwright’s request interception to block unnecessary resources (images, fonts, analytics scripts) to speed up rendering.



\- Set a page timeout of 30 seconds. If the page fails to render, retry once, then log as a scrape failure.



\### \*\*Resource Management\*\*



\- Run headless browser scrapers with a concurrency limit of 3–4 simultaneous browser contexts to avoid memory exhaustion.



\- Reuse browser instances across multiple bank scrapes within the same Celery task batch.



\- Allocate at least 2GB RAM per headless Chromium instance in the Docker container.



\- Monitor memory usage and implement automatic browser restart if memory exceeds 80% of the container limit.



\## \*\*2.4 PDF Parsing Pipeline (Tier 3)\*\*



About 20% of banks publish rate data as downloadable PDF documents. This requires a dedicated PDF parsing pipeline that handles the significant variability in PDF structure across banks.



\### \*\*Pipeline Flow\*\*



\- Download: Fetch the PDF from the bank’s rate page. Some banks link the PDF directly; others require navigating to a downloads page first. The config stores the direct PDF URL or the page URL + PDF link selector.



\- Hash Check: Compute an MD5 hash of the downloaded PDF. Compare against the last known hash. If identical, skip parsing (the PDF hasn’t changed). This avoids unnecessary reprocessing.



\- Extract Tables: Use pdfplumber as the primary extraction tool. Pass the page numbers and table area coordinates from the per-bank config. pdfplumber’s extract\_table() method handles most well-structured PDFs.



\- Fallback to Camelot: If pdfplumber fails (returns empty or garbled data), retry with Camelot’s lattice mode (for PDFs with visible cell borders) or stream mode (for borderless tables).



\- OCR Fallback: If both pdfplumber and Camelot fail, the PDF may be a scanned image. Use Tesseract OCR to extract text, then apply regex-based parsing. Flag the result for mandatory human review.



\- Normalise: Map the extracted columns to the unified schema using the column\_mapping config. Handle the specific column header variations each bank uses.



\### \*\*Bank-Specific PDF Challenges\*\*



\- \*\*Canara Bank: \*\*PDF has merged cells for tenure ranges that span multiple rows. pdfplumber handles this by detecting cell boundaries, but the config must specify exact table area coordinates to avoid picking up header text.



\- \*\*Indian Bank: \*\*PDF uses irregular spacing instead of cell borders. Camelot’s stream mode works better here than pdfplumber. The config specifies which parser to use as the primary tool.



\- \*\*Bank of India: \*\*Publishes both HTML and PDF for different products. FD rates are on the HTML page; RD rates are in a separate PDF. The config handles this as a “mixed” source with two scraping steps.



\- \*\*Older PSB circulars: \*\*Some public sector banks distribute rate change circulars as scanned PDFs (actual images, not text). These require OCR and should always be flagged for manual verification.



\### \*\*Column Normalisation Layer\*\*



Banks use wildly different column headers for the same data. The normalisation layer maps these to the unified schema:



\- "Rate of Interest", "ROI (%)", "Interest Rate p.a.", "Int. Rate (% p.a.)" → rate\_general\_pct



\- "Sr. Citizen Rate", "Senior Citizens", "60 yrs \& above" → rate\_senior\_pct



\- "Period", "Tenure", "Maturity Period", "Duration" → tenure text (then parsed to min/max days)



\- "Min. Amount", "Minimum Deposit", "Min Deposit (Rs.)" → min\_deposit



This mapping is stored in the column\_mapping field of the per-bank config. A central utility function applies the mapping during the normalisation stage.



\# \*\*3. Per-Bank Configuration System\*\*



The per-bank configuration system is the backbone of the scraping pipeline’s maintainability. Instead of writing custom scraper code for each of the 60–70 institutions, a single generic scraper reads a bank-specific JSON configuration file that defines how to fetch, parse, and normalise that bank’s data.



\## \*\*3.1 Configuration Schema\*\*



Every institution has a JSON configuration file containing the following fields:



| \*\*Field\*\* | \*\*Type\*\* | \*\*Description\*\* | \*\*Required\*\* |

| --- | --- | --- | --- |

| bank\_id | string | Unique identifier matching the banks table (e.g., "sbi", "hdfc") | Yes |

| scraper\_type | enum | html\_static │ html\_js │ pdf │ mixed │ government | Yes |

| rate\_page\_urls | array | List of URLs to scrape (some banks have separate pages per product) | Yes |

| selectors | object | CSS selectors for table container, rows, rate cells, tenure cells | For HTML |

| pdf\_download\_url | string | Direct URL to download the rate card PDF | For PDF |

| pdf\_table\_settings | object | pdfplumber/Camelot config: page numbers, table areas, column boundaries | For PDF |

| js\_wait\_selector | string | CSS selector to wait for before extracting (for JS-rendered pages) | For JS |

| js\_api\_endpoint | string | Discovered internal API endpoint (preferred over headless browser) | Optional |

| column\_mapping | object | Maps bank-specific column headers to unified schema fields | Yes |

| tenure\_parser | string | Regex or parser function name for converting tenure text to min/max days | Yes |

| expected\_slab\_count | integer | Expected number of tenure slabs (for completeness validation) | Yes |

| rate\_multiplier | float | 1.0 if rates are percentages, 100.0 if rates are decimals (0.065 for 6.5%) | Yes |

| senior\_citizen\_premium | string | How senior rates are presented: "separate\_table", "same\_table", "fixed\_premium" | Yes |

| update\_frequency | string | Expected update cadence: daily, weekly, monthly, quarterly | Yes |

| last\_known\_change | date | Date of last observed rate change (for staleness baseline) | Yes |

| notes | string | Free-text notes on quirks (e.g., "accordion tabs", "CAPTCHA on 3rd request") | Optional |



\## \*\*3.2 Example Configuration: SBI\*\*



A simplified example showing how SBI’s configuration drives the scraper:



\- bank\_id: "sbi"



\- scraper\_type: "html\_static"



\- rate\_page\_urls: \["https://sbi.bank.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits"]



\- selectors.table: "table.interest-rate-table" (CSS selector for the rate table)



\- selectors.rows: "tbody tr" (selector for data rows within the table)



\- selectors.effective\_date: ".rate-effective-date" (selector for the "w.e.f." date text)



\- column\_mapping: {0: "tenure\_text", 1: "rate\_general\_pct", 2: "rate\_senior\_pct"}



\- tenure\_parser: "sbi\_standard" (handles SBI’s specific tenure text format)



\- expected\_slab\_count: 11



\- rate\_multiplier: 1.0 (rates are already in percentage format)



\- senior\_citizen\_premium: "same\_table" (general and senior rates are in the same table)



\- update\_frequency: "monthly"



\## \*\*3.3 Configuration Maintenance Workflow\*\*



When a bank redesigns its website or changes its rate page structure:



\- The monitoring system detects a scrape failure (parse error or zero results).



\- An alert is sent to the team with the bank name and error details.



\- A team member visits the bank’s rate page, inspects the new structure, and updates the JSON config file (selectors, table area, etc.).



\- The updated config is committed to Git and deployed. The next scheduled scrape uses the new config.



\- No scraper code changes are needed – only the config file is updated.



\*This config-driven approach is the single most important architectural decision for long-term maintainability. Banks redesign their websites 1–2 times per year. Without it, you’d be constantly rewriting scraper code.\*



\# \*\*4. Data Validation \*\*\*\*\&\*\*\*\* Quality Engine\*\*



Scraped data is inherently unreliable. A single CSS selector change, a PDF layout shift, or a temporary website error can inject wrong data into your database. The validation engine is a multi-layer pipeline that catches errors before they reach users.



\## \*\*4.1 Validation Pipeline\*\*



Every scraped record passes through seven validation layers in sequence:



| \*\*Layer\*\* | \*\*Stage\*\* | \*\*Rule\*\* | \*\*Action on Failure\*\* |

| --- | --- | --- | --- |

| Layer 1: Format | Ingestion | Ensure rates are numeric, tenures parse to days, no null required fields | Auto-reject |

| Layer 2: Range | Post-parse | FD rates: 2.50%–9.50%; SA rates: 2.00%–8.00%; RD rates: 3.00%–9.00% | Flag for review |

| Layer 3: Delta | Post-parse | Rate change > 50 bps from previous value for same product/tenure | Flag for review |

| Layer 4: Monotonicity | Post-parse | FD rates should generally increase with tenure (flag inversions) | Flag for review |

| Layer 5: Completeness | Post-parse | Number of slabs matches expected\_slab\_count ±20% | Flag + rescrape |

| Layer 6: Cross-ref | Post-validation | Compare Tier 1 bank rates against BankBazaar/Paisabazaar; >10 bps gap flags | Flag for review |

| Layer 7: Staleness | Scheduled | No rate change detected in 60+ days for any bank | Force rescrape + manual check |



\## \*\*4.2 Validation Rule Details\*\*



\### \*\*Range Checks\*\*



These catch wildly incorrect values that result from parsing errors (e.g., a scraper reading a phone number instead of an interest rate). The ranges are intentionally wide to accommodate SFBs that offer premium rates:



\- FD rates: 2.50% to 9.50% (covers large PSBs at ~3% short-term to aggressive SFBs at ~9%)



\- Savings account rates: 2.00% to 8.00% (covers SBI’s 2.70% to Ujjivan/AU’s 7%+)



\- RD rates: 3.00% to 9.00%



\- NBFC FD rates: 5.00% to 10.00% (NBFCs typically offer higher rates)



\- Post office scheme rates: 4.00% to 9.00%



\### \*\*Delta Checks\*\*



Banks rarely change rates by more than 25–50 bps in a single revision. A rate jumping by 100+ bps almost certainly indicates a scraping error. The delta check compares each new rate against the most recent value for the same bank/product/tenure combination.



\- Threshold: 50 bps (configurable per bank; SFBs may warrant a higher threshold of 75 bps)



\- Exception: When a bank launches an entirely new product or special tenure scheme, there’s no previous value to compare against. New products are flagged for review but with a lower priority.



\### \*\*Monotonicity Checks\*\*



In a normal interest rate environment, FD rates increase with tenure – a bank pays more for money locked in for 5 years than for 1 year. An inverted yield curve (where short tenures pay more than long tenures) does occasionally occur, but it’s unusual enough to warrant review.



\- Check: For each bank, sort all FD rate slabs by tenure\_min\_days. Flag if any rate is lower than the rate for the previous (shorter) tenure.



\- Handling: Inverted patterns are flagged for review, not auto-rejected. If confirmed (i.e., the bank genuinely has an inverted curve), mark the pattern as “known inversion” in the config to suppress future false positives.



\### \*\*Completeness Checks\*\*



Each bank’s config specifies the expected\_slab\_count – the typical number of tenure slabs that bank publishes. SBI has 11–12 slabs; a smaller bank might have 6–8.



\- If a scrape returns fewer than 80% of the expected slab count, something likely went wrong (partial page load, missing table section).



\- If a scrape returns significantly more slabs than expected, the parser may be picking up extraneous data (e.g., a different product’s table).



\### \*\*Cross-Reference Checks\*\*



For Tier 1 banks (top 10 by deposit volume), compare scraped rates against at least one secondary aggregator (BankBazaar, Paisabazaar, or StableMoney). This catches systematic scraping errors that pass all other validation layers.



\- Threshold: Flag if any rate differs by more than 10 bps from the secondary source.



\- Limitation: Secondary sources also scrape data and may have their own errors. Treat discrepancies as flags for investigation, not automatic corrections.



\## \*\*4.3 Human Review Queue\*\*



Flagged records enter a review queue with a simple admin interface. Each record shows the scraped data, the validation rule that flagged it, the previous known-good value, and a link to the bank’s rate page for manual verification.



\- \*\*Approve: \*\*The data is correct. Publish it to the production database. The validation rule’s threshold may need adjustment if false positives are frequent.



\- \*\*Reject \*\*\*\*\&\*\*\*\* Rescrape: \*\*The data is incorrect. Trigger an immediate rescrape and re-validate. If the rescrape produces the same anomalous result, escalate to manual investigation.



\- \*\*Reject \*\*\*\*\&\*\*\*\* Hold: \*\*Cannot determine correctness. Keep the previous known-good data live on the platform. Mark the bank’s data as “unverified” with a yellow/red freshness indicator.



Target SLA: All flagged records should be reviewed within 4 hours during business hours (9 AM – 9 PM IST). Critical flags (Tier 1 banks with >50 bps delta) should be reviewed within 1 hour.



\## \*\*4.4 Data Freshness Monitoring\*\*



The freshness system tracks when each bank’s data was last successfully scraped and validated:



\- \*\*Green (Fresh): \*\*Last verified within 7 days. This is the default state after a successful scrape cycle.



\- \*\*Yellow (Aging): \*\*Last verified 8–30 days ago. The data is likely current (most banks don’t change rates this often) but hasn’t been re-confirmed.



\- \*\*Red (Stale): \*\*Last verified 30+ days ago. Either the scraper is broken for this bank, or the bank’s website is inaccessible. User-facing pages show a warning.



Every rate displayed on the platform shows a “Last verified: \[date]” timestamp. This transparency is a competitive advantage over incumbents who rarely disclose data freshness.



\# \*\*5. Scheduling \*\*\*\*\&\*\*\*\* Orchestration\*\*



The scraping pipeline runs on an automated schedule orchestrated by Celery Beat (a periodic task scheduler) with Redis as the message broker. The schedule is designed to complete all scraping, validation, and alerting before 06:00 IST each day, so users always see fresh data by morning.



\## \*\*5.1 Daily Schedule\*\*



| \*\*Time\*\* | \*\*Job\*\* | \*\*Scope\*\* | \*\*Resource Load\*\* | \*\*Duration\*\* |

| --- | --- | --- | --- | --- |

| Daily 02:00 IST | Tier 1 HTML scrapers | All static HTML banks | Low (HTTP only) | ~15 min |

| Daily 03:00 IST | Tier 2 JS scrapers | All JS-rendered banks | High (browser) | ~30 min |

| Daily 04:00 IST | Tier 3 PDF scrapers | All PDF-dominant banks | Medium | ~20 min |

| Daily 04:30 IST | Cross-reference validation | Compare against BankBazaar/Paisabazaar | Low | ~10 min |

| Daily 05:00 IST | Anomaly detection run | Run all validation rules against new data | Low | ~5 min |

| Quarterly (Jan, Apr, Jul, Oct) | Government scheme update | Check Ministry of Finance notification | Low | Manual trigger |

| Weekly (Monday 06:00 IST) | Staleness audit | Check all banks for data freshness | Low | ~5 min |

| On-demand | Emergency rescrape | Triggered by rate change news or user reports | Varies | ~5 min per bank |



\## \*\*5.2 Retry \*\*\*\*\&\*\*\*\* Error Handling\*\*



Each scrape task follows a graduated retry strategy:



\- First failure: Retry immediately (transient network error).



\- Second failure: Wait 5 minutes, then retry (temporary server issue).



\- Third failure: Wait 30 minutes, then retry (possible rate limiting or maintenance window).



\- Fourth failure: Mark as failed. Send alert to the team with error details. The bank’s data retains its last known-good values with a “Yellow” freshness indicator.



If a bank’s scraper fails for 3 consecutive days, escalate to a “Red” alert with the assumption that the website structure has changed and the config needs updating.



\## \*\*5.3 Rate Change Detection \*\*\*\*\&\*\*\*\* Notifications\*\*



When the pipeline detects an actual rate change (validated and published), it triggers:



\- An entry in the rate\_change\_log table with before/after values and detection timestamp.



\- An internal Slack notification to the team (for awareness and quality monitoring).



\- A user-facing notification (email/push) to any users who have set alerts on that bank/product.



\- An update to the “Latest Rate Changes” feed on the platform homepage.



\- A social media post (automated or queued for review) announcing the rate change – this drives traffic.



\# \*\*6. Monitoring \*\*\*\*\&\*\*\*\* Observability\*\*



A scraping pipeline without monitoring is a ticking time bomb. This section defines the dashboards, metrics, and alerting that keep the pipeline healthy.



\## \*\*6.1 Key Metrics\*\*



\- \*\*Scrape success rate: \*\*Percentage of scheduled scrape tasks that complete successfully. Target: >95% daily. Drops below 90% trigger a team review.



\- \*\*Data coverage: \*\*Number of institutions with fresh (Green) data divided by total institutions. Target: >90% at Green, <5% at Red.



\- \*\*Validation pass rate: \*\*Percentage of scraped records that pass all validation layers without flagging. Target: >85%. A drop suggests either widespread bank rate changes or scraper degradation.



\- \*\*Review queue depth: \*\*Number of flagged records awaiting human review. Target: <20 at any time. Spikes indicate either mass rate changes or systematic scraping issues.



\- \*\*Latency: \*\*Time from scrape initiation to data being available in the database. Target: <5 minutes for HTML scrapers, <15 minutes for JS/PDF scrapers.



\- \*\*Freshness distribution: \*\*Breakdown of all banks by Green/Yellow/Red status. Displayed as a daily trend chart.



\## \*\*6.2 Dashboards\*\*



\- Pipeline Health Dashboard: Real-time view of running/completed/failed scrape tasks, with drill-down to individual bank logs.



\- Data Quality Dashboard: Validation pass/fail rates by bank, trend charts for flagged records, review queue status.



\- Coverage Dashboard: Map of all institutions colour-coded by freshness status (Green/Yellow/Red).



\- Rate Change Dashboard: Timeline of all detected rate changes, filterable by bank, product, and date range.



\## \*\*6.3 Alerting\*\*



\- Immediate (Slack + email): Scrape failure for any Tier 1 bank; validation flag on a Tier 1 bank with >50 bps delta.



\- Hourly digest: Summary of all scrape failures and validation flags from the past hour.



\- Daily report (email): Full pipeline health summary – success rates, coverage, freshness distribution, review queue depth.



\- Escalation: If any bank stays at “Red” freshness for 3+ consecutive days, escalate to a manual investigation task.



\# \*\*7. Deliverables \*\*\*\*\&\*\*\*\* Week-by-Week Timeline\*\*



Phase 2 spans 4–6 weeks. The timeline below breaks down every deliverable with ownership. Infrastructure and framework setup happen in Week 1, scraper development in Weeks 2–4, validation and scheduling in Weeks 3–5, and full coverage with testing in Weeks 5–6.



| \*\*Timeline\*\* | \*\*Deliverable\*\* | \*\*Description\*\* | \*\*Owner\*\* |

| --- | --- | --- | --- |

| Week 1 | Scraping framework setup | Scrapy project scaffold, Playwright integration, Docker environment, PostgreSQL connection | Backend Engineer |

| Week 1 | Per-bank config system | JSON config schema, config loader, first 5 bank configs (SBI, HDFC, Canara, BoB, AU SFB) | Scraping Engineer |

| Week 1–2 | HTML scrapers (Tier 1) | Build scrapers for all ~15 static HTML banks, validate data extraction | Scraping Engineer |

| Week 2 | JS scrapers (Tier 2) | Playwright-based scrapers for HDFC, Kotak, Axis, IndusInd, IDFC First, Bajaj Finance | Scraping Engineer |

| Week 2–3 | PDF pipeline | PDF download + pdfplumber parsing for Canara, Indian Bank, BOI; normalisation layer | Data Engineer |

| Week 3 | Validation engine | All 7 validation layers implemented as reusable pipeline; anomaly thresholds tuned | Data Engineer |

| Week 3–4 | Human review queue | Admin UI for reviewing flagged records (approve/reject/hold); email notifications | Frontend + Backend |

| Week 4 | Scheduling \& orchestration | Celery Beat schedule, job monitoring dashboard, alerting on failures | DevOps Engineer |

| Week 4 | Government scheme parser | Ministry of Finance gazette PDF parser; India Post scheme rate extractor | Scraping Engineer |

| Week 4–5 | Cross-reference system | BankBazaar/Paisabazaar scrapers for validation; discrepancy detection logic | Data Engineer |

| Week 5 | Monitoring \& alerting | Scrape success/failure dashboard, data freshness monitor, Slack/email alerts | DevOps Engineer |

| Week 5–6 | Remaining banks \& NBFCs | Complete scraper coverage for all 60–70 institutions; fill coverage gaps | Full team |

| Week 6 | End-to-end testing | Full pipeline test: scrape → validate → store → display; load testing | Full team |

| Week 6 | Phase 2 completion review | Sign off on pipeline reliability, data quality metrics, Phase 3 readiness | All stakeholders |



\# \*\*8. Phase 2 Risks \*\*\*\*\&\*\*\*\* Mitigations\*\*



\- \*\*Bank website redesigns: \*\*The most likely and recurring risk. Mitigation: Config-driven scrapers mean only a JSON file update is needed, not code changes. Monitoring detects failures within hours.



\- \*\*IP blocking: \*\*Aggressive scraping triggers rate limits or IP bans. Mitigation: Respectful crawl delays (1–2 seconds between requests), proper User-Agent headers, and rotating proxy IPs if needed. Bank rate pages are public and low-traffic, so blocks are rare.



\- \*\*PDF format changes: \*\*A bank publishes a PDF with a completely different layout. Mitigation: The PDF pipeline has multiple fallback parsers (pdfplumber → Camelot → OCR). For truly unparseable PDFs, fall back to manual data entry until the parser is updated.



\- \*\*JavaScript framework upgrades: \*\*A bank upgrades from React 17 to React 19 and changes its internal API endpoints. Mitigation: Network interception-based scrapers are resilient to frontend changes if the API stays the same. If the API changes, Playwright-based scraping provides a fallback.



\- \*\*Validation false positives: \*\*Overly sensitive thresholds generate too many flags, overwhelming the review queue. Mitigation: Start with conservative thresholds and tune based on real data. Track false positive rates per bank and adjust per-bank thresholds.



\- \*\*Team capacity: \*\*60–70 bank configs in 6 weeks is ambitious. Mitigation: Prioritise Tier 1 (top 10 banks) in Weeks 1–3. Tier 2–3 banks can be added incrementally without blocking the platform launch.



\# \*\*9. Phase 2 Completion Criteria\*\*



Phase 2 is complete when all of the following are met:



\- Scrapers are operational for at least the top 40 institutions (covering >95% of the deposit market by volume).



\- All 7 validation layers are implemented and tested with real data; anomaly thresholds are tuned.



\- The human review queue is functional with approve/reject/hold workflows.



\- Daily automated scheduling runs successfully for 5 consecutive days with >95% scrape success rate.



\- Monitoring dashboards are live and alerting is configured for scrape failures and validation anomalies.



\- Rate change detection works end-to-end: scrape → detect change → log → notify.



\- Data freshness indicators (Green/Yellow/Red) are computed correctly for all covered institutions.



\- A Phase 3 kickoff plan is drafted with confirmed data readiness for the platform frontend.


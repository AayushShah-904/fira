\*\*PHASE 1 DEEP DIVE\*\*



\*\*Research \*\*\*\*\&\*\*\*\* Data Strategy\*\*



\*Indian Bank Interest Rate Aggregator\*



Complete product taxonomy, data source inventory, database schema,

validation framework, and week-by-week deliverables



Version 1.0  •  March 2026



\*\*CONFIDENTIAL\*\*



\# \*\*1. Product Taxonomy\*\*



The first workstream defines the complete universe of interest-yielding products the platform will track. Getting this right at the outset prevents costly schema changes later. The taxonomy must be granular enough to capture the differences users care about (e.g., senior citizen rates, NRI eligibility) while being structured enough to enable clean comparison tables.



\## \*\*1.1 Complete Product Matrix\*\*



The table below catalogues every product type, its variants, typical tenures, deposit ranges, and which institutions offer it. This becomes the master reference for the data model and scraper requirements.



| \*\*Product Type\*\* | \*\*Variants to Track\*\* | \*\*Tenure Range\*\* | \*\*Deposit Range\*\* | \*\*Offered By\*\* |

| --- | --- | --- | --- | --- |

| Fixed Deposits | Regular, Senior Citizen, Super Senior, NRE, NRO, Tax-Saving (Sec 80C), Flexi/Sweep, Green/Special Tenure | 7 days – 10 years | ₹1,000+ | All banks, SFBs, NBFCs |

| Recurring Deposits | Regular, Senior Citizen | 6 months – 10 years | ₹100/month+ | All banks, SFBs |

| Savings Accounts | Regular, Salary, Women, Senior Citizen, Zero Balance, Digital-Only | On-demand | ₹0 – ₹10,000+ | All banks, SFBs, Payments banks |

| Post Office Time Deposits | 1-year, 2-year, 3-year, 5-year (Sec 80C) | 1 – 5 years | ₹1,000 | India Post |

| PPF | Single variant, EEE tax status | 15 years (ext. in 5-yr blocks) | ₹500 – ₹1.5L/yr | India Post, select banks |

| Senior Citizen Savings Scheme | Single variant, quarterly payout | 5 years (ext. 3 years) | ₹1,000 – ₹30L | India Post, select banks |

| Sukanya Samriddhi Yojana | Girl child (under 10), EEE | 21 years from opening | ₹250 – ₹1.5L/yr | India Post, select banks |

| National Savings Certificate | Single variant, Sec 80C | 5 years | ₹1,000+ | India Post |

| Kisan Vikas Patra | Single variant, doubles at maturity | 115 months (~9.5 yrs) | ₹1,000+ | India Post |

| Monthly Income Scheme | Single/Joint, monthly payout | 5 years | ₹1,000 – ₹9L (single) | India Post |

| Sovereign Gold Bonds | Per issuance, linked to gold price | 8 years (exit at 5) | 1 – 4 kg/yr | RBI (periodic issuance) |

| RBI Floating Rate Bond | Linked to NSC + 35 bps | 7 years | ₹1,000+ | Select banks |

| NBFC Fixed Deposits | Regular, Senior Citizen, Cumulative, Non-Cumulative | 1 – 5 years typically | ₹15,000 – ₹25,000+ | Bajaj, Shriram, Mahindra, etc. |



\## \*\*1.2 Fixed Deposits – Variant Breakdown\*\*



Fixed deposits are the most complex product type because banks offer numerous sub-variants, each with different rates and eligibility rules. The platform must treat each as a distinct product with its own rate slabs:



\- \*\*Regular FDs: \*\*The baseline product. Available to all resident individuals. Tenures from 7 days to 10 years. This is the primary comparison target for most users.



\- \*\*Senior Citizen FDs: \*\*Typically 25–50 bps above regular rates. SBI offers an additional 10 bps for super seniors (80+ years) under its “SBI Patrons” scheme. Every bank’s senior citizen premium is different, so this must be tracked per bank, not assumed.



\- \*\*NRE FDs: \*\*For Non-Resident Indians. Interest is fully tax-free in India and repatriable. Rates differ from domestic FDs. Only available at banks (not NBFCs). Denominated in INR but funded from foreign currency.



\- \*\*NRO FDs: \*\*For NRIs using Indian-earned income. Taxable in India. Rates usually identical to domestic FDs but must be tracked separately for NRI users.



\- \*\*Tax-Saving FDs (Section 80C): \*\*5-year lock-in, maximum ₹1.5 lakh per financial year. No premature withdrawal. Interest is taxable. Available at all banks but NOT at NBFCs. Tax deduction eligibility is a key user decision factor.



\- \*\*Flexi/Sweep FDs: \*\*Linked to savings/current account. Excess balance auto-swept into FD. Rates may differ from regular FDs. SBI calls this MOD (Multi Option Deposit); HDFC calls it Sweep-In.



\- \*\*Special Tenure FDs: \*\*Banks frequently launch promotional schemes with unique tenures. SBI’s “Amrit Vrishti” (444 days) and “Green Rupee Term Deposit” (1111/1777/2222 days) are examples. These have limited-time rates that must be flagged with launch and expiry dates.



\## \*\*1.3 Post Office \*\*\*\*\&\*\*\*\* Government Schemes\*\*



These are governed by the Ministry of Finance and reviewed quarterly (typically unchanged for extended periods). Current rates as of Jan–Mar 2026:



\- \*\*PPF: \*\*7.10% p.a., compounded annually. 15-year tenure, extendable in 5-year blocks. Full EEE status (exempt at investment, accrual, and withdrawal). Max ₹1.5 lakh per year.



\- \*\*SCSS: \*\*8.20% p.a., paid quarterly. 5-year tenure extendable by 3 years. For citizens aged 60+ (55+ in special cases). Max ₹30 lakh.



\- \*\*SSY: \*\*8.20% p.a., compounded annually. For girl child under 10. Deposits for 15 years, matures at 21. Full EEE status.



\- \*\*NSC: \*\*7.70% p.a., compounded annually but paid at maturity. 5-year tenure. Sec 80C eligible.



\- \*\*KVP: \*\*7.50% p.a. Doubles in 115 months (~9 years 7 months). No 80C benefit. Transferable.



\- \*\*MIS: \*\*7.40% p.a., paid monthly. 5-year tenure. Max ₹9 lakh (single), ₹15 lakh (joint).



\- \*\*Post Office Time Deposits: \*\*1-year (6.90%), 2-year (7.00%), 3-year (7.10%), 5-year (7.50%). The 5-year TD is Sec 80C eligible.



\- \*\*Post Office Savings Account: \*\*4.00% p.a. Low but included for completeness.



\*Key insight: Post office scheme rates have remained stable for 7 consecutive quarters. When they do change, it’s a single notification covering all schemes – simpler to track than individual bank rate changes.\*



\## \*\*1.4 NBFC Deposits\*\*



Non-banking financial companies offer corporate FDs that typically carry higher rates than bank FDs but different risk profiles (no DICGC deposit insurance). The major NBFCs to track:



\- \*\*Bajaj Finance: \*\*CRISIL AAA/Stable rated. Rates up to 7.30% for seniors. Min ₹15,000. Tenures 12–60 months.



\- \*\*Shriram Finance: \*\*ICRA AA+ (Stable). Rates up to 8.10% for seniors. Strong rural presence.



\- \*\*Mahindra Finance: \*\*IND AAA/Stable. Additional 0.05% for women depositors, 0.50% for seniors.



\- \*\*PNB Housing Finance: \*\*CRISIL AA/Stable. Housing finance-focused NBFC.



\- \*\*LIC Housing Finance: \*\*Government-linked. Conservative rates but high trust.



\- \*\*Sundaram Home Finance: \*\*Strong in South India. CRISIL AAA.



\- \*\*ICICI Home Finance: \*\*Subsidiary of ICICI Bank. Rates up to 7.35% for seniors.



\*Critical distinction for users: NBFC deposits are NOT covered by DICGC insurance (which covers bank deposits up to ₹5 lakh). The platform must clearly communicate this risk difference.\*



\## \*\*1.5 Small Finance Banks\*\*



India currently has 12 small finance banks. These are full scheduled commercial banks regulated by RBI, and their deposits ARE covered by DICGC insurance. They offer among the highest FD and savings rates in the market because they actively compete for deposits to fund their lending operations.



\- AU Small Finance Bank – Largest SFB; RBI-approved transition to universal bank



\- Ujjivan SFB – Strong micro-lending focus, 600+ branches across 24 states



\- Equitas SFB – Digital-first, popular in South India



\- Jana SFB – 770+ branches in 22 states, 12 million customers



\- Utkarsh SFB – Strong in North India, Varanasi-headquartered



\- ESAF SFB – Kerala-based, strong social responsibility focus



\- Suryoday SFB – High savings and FD rates, digital-friendly



\- Capital SFB – First-ever SFB in India, Punjab-based



\- Shivalik SFB – Converted from cooperative bank in 2021



\- North East SFB (Slice) – Rebranded as Slice, digital-first



\- Unity SFB – Backed by BharatPe, urban-centric strategy



\- Fincare SFB – Merged into AU SFB effective April 2024



\# \*\*2. Data Source Inventory\*\*



This section provides the institution-by-institution source mapping. For each bank/NBFC, we document the exact URL pattern, data format, whether JavaScript rendering is required for scraping, and observed update frequency. This inventory becomes the configuration reference for Phase 2’s scraping pipeline.



\## \*\*2.1 Source Format Distribution\*\*



Based on analysis of the top 50+ institutions:



\- \*\*HTML tables (static): \*\*~40% of banks. Easiest to scrape. Typically PSBs and smaller private banks. Standard HTTP request + HTML parser is sufficient.



\- \*\*JavaScript-rendered (SPA/React): \*\*~25% of banks. Requires headless browser (Puppeteer/Playwright). Common among large private banks (HDFC, Kotak, Axis, IDFC First, Bajaj Finance). Higher resource cost per scrape.



\- \*\*PDF rate cards: \*\*~20% of banks. Requires PDF parsing library. Common among PSBs (Canara Bank, Indian Bank, BOI). PDFs may be tabular or semi-structured.



\- \*\*Mixed (HTML + PDF): \*\*~15% of banks. Some products on HTML pages, others as downloadable PDFs. Requires both scraping approaches.



\## \*\*2.2 Institution-by-Institution Source Map\*\*



The table below is an abridged version of the full source inventory covering the top 22 institutions across all categories. The full inventory (to be completed in Week 1) will cover 60–70 institutions.



| \*\*Institution\*\* | \*\*Type\*\* | \*\*Rate Page URL / Pattern\*\* | \*\*Data Format\*\* | \*\*JS?\*\* | \*\*Update Freq.\*\* |

| --- | --- | --- | --- | --- | --- |

| SBI | PSB | sbi.bank.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits | HTML table | No | Dec 2025 |

| HDFC Bank | PVB | hdfc.com > Rates page | HTML (React SPA) | Yes | Frequent |

| ICICI Bank | PVB | icicibank.com > Interest Rates | HTML table + PDF | Partial | Frequent |

| Axis Bank | PVB | axisbank.com > FD rates | HTML table | Yes | Frequent |

| Kotak Mahindra | PVB | kotak.com > Deposits | HTML (JS-rendered) | Yes | Frequent |

| Bank of Baroda | PSB | bankofbaroda.in > Interest Rates | HTML table | No | Quarterly |

| PNB | PSB | pnbindia.in > Interest Rates | HTML + PDF | No | Quarterly |

| Canara Bank | PSB | canarabank.com > Interest Rates | PDF dominant | No | Quarterly |

| Union Bank | PSB | unionbankofindia.co.in | HTML table | No | Quarterly |

| IndusInd Bank | PVB | indusind.com > Deposits | HTML (JS-rendered) | Yes | Frequent |

| Indian Bank | PSB | indianbank.in > Deposit Rates | PDF dominant | No | Quarterly |

| Bank of India | PSB | bankofindia.co.in | HTML + PDF | No | Quarterly |

| Federal Bank | PVB | federalbank.co.in | HTML table | No | Frequent |

| IDFC First | PVB | idfcfirstbank.com | HTML (React) | Yes | Frequent |

| Yes Bank | PVB | yesbank.in | HTML table | Partial | Frequent |

| Bandhan Bank | PVB | bandhanbank.com | HTML table | No | Frequent |

| AU SFB | SFB | aubank.in | HTML table | No | Frequent |

| Ujjivan SFB | SFB | ujjivansfb.in | HTML table + PDF | No | Frequent |

| Equitas SFB | SFB | equitasbank.com | HTML table | Partial | Frequent |

| Bajaj Finance | NBFC | bajajfinserv.in/fixed-deposit | HTML (React) | Yes | Quarterly |

| Shriram Finance | NBFC | shriramfinance.in | HTML + PDF | Partial | Quarterly |

| Mahindra Finance | NBFC | mahindrafinance.com | HTML page | No | Quarterly |



\## \*\*2.3 Cross-Reference \*\*\*\*\&\*\*\*\* Validation Sources\*\*



No single source should be trusted alone. These secondary sources serve as validation anchors:



\- RBI Domestic Deposit Rates Database (rbi.org.in) – RBI publishes select interest rate data for scheduled commercial banks. Serves as the authoritative baseline for anomaly detection.



\- BankBazaar.com – Aggregates FD rates across 40+ banks. Useful for cross-referencing but introduces a secondary aggregation layer (their own scraping may have errors).



\- Paisabazaar.com – Similar to BankBazaar. Covers FDs, savings accounts, and NBFC deposits.



\- StableMoney.in – Newer aggregator focused on FDs and savings. Good coverage of SFBs and NBFCs.



\- Ministry of Finance quarterly notifications – The single authoritative source for all post office small savings scheme rates. Published as a press release/gazette notification.



\- Individual bank press releases / RBI circulars – Banks announce rate changes via press releases and internal circulars. Monitoring these provides early detection of changes before the website is updated.



\## \*\*2.4 Source-Specific Challenges \*\*\*\*\&\*\*\*\* Mitigations\*\*



Each data source comes with specific challenges that must be planned for:



\### \*\*HTML Table Scraping\*\*



\- Challenge: Banks use inconsistent table structures. SBI uses a clean HTML table; PNB mixes colspan and rowspan.



\- Challenge: Some banks use rate tables embedded in accordion/tab components that require interaction to reveal data.



\- Mitigation: Per-bank scraper configuration files that define CSS selectors, table parsing strategy, and data field mappings.



\- Mitigation: Headless browser with click automation for accordion/tab content.



\### \*\*PDF Parsing\*\*



\- Challenge: PDF tables rarely have consistent column structures across banks. Canara Bank’s PDF has merged cells; Indian Bank’s uses irregular spacing.



\- Challenge: Some PDFs are scanned images rather than text-based (especially older circulars from PSBs).



\- Mitigation: Use pdfplumber or Camelot for text-based PDFs. Fall back to OCR (Tesseract) for scanned PDFs.



\- Mitigation: Build a normalisation layer that maps varying column headers ("Rate of Interest", "ROI (%)", "Interest Rate p.a.") to a unified field name.



\### \*\*JavaScript-Rendered Pages\*\*



\- Challenge: Puppeteer/Playwright scrapes are 5–10x slower than simple HTTP requests and consume more memory.



\- Challenge: Private banks like HDFC and Kotak use React/Angular SPAs that load rate data via API calls to internal endpoints.



\- Mitigation: Before building a full headless browser scraper, inspect network traffic to identify the underlying API endpoint. If found, use direct API calls instead (much faster and more reliable).



\- Mitigation: Cache headless browser sessions to reduce cold-start overhead.



\### \*\*Rate of Change \*\*\*\*\&\*\*\*\* Staleness\*\*



\- Large PSBs (SBI, BoB, PNB): Update rates every 1–3 months. Relatively predictable cadence tied to RBI policy actions.



\- Large private banks (HDFC, ICICI, Axis): Update more frequently, sometimes monthly, and often launch special tenure schemes.



\- SFBs: Update frequently and aggressively compete on rates. AU, Ujjivan, and Equitas may change rates multiple times per quarter.



\- NBFCs: Quarterly updates are typical. Less frequent but still need monitoring.



\- Post office schemes: Government reviews quarterly but rates have been unchanged for 7 consecutive quarters.



\# \*\*3. Database Schema Design\*\*



The schema is designed around three principles: (a) version everything with effective dates for full rate history, (b) normalise carefully to avoid data duplication while keeping queries fast, and (c) accommodate the full breadth of product types without requiring schema changes when new product variants emerge.



\## \*\*3.1 Entity Overview\*\*



The table below summarises all database entities, their key fields, and estimated row counts at full coverage:



| \*\*Entity\*\* | \*\*Key Fields\*\* | \*\*Est. Rows\*\* |

| --- | --- | --- |

| banks | id, name, short\_name, type, ifsc\_prefix, logo\_url, website, rate\_page\_url, rbi\_licence\_no, established\_year, deposit\_insurance, is\_active, created\_at, updated\_at | ~70 rows |

| products | id, bank\_id (FK), product\_type, product\_name, variant, description, eligibility\_notes, section\_80c, is\_active, created\_at | ~500–800 rows |

| rate\_slabs | id, product\_id (FK), tenure\_min\_days, tenure\_max\_days, rate\_general\_pct, rate\_senior\_pct, rate\_super\_senior\_pct, compounding\_freq, effective\_from, effective\_to, min\_deposit, max\_deposit, premature\_penalty\_pct, tds\_applicable, source\_url, created\_at | ~5,000–10,000 rows |

| savings\_tiers | id, product\_id (FK), balance\_min, balance\_max, rate\_pct, effective\_from, effective\_to, created\_at | ~200–400 rows |

| rate\_change\_log | id, rate\_slab\_id (FK), field\_changed, old\_value, new\_value, changed\_at, detected\_at, verified\_by, source | Grows over time |

| scrape\_runs | id, bank\_id (FK), started\_at, completed\_at, status, records\_found, records\_changed, error\_log | Grows daily |

| special\_schemes | id, product\_id (FK), scheme\_name, special\_tenure\_days, promotional\_rate\_pct, launch\_date, expiry\_date, is\_active | ~50–100 rows |



\## \*\*3.2 Versioning Strategy\*\*



Every rate slab has an effective\_from date and a nullable effective\_to date. When rates change:



\- The existing active slab (where effective\_to IS NULL) gets its effective\_to set to the day before the new rate starts.



\- A new slab row is created with the new rate, effective\_from set to the change date, and effective\_to left as NULL.



\- An entry is written to rate\_change\_log recording the field that changed, old value, new value, and detection timestamp.



\- The change is either auto-published (if within normal thresholds) or queued for human review (if anomalous).



\*This append-only versioning approach means you NEVER update or delete rate data. This preserves complete history for trend charts and enables audit trails. Historical rate data becomes a competitive moat over time.\*



\## \*\*3.3 Tenure Normalisation\*\*



Banks describe tenures in inconsistent text formats ("1 year to less than 2 years", "12 months to 23 months", "366 days to 730 days"). The schema stores tenure as min/max days to enable consistent comparison and filtering. Below is the standard mapping:



| \*\*Bank’s Description\*\* | \*\*tenure\_min\_days\*\* | \*\*tenure\_max\_days\*\* |

| --- | --- | --- |

| 7 days to 14 days | 7 | 14 |

| 15 days to 29 days | 15 | 29 |

| 30 days to 45 days | 30 | 45 |

| 46 days to 90 days | 46 | 90 |

| 91 days to 179 days | 91 | 179 |

| 180 days to 210 days | 180 | 210 |

| 211 days to less than 1 year | 211 | 364 |

| 1 year to less than 2 years | 365 | 729 |

| 2 years to less than 3 years | 730 | 1094 |

| 3 years to less than 5 years | 1095 | 1824 |

| 5 years to 10 years | 1825 | 3650 |

| 444 days (SBI Amrit Vrishti) | 444 | 444 |

| 999 days (special tenure) | 999 | 999 |

| 1111 days (SBI Green Rupee) | 1111 | 1111 |



Special tenure FDs (like SBI’s 444-day Amrit Vrishti) have identical min and max values. The special\_schemes table links these to their promotional details and expiry dates.



\## \*\*3.4 Key Schema Design Decisions\*\*



\### \*\*Product Type as Enum vs. Lookup Table\*\*



Use a PostgreSQL ENUM for product\_type (FD, RD, SA, TD, PPF, SCSS, SSY, NSC, KVP, MIS, SGB, RBI\_BOND, NBFC\_FD). ENUMs are faster for filtering and prevent invalid values. If new product types emerge (rare), a migration adds the value.



\### \*\*Separate savings\_tiers Table\*\*



Savings accounts use balance-based tiers rather than tenure-based slabs. A ₹50,000 balance might earn 2.70% while ₹10 lakh+ earns 3.50%. The savings\_tiers table has balance\_min, balance\_max, and rate\_pct. Keeping this separate from rate\_slabs (which is tenure-based) avoids overloading one table with incompatible semantics.



\### \*\*Compounding Frequency Field\*\*



Critical for accurate maturity calculations. Banks compound quarterly by default, but some products differ: post office RD compounds quarterly, PPF compounds annually, SBI Annuity compounds quarterly then discounts monthly. Store as an ENUM: DAILY, MONTHLY, QUARTERLY, HALF\_YEARLY, YEARLY, AT\_MATURITY.



\### \*\*Credit Rating for NBFCs\*\*



Add a credit\_rating field (e.g., "CRISIL AAA/Stable") to the banks table. This is important context for users comparing NBFC deposits against insured bank deposits. Track the rating agency, rating, and outlook separately.



\### \*\*Deposit Insurance Flag\*\*



Boolean deposit\_insurance\_covered on the banks table. TRUE for all scheduled commercial banks and SFBs (covered by DICGC up to ₹5 lakh). FALSE for NBFCs. This powers a crucial user-facing filter and risk indicator.



\# \*\*4. Data Validation \*\*\*\*\&\*\*\*\* Quality Framework\*\*



Scraped data is unreliable by nature. A single misread CSS selector can populate your database with wrong rates that erode user trust. This section defines the multi-layered validation system that must be built alongside the scraping pipeline.



\## \*\*4.1 Automated Validation Rules\*\*



\- Range check: Any FD rate outside 2.50%–9.50% is flagged as suspect. Savings account rates outside 2.00%–8.00% are flagged. These ranges cover the full spectrum from large PSBs to aggressive SFBs.



\- Delta check: Any single rate change exceeding 50 bps from the previous value triggers a review queue entry. Banks rarely change rates by more than 25–50 bps at a time.



\- Monotonicity check: FD rates should generally increase with tenure (with exceptions for inverted yield curves). Flag if a 1-year rate is higher than a 3-year rate at the same bank unless the inverted pattern is confirmed.



\- Completeness check: After each scrape, verify that the expected number of tenure slabs is present. SBI typically has 10–12 tenure buckets. If a scrape returns only 3, something broke.



\- Cross-reference check: For Tier 1 banks, compare scraped rates against at least one secondary source (BankBazaar, Paisabazaar, or RBI database). Discrepancies exceeding 10 bps trigger manual review.



\- Staleness check: If a bank’s rate data hasn’t changed in 60+ days, trigger a forced rescrape and manual verification. Most banks update at least quarterly.



\- Format consistency: Ensure rates are stored as decimal percentages (e.g., 6.50, not 0.065 or "6.50%"). Normalise at ingestion.



\## \*\*4.2 Human Review Queue\*\*



Any record flagged by automated rules enters a review queue with three dispositions:



\- \*\*Approve: \*\*Reviewer confirms the scraped data is correct (e.g., the bank genuinely made a large rate change). Record is published.



\- \*\*Reject \*\*\*\*\&\*\*\*\* Rescrape: \*\*Data appears incorrect. Trigger a rescrape and re-evaluate. If still anomalous, escalate to manual bank website verification.



\- \*\*Reject \*\*\*\*\&\*\*\*\* Hold: \*\*Cannot verify. Mark the bank’s rates as “unverified” on the frontend and display the last known-good rates with a warning timestamp.



\## \*\*4.3 Data Freshness Indicators\*\*



Every rate displayed on the platform must show a “Last verified” timestamp. Additionally, implement a traffic-light system:



\- \*\*Green: \*\*Verified within the last 7 days. Data is fresh.



\- \*\*Yellow: \*\*Last verified 8–30 days ago. Data is likely current but may be stale.



\- \*\*Red: \*\*Last verified 30+ days ago. Data may be outdated. User should verify with the bank.



\*Transparency about data freshness is a competitive advantage. Incumbents like BankBazaar rarely show when their data was last updated, leading to user distrust. Your platform should make freshness a first-class feature.\*



\# \*\*5. Deliverables \*\*\*\*\&\*\*\*\* Week-by-Week Timeline\*\*



Phase 1 spans 3 weeks. The table below breaks down every deliverable, its description, target completion, and responsible role. Some tasks run in parallel.



| \*\*Timeline\*\* | \*\*Deliverable\*\* | \*\*Description\*\* | \*\*Owner\*\* |

| --- | --- | --- | --- |

| Week 1, Day 1–2 | Product taxonomy spreadsheet | Complete list of every product variant with fields to capture | Product Manager |

| Week 1, Day 2–4 | Bank source inventory | URL, format, JS required, quirks for all 60–70 institutions | Research Lead |

| Week 1, Day 3–5 | Post office \& govt scheme inventory | Ministry of Finance source mapping, RBI bond issuance tracking | Research Lead |

| Week 1–2 | Database schema design | ERD, SQL migrations, seed data for banks table | Backend Engineer |

| Week 2 | Data validation rules document | Anomaly thresholds, cross-reference rules, staleness policies | Data Engineer |

| Week 2 | Prototype scraper: SBI (HTML) | Working scraper extracting all FD/RD/SA rates from SBI website | Scraping Engineer |

| Week 2–3 | Prototype scraper: Canara Bank (PDF) | PDF parser for rate card extraction | Scraping Engineer |

| Week 2–3 | Prototype scraper: HDFC (JS-rendered) | Headless browser scraper for React-based rate page | Scraping Engineer |

| Week 3 | Schema validation with real data | Load scraped data into schema, identify gaps, iterate on model | Full team |

| Week 3 | NBFC \& SFB source mapping | All 12 SFBs + 6–8 major NBFCs with source URLs documented | Research Lead |

| Week 3 | Phase 1 completion review | Sign off on taxonomy, schema, and pipeline readiness for Phase 2 | All stakeholders |



\## \*\*5.1 Week 1: Research \*\*\*\*\&\*\*\*\* Inventory\*\*



The focus of Week 1 is pure research. No code is written yet. The team visits every bank’s rate page, documents the URL, format, and quirks, and builds the product taxonomy spreadsheet. This is unglamorous but essential – the quality of Phase 2’s scraping pipeline depends entirely on the accuracy of this inventory.



\- Assign 2–3 researchers to split the bank list and manually visit each rate page.



\- For each bank, capture: primary rate URL, secondary URLs (if different products are on different pages), data format, screenshot of the rate table, any CAPTCHAs or anti-bot measures, and notes on layout/structure.



\- Cross-reference the product taxonomy against the actual products each bank offers. Not every bank offers every variant (e.g., not all banks have super senior citizen rates or green FDs).



\- Identify banks that publish rate change circulars or press releases (these can serve as early-warning triggers before the website is updated).



\## \*\*5.2 Week 2: Schema \*\*\*\*\&\*\*\*\* Prototype Scrapers\*\*



With the inventory complete, the engineering team begins building. Three parallel workstreams:



\### \*\*Database Setup\*\*



\- Finalise the PostgreSQL schema based on the taxonomy and source inventory findings from Week 1.



\- Write and run migration scripts. Seed the banks table with all 60–70 institutions.



\- Set up a staging environment with Docker Compose (PostgreSQL + Redis + API shell).



\### \*\*Prototype Scrapers\*\*



\- Build 3 prototype scrapers covering the three main source formats:



\- Scraper 1 – SBI (HTML table): Simple HTTP + BeautifulSoup/Cheerio. Validates the basic ingestion pipeline.



\- Scraper 2 – Canara Bank or Indian Bank (PDF): PDF download + pdfplumber parsing. Validates the PDF normalisation layer.



\- Scraper 3 – HDFC or Kotak (JS-rendered): Puppeteer/Playwright headless browser. Or, ideally, discover the underlying API endpoint.



\### \*\*Validation Rules Engine\*\*



\- Implement the automated validation rules (range, delta, completeness, staleness) as a reusable module.



\- Set up a basic human review queue (can be a simple database table + admin UI, or even a shared spreadsheet initially).



\## \*\*5.3 Week 3: Integration \*\*\*\*\&\*\*\*\* Iteration\*\*



The final week validates that the taxonomy, schema, and scrapers work together end-to-end:



\- Load real scraped data from the 3 prototype banks into the database. Verify all fields map correctly.



\- Identify schema gaps – for example, SBI’s Amrit Vrishti 444-day scheme may need the special\_schemes table. Iterate on the model.



\- Run validation rules against real data. Tune thresholds (is 50 bps delta too aggressive? Too lenient?).



\- Complete the NBFC and SFB source mapping (Weeks 1–2 focused on banks; Week 3 extends to NBFCs and SFBs).



\- Conduct a Phase 1 completion review with all stakeholders. Sign off on taxonomy, schema, source inventory, and pipeline readiness for Phase 2.



\# \*\*6. Phase 1 Risks \*\*\*\*\&\*\*\*\* Mitigations\*\*



\- \*\*Incomplete source inventory: \*\*Some smaller banks may not have easily accessible rate pages. Mitigation: Prioritise the top 40 banks that cover 95%+ of deposits; add smaller banks incrementally in Phase 2.



\- \*\*Schema over-engineering: \*\*Designing for every possible edge case upfront can slow progress. Mitigation: Build for the 90% case now, and plan for schema migrations as real data reveals gaps.



\- \*\*PDF parsing complexity: \*\*Some bank PDFs may be genuinely unparseable (scanned, poor quality, complex merged cells). Mitigation: For initial launch, manually enter rates for banks with unparseable PDFs. Automate later.



\- \*\*Rate page changes mid-phase: \*\*A bank might redesign its website while you’re building the scraper. Mitigation: Build scrapers with configurable selectors stored externally (JSON config), not hardcoded in scraper logic.



\- \*\*Team bandwidth: \*\*3 weeks is tight for full coverage of 60+ institutions. Mitigation: Tier the work – complete Tier 1 (top 10) exhaustively; Tier 2–3 can have lighter documentation in Phase 1 and be fleshed out in Phase 2.



\# \*\*7. Phase 1 Completion Criteria\*\*



Phase 1 is complete when all of the following are met:



\- Product taxonomy spreadsheet covers all product types and variants with field definitions.



\- Data source inventory documents rate page URLs, formats, and scraping notes for at least the top 40 institutions.



\- PostgreSQL schema is finalised, migrations run successfully, and banks table is seeded.



\- Three prototype scrapers (HTML, PDF, JS-rendered) successfully extract and load data into the schema.



\- Validation rules are defined and implemented as a testable module.



\- The team has confidence that the schema accommodates all product types identified in the taxonomy without requiring structural changes.



\- A Phase 2 kickoff plan is drafted with scraper assignments for all remaining institutions.


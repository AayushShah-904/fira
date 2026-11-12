\*\*PROJECT PLAN\*\*



\*\*Indian Bank Interest Rate Aggregator\*\*



\*A comprehensive platform for comparing interest-yielding products across all Indian banks\*



Version 1.0  •  March 2026



\*\*CONFIDENTIAL\*\*



\# \*\*Executive Summary\*\*



This document outlines the end-to-end plan for building an aggregator website that catalogues interest-yielding products from all Indian banks. The platform will enable consumers to compare fixed deposits, recurring deposits, savings accounts, tax-saving instruments, and other deposit products across 50+ financial institutions, with real-time rate tracking, calculators, and personalised alerts.



The project is structured in six phases spanning approximately 6–9 months from inception to a monetisation-ready launch, with ongoing enhancements thereafter.



\# \*\*Phase Overview\*\*



The table below summarises the six phases, their key activities, and estimated timelines.



| \*\*Phase\*\* | \*\*Title\*\* | \*\*Key Activities\*\* | \*\*Timeline\*\* |

| --- | --- | --- | --- |

| Phase 1 | Research \& Data Strategy | Define product scope, map data sources, design the data model | 2–3 weeks |

| Phase 2 | Data Collection Pipeline | Build scrapers/parsers, validation layer, and scheduling | 4–6 weeks |

| Phase 3 | Build the Platform | Frontend, backend, API, calculators, comparison tools, SEO | 8–12 weeks |

| Phase 4 | Compliance \& Legal | Disclaimers, regulatory checks, terms of service | 1–2 weeks |

| Phase 5 | Monetization | Affiliate integrations, advertising, lead generation, premium API | 2–4 weeks |

| Phase 6 | Growth \& Differentiation | Reviews, post-tax calculators, AA integration, content | Ongoing |



\# \*\*Phase 1: Research \*\*\*\*\&\*\*\*\* Data Strategy\*\*



The foundation phase establishes what the platform will cover, where the data comes from, and how it will be structured.



\## \*\*1.1 Product Scope\*\*



Define the complete universe of interest-yielding products to be aggregated:



\- Fixed Deposits (FDs) – regular, senior citizen, NRE/NRO, flexi, and tax-saving variants



\- Recurring Deposits (RDs) – monthly deposit schemes across banks



\- Savings Accounts – base rate, tiered rates by balance slab



\- Post Office Schemes – NSC, KVP, SCSS, PPF, Sukanya Samriddhi



\- Government Bonds \& SGBs – Sovereign Gold Bonds, RBI Floating Rate Bonds



\- Small Finance Banks \& NBFC Deposits – often carry premium rates



\## \*\*1.2 Data Source Mapping\*\*



Since Indian banks do not expose standardised APIs for rate data, the following sources will be used:



\- Bank websites – RBI mandates public disclosure of interest rates; most banks publish on dedicated pages



\- RBI Master Directions – baseline regulatory data and rate circulars



\- PDF rate cards – many banks distribute rate schedules as downloadable PDFs



\- Direct partnerships – affiliate/distribution agreements for verified, timely data



\- Financial data aggregators – cross-referencing with platforms like BankBazaar or Paisabazaar



\## \*\*1.3 Data Model Design\*\*



The core data entities required are:



\- Bank – name, type (public/private/SFB/NBFC), IFSC prefix, logo, website, RBI licence details



\- Product – type (FD/RD/SA/etc.), name, description, eligibility criteria



\- Rate Slab – tenure range, interest rate (general), rate (senior citizen), compounding frequency, effective date



\- Metadata – minimum deposit, maximum deposit, premature withdrawal penalty, auto-renewal policy, TDS applicability



A versioned schema with effective dates is essential, as rates change frequently and historical tracking adds significant user value.



\# \*\*Phase 2: Data Collection Pipeline\*\*



\## \*\*2.1 Web Scraping Infrastructure\*\*



Build automated scrapers using Scrapy (Python) or Puppeteer (Node.js) to extract rate data from bank websites. Key considerations:



\- Handle both HTML table formats and downloadable PDF rate cards



\- Use headless browsers for JavaScript-rendered pages (common among private banks)



\- Implement rate-limiting and respectful crawling to avoid IP blocks



\- Maintain per-bank configuration files for URL patterns, selectors, and data mappings



\## \*\*2.2 PDF Parsing\*\*



Many banks publish rates as PDF documents. Use libraries like Tabula, Camelot, or pdfplumber to extract tabular data. Build a normalisation layer that maps varying column structures to the unified data model.



\## \*\*2.3 Validation \*\*\*\*\&\*\*\*\* Quality Assurance\*\*



Scraped data is inherently unreliable. Implement:



\- Cross-referencing – compare scraped rates with RBI published data and at least one secondary source



\- Anomaly detection – flag any rate change exceeding 50 bps from the previous value



\- Human review queue – escalate flagged data for manual verification before publication



\- Staleness alerts – if a bank’s data hasn’t been updated in 30+ days, trigger a rescrape and flag for review



\## \*\*2.4 Scheduling \*\*\*\*\&\*\*\*\* Freshness\*\*



Run scraping jobs daily. Display “last verified” timestamps prominently on the website so users understand data freshness. Maintain a rate change log that records every update with before/after values.



\# \*\*Phase 3: Build the Platform\*\*



\## \*\*3.1 Tech Stack\*\*



\- Frontend: Next.js with SSR for SEO, Tailwind CSS for styling



\- Backend: Node.js/Express or Python FastAPI



\- Database: PostgreSQL with rate history tables; Redis for caching hot queries



\- Search: Elasticsearch for fast faceted filtering across banks, products, and tenures



\- Infrastructure: AWS or GCP, containerised with Docker, CI/CD via GitHub Actions



\## \*\*3.2 Core Features\*\*



\- Comparison tables – sort and filter by bank, product type, tenure, rate, and minimum deposit



\- Financial calculators – FD maturity, RD maturity, tax-adjusted returns, SIP vs FD comparison



\- Bank profile pages – comprehensive view of all products offered by a single bank



\- Rate change tracker – historical charts showing how rates have moved over time



\- User alerts – email/push notifications when tracked products have rate changes



\- Mobile-responsive design – India is mobile-first; optimise for small screens



\## \*\*3.3 SEO Strategy\*\*



Programmatic SEO is critical for acquisition. Generate pages targeting high-intent queries such as:



\- "Best FD rates in India 2026" – dynamic landing page with top rates



\- "SBI vs HDFC FD rates" – bank-to-bank comparison pages



\- "Best FD rates for 3 years" – tenure-specific pages



\- "Senior citizen FD rates" – audience-specific pages



Implement structured data (JSON-LD) for rich snippets in Google search results.



\# \*\*Phase 4: Compliance \*\*\*\*\&\*\*\*\* Legal\*\*



The platform must operate within India’s regulatory framework:



\- Display clear disclaimers that rates are indicative and should be verified with the respective bank



\- If generating leads or facilitating account openings, registration as a corporate agent (under IRDAI/RBI guidelines) or partnership with existing distribution platforms may be required



\- Comply with the IT Act, 2000 for data handling and the Digital Personal Data Protection Act, 2023 for user data



\- Implement a comprehensive Terms of Service and Privacy Policy



\- Ensure accessibility compliance (WCAG 2.1) for inclusive design



\# \*\*Phase 5: Monetisation\*\*



\## \*\*5.1 Revenue Streams\*\*



\- Affiliate commissions – earn per account opening or FD booking referred to partner banks



\- Display advertising – Google AdSense and direct ad sales; finance keywords command premium CPMs



\- Lead generation – sell qualified leads to banks and NBFCs looking to acquire depositors



\- Premium API – offer a paid API to fintech apps, robo-advisors, and financial planners who need structured rate data



\- Sponsored listings – allow banks to promote their products in search results (clearly marked as sponsored)



\## \*\*5.2 Pricing Strategy\*\*



Start with free access to build traffic and trust. Introduce monetisation gradually: affiliate links from day one (low-friction), advertising after reaching 50K monthly visitors, and the premium API once the data pipeline is proven reliable.



\# \*\*Phase 6: Growth \*\*\*\*\&\*\*\*\* Differentiation\*\*



\## \*\*6.1 Value-Added Features\*\*



\- Post-tax return calculator – show effective returns based on user’s income tax slab (critical for Indian investors comparing FDs vs debt mutual funds)



\- FD vs mutual fund comparison – help users understand risk-adjusted, tax-adjusted returns



\- User reviews – crowd-sourced bank service quality ratings



\- Account Aggregator (AA) integration – under RBI’s AA framework, let users see their existing deposits alongside better alternatives



\## \*\*6.2 Content \*\*\*\*\&\*\*\*\* Community\*\*



\- Educational blog – articles on deposit strategies, tax planning, and rate forecasts



\- Monthly rate digest – email newsletter summarising the biggest rate changes



\- Expert commentary – partner with financial advisors for curated insights



\## \*\*6.3 Expansion Roadmap\*\*



\- Add mutual fund and bond yields for cross-product comparison



\- Expand to other South Asian markets (Bangladesh, Sri Lanka, Nepal)



\- Mobile app for real-time notifications and on-the-go comparisons



\# \*\*Key Risks \*\*\*\*\&\*\*\*\* Mitigations\*\*



\- Data accuracy: Mitigate with multi-source validation, anomaly detection, and human review queues



\- Scraping fragility: Banks redesign websites; mitigate with modular scraper configs and monitoring dashboards



\- Regulatory changes: Stay updated on RBI circulars; build relationships with compliance consultants



\- Competition from incumbents (BankBazaar, Paisabazaar): Differentiate on depth, freshness, and transparency of data



\# \*\*Immediate Next Steps\*\*



\- Deep-dive into Phase 1: finalise product taxonomy and data source inventory



\- Design the database schema with versioned rate slabs



\- Prototype scrapers for the top 5 banks (SBI, HDFC, ICICI, Axis, Kotak)



\- Set up the project repository and CI/CD pipeline


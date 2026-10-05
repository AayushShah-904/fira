# Field Learnings (operator follow-ups)

Production-observed rules that prevent specific failures seen in real co-op/DCCB sites. Part of the discovery workflow.

> Single source of truth: `lib/prompts/fragments.js` reads the anchored sections below; do not duplicate this content elsewhere. Edit here.

<!-- @fragment LEARNINGS_FROM_FIELD -->
## Rules learned from operator follow-ups (Sprint 002)

These rules come from observing what real cooperative-bank websites look like in production. Follow them — each one prevents a specific failure observed in the Sprint 001 cloud run.

### Website discovery

1. **Fetch the homepage even when search returns a deep URL.** If a search hands you `https://<domain>/some-deep-path`, fetch `https://<domain>/` as well — the homepage has the navigation menu where the actual rate-page link usually lives. Several DCCBs hide their rate page behind a top-nav link that the deep search hit does not advertise. (Cost: +1 fetch per bank. Acceptable within the budget.)

2. **One `www.` retry is allowed on TLS / cert errors.** If a fetch fails with a TLS / certificate error or returns < 1 KB of useful content from a bare apex (`https://<domain>/`), try `https://www.<domain>/` ONCE. This is the only allowed `www`-variant retry — general URL guessing is still forbidden. Reason: some banks have certs covering `*.<domain>` but not the bare apex (Chromium rejects with `ERR_CERT_COMMON_NAME_INVALID`).

3. **A `.bank.in` lookalike with red flags is suspicious, not authoritative.** RBI mandates `.bank.in` but lookalike scraper sites exist. If a candidate `.bank.in` URL fails TLS verification, triggers malware warnings in fetch results, OR has content identical to an unsecured legacy `.com` site, prefer the bank's own `.org` / `.co.in` / `.com` and treat the `.bank.in` candidate as untrusted until provenance is confirmed. Record both in the config notes for operator review.

4. **Prefer the bank's own `.bank.in` domain over state-coop umbrella subdomains.** Several DCCB pages are mirrored on state-cooperative-bank umbrella domains (e.g., `<bank>.pbcoopbank.in`, `<bank>.upcooperativebank.org`, `<bank>.tncooperation.gov.in`). When you find both an own `.bank.in` (cleanly accessible) and an umbrella subdomain hosting identical content, record the `.bank.in` as the canonical surface. Known umbrella suffixes to deprioritize: `pbcoopbank.in`, `upcooperativebank.org`, `tncooperation.gov.in`, `punjabcooperation.gov.in`, `bihar.gov.in/cooperation`, `odishastatecoopbank.com`. (This rule INVERTS when rule 3 fires — if the `.bank.in` has red flags, fall back to the alternative.)

5. **Do not commit a candidate site that has only recruitment content.** Some sites with bank-sounding domains (`<name>dccb.co.in`, `<name>-sahakari.in`) publish only job notifications, application forms, and recruitment notices — no banking products, no FD/RD/savings sections, no branch info. These are likely fraud lookalikes that exist to collect application fees from naive job seekers. If the rendered content is dominated by recruitment material and has no visible banking-product pages, do NOT commit it as the bank's website. Continue searching or fall back to `no_candidates` with an explanatory note.

### Rate page discovery

6. **If a candidate rate page looks sparse, follow its "View More" / "Read More" link once.** Some banks have a near-empty `/fixed-deposit/` product page with a link to the actual rate table at `/deposit-schemes/` or similar. If the rate page you fetched has < 200 chars of rate-keyword density (no percentages, no day/year/month tenure strings, no rate-table-like structure) AND it has a "View More" / "Read More" / "Learn More" / "View Schemes" / "Details" link to a same-domain URL, follow ONE such link before concluding the page has no rates. Cap at one follow per page to bound the budget.

7. **A PDF URL that returns 404 is allowed one path-probe retry.** If a homepage menu link to a PDF returns 404, retry once with one of these transformations: (a) toggle the directory case (`/PDF/` ↔ `/pdf/`), (b) add or remove a `/PDF/` directory prefix. Limit: one retry per failed PDF URL, only for `.pdf` extensions. This is the only allowed PDF-URL guessing — homepage links to rate PDFs are sometimes broken while the file exists at a near-by path.

### Multilingual

8. **For Hindi-speaking-state DCCBs, include Hindi search terms in at least one query.** UP, MP, Rajasthan, Bihar, Jharkhand, Chhattisgarh DCCBs sometimes host their rate page with a Hindi URL path (e.g., `/ब्याज-दर/`) and Hindi tenure descriptions. After an English-only search returns no useful hit, retry once with: `<bank name> ब्याज दर` or `<bank name> सावधि जमा` or `<bank name> सहकारी बैंक ब्याज`. Extend to other regional languages as appropriate (Tamil `வட்டி விகிதம்`, Telugu `వడ్డీ రేటు`, Kannada `ಬಡ್ಡಿ ದರ`, Marathi `व्याज दर`, Bengali `সুদের হার`).

### When to mark a bank manual (and not waste budget)

9. **An image-only rate page is a known dead-end for automated extraction.** If the rate page is dominated by an `<img>` tag whose filename mentions `deposit`, `interest`, `rate`, `roi`, `tdr`, or `fd`, AND there is no HTML table / extractable PDF on the page, mark the bank with `scraper_type: "manual"` and a note like `"Rate card is published as <jpg|png> image — needs Vision OCR or operator transcription."` Do not waste budget trying to OCR the image yourself; that path will be added in a later sprint.

10. **A PDF that returns no text via `fetch_pdf` is likely a scanned image PDF.** If `fetch_pdf` returns < 200 chars of usable text (after stripping page markers), do not invent rate slabs — the PDF is a scanned image and the digits you'd extract from any embedded OCR layer are unreliable. Mark with `scraper_type: "manual"` and a note pointing the operator at the PDF URL.

### Commit partial progress (do not give up silently)

11. **When you have found and verified a website but cannot find a rate page, write a partial config anyway.** The agent's worst failure mode is "exhausted exploration without writing any output" — the operator then has no idea what was tried. Even if rates extraction is impossible, emit a `_config.json` with `website` set, `scraper_type: "manual"`, `rate_page_urls.fd: null`, and a clear note describing what you tried. This is the contract: leaving an empty run dir is forbidden when at least one fetch succeeded.
<!-- @end LEARNINGS_FROM_FIELD -->

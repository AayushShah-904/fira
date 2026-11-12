# Hand-off — Top-100 DCCB / NSUCB selection research

> Hand this whole document to a web-search assistant or another agent. It
> is self-contained: gives the goal, the constraints, the format, what's
> already been tried, and the deliverable.

## Goal

Identify the **top 100 District Central Co-operative Banks (DCCBs)** and the
**top 100 Non-Scheduled Urban Co-operative Banks (NSUCBs)** in India by
financial heft — primarily AUM (Assets Under Management), or as close to that
as the public data allows. These will be the cohort for an automated rate-
discovery refresh feeding a downstream rates pack consumed by a comparison
product.

Acceptable proxies for AUM, in descending preference:
1. Total deposits (most directly tracks "financial heft" for retail co-ops)
2. Total business mix (deposits + advances)
3. Total assets / balance sheet size
4. Industry awards + NABARD/NAFSCOB/NAFCUB recognition (validated proxy for major status)
5. "Tier-3 / Tier-4" rating from the RBI's revised UCB tiered regulatory framework (Tier 3 ≈ ₹100-1000 cr business, Tier 4 ≈ >₹1000 cr business) — applies to UCBs only

Important: we are explicitly NOT including **Scheduled** UCBs (SUCBs) in
the "top 100" — those are all 52 of them in a separate cohort already.
Only Non-Scheduled UCBs (NSUCBs) need ranking.

## Constraints

### 1. Output format

Both deliverables are JSON arrays in this exact shape (one object per bank):

```json
[
  { "bank_code": "<canonical-slug>", "category": "District Central Co-operative Bank", "state": "Maharashtra" },
  { "bank_code": "<canonical-slug>", "category": "Non-Scheduled Urban Co-operative Bank", "state": "Gujarat" }
]
```

- Two files: `data/cohorts/_top-100-dccb-by-aum.json` and
  `data/cohorts/_top-100-nsucb-by-aum.json`
- The `category` field MUST be the exact string above (matches the master
  RBI CSV).
- `state` SHOULD match the master CSV (Maharashtra / Gujarat / Karnataka /
  etc. — full English name, no abbreviation).

### 2. Naming convention — critical

The `bank_code` must be the canonical slug used by our master list
(`data/Indian_Banks_Comprehensive_List_RBI.csv`). The master uses
**"Co-operative"** (with a hyphen) and **"Ltd."** suffix. Examples:

| Marketing/award name | Master CSV name | Slug |
|---|---|---|
| Karimnagar District Cooperative Central Bank | Karimnagar District Co-operative Central Bank Ltd. | karimnagar-district-co-operative-central-bank-ltd |
| Pune DCCB | Pune District Central Co-operative Bank Ltd. | pune-district-central-co-operative-bank-ltd |
| The Ahmedabad DCCB | The Ahmedabad District Co-operative Bank Ltd. | the-ahmedabad-district-co-operative-bank-ltd |

The slug algorithm (lowercase, strip non-[a-z0-9 -], spaces to hyphens,
collapse repeats — implemented in `scripts/utils/slugify.js`) is run
against the **master CSV's exact name**, not the marketing name. So the
research output must reference banks by their RBI / master-CSV name.

If a "top 100" candidate doesn't appear in the master CSV verbatim, drop
it (or include it with a note that the slug needs operator review).

### 3. Geographic distribution

Don't over-concentrate. Top-economy states have a lot of co-ops:

| Category | Master CSV count by state (top) |
|---|---|
| DCCB | UP 41 · Maharashtra 31 · Rajasthan 29 · Tamil Nadu 24 · Karnataka 21 · Punjab 19 · Haryana 19 · AP 18 · Gujarat 18 · Odisha 16 · WB 16 · Uttarakhand 9 · MP 38 (the Jilla Sahakari Kendriya banks) · J&K 3 · Himachal 2 · Kerala 1 · Jharkhand 1 |
| NSUCB | Maharashtra 347 · Gujarat 196 · Karnataka 172 · Kerala 57 · Telangana 45 · Andhra 43 · MP 43 · Rajasthan 34 |

For DCCB, aim for representation from at least 10 states. For NSUCB,
representation from at least 6 states (the data skews to Maharashtra +
Gujarat + Karnataka heavily — that's fine, but include some from
Telangana, AP, MP, Rajasthan, Kerala for diversity).

## Already attempted (don't repeat)

| Source | URL | Outcome |
|---|---|---|
| NAFSCOB DCCB Awards page | https://www.nafscob.org/dccbs-awards.php | **Useful** — got 17 award winners (2008-2019). Listed below. |
| NABARD "Empowering Rural Financial Institutions" PDF | https://www.nabard.org/pdf/2024/empowering-rural-financial-institutions.pdf | Text not extractable via standard fetch — design file with embedded fonts. Need a PDF parser. |
| Ministry of Cooperation USQ 1350 PDF | https://www.cooperation.gov.in/sites/default/files/2025-10/USQ%201350%20English.pdf | HTTP 403 from the gov host on standard fetch. May work via curl with custom UA. |
| RBI DBIE database | https://dbie.rbi.org.in/ | Cert verification fails via standard fetch — has UCB bank-wise data behind an interactive query interface. |
| Ministry of Cooperation DCCB reports | https://cooperatives.gov.in/en/home/dccb-reports | Cert verification fails via standard fetch. |
| NAFCUB Achievements page | https://nafcub.org/achievements.php | Sector-level only, no bank rankings. |
| Sahkarnet "Top 10 Cooperative Banks" | https://www.sahkarnet.com/resources/top-10-cooperative-banks-in-india/ | UCB top 10 but mostly **scheduled** UCBs (not our target). Useful as exclusion list — those banks are NOT in NSUCB. |

The pattern: government infra blocks standard automated fetches. PDFs
need a proper PDF parser. A human with a browser and PDF reader can
extract this data in a couple of hours; an LLM via standard web fetch
can't.

## Already collected — DCCB award winners (NAFSCOB 2008-2019)

These are validated as "major DCCBs" by virtue of winning NAFSCOB awards
multiple years running. All 17 cross-reference cleanly to the master
CSV (matching slugs available):

| Slug | State |
|---|---|
| nawanshahr-central-co-operative-bank-ltd | Punjab |
| kangra-central-co-operative-bank-ltd | Himachal Pradesh |
| the-rajkot-district-co-operative-bank-ltd | Gujarat |
| satara-district-central-co-operative-bank-ltd | Maharashtra |
| ludhiana-central-co-operative-bank-ltd | Punjab |
| tiruchirapalli-district-central-co-operative-bank-ltd | Tamil Nadu |
| sikar-central-co-operative-bank-ltd | Rajasthan |
| the-ahmedabad-district-co-operative-bank-ltd | Gujarat |
| jaipur-central-co-operative-bank-ltd | Rajasthan |
| bhopal-district-central-co-operative-bank-ltd | Madhya Pradesh |
| karimnagar-district-co-operative-central-bank-ltd | Andhra Pradesh (Telangana per state reorg) |
| krishna-district-co-operative-central-bank-ltd | Andhra Pradesh |
| salem-district-central-co-operative-bank-ltd | Tamil Nadu |
| pune-district-central-co-operative-bank-ltd | Maharashtra |
| nadia-district-central-co-operative-bank-ltd | West Bengal |
| (Jilla Sahakari Kendriya Bank Maryadit — MP, multi-instance — pick the "Bhopal" district one) |  |
| (Kannur — Kerala — only present in master as a UCB, not a DCCB) |  |

That's ~15 high-confidence DCCB names. Need **~85 more** to reach 100.

## What I need back

Two JSON files, each with up to 100 entries, in the format above.

If you can only get partial results (say 60 + 40), that's still useful;
the cohort builder dedups and merges:

```bash
node scripts/build-cohort.js \
  --out data/cohorts/pm-refresh-2026-q2.json \
  data/cohorts/_small-categories.json \
  data/cohorts/_top-100-dccb-by-aum.json \
  data/cohorts/_top-100-nsucb-by-aum.json
```

A row that doesn't exist verbatim in the master CSV will be dropped at
cohort build time — so reference names that match the master.

## Specific search queries that might help

1. NABARD-DCCB-bank-wise data: search RBI bulletins indexed by Google
   Scholar (`site:rbidocs.rbi.org.in "DCCB" "deposits" 2024 filetype:pdf`)
2. State-level co-op bank registrar reports (each state has a Registrar
   of Co-operative Societies; many publish per-bank performance reports)
3. Indiastat.com pages for cooperative banks per state — paywalled but
   sometimes the free preview reveals the bank list
4. Karimnagar DCCB's claim of "9th consecutive NAFSCOB best DCCB award" —
   suggests there are 9 annual best-DCCB lists at the all-India level
   (the NAFSCOB page only showed 11 years' top-3); the missing years
   (2019-2025) likely have additional names
5. NABARD's annual report annexures — typically a "Statement on DCCB
   business mix" table

## Out-of-scope (don't research)

- SUCB ranking (we cover all 52 in a separate cohort)
- Specific NPA / profit numbers — only need ranking signal, not full
  financials
- Co-operative banks outside India

## When you have the data

Save as the two JSON files at the paths listed above, commit them, and
let me know. I'll handle the merge + cloud cohort kickoff.

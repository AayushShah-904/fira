# Phase 1: Rate Discovery & Bank Classification — Detailed Plan

## Goal

Use the rate-discovery-agent to classify all ~1958 banks and build scraper configs for the viable ones. Update the database with discovery results (website URLs, rate page URLs, scraper type, discovery status). Build tooling to import discovery outputs into the database and a simple admin view to track progress.

---

## Step 1: Agent Setup & Adaptation

The rate-discovery-agent is already extracted at `rate-discovery-agent/`. However, it was designed to run as a standalone Claude Code project. We need to:

1. **Verify agent prerequisites**:
   - Claude Code CLI installed and authenticated
   - Python 3 with `openpyxl` installed (for batch mode)
   - Test with a single bank: `./run-discovery.sh "State Bank of India" "Public Sector Bank" "Maharashtra"`

2. **Batch script already adapted for CSV**: `run-batch.sh` reads from CSV using Node.js (no Python/openpyxl dependency). Handles unquoted commas via the same `findCategoryInRow` logic used in the seed generator.

3. **Configure output directory**: Agent outputs go to `rate-discovery-agent/output/`. We'll import from there into the database.

---

## Step 2: Discovery Import Pipeline

Build tooling to import agent outputs (`*_config.json`, `*_rates.json`) into the BIRD database.

### 2.1 Import script (`packages/api/src/db/seed/import-discovery.mjs`)

Reads all `*_config.json` files from the agent output directory and updates the `banks` table:

- **Match by name**: Fuzzy-match `bank_name` from config to `name` in banks table (or match by generated code)
- **Update fields**:
  - `website_url` ← `config.website`
  - `rate_page_url` ← `config.rate_page_urls.fd` (primary)
  - `scraper_status` ← map from `config.scraper_type`:
    - `html_static`, `html_js`, `pdf`, `mixed`, `government` → `active`
    - `manual` → `manual_only`
    - no website found → `no_website`
    - website but no rates → `no_rates`
  - `discovery_status` ← based on `config.discovery_metadata.confidence`:
    - `high`/`medium` → `discovered`
    - `low` → `partial`
    - `none` or errors → `not_found`
  - `deposit_insurance` ← `config.deposit_insurance`

### 2.2 Rate data import

For banks where rates were extracted (`rate_slabs` is non-empty):
- Create `products` record (FD/regular for the bank)
- Import `rate_slabs` entries with tenure parsing
- This provides initial seed data before the Phase 2 scraping pipeline is built

### 2.3 CLI command

```bash
# Import all discovery results
node packages/api/src/db/seed/import-discovery.mjs rate-discovery-agent/output/

# Import a single bank
node packages/api/src/db/seed/import-discovery.mjs rate-discovery-agent/output/sbi_config.json
```

---

## Step 3: Tiered Discovery Execution

Run the agent in priority order. Each tier is a batch run, results reviewed before moving to next tier.

### Tier 1: Top Banks (PSBs + Large PVBs) — 33 banks
- **12 PSBs**: SBI, BoB, PNB, Canara, Union, Indian Bank, BOI, BOM, Central Bank, IOB, UCO, Punjab & Sind
- **21 PVBs**: HDFC, ICICI, Axis, Kotak, IndusInd, Yes, Federal, Bandhan, IDFC First, RBL, South Indian, City Union, Karur Vysya, Tamilnad Mercantile, DCB, Nainital, CSB, Dhanlaxmi, Lakshmi Vilas, Karnataka Bank, Jammu & Kashmir Bank

```bash
cd rate-discovery-agent
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Public Sector Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Private Sector Bank (Indian)"
```

**Expected**: All 33 should have websites with rate pages. Nearly 100% success rate.

### Tier 2: SFBs + Payments Banks + Financial Institutions — 21 banks
- **11 SFBs**: AU, Ujjivan, Equitas, Jana, Utkarsh, ESAF, Suryoday, Capital, Shivalik, NE/Slice, Unity
- **6 PBs**: Airtel, India Post, Jio, Fino, Paytm, NSDL
- **4 FIs**: NABARD, SIDBI, NHB, EXIM Bank

```bash
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Small Finance Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Payments Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Financial Institution"
```

**Expected**: SFBs should all have websites. Payments banks may not have traditional FD rates. FIs typically don't take public deposits.

### Tier 3: Scheduled Co-ops + Foreign Banks + RRBs — 148 banks
- **52 SUCBs**: Larger co-op banks, most should have websites
- **44 FBs**: International banks — many have Indian rate pages, some don't take INR deposits
- **28 RRBs**: Regional rural banks — mixed web presence
- **24 SSCBs**: State co-op banks — typically have websites

```bash
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Scheduled Urban Co-operative Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Foreign Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Regional Rural Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Scheduled State Co-operative Bank"
```

**Expected**: ~60-70% success rate. Many co-ops will have basic websites.

### Tier 4: Remaining Banks — ~1754 banks
- **1392 NSUCBs**: Non-scheduled urban co-ops — many will have no website
- **352 DCCBs**: District co-ops — mostly no web presence
- **10 NSSCBs**: Non-scheduled state co-ops
- **2 LABs**: Local area banks

```bash
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Non-Scheduled Urban Co-operative Bank" 50
# Run in batches of 50, review results, continue
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "District Central Co-operative Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Non-Scheduled State Co-operative Bank"
./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Local Area Bank"
```

**Expected**: ~10-20% success rate for NSUCBs. Most will be classified as `no_website` or `no_rates`. DCCBs may have some presence on state co-op portals.

---

## Step 4: Admin Discovery Dashboard

Add a simple admin page to the web app showing discovery progress.

### 4.1 API endpoint

`GET /api/admin/discovery-stats` — returns:
```json
{
  "total": 1958,
  "by_discovery_status": {
    "discovered": 245,
    "partial": 30,
    "not_found": 83,
    "pending": 1600
  },
  "by_scraper_status": {
    "active": 200,
    "no_website": 1500,
    "no_rates": 50,
    "manual_only": 8,
    "pending": 200
  },
  "by_category": [
    { "category": "PSB", "total": 12, "discovered": 12 },
    { "category": "PVB", "total": 21, "discovered": 21 },
    ...
  ]
}
```

### 4.2 Web route

`/admin/discovery` — simple dashboard showing:
- Overall progress bar (discovered / total)
- Breakdown by category (table with discovered/pending/not_found counts)
- List of recently discovered banks with their scraper type and confidence

---

## Step 5: Post-Discovery Database Update

After each tier's batch run:

1. Run the import script to update bank records
2. Review the import report (matched/unmatched/errors)
3. Manually resolve any name mismatches
4. Check the admin dashboard for progress
5. Move to the next tier

---

## Execution Timeline

| Week | Activity |
|------|----------|
| Week 1 | Steps 1-2: Agent setup, import pipeline, test with single banks |
| Week 1-2 | Step 3 Tier 1: PSBs + PVBs (33 banks), import results |
| Week 2 | Step 3 Tier 2: SFBs + PBs + FIs (21 banks), import results |
| Week 2 | Step 4: Admin discovery dashboard |
| Week 2-3 | Step 3 Tier 3: SUCBs + FBs + RRBs + SSCBs (148 banks) |
| Week 3-4 | Step 3 Tier 4: NSUCBs + DCCBs (1754 banks, in batches) |
| Week 4 | Step 5: Final review, cleanup, Phase 1 completion |

---

## Deliverables Checklist

- [ ] Rate discovery agent tested and working
- [ ] Import pipeline (discovery outputs → database)
- [ ] Tier 1 complete: 33 PSBs + PVBs discovered and imported
- [ ] Tier 2 complete: 21 SFBs + PBs + FIs discovered and imported
- [ ] Admin discovery dashboard (stats + progress tracking)
- [ ] Tier 3 complete: 148 scheduled co-ops + FBs + RRBs
- [ ] Tier 4 complete: ~1754 remaining banks (bulk classified)
- [ ] All 1958 banks have a discovery_status other than "pending"
- [ ] Phase 1 implementation doc written

---

## Expected Outcomes

- **~150-300 banks** classified as `discovered` with scraper configs ready for Phase 2
- **~50-100 banks** classified as `partial` (website exists, rates unclear)
- **~1500+ banks** classified as `no_website` or `no_rates`
- Scraper configs available for all discovered banks (feeding directly into Phase 2)
- Initial rate data seeded for banks where HTML extraction succeeded

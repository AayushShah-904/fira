# Plan: Complete Product Coverage for Priority Banks

## Context

We have 251 priority banks (excluding NSUCB/DCCB). Current gaps:
- **75 banks** have domain but no FD rate page URL
- **64 NRI-eligible banks** (PVB, FB, SFB) have no NRE/NRO/FCNR rates (feature added after their initial run)
- **11 banks** have no domain at all
- **42 banks** marked `manual` — mixed bag: some legit, some need retry
- **17 banks** blocked by WAF/CAPTCHA/cert errors

The plan adds targeted bank selection to the batch runner and a gap analysis dashboard, then runs focused batches only on banks that need work.

---

## Phase 1: Infrastructure — Gap Analysis & Targeted Batch Support

### Step 1: Create `scripts/analyze-gaps.js`

Coverage dashboard + gap list generator. Two output modes:

**Dashboard mode** (default):
```
Category       | Total | Domain | FD URL | Rates | NRE | NRO | FCNR | GIFT | Manual | Problem
PSB            |    12 |     12 |     12 |    12 |  12 |  10 |   11 |    - |      0 |       0
PVB            |    21 |     21 |     21 |    21 |  10 |   7 |    9 |    - |      0 |       2
...
```

**List mode** — output specific bank slugs for each gap type:
```bash
node scripts/analyze-gaps.js --list missing-fd          # banks with domain but no FD URL
node scripts/analyze-gaps.js --list missing-domain       # banks with no domain
node scripts/analyze-gaps.js --list missing-nri          # NRI-eligible banks without NRE/NRO
node scripts/analyze-gaps.js --list missing-gift         # IBU banks without GIFT rates
node scripts/analyze-gaps.js --list manual               # banks marked manual
node scripts/analyze-gaps.js --list problems             # WAF/CAPTCHA/cert banks
node scripts/analyze-gaps.js --list no-config            # banks with no output config at all
node scripts/analyze-gaps.js --list stale --max-age 7    # banks with rates older than N days
```

Each `--list` mode writes a file: `output/gaps/<gap-type>.txt` (one slug per line). This feeds directly into the batch runner's new `--banks` flag.

**Files to create:**
- `scripts/analyze-gaps.js`

### Step 2: Add `--banks` flag to `run-batch.js`

Accept a file of bank slugs to process instead of (or in addition to) `--category`:

```bash
# Process only specific banks from a gap list
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv \
  --banks output/gaps/missing-fd.txt --concurrency 2

# Or inline comma-separated slugs
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv \
  --banks "hdfc-bank-limited,karnataka-bank-limited,rbl-bank-limited"
```

Implementation: After CSV parsing and category filtering, further filter to only banks whose slug appears in the `--banks` list. If the argument is a `.txt` file path, read it line-by-line; otherwise split by comma.

**Files to modify:**
- `run-batch.js` — add `--banks` arg parsing and filtering (~15 lines)

### Step 3: Add `status` field support to `bank-domains.json`

Add an optional `status` field for banks that should be skipped. The batch runner and pipeline check this before processing:

- `"active"` or absent — normal processing
- `"no_retail_deposits"` — FIs like NABARD, SIDBI, NHB, EXIM
- `"no_website"` — confirmed no India-facing website (Sberbank, Sonali, QNB, UBS, etc.)
- `"wholesale_only"` — IBUs with no public retail rate card (Natixis, JP Morgan Securities, etc.)
- `"rates_in_images"` — rates published as JPG/PNG images, not HTML/PDF
- `"site_unreachable"` — cert errors, domain expired, persistent 5xx

`run-batch.js` and `run-pipeline.js` skip banks with a non-active status unless `--include-skipped` is passed.

**Files to modify:**
- `data/bank-domains.json` — add `status` to ~25 banks we've already identified
- `run-batch.js` — add status check before processing each bank (~5 lines)
- `run-pipeline.js` — add status check in bank classification

---

## Phase 2: Fill Domain & FD Rate Page Gaps

### Step 2a: Discover domains for 11 banks with no domain

```bash
node scripts/run-domain-discovery.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv \
  --category "Foreign Bank"
# Also covers IBU (2), NSSCB (1), SUCB (1) — small enough to do in one batch
```

### Step 2b: Full discovery for banks with domain but no FD page (75 banks)

Generate targeted list, then run only those:

```bash
node scripts/analyze-gaps.js --list missing-fd
# Produces output/gaps/missing-fd.txt with ~75 slugs

node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv \
  --banks output/gaps/missing-fd.txt --concurrency 2
```

This runs only the 26 RRBs, 22 IBUs, 10 FBs, 8 NSSCBs, 5 PBs, 4 FIs that actually need FD page discovery — not the entire category.

**Est. cost:** ~75 banks × $0.08 avg = ~$6

### Step 2c: Review results and tag permanent skips

After 2b, many FIs and wholesale IBUs will come back as `manual`. Tag them:

```bash
node scripts/analyze-gaps.js --list manual
# Review output, then update bank-domains.json with appropriate status tags
```

---

## Phase 3: NRI Expansion (targeted)

Only banks that are NRI-eligible AND don't already have NRE/NRO rate files:

```bash
node scripts/analyze-gaps.js --list missing-nri
# Produces output/gaps/missing-nri.txt with ~64 slugs:
#   11 PVBs, 10 SFBs, 43 FBs

node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv \
  --banks output/gaps/missing-nri.txt --expand-nri --concurrency 2
```

Note: Many foreign banks won't have separate NRI pages (they operate wholesale). The agent will set NRI URLs to null — that's the correct outcome.

**Est. cost:** ~64 banks × $0.10 (Tier 2 for expand-nri) = ~$6.40

---

## Phase 4: Problem Area Retry

### Step 4a: Tag permanent skips in bank-domains.json

Based on our earlier analysis, directly set `status` for banks we know can't be processed:

| Bank | Status | Reason |
|------|--------|--------|
| NABARD, SIDBI, NHB, EXIM Bank | `no_retail_deposits` | Development FIs, no retail deposits |
| Sberbank, Sonali, QNB, UBS, Woori, Maybank Indonesia, FirstRand, Industrial Bank of Korea | `no_website` | No India website with deposit rates |
| Natixis IBU, JP Morgan Securities IBU, Société Générale IBU, Mashreqbank IBU | `wholesale_only` | No public retail rate card |
| Janalaxmi Co-op, Karimnagar DCCB | `rates_in_images` | Rates in JPG images |

### Step 4b: Retry WAF/CAPTCHA banks

Generate the list and retry one-by-one with debug logging:

```bash
node scripts/analyze-gaps.js --list problems
# Shows: HDFC, Karnataka Bank, AU SFB, Bank of India, Airtel PB, Jio PB, CTBC, etc.

# Retry individually with debug to diagnose
node run-discovery.js "HDFC Bank Limited" "Private Sector Bank (Indian)" --log-level debug
node run-discovery.js "Karnataka Bank Limited" "Private Sector Bank (Indian)" --log-level debug
node run-discovery.js "Airtel Payments Bank Limited" "Payments Bank" --log-level debug
```

If they fail again, mark `status: "site_unreachable"` with the failure reason in notes.

### Step 4c: Retry previously failed banks

```bash
node scripts/analyze-gaps.js --list no-config
# Banks with domains but no output config — these failed during earlier runs

node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv \
  --banks output/gaps/no-config.txt --concurrency 2
```

---

## Execution Order

| # | Action | What | Banks | Est. Cost |
|---|--------|------|-------|-----------|
| 1 | Code | Create `analyze-gaps.js` | — | $0 |
| 2 | Code | Add `--banks` to `run-batch.js` | — | $0 |
| 3 | Code | Add `status` field support | — | $0 |
| 4 | Data | Tag permanent skip banks | ~25 | $0 |
| 5 | Run | Domain discovery (missing domains) | 11 | ~$0.04 |
| 6 | Run | Full discovery (missing FD pages) | ~75 | ~$6 |
| 7 | Run | NRI expansion (missing NRE/NRO/FCNR) | ~64 | ~$6.40 |
| 8 | Run | Retry WAF/CAPTCHA banks | ~10 | ~$1.50 |
| 9 | Run | Retry no-config banks | ~15 | ~$1 |
| | **Total** | | | **~$15** |

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `scripts/analyze-gaps.js` | **Create** | Coverage dashboard + gap list generator |
| `run-batch.js` | **Modify** | Add `--banks` flag for targeted bank selection |
| `run-pipeline.js` | **Modify** | Add `status` check to skip tagged banks |
| `data/bank-domains.json` | **Modify** | Add `status` tags for ~25 permanent-skip banks |

---

## Verification

After each batch run:
1. `node scripts/analyze-gaps.js` — check coverage dashboard
2. `node scripts/analyze-gaps.js --list <gap-type>` — verify gap list shrinks
3. Spot-check rate files: `cat output/latest/<bank>_nre_rates.json | head -5`
4. Cost tracking: `node -e "..."` summary.json aggregation
5. Review new `manual` results — tag appropriately in bank-domains.json

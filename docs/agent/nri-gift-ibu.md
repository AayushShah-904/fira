# NRI / FCNR / GIFT-City (IBU) Rate Pages

Read this only for PSB/PVB/FB/large-SFB (NRI) or IBU (GIFT) banks. Co-ops/RRBs/PBs/LABs do not offer these.

> Single source of truth: `lib/prompts/fragments.js` reads the anchored sections below; do not duplicate this content elsewhere. Edit here.

<!-- @fragment STEP_NRI_FCNR -->
## Find NRI/FCNR Rate Pages

NRE, NRO, and FCNR are **separate deposit products** with their own interest rate schedules. Do NOT assume they share rates with domestic FDs — each must be fetched and extracted independently.

**Search for NRI deposit pages:**
1. **Search for links** on the bank's website containing keywords: `NRE deposit`, `NRO deposit`, `NRI fixed deposit`, `NRI banking`, `FCNR deposit rates`, `FCNR-B rates`, `foreign currency deposit`, `non-resident deposit`
2. Try common URL patterns: `/nri-deposits`, `/nri-interest-rates`, `/nri-fd-rates`, `/fcnr-rates`, `/foreign-currency-deposits`, `/nri-banking`, `/non-resident-deposits`
3. If not found from the homepage, **web search**: `site:<domain> NRI deposit interest rate`
4. Many banks have a **single combined NRI page** covering NRE + NRO + FCNR rates. Record this as `fd_nri_combined`.
5. Some banks publish **separate PDFs** per variant.

**Product details:**
- **NRE** (Non-Resident External): INR-denominated, tax-free in India. Rates are set independently from domestic FD rates — always fetch the NRE-specific page.
- **NRO** (Non-Resident Ordinary): INR-denominated, taxable. Rates may differ from both domestic and NRE rates — fetch separately.
- **FCNR** (Foreign Currency Non-Resident): Denominated in **foreign currencies** (USD, GBP, EUR, JPY, CAD, AUD) — NOT INR. Rate tables show separate rates per currency. No senior citizen premium. Min tenure 1 year (365d), max 5 years (1825d).

**Important:**
- Each variant (NRE, NRO, FCNR) gets its own rate file — do not merge them.
- If a variant's page is **not found**, set the URL field to `null` in the config — this means "searched, not found" (distinct from never having searched).
- Some banks don't offer all NRI products — that's expected, just record null for those.
<!-- @end STEP_NRI_FCNR -->

<!-- @fragment STEP_GIFT_CITY -->
## Find GIFT City / IFSC Rate Pages (IBU Only)

IBUs operate under IFSCA in GIFT City, Gujarat. Their deposits are in foreign currency (USD, GBP, EUR, etc.) and are NOT covered by DICGC insurance.

1. IBU rate pages are typically found under the **parent bank's** IFSC/GIFT City section.
2. **Search patterns:** `site:<parent_domain> GIFT City deposit rates`, `site:<parent_domain> IFSC banking unit deposit`
3. Common URL patterns: `/gift-ifsc/`, `/ifsc-banking/`, `/international-banking/gift-city/`, `/ibu/deposit-rates`
4. Some IBUs share rate pages with their parent bank's FCNR section.
5. Some IBUs have dedicated microsites or separate PDF rate cards.
6. If the parent bank's domain is known, use it for searching.

**Output:** IBU configs should set `bank_type: "IBU"` and `deposit_insurance: false`. Rate files should use `variant: "gift"` with `currency` per slab.
<!-- @end STEP_GIFT_CITY -->

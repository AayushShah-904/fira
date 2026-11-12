# Cohort comparison — Sprint 001 cloud (2026-05-08) → Sprint 002 cloud rerun (2026-05-13, exec caj-bofia-rate-discovery-prod-hdh2hlz)

- **Sprint 001 cloud (2026-05-08):** 350 banks
- **Sprint 002 cloud rerun (2026-05-13, exec caj-bofia-rate-discovery-prod-hdh2hlz):** 35 banks
- **Shared (in both runs):** 35
- **Only in Sprint 001 cloud (2026-05-08):** 315
- **Only in Sprint 002 cloud rerun (2026-05-13, exec caj-bofia-rate-discovery-prod-hdh2hlz):** 0

## Tier-2 distribution side-by-side

| failure_class | Sprint 001 cloud (2026-05-08) | % | Sprint 002 cloud rerun (2026-05-13, exec caj-bofia-rate-discovery-prod-hdh2hlz) | % | Δ (pp) |
|---|---:|---:|---:|---:|---:|
| `success` | 0 | 0.0% | 21 | 60.0% | +60.0 |
| `partial_success` | 0 | 0.0% | 6 | 17.1% | +17.1 |
| `extraction_failed` | 0 | 0.0% | 3 | 8.6% | +8.6 |
| `discovery_failed` | 0 | 0.0% | 3 | 8.6% | +8.6 |
| `no_rates_expected` | 0 | 0.0% | 1 | 2.9% | +2.9 |
| `unclassified` | 350 | 100.0% | 1 | 2.9% | -97.1 |

## Transition matrix (banks in both runs)

Rows = Sprint 001 cloud (2026-05-08); columns = Sprint 002 cloud rerun (2026-05-13, exec caj-bofia-rate-discovery-prod-hdh2hlz). Diagonal = unchanged classification.

| from \ to | `success` | `partial_success` | `extraction_failed` | `discovery_failed` | `no_rates_expected` | `unclassified` | total |
|---|---:|---:|---:|---:|---:|---:|---:|
| `unclassified` | 21 | 6 | 3 | 3 | 1 | 1 | **35** |

**Movement summary:** unchanged=1, improved=34, regressed=0.

## Banks only in Sprint 001 cloud (2026-05-08) (315)

| Bank | classification |
|---|---|
| `aligarh-zilla-sahakari-bank-ltd` | unclassified |
| `allahabad-district-central-co-operative-bank-ltd` | unclassified |
| `almora-zilla-sahakari-bank-ltd` | unclassified |
| `alwar-central-co-operative-bank-ltd` | unclassified |
| `ambala-central-co-operative-bank-ltd` | unclassified |
| `amritsar-central-co-operative-bank-ltd` | unclassified |
| `bahraich-district-central-co-operative-bank-ltd` | unclassified |
| `balasore-bhadrak-district-central-co-operative-bank-ltd` | unclassified |
| `ballia-district-central-co-operative-bank-ltd` | unclassified |
| `banda-district-central-co-operative-bank-ltd` | unclassified |
| `banki-district-central-co-operative-bank-ltd-banki-ccb-building` | unclassified |
| `barabanki-district-central-co-operative-bank-ltd` | unclassified |
| `baramulla-central-co-operative-bank-ltd` | unclassified |
| `baran-central-co-operative-bank-ltd` | unclassified |
| `bareilly-zilla-sahakari-bank-ltd` | unclassified |
| `basti-district-central-co-operative-bank-ltd` | unclassified |
| `behrampore-district-central-co-operative-bank-ltd` | unclassified |
| `belgaum-district-central-co-operative-bank-ltd` | unclassified |
| `bellary-district-co-operative-central-bank-ltd` | unclassified |
| `bhandara-district-central-co-operative-bank-ltd` | unclassified |
| `bharatpur-central-co-operative-bank-ltd` | unclassified |
| `bhawanipatna-central-co-operative-bank-ltd` | unclassified |
| `bhilwara-central-co-operative-bank-ltd` | unclassified |
| `bhiwani-central-co-operative-bank-ltd` | unclassified |
| `bidar-district-central-co-operative-bank-ltd` | unclassified |
| `bijnor-jilla-sahakari-bank-ltd` | unclassified |
| `bikaner-central-co-operative-bank-ltd` | unclassified |
| `birbhum-district-central-co-operative-bank-ltd` | unclassified |
| `bolangir-district-central-co-operative-bank-ltd` | unclassified |
| `budaun-zilla-sahakari-bank-ltd` | unclassified |
| `buldhana-district-central-co-operative-bank-ltd` | unclassified |
| `bundi-central-co-operative-bank-ltd` | unclassified |
| `burdwan-central-co-operative-bank-ltd` | unclassified |
| `chamoli-zilla-sahakari-bank-ltd` | unclassified |
| `chandrapur-district-central-co-operative-bank-ltd` | unclassified |
| `chittorgarh-kendriya-sahakari-bank-ltd` | unclassified |
| `churu-central-co-operative-bank-ltd` | unclassified |
| `coimbatore-district-central-co-opertive-bank-ltd` | unclassified |
| `cuddalore-district-central-co-operative-bank-ltd` | unclassified |
| `cuddapah-district-co-operative-central-bank-ltd` | unclassified |
| `cuttack-central-co-operative-bank-ltd` | unclassified |
| `dakshin-dinajpur-district-central-co-op-bank-ltd` | unclassified |
| `darjeeling-district-central-co-operative-bank-ltd` | unclassified |
| `dausa-central-co-operative-bank-ltd` | unclassified |
| `davanagere-central-co-operative-bank-ltd` | unclassified |
| `dehradun-district-central-co-operative-bank-ltd` | unclassified |
| `deoria-kasia-district-central-co-operative-bank-ltd` | unclassified |
| `dharampuri-district-central-co-operative-bank-ltd` | unclassified |
| `dhule-nandurbar-district-central-co-operative-bank-ltd` | unclassified |
| `dindigul-central-co-operative-bank-ltd` | unclassified |
| ... +265 more | |

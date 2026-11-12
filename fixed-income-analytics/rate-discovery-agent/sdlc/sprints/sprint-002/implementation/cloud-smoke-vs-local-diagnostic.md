# Cohort comparison — Local diagnostic (2026-05-11) → Cloud smoke (2026-05-13)

- **Local diagnostic (2026-05-11):** 34 banks
- **Cloud smoke (2026-05-13):** 34 banks
- **Shared (in both runs):** 34
- **Only in Local diagnostic (2026-05-11):** 0
- **Only in Cloud smoke (2026-05-13):** 0

## Tier-2 distribution side-by-side

| failure_class | Local diagnostic (2026-05-11) | % | Cloud smoke (2026-05-13) | % | Δ (pp) |
|---|---:|---:|---:|---:|---:|
| `success` | 19 | 55.9% | 21 | 61.8% | +5.9 |
| `partial_success` | 6 | 17.6% | 6 | 17.6% | 0.0 |
| `extraction_failed` | 4 | 11.8% | 3 | 8.8% | -2.9 |
| `discovery_failed` | 3 | 8.8% | 3 | 8.8% | 0.0 |
| `no_rates_expected` | 2 | 5.9% | 1 | 2.9% | -2.9 |

## Transition matrix (banks in both runs)

Rows = Local diagnostic (2026-05-11); columns = Cloud smoke (2026-05-13). Diagonal = unchanged classification.

| from \ to | `success` | `partial_success` | `extraction_failed` | `discovery_failed` | `no_rates_expected` | total |
|---|---:|---:|---:|---:|---:|---:|
| `success` | 19 |  |  |  |  | **19** |
| `partial_success` | 1 | 5 |  |  |  | **6** |
| `extraction_failed` | 1 | 1 | 2 |  |  | **4** |
| `discovery_failed` |  |  |  | 3 |  | **3** |
| `no_rates_expected` |  |  | 1 |  | 1 | **2** |

**Movement summary:** unchanged=30, improved=3, regressed=1.

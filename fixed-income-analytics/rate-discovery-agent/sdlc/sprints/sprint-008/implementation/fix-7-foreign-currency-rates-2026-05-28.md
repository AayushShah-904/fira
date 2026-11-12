# Fix — foreign-currency (non-INR) rates excluded (2026-05-28)

Operator flagged `ab-bank-plc` shipping a 12% "FD" — AB Bank PLC is Bangladeshi, and the rate is BDT, not Indian INR. A scan for the pattern (foreign bank whose source is the home-country site, home-currency rates) confirmed two:

| Bank | Source | Issue |
|---|---|---|
| ab-bank-plc | abbl.com (Bangladesh) | BDT rates 8–12%, no currency tag, `state: Bangladesh` — not Indian INR FD |
| sonali-bank-plc | sonalibank.in `New_Interest_Rate.pdf` | Bangladesh BDT rate PDF, mangled parse (e.g. "21\t1\tdays" 13%) |

Both **quarantined** (rate_slabs=[], `discovery_status: foreign_currency_not_inr`). If their India branches publish INR FD rates, those can be sourced separately later.

## Scope clarification (what is NOT this bug)
- Most foreign banks have legit India branches on `.bank.in` with plausible INR rates (deutsche, hsbc, emirates, dbs, sbm, doha, etc.) — `state` = home country is just origin metadata; **kept**.
- Absurd >15% values (kookmin 1530%, shivalik 714%, panchmahal 600%, jammu 31%) are already dropped by the rate-bounds `[0.1,15]` filter at pack-build — never shipped.
- **deogiri (14.5%) + udupi (14%)** are *Indian* co-ops shipping INR parse errors (not foreign currency) — a separate extraction-bug class; flagged for a follow-up fix, not quarantined as foreign.

## Verified
- After quarantine + rebuild: blocking `rate_reasonableness_outlier` **2 → 1** (only model-coop 9.5%, borderline-legit). ab-bank no longer an outlier.
- Banks shipping a `regular` rate >9.5%: now only deogiri/udupi (the Indian parse-error follow-up).
- `npm test` green (1 known playwright fail); `check-write-discipline` clean.

## Follow-on
- deogiri-nagari-sahakari (14.5%) + udupi-co-operative-town (14%): re-extract / correct the INR parse errors.
- Optionally source AB Bank / Sonali Bank **India-branch** INR FD rates if published.

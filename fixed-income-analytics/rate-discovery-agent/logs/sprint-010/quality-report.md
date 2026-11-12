# Pack quality gate — rates-pack vs 2026-05-28

## Verdict: BLOCK

- New pack:      rates-pack.json — 578 banks, 8990 slabs
- Baseline pack: baseline-pack-2026-05-28.json — 517 banks, 8369 slabs
- Net bank delta: +61
- Net slab delta: +621

## Summary counts

- REGRESSIONS: 0 (blocking: 0, accepted: 0)
- ANOMALIES:   48 (blocking: 48, accepted: 0)
- WARNINGS:    393
- INFO:        0
- GAINS:       133
- NEW VARIANTS: 7

## Regressions (0)

_None._

## Anomalies (48)

| bank_code | variant | check | value | accepted | detail |
|---|---|---|---|---|---|
| uco-bank | fcnr | anomalous_gain | undefined | NO |  |
| ajara-urban-co-operative-bank-ltd | regular | senior_below_general | {"general":3.25,"senior":2.75} | NO | rate_senior_pct < rate_general_pct by 50bps (Indian FD invariant; threshold 30bps) |
| ajara-urban-co-operative-bank-ltd | regular | senior_below_general | {"general":4.5,"senior":4} | NO | rate_senior_pct < rate_general_pct by 50bps (Indian FD invariant; threshold 30bps) |
| ajara-urban-co-operative-bank-ltd | regular | senior_below_general | {"general":6.25,"senior":5.5} | NO | rate_senior_pct < rate_general_pct by 75bps (Indian FD invariant; threshold 30bps) |
| ajara-urban-co-operative-bank-ltd | regular | senior_below_general | {"general":6.75,"senior":6} | NO | rate_senior_pct < rate_general_pct by 75bps (Indian FD invariant; threshold 30bps) |
| ajara-urban-co-operative-bank-ltd | regular | senior_below_general | {"general":6.5,"senior":5.25} | NO | rate_senior_pct < rate_general_pct by 125bps (Indian FD invariant; threshold 30bps) |
| howrah-district-central-co-operative-bank-ltd | regular | senior_below_general | {"general":5.25,"senior":4.75} | NO | rate_senior_pct < rate_general_pct by 50bps (Indian FD invariant; threshold 30bps) |
| howrah-district-central-co-operative-bank-ltd | regular | senior_below_general | {"general":5.5,"senior":4.85} | NO | rate_senior_pct < rate_general_pct by 65bps (Indian FD invariant; threshold 30bps) |
| kanpur-zilla-sahakari-bank-ltd | regular | senior_below_general | {"general":3.75,"senior":2.9} | NO | rate_senior_pct < rate_general_pct by 85bps (Indian FD invariant; threshold 30bps) |
| kanpur-zilla-sahakari-bank-ltd | regular | senior_below_general | {"general":4.5,"senior":3.95} | NO | rate_senior_pct < rate_general_pct by 55bps (Indian FD invariant; threshold 30bps) |
| kanpur-zilla-sahakari-bank-ltd | regular | senior_below_general | {"general":5.2,"senior":4.4} | NO | rate_senior_pct < rate_general_pct by 80bps (Indian FD invariant; threshold 30bps) |
| krishna-district-co-operative-central-bank-ltd | regular | senior_below_general | {"general":4,"senior":1} | NO | rate_senior_pct < rate_general_pct by 300bps (Indian FD invariant; threshold 30bps) |
| krishna-district-co-operative-central-bank-ltd | regular | senior_below_general | {"general":6.25,"senior":1} | NO | rate_senior_pct < rate_general_pct by 525bps (Indian FD invariant; threshold 30bps) |
| krishna-district-co-operative-central-bank-ltd | regular | senior_below_general | {"general":6.75,"senior":2} | NO | rate_senior_pct < rate_general_pct by 475bps (Indian FD invariant; threshold 30bps) |
| krishna-district-co-operative-central-bank-ltd | regular | senior_below_general | {"general":7.25,"senior":3} | NO | rate_senior_pct < rate_general_pct by 425bps (Indian FD invariant; threshold 30bps) |
| krishna-district-co-operative-central-bank-ltd | regular | senior_below_general | {"general":7.75,"senior":4} | NO | rate_senior_pct < rate_general_pct by 375bps (Indian FD invariant; threshold 30bps) |
| nadia-district-central-co-operative-bank-ltd | regular | super_senior_below_senior | {"senior":6.25,"super_senior":5.75} | NO | rate_super_senior_pct < rate_senior_pct by 50bps |
| nadia-district-central-co-operative-bank-ltd | regular | super_senior_below_senior | {"senior":7.4,"super_senior":6.9} | NO | rate_super_senior_pct < rate_senior_pct by 50bps |
| nadia-district-central-co-operative-bank-ltd | regular | super_senior_below_senior | {"senior":7.5,"super_senior":7} | NO | rate_super_senior_pct < rate_senior_pct by 50bps |
| nadia-district-central-co-operative-bank-ltd | regular | super_senior_below_senior | {"senior":7.25,"super_senior":6.75} | NO | rate_super_senior_pct < rate_senior_pct by 50bps |
| nkgsb-co-operative-bank-ltd | regular | senior_below_general | {"general":7.65,"senior":0.1} | NO | rate_senior_pct < rate_general_pct by 755bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":5.5,"senior":1} | NO | rate_senior_pct < rate_general_pct by 450bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":6,"senior":2} | NO | rate_senior_pct < rate_general_pct by 400bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":6.25,"senior":3} | NO | rate_senior_pct < rate_general_pct by 325bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":8,"senior":4} | NO | rate_senior_pct < rate_general_pct by 400bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":8.1,"senior":5} | NO | rate_senior_pct < rate_general_pct by 310bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":8.3,"senior":6} | NO | rate_senior_pct < rate_general_pct by 230bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":8.45,"senior":7} | NO | rate_senior_pct < rate_general_pct by 145bps (Indian FD invariant; threshold 30bps) |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | senior_below_general | {"general":8.5,"senior":8} | NO | rate_senior_pct < rate_general_pct by 50bps (Indian FD invariant; threshold 30bps) |
| shamrao-vithal-co-operative-bank-ltd | regular | senior_below_general | {"general":5.25,"senior":0.5} | NO | rate_senior_pct < rate_general_pct by 475bps (Indian FD invariant; threshold 30bps) |
| shamrao-vithal-co-operative-bank-ltd | regular | senior_below_general | {"general":5.25,"senior":0.5} | NO | rate_senior_pct < rate_general_pct by 475bps (Indian FD invariant; threshold 30bps) |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":4.5,"super_senior":4} | NO | rate_super_senior_pct < rate_senior_pct by 50bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":4.25,"super_senior":3.75} | NO | rate_super_senior_pct < rate_senior_pct by 50bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":4,"super_senior":2.45} | NO | rate_super_senior_pct < rate_senior_pct by 155bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":3.75,"super_senior":2.45} | NO | rate_super_senior_pct < rate_senior_pct by 130bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":4,"super_senior":2.45} | NO | rate_super_senior_pct < rate_senior_pct by 155bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":6.74,"super_senior":6.2} | NO | rate_super_senior_pct < rate_senior_pct by 54bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":6.94,"super_senior":6.2} | NO | rate_super_senior_pct < rate_senior_pct by 74bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":7.16,"super_senior":6.2} | NO | rate_super_senior_pct < rate_senior_pct by 96bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":7.38,"super_senior":6.2} | NO | rate_super_senior_pct < rate_senior_pct by 118bps |
| south-indian-bank-limited | nre | super_senior_below_senior | {"senior":7.61,"super_senior":6.2} | NO | rate_super_senior_pct < rate_senior_pct by 141bps |
| the-district-co-operative-central-bank-ltd-srikakulam | regular | senior_below_general | {"general":6.75,"senior":0.6} | NO | rate_senior_pct < rate_general_pct by 615bps (Indian FD invariant; threshold 30bps) |
| the-karnataka-state-co-operative-apex-bank-ltd | regular | senior_below_general | {"general":4,"senior":1} | NO | rate_senior_pct < rate_general_pct by 300bps (Indian FD invariant; threshold 30bps) |
| the-karnataka-state-co-operative-apex-bank-ltd | regular | senior_below_general | {"general":4.5,"senior":2} | NO | rate_senior_pct < rate_general_pct by 250bps (Indian FD invariant; threshold 30bps) |
| the-karnataka-state-co-operative-apex-bank-ltd | regular | senior_below_general | {"general":4.75,"senior":3} | NO | rate_senior_pct < rate_general_pct by 175bps (Indian FD invariant; threshold 30bps) |
| the-karnataka-state-co-operative-apex-bank-ltd | regular | senior_below_general | {"general":5.25,"senior":4} | NO | rate_senior_pct < rate_general_pct by 125bps (Indian FD invariant; threshold 30bps) |
| the-karnataka-state-co-operative-apex-bank-ltd | regular | senior_below_general | {"general":6,"senior":5} | NO | rate_senior_pct < rate_general_pct by 100bps (Indian FD invariant; threshold 30bps) |
| the-karnataka-state-co-operative-apex-bank-ltd | regular | senior_below_general | {"general":6.5,"senior":6} | NO | rate_senior_pct < rate_general_pct by 50bps (Indian FD invariant; threshold 30bps) |

## Warnings (393)

| bank_code | variant | kind | baseline | new | delta | detail |
|---|---|---|---|---|---|---|
| bank-of-bahrain-and-kuwait-bsc | fcnr | variant | 6 | 5 | -16.7% |  |
| bank-of-maharashtra | nre | variant | 7 | 6 | -14.3% |  |
| beed-district-central-co-operative-bank-ltd | regular | variant | 8 | 7 | -12.5% |  |
| bharat-co-operative-bank-mumbai-ltd | regular | variant | 40 | 33 | -17.5% |  |
| bnp-paribas | regular | variant | 9 | 8 | -11.1% |  |
| burdwan-central-co-operative-bank-ltd | regular | variant | 12 | 11 | -8.3% |  |
| central-bank-of-india | nre | variant | 6 | 5 | -16.7% |  |
| central-bank-of-india | fcnr | variant | 32 | 30 | -6.3% |  |
| city-union-bank-limited | fcnr | variant | 35 | 32 | -8.6% |  |
| hdfc-bank-limited | nre | variant | 18 | 17 | -5.6% |  |
| hissar-district-central-co-operative-bank-ltd | regular | variant | 10 | 9 | -10.0% |  |
| jalandhar-central-co-operative-bank-ltd | regular | variant | 8 | 7 | -12.5% |  |
| jalgaon-peoples-co-operative-bank-ltd | regular | variant | 11 | 9 | -18.2% |  |
| jammu-central-co-operative-bank-ltd | regular | variant | 10 | 9 | -10.0% |  |
| nadia-district-central-co-operative-bank-ltd | regular | variant | 8 | 7 | -12.5% |  |
| nagpur-district-central-co-operative-bank-ltd | regular | variant | 9 | 8 | -11.1% |  |
| puducherry-grama-bank | regular | variant | 11 | 10 | -9.1% |  |
| rajapur-urban-cooperative-bank-ltd-rajapur | regular | variant | 21 | 19 | -9.5% |  |
| sbm-bank-india-limited | fcnr | variant | 37 | 32 | -13.5% |  |
| sri-potti-sriramulu-nellore-district-cooperative-central-bank-ltd | regular | variant | 11 | 10 | -9.1% |  |
| state-bank-of-india | fcnr | variant | 36 | 30 | -16.7% |  |
| the-akola-janata-commercial-co-operative-bank-ltd-akola | regular | variant | 15 | 14 | -6.7% |  |
| the-maharashtra-state-co-operative-bank-ltd | regular | variant | 11 | 10 | -9.1% |  |
| the-valsad-district-central-co-operative-bank-ltd | regular | variant | 10 | 9 | -10.0% |  |
| the-vishweshwar-sahakari-bank-ltd-pune | regular | variant | 9 | 8 | -11.1% |  |
| the-west-bengal-state-co-operative-bank-ltd | regular | variant | 11 | 10 | -9.1% |  |
| yes-bank-limited | regular | variant | 18 | 17 | -5.6% |  |
| agra-zilla-sahakari-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| ahmednagar-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| ajara-urban-co-operative-bank-ltd | regular | anomaly | — | — | — | rate_senior_pct < rate_general_pct by 25bps (within 30bps tolerance — likely promotional / non-callable / bulk tier where senior premium does not apply) |
| ajara-urban-co-operative-bank-ltd | regular | anomaly | — | — | — | rate_senior_pct < rate_general_pct by 25bps (within 30bps tolerance — likely promotional / non-callable / bulk tier where senior premium does not apply) |
| ajara-urban-co-operative-bank-ltd | regular | anomaly | — | — | — | median senior premium -0.50pp (~0/negative) while NSUCB banks median +0.50pp — possible senior/general column swap |
| akhand-anand-co-operative-bank-ltd-surat | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while NSUCB banks median +0.50pp — possible senior/general column swap |
| allahabad-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| amreli-nagrik-sahakari-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| amreli-nagrik-sahakari-bank-ltd | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while NSUCB banks median +0.50pp — possible senior/general column swap |
| amritsar-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| andhra-pradesh-grameena-bank | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| andhra-pradesh-mahesh-co-op-urban-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| angul-united-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| apna-sahakari-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| arunachal-pradesh-rural-bank | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| balageria-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| balasore-bhadrak-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| bandhan-bank-limited | regular | anomaly | — | — | — | rate 7.25% deviates 175bps from nearest recent history 5.5% (last 2: 5.5/5.5%) |
| bangalore-city-co-operative-bank-ltd-bangalore | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| bangalore-district-and-bangalore-rural-district-co-op-central-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| bank-of-america | regular | anomaly | — | — | — | rate 2.9% is 218bps from the FB peer median 5.08% (n=28) |
| bank-of-baroda | fcnr | anomaly | — | — | — | duplicate USD tenure+amount-tier with differing rate (collapsed currency section?) |
| bank-of-baroda | regular | anomaly | — | — | — | rate 6.3% is 30bps from the PSB peer median 6% (n=11; outside IQR fence) |
| bank-of-ceylon | regular | anomaly | — | — | — | rate 7.25% is 217bps from the FB peer median 5.08% (n=28) |
| bank-of-maharashtra | regular | anomaly | — | — | — | rate 5% is 100bps from the PSB peer median 6% (n=11; outside IQR fence) |
| bank-of-nova-scotia | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| beed-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | rate 5.5% is 125bps from the DCCB peer median 6.75% (n=85; outside IQR fence) |
| bharat-co-operative-bank-mumbai-ltd | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while SUCB banks median +0.35pp — possible senior/general column swap |
| bharath-co-operative-bank-limited-bangalore | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| bhuj-commercial-co-op-bank-ltd | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while NSUCB banks median +0.50pp — possible senior/general column swap |
| bikaner-central-co-operative-bank-ltd | regular | anomaly | — | — | — | rate 8.25% is 150bps from the DCCB peer median 6.75% (n=85; outside IQR fence) |
| bombay-mercantile-co-operative-bank-limited | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| bombay-mercantile-co-operative-bank-limited | nre | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| bombay-mercantile-co-operative-bank-limited | fcnr | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| canara-bank | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| canara-bank | regular | anomaly | — | — | — | rate_senior_pct < rate_general_pct by 15bps (within 30bps tolerance — likely promotional / non-callable / bulk tier where senior premium does not apply) |
| canara-bank | nre | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| canara-bank | nro | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| canara-bank | fcnr | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| canara-bank | regular | anomaly | — | — | — | rate 5% is 100bps from the PSB peer median 6% (n=11; outside IQR fence) |
| central-bank-of-india | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| central-co-operative-bank-ltd-ara_dds | regular | anomaly | — | — | — | rate 2.5% outside plausible band [2.75, 8.75] around repo 5.25% for (unknown) |
| chamoli-zilla-sahakari-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| chandrapur-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| chandrapur-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | rate 5% is 190bps from the DCCB peer median 6.9% (n=108; outside IQR fence) |
| chiplun-urban-coopbank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| churu-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| citibank-na | regular | anomaly | — | — | — | rate 1.75% is 333bps from the FB peer median 5.08% (n=28) |
| citibank-na | regular | anomaly | — | — | — | rate 1.75% is 357bps from the FB peer median 5.32% (n=21) |
| citibank-na | regular | anomaly | — | — | — | rate 1.75% is 413bps from the FB peer median 5.88% (n=18) |
| city-union-bank-limited | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while PVB banks median +0.25pp — possible senior/general column swap |
| city-union-bank-limited | fcnr | anomaly | — | — | — | unrecognised currency 'YEN' |
| city-union-bank-limited | fcnr | anomaly | — | — | — | unrecognised currency 'YEN' |
| city-union-bank-limited | fcnr | anomaly | — | — | — | unrecognised currency 'YEN' |
| city-union-bank-limited | fcnr | anomaly | — | — | — | unrecognised currency 'YEN' |
| city-union-bank-limited | fcnr | anomaly | — | — | — | unrecognised currency 'YEN' |
| coimbatore-district-central-co-opertive-bank-ltd | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while DCCB banks median +0.50pp — possible senior/general column swap |
| cooperatieve-rabobank-ua | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| cooperatieve-rabobank-ua | nre | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| cooperatieve-rabobank-ua | regular | anomaly | — | — | — | rate 3% is 208bps from the FB peer median 5.08% (n=28) |
| cooperatieve-rabobank-ua | regular | anomaly | — | — | — | rate 3.25% is 207bps from the FB peer median 5.32% (n=21) |
| cooperatieve-rabobank-ua | regular | anomaly | — | — | — | rate 3.25% is 263bps from the FB peer median 5.88% (n=18) |
| credit-agricole-corporate-and-investment-bank | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| csb-bank-limited | regular | anomaly | — | — | — | rate 5% is 150bps from the PVB peer median 6.5% (n=18; outside IQR fence) |
| cuddapah-district-co-operative-central-bank-ltd | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while DCCB banks median +0.50pp — possible senior/general column swap |
| cuttack-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| dahod-urban-co-op-bank-ltd | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while NSUCB banks median +0.50pp — possible senior/general column swap |
| davanagere-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| dbs-bank-india-limited | nre | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| dcb-bank-limited | regular | anomaly | — | — | — | rate 8% outside plausible band [3.25, 7.75] around repo 5.25% for PVB |
| deccan-merchants-co-op-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| dehradun-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | effective_date older than 6 months relative to pack.generated_at |
| dehradun-district-central-co-operative-bank-ltd | regular | anomaly | — | — | — | median senior premium 0.00pp (~0/negative) while DCCB banks median +0.50pp — possible senior/general column swap |
_…293 more truncated._

## Top gains (140 total, showing 30)

| bank_code | variant | baseline | new | delta | detail |
|---|---|---|---|---|---|
| indusind-bank-limited | gift | 0 | 72 | NEW |  |
| churu-central-co-operative-bank-ltd | — | 0 | 43 | NEW | new bank added |
| canara-bank | fcnr | 30 | 68 | +126.7% |  |
| uco-bank | nro | 16 | 37 | +131.3% |  |
| doha-bank-qpsc | fcnr | 13 | 33 | +153.8% |  |
| indian-overseas-bank | regular | 14 | 34 | +142.9% |  |
| south-indian-bank-limited | nre | 11 | 31 | +181.8% |  |
| hanumangarh-kendriya-sahakari-bank-ltd | — | 0 | 15 | NEW | new bank added |
| rbl-bank-limited | nre | 5 | 20 | +300.0% |  |
| canara-bank | nro | 23 | 37 | +60.9% |  |
| malda-district-central-co-operative-bank-ltd | — | 0 | 14 | NEW | new bank added |
| uco-bank | nre | 7 | 21 | +200.0% |  |
| indore-premier-co-operative-bank-ltd | regular | 8 | 21 | +162.5% |  |
| the-adilabad-district-co-operative-central-bank-ltd | regular | 0 | 12 | NEW |  |
| the-punjab-state-co-operative-bank-ltd | regular | 12 | 24 | +100.0% |  |
| cuddapah-district-co-operative-central-bank-ltd- | — | 0 | 11 | NEW | new bank added |
| prakasam-district-co-operative-central-bank-ltd- | — | 0 | 11 | NEW | new bank added |
| the-boudh-co-operative-central-bank-ltd | — | 0 | 11 | NEW | new bank added |
| canara-bank | nre | 23 | 32 | +39.1% |  |
| indusind-bank-limited | nre | 5 | 14 | +180.0% |  |
| karur-vysya-bank-limited | regular | 19 | 28 | +47.4% |  |
| shamrao-vithal-co-operative-bank-ltd | regular | 17 | 26 | +52.9% |  |
| vidyasagar-central-co-operative-bank-ltd | — | 0 | 9 | NEW | new bank added |
| wardha-district-central-co-operative-bank-ltd | — | 0 | 8 | NEW | new bank added |
| bangalore-district-and-bangalore-rural-district-co-op-central-bank-ltd | regular | 0 | 7 | NEW |  |
| chamoli-zilla-sahakari-bank-ltd | — | 0 | 7 | NEW | new bank added |
| chandrapur-district-central-co-operative-bank-ltd | — | 0 | 7 | NEW | new bank added |
| federal-bank-limited | regular | 13 | 20 | +53.8% |  |
| the-nalgonda-district-co-operative-central-bank-ltd | — | 0 | 7 | NEW | new bank added |
| zila-sahkari-bank-ltd-garhwal-kotdwar | — | 0 | 7 | NEW | new bank added |

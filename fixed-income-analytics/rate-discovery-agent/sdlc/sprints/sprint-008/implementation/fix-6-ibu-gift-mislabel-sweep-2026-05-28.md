# Fix — IBU bare-vs-gift mislabel sweep (2026-05-28)

**Bug:** an IBU's GIFT data sat in a bare `<slug>_rates.json` whose own `variant` field said "gift", but the pack slots by filename → it shipped as the **regular (domestic) variant**. 12 IBUs affected; GIFT foreign-currency rates appeared as domestic INR FD. Root cause: `build-pack` slotted by filename, not the `variant` field.

## Durable guard
`pack/build-pack.js#buildVariant` now returns null for a `regular`-slot file whose own `variant !== 'regular'` **and** whose slabs carry a `currency` — refuses to ship GIFT/FCNR rates as domestic FD. A no-currency odd label (e.g. `bank-of-china-limited` variant `corporate`, no currency = genuine domestic FD) is deliberately left alone.

## Data moves (no data lost)
Per-bank, picking the freshest/fullest GIFT copy:

| Action | Banks | Why |
|---|---|---|
| **Promote** bare→`_gift`, empty bare | canara-ibu (bare newer + adds EUR/GBP vs USD-only stale `_gift`), bank-of-baroda-ibu (bare eff 05-19 vs `_gift` 03-16) | bare was the better copy |
| **Relabel** bare→new `_gift`, empty bare | kotak-ibu (55), state-bank-of-india-ibu (16), standard-chartered-ibu (8) | no `_gift` existed; guard would otherwise drop their only data |
| **Empty bare**, keep `_gift` | axis, hsbc, idbi, indian-bank, rbl (`_gift` canonical/newer) | `_gift` already correct |
| already fixed | punjab-national-bank-ibu (prior commit) | |
| **excluded** | bank-of-china-limited (`corporate`, no currency — domestic FD, not gift) | not a gift mislabel |

0-slab bare files (anz, barclays, bnp, citi, dbs, hdfc, idfc, mizuho, yes, …) need no action — empty variants are dropped by build-pack and the guard covers them.

## Verified
- Rebuilt pack: **0 banks ship a currency-bearing `regular` variant** (was 12); **18 gift variants** (was 15 — kotak/sbi/standard-chartered now correctly gift); canara gift now USD/EUR/GBP; pnb gift USD/EUR; none of these have a regular variant.
- `npm test` green (1 known playwright fail / 44 skip); `check-write-discipline` clean.

## Follow-on
- bob-ibu: the promoted bare (45 slabs, 5 cur × 9 tenures) has fewer tenure rungs than the old `_gift` (65 = 5 × 13) but is 2 months fresher — a re-extract could restore both freshness and granularity.
- bank-of-china-limited `corporate` variant — minor labeling oddity (ships as regular; harmless), left as-is.

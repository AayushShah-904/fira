# Fix category 2 — thin / garbled own-domain ladders (2026-05-27)

The 6 banks the Phase-3 truncated-ladder check flagged that were NOT aggregator-sourced. Resolved via 4 Tier-2 discovery agents + 2 direct product-type fixes.

| Bank | Type | Outcome |
|---|---|---|
| tumkur-veerashaiva | NSUCB | **Re-extracted** from own `tvcbltd.bank.in` → 5 slabs (prior rows were garbled run-on text; dropped the 0% no-interest band; special >₹15L tier kept as `deposit_range=above_15l`). Senior +0.50% per note. |
| the-rajkot-district | DCCB | **Recovered** the 3 missing long-tenure rungs → 6 slabs (was 3, missing 180d / 1-2y / 2-3y). Senior +0.50%. eff 2023-04-03. |
| thanjavur-central | DCCB | **Not an error** — the bank publishes a single headline FD rate (8.25% / 8.50% senior), no tenure ladder. Prior 1-slab was correct. Truncated-ladder = false positive (see below). |
| vysya-coop-tumkur | NSUCB | **Quarantined** — no own website; distinct bank (IFSC UTIB, Axis-sponsored) wrongly mapped to tumkur-veerashaiva's `tvcbltd.bank.in`. rate_slabs=[]. |
| india-post-payments (IPPB) | PB | **Quarantined FD** — payments banks can't offer FDs; the 2 "FD" slabs were savings-balance tiers (2% / 2.25%) mislabeled. rate_slabs=[]. |
| nsdl-payments | PB | **Quarantined FD** — same: savings tiers (1.5% / 5%) mislabeled as FD. rate_slabs=[]. |

Net: 2 genuinely fixed, 1 false-positive confirmed correct, 3 quarantined (1 wrong-domain + 2 wrong-product).

## Wrong-domain + wrong-product bug classes found

- **Shared domain** (same class as Sprint-007 nasik-on-nadia): vysya-coop and tumkur-veerashaiva both pointed at `tvcbltd.bank.in`. `tvcbltd` IS tumkur-veerashaiva's site; vysya was mis-mapped and had no own site → quarantined.
- **Wrong product**: both payments banks shipped savings-account balance tiers as FD slabs. Payments banks (RBI) accept only demand deposits ≤ ₹2 lakh, no term deposits → FD variant emptied.

## Applied + verified

`tmp/apply-cat2-fixes.js` via `safeWriteArtifact` (rates + registry), `extraction_method='manual_transcription_from_rendered_text'`. Registry repointed (vysya/IPPB/NSDL → `discovery_status` no_website / no_fd_product).

- Global `truncated_ladder` count: **13 → 1** (only thanjavur).
- `npm test`: 1181 pass / 1 known-fail / 44 skip.

## Known residual false-positive

**thanjavur-central** still trips `truncated_ladder` (1 slab, null tenure) because the check can't know the bank genuinely publishes a single headline rate. It is correct data. At ship time it needs either an operator sign-accept or a check refinement (e.g. exempt `discovery_status='single_headline_rate'`). Logged as a follow-on; not auto-suppressed (the gate surfacing it is working as designed).

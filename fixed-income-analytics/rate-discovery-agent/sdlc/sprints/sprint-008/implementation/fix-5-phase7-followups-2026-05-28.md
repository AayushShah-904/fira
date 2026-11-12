# Phase-7 follow-ups: open items 2/3/4 + repo-anchor activation (2026-05-28)

Operator approved the repo rate (5.25%, eff 2026-04-08) → repo anchor active. Activation surfaced a calibration issue (false positives) and the operator directed fixes a/b/c/d.

## (a) slice-SFB 13.78% — real bug, fixed
slice's PDF extraction produced a bogus `"1 Year" → 13.78%` slab (parse artifact) alongside the correct `"12 months 1 Day to 18 months"` ~7.25-7.5% rows. Dropped the 13.78% slab (38→37). Full PDF re-extract recommended later (duplicate 12m1d rows remain).

## (c) thanjavur — durable exemption
`ladderPlausibility` now returns null when **no slab has a parsed tenure_max** — a bank publishing a single headline FD rate with no per-tenure ladder (thanjavur) can't be assessed for truncation. Generalizes beyond thanjavur; real truncations (which have parsed tenures) still fire. Added a unit test. Global `truncated_ladder`: now **0** on the fresh pack.

## (b) repo spreads — widened (operator-directed)
Repo was cut to 5.25% but Indian FD rates lag, so the original tight high-side spreads false-flagged normal rates (PSB 6.5%, SFB/co-op 8-9%). Widened `spreads_by_bank_type` high side (PSB +1→+2, PVB +2.5, SFB +3.5, co-ops +4.0, FB ±4.0, etc.). Result on the fresh pack: blocking `rate_reasonableness_outlier` **17 → 2**, both genuine:
- `ab-bank-plc` FB 1y **12%** (implausibly high for a foreign bank's INR FD).
- `model-co-operative-urban-bank` NSUCB 2-3y **9.5%** (just over the 9.25 co-op ceiling — borderline; operator review).

(39 peer + 6 historical + 5 repo WARNs remain as non-blocking triage, mostly the high-variance FB category.)

## (d) pnb-ibu — stale duplicate removed + systematic IBU finding
pnb-ibu's `_gift_rates.json` was already current (eff 2026-05-01, USD >9-12M 4.20 — confirmed by a live re-extraction). The stale value (4.10) lived in a **bare `_rates.json` that the pack slotted as the *regular* variant** (GIFT data mislabeled as domestic FD). Emptied it → the bogus regular variant is gone; the current gift variant remains.

**Systematic finding (new):** **12 IBUs have the same bare-vs-gift mislabel** — a bare `_rates.json` (variant field says "gift") that the pack reads as "regular" because the filename lacks the `_gift` suffix, so GIFT rates ship as domestic FD: axis-ibu, bank-of-baroda-ibu, canara-ibu, hsbc-ibu, idbi-ibu, indian-bank-ibu, rbl-ibu (with slabs) + barclays/hdfc/idfc/mizuho-ibu (empty bare). Root cause: build-pack slots by filename, not the `variant` field. **Recommended follow-on:** a dedicated sweep — for each, verify the `_gift_rates.json` is canonical/complete, then empty (or relabel) the bare file; and/or harden build-pack to honor the `variant` field. NOT bulk-fixed here to avoid data loss without per-bank verification.

## Verified
- `node --test tests/checks/*` → 32/32. `npm test` green (1 known playwright fail / 44 skip).
- Fresh pack (`npm run build-pack`): truncated_ladder 0; blocking outliers 2 (both genuine); pnb-ibu regular variant absent.

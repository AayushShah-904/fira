# Brief — blob-shrink review hand-off (2026-07-08)

## The ask (5-minute read to start)

We reconciled our local rate data into the cloud blob (source of truth for the rate
pack). For **20 rate files**, the local copy and the cloud copy disagree by more than
50% in slab count, and the automation deliberately left them for a human to decide. We
need you to pick, per file, **KEEP BLOB** or **RESTORE LOCAL**.

## Why they differ (one line)

Most are pre-safe-write clobbers — a thin HTML re-scrape overwrote a rich PDF/manual
ladder (e.g. Axis local 54 slabs from the June-13 rate-card PDF vs blob 2 slabs from the
HTML teaser page). Two (canara) are genuinely ambiguous. Full reasoning in
`REVIEW-GUIDE.md`.

## Scope & priority

- **13 of 20 are NRI-relevant** (NRE/NRO/FCNR/GIFT) — these feed the PM's NRI pack, so
  they matter most. **7 are domestic-only** — lower priority.
- **None of this blocks today's PM pack.** It ships fine from current blob state (quality
  gate PASSES, +12.43%, 0 regressions). These are *quality upgrades* — restoring the
  clobbered ladders makes ~13 banks richer in a **future** pack. Handle async, no rush.

## What to do

1. Open **`DECISIONS.md`** — a checklist of all 20 with slab counts and a recommendation
   per row. Fill in the DECISION column.
2. For anything not obvious from the sheet, compare the paired **`local/<file>`** and
   **`blob/<file>`** copies (and open the live `source_url` if still unsure).
3. Commit `DECISIONS.md` with your calls.
4. Apply each **RESTORE LOCAL** with the one-line `az` upload in `REVIEW-GUIDE.md §How to
   apply`. KEEP BLOB decisions need no action.

## Files in this folder

| File | Purpose |
| --- | --- |
| `BRIEF.md` | This note |
| `DECISIONS.md` | The 20-case checklist to fill in (start here) |
| `REVIEW-GUIDE.md` | Detailed how-to-decide + how-to-apply reference |
| `comparison.json` | Per-case data (currencies, tenors, rate range, dates, URLs, method) |
| `local/`, `blob/` | The two candidate versions of each file, side by side |

Questions on any specific case — ping me; the sprint-011 context is fresh.

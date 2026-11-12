# Blob-shrink review — 20 cases (2026-07-08)

**For:** whoever picks up the blob-state reconciliation review.
**Owner decision needed on:** 20 rate files where the local copy and the cloud
blob copy disagree by more than 50% in slab count. The automated seeding
(`scripts/azops/seed-latest-from-local.js --scope all`) deliberately did **not**
touch these — every other file was reconciled automatically. These 20 need a
human to pick which version is correct.

## Why these exist

Two independent causes produced big local-vs-blob slab-count gaps:

1. **Pre-rule-4 clobbers (most cases).** Before safe-write rule 4 shipped
   (2026-07-07), a thin re-extraction could overwrite a rich ladder. The blob
   carries some of those scars. Example: `axis-bank-limited_rates.json` — local
   is **54 slabs from the 13-June rate-card PDF**, blob is **2 slabs scraped
   today from the HTML teaser page** (`/deposits/fixed-deposits/fd-interest-rates`).
   The HTML page only shows a headline rate; the PDF is the real ladder. This is
   a clobber → the local 54-slab version is correct.

2. **Genuine ambiguity (the 2 canara cases).** `canara-bank_fcnr` local is 30
   slabs (clean 5-currency × 6-tenor grid, manual transcription) vs blob 68
   (older, llm_inline_extraction — flagged in the sprint-007 multi-table
   over-extraction analysis as possibly double-counting). Here "more slabs" is
   not obviously "more correct". Canara is WAF-blocked in the cloud, so no
   re-scrape will settle it — this is a real judgment call.

## What's in this folder

| Path | Contents |
| --- | --- |
| `comparison.json` | Per-case summary: slab count, currencies, tenors, rate range, `scraped_at`, `effective_date`, `source_url`, `extraction_method` for BOTH versions |
| `local/<file>` | The local `output/latest/` version (candidate to restore) |
| `blob/<file>` | The current blob version (what a cloud pack would use today) |

`comparison.json` is the fast path — scan it first. Open the paired
`local/`+`blob/` files only when the summary doesn't decide it.

## How to decide each case

For each file, pick **KEEP BLOB** or **RESTORE LOCAL**:

- **Compare `source_url`.** A PDF / rate-card URL almost always carries the full
  ladder; a generic `/fixed-deposits` or `/rates-charges` HTML page is often a
  teaser. If local = PDF and blob = HTML with far fewer slabs → **RESTORE LOCAL**.
- **Compare `extraction_method`.** `manual_transcription_from_rendered_text` and
  PDF extractions are high-trust. `automatic_html_static` with a tiny slab count
  is the classic teaser-clobber → **RESTORE LOCAL**.
- **Check the rate values and tenors** in the paired files. If the smaller set is
  missing whole tenor bands (e.g. only 1–2 year, no 3/5-year) it's a partial
  page → prefer the fuller one.
- **`local newer but shrink of blob` (canara ×2):** here local is the *newer*
  scrape but *smaller*. Decide whether the newer/cleaner grid or the older/larger
  set is right; if unsure, open the `source_url` live and count. Canara can't be
  re-scraped from cloud (WAF), so this decision sticks until the site is
  reachable.

## Recommended dispositions (starting point — verify, don't rubber-stamp)

- **RESTORE LOCAL** for the 18 "blob newer but shrink of local" cases: they match
  the clobber signature (blob is a thinner/newer HTML scrape over a rich PDF or
  manual ladder). Highest-confidence: `axis-bank-limited_rates` (54→2),
  `barclays-bank-plc_rates` (26→5), `citibank-na_nro` (34→1), `mizuho-bank-ltd_nre`
  (22→1), and the five IBU GIFT ladders (hdfc/kotak/idfc/pnb/indusind).
- **OPEN QUESTION** for the 2 canara cases — genuine judgment, see above.

## How to apply a decision

**KEEP BLOB:** do nothing — the blob already has that version.

**RESTORE LOCAL:** upload the local copy over the blob (one file):

```bash
az storage blob upload \
  --account-name stbofiarateagentprod01 --auth-mode login \
  --container-name agent-state \
  --name "output:latest:<file>" \
  --file "sdlc/sprints/sprint-011/review/blob-shrink-2026-07-08/local/<file>" \
  --overwrite true
```

(Or restore several at once with a loop over the approved filenames.) After
restoring, the next cloud run's pack will pick up the corrected data. Record the
dispositions (KEEP/RESTORE per file) in a commit so the decision is auditable —
append a `DECISIONS.md` here or annotate `comparison.json`.

## Note on urgency

None of these 20 block today's NRI pack. The pack builds fine from current blob
state (pre-flight quality gate PASSES, +12.43%, 0 regressions). These are
*quality upgrades* — restoring the clobbered ladders makes ~15 banks richer in a
future pack. Handle async.

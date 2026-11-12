# Fix category 1 — aggregator-sourced banks (2026-05-27)

The Phase-3 truncated-ladder check surfaced **7 banks shipping a single junk slab scraped from `codeforbanks.com`**, a forbidden aggregator (CLAUDE.md non-negotiable #3). Their registry `domain` + `rate_pages.fd` were the aggregator's FD-calculator URL. Fixed via 7 parallel Tier-2 discovery agents.

## Outcome

**5 recovered from the bank's OWN official source** (no aggregators):

| Bank | Source | Slabs | Effective | Notes |
|---|---|---:|---|---|
| amritsar-central (DCCB) | amritsar.pbcoopbank.in | 14 | 2025-06-16 | senior +0.50% (note) for ≥1y |
| ludhiana-central (DCCB) | ludhiana.pbcoopbank.in | 9 | 2023-04-06 | official but **stale**; senior null |
| sangrur-central (DCCB) | sangrur.pbcoopbank.in | 9 | 2025-11-06 | printed senior; dropped a Provident-Fund row |
| godavari-urban (NSUCB) | godavaribank.com | 5 | null | read via bank's own Wayback snapshot (live site JS-WAF) |
| sardar-vallabhbhai (NSUCB) | sardar.bank.in | 7 | 2025-10-01 | RBI `.bank.in`; printed senior ≥1y |

The Punjab DCCBs sit on the Punjab State Cooperative Bank umbrella (`<district>.pbcoopbank.in`) — the cooperative structure's own portal, not an aggregator.

**2 quarantined — no own website exists** (rate_slabs=[], so they drop from the pack):
- `erode-co-operative-urban-bank` — no site (distinct from Erode DCCB).
- `the-amravati-merchants` — no site (IFSC `YESB…` sponsor-bank model).

## How applied

`tmp/apply-aggregator-fixes.js` (gitignored, one-off) wrote each rate file via `safeWriteArtifact({kind:'rates', source:'operator'})` with `extraction_method='manual_transcription_from_rendered_text'` (CURATED → clobber-protected) + `discovery_metadata.run_method='tier-2'` + a `fixed_from: codeforbanks.com` provenance note and per-bank warnings (computed-senior-from-note, archive source, staleness). The registry was rewritten via `safeWriteArtifact({kind:'registry-file'})` to point at the real sites (quarantined two → `domain:null`, `discovery_status:'no_website'`).

## Verified

- Aggregator scan over all `output/latest`: **0** banks sourced from codeforbanks/any aggregator (was 7).
- `rate-sanity-audit` on the 7: no truncated-ladder / column / bounds issues; only residual flag is ludhiana `stale` (honest — official 2023 page).
- `npm test`: 1181 pass / 1 known-fail / 44 skip (unchanged).

Anti-fabrication: every recovered rate traces to its `source_row_text`; computed senior rates (amritsar, godavari) carry an explicit warning that the +0.50% came from a page note, matching the Sprint-007 senior-premium-from-note practice.

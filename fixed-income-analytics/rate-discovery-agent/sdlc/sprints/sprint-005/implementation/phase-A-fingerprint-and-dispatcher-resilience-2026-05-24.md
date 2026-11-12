# Phase A — Fingerprint + schema extension + dispatcher resilience

**Date:** 2026-05-24
**Design:** `../design/template-fingerprinting.md`
**Plan:** `../plan/sprint-005-scope.md`

## What landed

### A.1 — Fingerprint module

- `lib/templating/fingerprint.js` — `fingerprintPage({ html, url, kind }) → { template_hash, structural_signature, candidate_tables, reason }`
- `lib/templating/_helpers/score-table.js` — lifted `scoreTable()` + `readTableRows()` from `lib/actions/_cheerio_tables.js` into a shared helper so the fingerprint and the future Phase C generic extractor pick the same rate region. The original copy in `_cheerio_tables.js` is intentionally kept during the Phase F stub period so existing call-sites continue to work without coupling to the new path.
- `lib/templating/synonyms.js` — header-cell normalization + canonical-token map (`general → regular`, `sr citizen → senior`, `period of deposit → tenure`, ...).
- `tests/lib/templating/fingerprint.test.js` — 11 tests covering: cluster collision on synthetic WP-themed pages with different rate values; cluster divergence between WP and AEM; domain TLD recognition; header synonym normalization; no-table page stable signature; iframe hint; non-html kinds (pdf-text, image); invalid kind throws; empty html doesn't throw; slab buckets; table-region anchor outscores noise tables.

**Verification:** `node --test tests/lib/templating/fingerprint.test.js` — 11/11 pass.

### A.2 — Schema documentation

- `lib/templating/schema.md` — informative spec for the `template` block in `data/bank-domains.json`. Optional + additive (no migration of existing data in Phase A; that's Phase E). JSON Schema (`schema.json`) deferred to Phase A.3.

No production `data/bank-domains.json` data was modified in Phase A. The schema doc is the source of truth until the JSON Schema lands.

### A.3 — Authoring CLI

**Deferred:** the interactive `scripts/author-template.js` CLI needs the hardened fetch layer from Phase B to be productive (the existing `scripts/fetch_rates_playwright.js` lacks the iframe + retry-escalation + per-bank-wait-condition support that authoring against real banks requires). Authoring will work against captured HTML fixtures starting in Phase A.3, and against live pages once Phase B lands.

This is documented as a Phase A.3 follow-up in the design doc; the fingerprint primitive itself is fully functional and can be exercised against any HTML string today.

### A.4 — Dispatcher resilience for `scraper_type: unknown`

**Scope adjustment from the design doc.** Initial design called for a one-line orchestrator change to attempt `html_static` fetch when `scraper_type` is unknown. Investigation found that `lib/actions/classify_rate_page.js:61-63` already drops unrecognized `cached_kind` values and proceeds with live discovery. The actual Phase 0.2 failure cluster (~31 NSUCB/DCCB banks with `scraper_type: null`) is upstream: those banks were processed via the LLM-agent path (not the orchestrator), wrote stub configs, and the orchestrator was never re-attempted.

The deeper "re-attempt failed banks via orchestrator regardless of legacy LLM-agent state" fix belongs in Phase B alongside the retry-escalation rungs, not in Phase A's dispatcher.

What landed in Phase A.4:

- `tests/lib/actions/classify_rate_page.test.js` — two new regression tests covering the existing resilience to unrecognized `cached_kind` values. These are the gate that protects the resilience under future refactors. Tests cover:
  - `cached_kind: 'unknown'` with a `cached_body` → classifies from body, doesn't abort
  - `cached_kind` ∈ {`'mixed'`, `'government'`, `'manual'`, `'unknown'`, `null`, `''`} all tolerated; tests iterate the full set

**Assumption documented:** the live orchestrator path correctly handles `scraper_type: null` once it's been entered. The 31-bank failure cluster reflects banks that haven't been re-attempted via the orchestrator since adopting the LLM-agent path. Phase B's retry-escalation includes "if no rates produced AND no orchestrator attempt logged for this bank, force-attempt via orchestrator." This is the right place because it shares plumbing with the new fetch escalation rungs.

## Tests

```
$ node --test tests/lib/templating/fingerprint.test.js
# tests 11; pass 11; fail 0

$ node --test tests/lib/actions/classify_rate_page.test.js
# tests 19; pass 19; fail 0
```

Full suite: `npm test` — green (852 pass / 1 skip / 0 fail).

## Files changed

**New:**
- `lib/templating/fingerprint.js`
- `lib/templating/_helpers/score-table.js`
- `lib/templating/synonyms.js`
- `lib/templating/schema.md`
- `tests/lib/templating/fingerprint.test.js`

**Modified:**
- `tests/lib/actions/classify_rate_page.test.js` (+2 tests)

**No production code under `lib/actions/`, `lib/orchestrator.js`, or `data/bank-domains.json` was modified.** Phase A delivers new primitives + tests; integration into the runtime path is Phase B/C work.

## Open follow-ups

| Item | Phase |
|---|---|
| `scripts/author-template.js` interactive CLI | A.3 (after Phase B fetch layer) |
| `lib/templating/schema.json` JSON Schema | A.3 |
| Original `_cheerio_tables.js` `scoreTable()` deletion in favor of the shared helper | F (after extract_html_table.js split) |
| Re-attempt-via-orchestrator for `scraper_type:null` banks | B (alongside retry escalation) |
| Apply fingerprint against real-world captured HTML to validate cluster predictions | A.3 (gated on harvest-golden-html.js) |

## Risks

1. **Synonym map drift** — adding new entries to `lib/templating/synonyms.js` is safe (more banks collapse together), but removing or rewriting entries invalidates prior `template_hash` values. Locked-in entries should be additive-only after Phase E migration begins.
2. **Tag-tree skeleton fragility** — `walkSkeleton()` collapses tag classes via `firstClassPrefix()` regex. If a bank's HTML changes its class naming convention, the hash drifts. Mitigation: the authoring CLI's "reuse existing template_id" step is operator-confirmed, not auto-accepted; an unexpected hash drift surfaces in the operator confirmation flow.
3. **Phase A.4 scope reduction is a documented assumption.** The 31-bank failure cluster is NOT fixed by Phase A; the fix moves to Phase B. Operator should verify this trade-off before Phase E migration begins, since it shifts effort across sprints.

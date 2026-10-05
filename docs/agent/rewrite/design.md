# Design Document — Rate Discovery Agent (v2, clean-slate)

> Status: **Proposal / not yet implemented.** Implements [`functional-spec.md`](./functional-spec.md)
> and [`evaluation-spec.md`](./evaluation-spec.md). Architecture decision (locked with operator):
> **bespoke Node pipeline + direct LLM calls, no agent framework; preserve the v1 orchestrator/stage
> approach unless a strong argument emerges.** Instrument-extensibility stance (locked):
> **generic contracts now, deposit-only implementation** — see
> [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md).

## 1. Architecture overview

A bespoke Node.js pipeline of discrete, testable stages. No LangGraph/Mastra/LlamaIndex — the
framework spike (Sprint 003) was deferred and nothing here needs graph orchestration that plain
functions + a registry don't already give us. The single biggest change from v1 is that **snapshot
capture moves to the front of the pipeline and becomes a hard dependency of extraction**, so every
output is re-checkable by construction.

```
                         ┌──────────────────── data/bank-domains.json (registry, single writer) ───┐
                         │                                                                          │
  cohort ──► [S0 lookup] ─► [S1 find-site] ─► [S2 find-rate-pages] ─► [S3 fetch + SNAPSHOT] ─► [S4 classify]
                                                                              │ snapshot-store           │
                                                                              ▼                          ▼
                                                              [S5 extract: template | llm-propose | ocr/vision]
                                                                              │ (reads snapshot bytes)
                                                                              ▼
                                          [L1 per-slab validate] ─► [L2 structural] ─► [L3 reasonableness]
                                                                              │
                                                                              ▼
                                       write output/latest/<bank>[_variant]_rates.json  (snapshot_ref)
                                                                              │
   ───────────────────────────────────────────────────────────────────────  pack & evaluation  ──────────
                                                                              ▼
   [pack/build-pack] ─► [L4 cross-check] ─► [L5 sampling audit] ─► [L6 golden] ─► [confidence] ─► [gate] ─► publish
```

### Design principle: snapshot-first
1. S3 captures raw bytes into the content-addressed store **before** anything parses them.
2. S5 extractors take a **snapshot handle**, not a URL — they cannot read un-captured bytes.
3. Every `_rates.json` carries `snapshot_ref`. A non-empty slab set without a resolvable ref fails
   Layer 1 (anti-fabrication).
4. All evaluators (L4 cross-check, L5 audit, L6 golden) read snapshots, never live sites — so results
   are deterministic and reproducible.

### Design principle: instrument-aware core, deposit-only implementation
The pipeline is generic over an `instrument_type`; **deposit** is the only one built (the YAGNI
guardrail — no bond logic until a bond sprint). What this means concretely:
1. The **generic core** is instrument-agnostic: discovery loop, snapshot store, the stage runner,
   pack/gate, confidence, signed accepts, human adjudication.
2. Three things are **registered per instrument** and resolved by `instrument_type`: the **extractor
   dispatch**, the **checks registry** (Layer 2/3), and the **observation/identity schema**.
3. Every output envelope and registry entry carries `instrument_type` + `schema_version`, so a future
   instrument (or a schema bump) coexists without breaking consumers.
4. Instrument-specific code lives under an instrument namespace (`lib/instruments/deposit/…`); the
   core never imports a concrete instrument directly — it looks one up via the registry.
See [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md) for the full rationale
and the bond roadmap.

## 2. Module layout

Proposed tree (✚ = new/re-architected in v2, ↻ = reused largely as-is from v1):

```
lib/
  prompts/
    fragments.js ↻          # reads <!-- @fragment NAME --> from docs/agent/*.md (single source of truth)
    build-prompt.js ↻       # assembles per-mode system prompts (discover | expand-nri | rates-only)
  llm/
    provider.js ✚           # unified LLM client: AOAI (tier-1 propose) + Claude (tier-2); retries, cost
    propose-template.js ↻   # LLM proposes {table_index, column_map, extracts[]}
    reextract-prompt.js ↻   # SHARED extraction prompt (primary + cross-check, no fork)
  fetch/
    fetch-html.js ↻         # escalation chain default→stealth→firefox→llm-fallback
    fetch-pdf.js ↻          # PDF download (buffer), text path + routes to OCR
    challenge-detect.js ↻   # WAF/bot/JS-scaffold detection → escalate
    www-self-heal.js ✚      # one host-toggle retry on tableless/sub-1KB fetch
  snapshot/
    snapshot-store.js ↻     # putSnapshot / getLatestSnapshot / readBlob (content-addressed)
    capture.js ✚            # fetch-time hook that every fetch path calls (the new hard dependency)
  instruments/
    registry.js ✚           # instrument plug-in registry: instrument_type → {extractors, checks, schema, identity}
    deposit/ ✚              # the ONLY instrument implemented in v2
      extractors/
        dispatch.js ↻       # pickExtractor({templateId, kind, fingerprint, productContext})
        generic-html-3col.js ↻  # default html_static/html_js; currency cross-product for fcnr/gift
        pdf-rate-card.js ↻  # text-PDF + DocIntel matrix path
        ocr.js ↻            # Azure Document Intelligence (extractViaOcr) for image/scanned PDF
        vision.js ↻         # Claude/vision fallback for image rate cards
      checks/
        slab-validate.js ✚  # Layer 1 (schema, bounds, tenure, traceability) — promoted to first-class
        structural-checks.js ↻  # Layer 2 (classifyTableType, ladderPlausibility, seniorPremiumPeerOutlier, fcnrCurrencySanity)
        rate-reasonableness.js ↻# Layer 3 (peer/repo/history anchors)
        rate-bounds.js ↻    # INR/foreign bounds
      schema.js ✚           # deposit observation schema + identity (bank_code)
    # bond/, gsec/, sgb/ … — FUTURE instruments register here; NOT built in v2 (YAGNI)
  templating/
    fingerprint.js ↻        # template hash for reuse/cluster detection (generic, core)
  confidence/
    score.js ↻              # computeVariantConfidence + tier (verified | needs_review)
  quality-gate/
    signed-accepts.js ↻     # HMAC verify, fail-closed, agent-immune
  registry.js ✚             # single-writer registry access (read hints, persist template+audit, clobber rules)
  slugify.js ↻              # canonical bank_code slug
  orchestrator.js ↻         # per-bank stage runner (S0..S5 + L1..L3), classify-outcome
scripts/
  bulk-author.js ↻          # fleet driver: fingerprint→cluster→propose→extract→gate→persist; --from-report
  audit/
    sample-correctness-audit.js ↻  # Layer 5 (stratified, judge, Wilson CI, worklist, --ingest)
    cross-check-all.js ↻           # Layer 4 (re-extract snapshots, diffSlabs, agreement)
  snapshot/
    backfill-snapshots.js ↻
    backfill-golden-from-snapshots.js ↻
  confidence/build-confidence.js ↻
  macro/propose-repo-rate.js ↻
  analysis/coverage-map.js ↻
bin/
  approve-accept.js ↻       # operator-only signed accept
  approve-macro-rate.js ↻   # operator-only macro approval
data/
  bank-domains.json ↻       # registry
  macro-rates.json ↻        # operator-approved repo metadata (ADR-017)
pack/
  build-pack.js ↻           # aggregate, dedup, bounds-filter, _pack_excludes, emit dist/rates-pack.json
  quality-gate.js ↻         # Layer 6 gate: delta classes + structural findings + signed accepts → verdict
tests/
  extractors/golden.test.js ↻
  golden-html/<bank>.{html,expected.json,expected.meta.json} ↻
  checks/*.test.js ✚        # unit tests per check with fixture slab sets
docs/agent/
  core.md, discovery-workflow.md, nri-gift-ibu.md, schemas.md, field-learnings.md ↻  # single source of truth
output/
  latest/<bank>[_variant]_rates.json, <bank>_config.json, _confidence/, _pack_excludes.json ↻
  snapshots/blobs/, index/, _index.json ↻
```

## 3. The per-bank agent runtime

- **Prompt assembly** keeps the v1 idea that paid off: the playbook lives once in `docs/agent/*.md`
  with anchored `<!-- @fragment NAME -->` sections; `fragments.js` extracts them and `build-prompt.js`
  assembles only the fragments a mode needs (discover ≈ full; expand-nri / rates-only trimmed ~55–60%).
  This avoids the CLAUDE.md↔prompt drift that bit v1.
- **Modes:** `discover`, `expand-nri`, `rates-only` (§ functional 4.2).
- **Action set** (the tools the agent calls): `find_website`, `find_rate_page`, `fetch_page`
  (→ snapshot), `classify_rate_page`, `extract_html_table`, `extract_pdf_table`, `extract_via_ocr`,
  `extract_via_vision`, `commit_config`, `commit_rates`, `commit_to_registry`, `slugify`. Every fetch
  action funnels through `snapshot/capture.js`.
- **LLM provider abstraction** (`lib/llm/provider.js`): one interface, two backends — AOAI for cheap
  Tier-1 template proposals, Claude for Tier-2 assisted retrieval and the cross-check second read.
  Centralises retries, token/cost accounting, and the tool-call budget ceiling.

## 4. Fetch & extraction

- **Escalation chain** (`fetch-html.js`): `default → stealth → firefox → llm-fallback`.
  `challenge-detect.js` flags WAF/bot/JS-scaffold and jumps rungs; `www-self-heal.js` does the single
  host-toggle retry. Template-driven flags (`expand_accordions`, `wait_for_network_idle`) come from
  the registry; aggressive-fetch is the default for templateless gap banks.
- **Snapshot capture** happens for every successful fetch (HTML, PDF, image) — this is the v2 hard
  dependency, wired in `capture.js` and called by all fetch paths.
- **PDF** (`fetch-pdf.js`): download as **buffer**; text path parses the structured JSON envelope from
  the PDF extractor; image/scanned PDFs (sub-200-char text) route to `ocr.js`. DocIntel handles
  matrix/multi-currency cards; vision is the last resort.
- **Extractor dispatch** (`dispatch.js`): if a registry `templateId` exists → that extractor; else if
  kind ∈ {html_static, html_js} → `generic-html-3col`; else → OCR/vision/llm-fallback. The generic
  extractor scores candidate tables, parses via `column_map`, parses tenure to min/max days, dedups,
  and asserts traceability. **Multi-currency cross-product** (`field@range#CUR` column tags) emits
  every currency × tenure cell for fcnr/gift — the v1 fix that stopped USD-only collapses.

## 5. Two-tier orchestration & registry writes

- **Tier 1** (`bulk-author.js`): fingerprint → if another bank in the same run already produced a
  working proposal for the same `template_hash`, reuse it (one LLM call per cluster) → else
  `propose-template` → extract → Layers 1–3 → on PASS persist template + rates with
  `audit{persisted_by, verdict_at, gates}` and `extraction_method: llm_verified`.
- **Tier 2** (Claude agent, separate output area): richer retrieval; writes CURATED
  `extraction_method` + `tier2{…}` hints. Folded into the registry by **one** coordinated writer.
- **Invariants** (enforced in `registry.js`): single registry writer; CURATED methods are
  overwrite-protected; variant-scoped templates (`template_gift`/`template_fcnr`) isolate
  foreign-currency data; richer-wins merge; Tier-2 parallel work never writes the registry directly.
- **Incremental:** `--from-report` re-runs only prior FAIL/REVIEW banks; `--only-buckets` narrows
  further; the shared `classify-verdict.js` buckets results.

## 6. Evaluation implementation (wiring the six layers)

- **L1** (`slab-validate.js`) runs inline in `commit_rates` / extractor output — promoted from a
  scattered v1 concern to one module called on every write.
- **L2/L3** (`structural-checks.js`, `rate-reasonableness.js`) run both inline (per-bank, to set
  `warnings` and block obviously-wrong writes) **and** at the gate (`quality-gate.js pass3`) against
  pack-wide peer stats and macro metadata.
- **L4** (`cross-check-all.js`) runs over snapshots after pack build, before confidence; uses the
  shared `reextract-prompt.js`.
- **L5** (`sample-correctness-audit.js`) runs on demand each cycle; emits the adjudicated error rate +
  CI and the human worklist (`--ingest` folds adjudications back).
- **L6** golden tests run in CI (`npm run test:golden`); `backfill-golden-from-snapshots.js` activates
  new goldens only under the tolerance + clean-structure rule; `--rebaseline` operator-gated.
- **Confidence** (`build-confidence.js`) reads L2–L5 signals → sidecars; opt-in pack emission flag.
- **Macro governance** lives entirely in operator-gated bins; the repo anchor is inert until approved.

## 7. Data contracts & storage

- **Registry** (`data/bank-domains.json`): per-bank `domain`, `rate_pages`, `scraper_type`,
  `discovery_status`, `extraction_method`, `template{template_id, template_hash, fingerprinted_at,
  fetch{}, extract{extractor, extracts[]}}`, `template_gift`/`template_fcnr`, `audit{}`, `tier2{}`.
- **Output** (`output/latest/`): `<bank>_config.json`, `<bank>[_variant]_rates.json` (with
  `snapshot_ref`), `_confidence/<bank>__<variant>.json`, `_pack_excludes.json` (quarantine by
  (bank_code, variant)).
- **Snapshots** (`output/snapshots/`): `blobs/`, `index/`, `_index.json` (§ eval 2).
- **Pack** (`pack/dist/rates-pack.json`): denormalised bundle; dedup identity key = (tenure_text,
  min/max days, deposit_range, currency, general/senior/super rates); bounds-filtered; optional
  confidence fields. History snapshots under `pack/history/` feed L3 + gate deltas.
- **Accepts** (`pack/quality-gate-accepts.json`): `{accepted_regressions[], accepted_anomalies[]}`,
  each operator-HMAC-signed.

## 8. What we deliberately drop from v1

- **Backfilled snapshots as the norm** — v2 captures at fetch time; backfill exists only to seed the
  initial corpus from existing `output/latest/`.
- **Ad-hoc `tmp/` fold scripts** — the merge/clobber logic lives in `registry.js` as tested code, not
  one-off gitignored scripts.
- **Scattered per-slab validation** — consolidated into `slab-validate.js` (Layer 1).
- **Late-bolted confidence** — designed-in from the start; cross-check runs before confidence so
  `verified` always means a real second read agreed.
- **CLAUDE.md / prompt drift** — single source of truth in `docs/agent/*.md` remains the only copy.
- **Any agent-writable accept or approval path** — structurally impossible (operator key only).

**Deliberately NOT built now (YAGNI, despite the generic seam):** bond/other-instrument extractors,
bond-specific checks, market-data/exchange connectors, and an ISIN-scale registry. The
`instrument_type` seam exists so these add as plug-ins later; building them against zero real bond
requirements would be speculative generality. The abstraction is validated against the *second* real
instrument, not invented ahead of it. See
[`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md).

## 9. Migration note (clean-slate, no compat layer)

Since v2 is a clean-slate rewrite, there is no compatibility shim. The only carry-over is **data**:
seed the snapshot store and golden corpus from the existing real artifacts in `output/latest/` and
`output/snapshots/` (per [[feedback_preserve_scraped_artifacts]] — never overwrite the real scraped
data; tests use temp dirs). Registry entries are re-validated against captured snapshots before being
trusted.

## 10. Open questions / risks for the operator

1. **LLM cost of universal cross-check (L4).** Re-extracting every snapshot doubles LLM spend on
   evaluation. Option: cross-check a sampled subset + all needs_review banks, rather than 100%.
2. **Provider mix.** Confirm AOAI-for-Tier-1 / Claude-for-Tier-2 split, or standardise on one.
3. **Confidence emission default.** Flip the pack `confidence_*` fields on for the PM by default, or
   keep opt-in until the PM contract is updated?
4. **Audit cadence & sample size.** What `--n` per stratum and what cycle frequency give an
   acceptable CI width without excessive human-adjudication load?
5. **Repository split.** Per [[project_agent_repo_split]], v2 may live in its own repo — decide before
   investing in the new module tree.
6. **Bond phase prerequisites (future, not v2).** Bond data-source access/licensing (exchange &
   market-data APIs vs the scrape-the-issuer model), the ISIN-scale identity/registry model
   (tens of thousands of instruments), and refresh cadence (intraday/daily bond data vs monthly
   deposits) — see [`vision-coverage-extensibility.md` §7](./vision-coverage-extensibility.md).

## 11. Traceability (functional ↔ evaluation ↔ design)

| Functional requirement | Evaluation criterion | Design component |
|---|---|---|
| No fabrication; snapshot_ref required | L1 traceability; acceptance "zero fabrication" | `snapshot/capture.js`, `checks/slab-validate.js` |
| Correct table (FD not loan/savings) | L2 classifyTableType | `checks/structural-checks.js`, gate pass3 |
| Full ladders | L2 ladderPlausibility | `checks/structural-checks.js` |
| Correct senior rates | L2 seniorPremiumPeerOutlier | `checks/structural-checks.js`, peer stats |
| FCNR/GIFT per-currency, no collapse | L2 fcnrCurrencySanity | `extractors/generic-html-3col.js` (currency cross-product), checks |
| Plausible rate values | L3 reasonableness (peer/repo/history) | `checks/rate-reasonableness.js`, `data/macro-rates.json` |
| Independent verification | L4 cross-check | `scripts/audit/cross-check-all.js`, `lib/llm/reextract-prompt.js` |
| Measured correctness | L5 sampling audit | `scripts/audit/sample-correctness-audit.js` |
| No regressions | L6 golden + gate deltas | `tests/extractors/golden.test.js`, `pack/quality-gate.js` |
| Honest confidence | Confidence score & tiers | `lib/confidence/score.js`, `scripts/confidence/build-confidence.js` |
| Operator-controlled exceptions | Signed accepts, fail-closed | `lib/quality-gate/signed-accepts.js`, `bin/approve-accept.js` |
| INR-only / foreign exclusion | L1 bounds + foreign-source rule | `instruments/deposit/checks/rate-bounds.js`, registry `discovery_status` |
| Explainable no-data tail | Coverage-gap metric | `discovery_status` taxonomy, `scripts/analysis/coverage-map.js` |
| Accommodate future instruments (bonds) | Instrument-agnostic eval framework; per-instrument checks | `instruments/registry.js`, `instruments/deposit/`, `instrument_type`+`schema_version` envelopes |

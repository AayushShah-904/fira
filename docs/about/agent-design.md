# Agent Design — How the Discovery Agent "Thinks"

> Prerequisite: read **[overview.md](overview.md)** first for the whole-system map. This page goes one level deeper on the LLM agent itself — how its prompt is built, how it picks a model, and how the three CLI modes change its behaviour. Siblings: **[architecture.md](architecture.md)** (runtime/control-flow), **[extraction.md](extraction.md)** (turning pages into slabs), **[quality-checks.md](quality-checks.md)** (safe-write, gate, confidence).

---

## 1. Framing

The agent is three things layered together:

1. **A prompt** — assembled per-run from small, anchored fragments that live in `docs/agent/*.md`, never hand-written per call.
2. **A tool loop / orchestrator** — `lib/orchestrator.js` walks a fixed, deterministic action sequence (find website → find rate page → classify → extract → commit) per bank. LLM calls happen *inside* specific actions (`find_website`'s web search, `extract_html_table`'s LLM-fallback, `extract_via_vision`), not as an open-ended chat loop over arbitrary tools.
3. **Model-tier routing** — `lib/tier-router.js` decides, before the run starts, whether to spend on the cheap model or the expensive one, and can flag (observe-only, see §4) when a result looks wrong.

**Historical note worth knowing as you onboard:** an earlier design (documented in `CLAUDE.md` and `docs/agent/*.md`) had Claude itself, or an open-ended Azure OpenAI chat loop (`lib/agent.js`), read the fragments as its system prompt and freely call tools (`fetch_url`, `run_playwright`, `fetch_pdf`, `slugify`, …) to accomplish the task end-to-end. That "LLM path" was retired in Sprint 010 (2026-06-09) — `run-discovery.js` now hard-errors on `--path llm`. **The orchestrator is the only path today.** `docs/agent/*.md` and `CLAUDE.md` remain accurate as the *behavioural contract* (schemas, rules, honesty-about-confidence) and as the literal source the interactive Claude Code agent reads when you run this repo's `CLAUDE.md` directly (`> Discover rates for: <Bank Name>`) — but the automated pipeline now enforces that contract in deterministic Node code, calling out to Azure OpenAI only for the sub-tasks that genuinely need a model (web search for a domain, HTML-table interpretation when the deterministic parser can't handle a page, vision/OCR reading). This is why the prompt-assembly mechanism (§2) still matters: it's the shared single source of truth for *both* the interactive-Claude path and (via the fragment text embedded in orchestrator prompts) the automated path's LLM sub-calls.

---

## 2. The prompt-assembly mechanism (the key thing to understand)

**`docs/agent/*.md` is the single source of truth.** Nothing else should restate its content.

```
docs/agent/*.md                lib/prompts/fragments.js         lib/prompts/build-prompt.js
┌─────────────────────┐        ┌───────────────────────┐        ┌──────────────────────────┐
│ <!-- @fragment X --> │  read  │ frag(file, "X") regex- │  pick  │ buildSystemPrompt(mode,  │
│ ...markdown...       │ ─────► │ extracts text between  │ ─────► │  {bankType, isIBU})      │
│ <!-- @end X -->      │        │ the anchors, verbatim  │        │  → joined prompt string  │
└─────────────────────┘        └───────────────────────┘        └──────────────────────────┘
```

- Each fragment is a named, anchored section: `<!-- @fragment NAME -->` … `<!-- @end NAME -->`. `lib/prompts/fragments.js` reads the five docs, regex-extracts every named section, and exports each as a constant (`IDENTITY`, `RULES_CORE`, `STEP_FIND_WEBSITE`, `RATE_SCHEMA`, …).
- `lib/prompts/build-prompt.js#buildSystemPrompt(mode, ctx)` assembles a subset of those constants into one system-prompt string, selected by `mode` (`"discover" | "expand-nri" | "rates-only"`) and bank context (`bankType`, `isIBU`).
- Prose *outside* the anchors (e.g., discovery-workflow.md's "Step 0 — Check known domains first") is for human/interactive readers only — `fragments.js` never sees it.

**Fragment → doc → mode mapping** (from `docs/agent/README.md`):

| Fragment(s) | Lives in | Read when |
|---|---|---|
| `IDENTITY`, `RULES_CORE` | `core.md` | always — every mode |
| `EFFICIENCY_RULES`, `STEP_FIND_WEBSITE`, `STEP_FIND_RATE_PAGES`, `STEP_SCRAPER_TYPE`, `STEP_EXTRACT_RATES` | `discovery-workflow.md` | discovering a bank end-to-end |
| `LEARNINGS_FROM_FIELD` | `field-learnings.md` | tricky co-op/DCCB sites (multilingual, image-only, umbrella domains) |
| `STEP_NRI_FCNR`, `STEP_GIFT_CITY` | `nri-gift-ibu.md` | NRI/FCNR (PSB/PVB/FB/large-SFB) or GIFT/IBU pages |
| `CONFIG_SCHEMA`, `RATE_SCHEMA`, `OUTPUT_SLUG`, `BANK_TYPE_TABLE` | `schemas.md` | writing config/rate JSON (strict field names), mapping `bank_type` |

`buildSystemPrompt` assembles a **different subset per mode** (see §3 for what each mode does):

| Mode | Fragments included | Approx. token savings vs. full doc set |
|---|---|---|
| `discover` | `IDENTITY` + `EFFICIENCY_RULES` + `LEARNINGS_FROM_FIELD` + `STEP_FIND_WEBSITE` + `STEP_FIND_RATE_PAGES` + (`STEP_NRI_FCNR` if bank type ∈ {PSB,PVB,FB,SFB,IBU}) + (`STEP_GIFT_CITY` if IBU) + `STEP_SCRAPER_TYPE` + `STEP_EXTRACT_RATES` + `CONFIG_SCHEMA` + `BANK_TYPE_TABLE` + `RATE_SCHEMA` + `RULES_CORE` + `OUTPUT_SLUG` | ~25% |
| `expand-nri` | `IDENTITY` + `STEP_NRI_FCNR` + `STEP_EXTRACT_RATES` + `CONFIG_SCHEMA` + `RATE_SCHEMA` + `RULES_CORE` + `OUTPUT_SLUG` | ~56% |
| `rates-only` | `IDENTITY` + `STEP_SCRAPER_TYPE` + `STEP_EXTRACT_RATES` + `RATE_SCHEMA` + `RULES_CORE` + `OUTPUT_SLUG` | ~60% |

`RATE_SCHEMA`, `RULES_CORE`, and `OUTPUT_SLUG` are appended unconditionally to every mode — the output contract and the non-negotiables always apply, regardless of what the agent is doing.

**The editing rule, twice over because it matters:** change a fragment by editing its anchored section inside `docs/agent/*.md`. Never restate the content in `CLAUDE.md` (a lean router — it just *points* at the docs) or in `fragments.js` (mechanical extractor — it has no prose of its own). There is intentionally **no second copy to drift**. `tests/prompts/fragments-docs.test.js` fails the build if an anchor is renamed, removed, or a doc goes missing — that's the safety net that keeps this invariant honest.

---

## 3. The three modes

`run-discovery.js` accepts one bank at a time and a mode flag; the mode selects both the prompt subset (§2) and, inside the orchestrator, which products/URLs are actually visited.

| Mode | CLI flag | What it does | When to use |
|---|---|---|---|
| **discover** | *(default)* | Full pipeline: find website → find every applicable rate page (domestic + NRI/GIFT if the bank type warrants it) → classify scraper type → extract → commit. | First-ever run for a bank, or a full re-discovery after the bank's site structure changed. |
| **expand-nri** | `--expand-nri` | Requires an existing config. Skips website discovery; searches for and extracts NRE/NRO/FCNR (and GIFT for IBUs) pages only. | A bank was discovered domestic-only and you now want its NRI variants without re-running the (already-done) website search. |
| **rates-only** | `--rates-only` | Requires an existing config with known URLs. Re-fetches the *already-recorded* rate page URLs and re-extracts — no new page discovery at all. | Cheap periodic refresh of rates on a bank whose page URLs haven't changed (fastest, lowest tool-call/token cost). |

**The `--rates-only` blind spot:** because this mode never re-runs `find_rate_page`, it is structurally blind to the bank moving or renaming its rate page/PDF. If a bank silently rotates its PDF filename (a real, recurring pattern — see the Axis dated-PDF case in `lib/orchestrator.js`'s hint-fallback logic) or restructures its site, `--rates-only` will either 404 against a stale cached URL or (worse) quietly return zero slabs while reporting a clean run. It trades coverage-safety for cost. Use `discover` or `--expand-nri` periodically even for "stable" banks to catch URL drift; don't run `--rates-only` forever on autopilot. `run-discovery.js` also derives `bank_type` from the existing config if `--category` isn't passed, and `expectedVariantsForBank` (§5) still gates quality on what the bank *should* have — so a `--rates-only` run that silently loses a variant is at least visible in the drift check, even though it can't fetch a fresh URL to fix it.

Mode is passed straight through to `lib/orchestrator.js#orchestrate({ mode, ... })`, which normalises anything other than `"recheck"` to `"discover"` at the action boundary (see `actionMode` in `orchestrator.js`) — `find_rate_page`/`classify_rate_page` only understand `{discover, recheck}`, so `"expand-nri"`/`"rates-only"` behave like `discover` *inside* the orchestrator's per-product loop, but a **cached URL switches that product's effective mode to `recheck`** (HEAD-confirm the cached path first, skip anchor-crawl) — this is the actual mechanism that makes `rates-only` cheap.

---

## 4. Model tiering / cost model

**All LLM calls go through Azure OpenAI** — `lib/azure-openai-client.js` (chat completions, with exponential-backoff retry on 429/500/503) and `lib/azure-openai-responses.js` (the Responses API's built-in `web_search` tool, used for domain/rate-page discovery). This is **not** the Anthropic API; the interactive Claude Code session you're reading this in is a separate thing from what the automated pipeline calls at runtime.

**Two tiers**, named by deployment:
- **Tier 1 — mini** (`gpt-4.1-mini`, env `AZURE_OPENAI_DEPLOYMENT_MINI`): cheap, fast, default for most banks (~70% historically).
- **Tier 2 — full** (`gpt-4.1`, env `AZURE_OPENAI_DEPLOYMENT_FULL`): costlier, used for harder pages.

`lib/tier-router.js#selectInitialTier` / `selectDiscoveryAction` pick the tier **before** any run starts, using cheap heuristics:

- Pre-route to **tier 2** when: `scraper_type` is `html_js` (needs Playwright interpretation), the registry notes mention WAF/CAPTCHA/bot-protection, `mode === "expand-nri"` (multi-page NRI discovery is harder), or the bank is an **IBU** (GIFT City discovery is complex).
- Everything else starts at **tier 1**.
- `RATE_FORCE_TIER=1|2` env var overrides the heuristic (used by `scripts/engine-probe.js` for controlled experiments).

`selectDiscoveryAction` also implements a **skip gate**: if the bank's registry entry (`data/bank-domains.json`) carries a terminal `discovery_status` (`no_website_known`, `website_known_no_rate_page`, `pending_vision`, `foreign_currency_not_inr`) or an operator-curated `extraction_method`, the agent isn't invoked at all — `run-discovery.js` writes a synthetic config/rates/summary from the registry and exits, spending $0. This only applies in `discover` mode; `--rates-only`/`--expand-nri` bypass it so an operator can force a re-run.

**Quality-driven escalation** — `checkQuality(ctx)` runs *after* an attempt and would trigger a retry with the stronger model on:
- 0 rate slabs extracted (unless `scraper_type` is legitimately `"manual"`),
- `extraction_confidence` of `"none"` or `"low"`,
- `scraper_type: "manual"` despite a known domain (unexpected failure),
- **slab drift**: any variant's slab count falling below `driftThreshold` (default 0.8) × `max(prior run's count, operator-curated floor, or a default-1 "expected" for any variant the bank type should produce)`. This is what caught the AU SFB cloud regression (23→12 slabs, still self-reported "high confidence").

**As of Sprint 010, `checkQuality` is observe-only for the orchestrator path** — `run-discovery.js` calls it once per run and logs a `[METRIC] slab_drift` line (feeding KQL) but does **not** retry: the orchestrator is deterministic, so re-running the same template against the same page would reproduce the same result — retrying only made sense against the old LLM chat-loop's run-to-run variance. The escalation logic (tiers, drift thresholds) still lives in `tier-router.js` and still gates the *initial* tier choice; it just no longer drives an automatic second attempt.

**Cost accounting** — `lib/cost-tracker.js#createCostTracker(model)` accumulates input/output tokens and per-model pricing (env-overridable `AZURE_OPENAI_{MINI,FULL}_{INPUT,OUTPUT}_PRICE_PER_1M`), plus Azure Document Intelligence OCR pages at `$0.01/page` (`AZURE_DI_LAYOUT_PRICE_PER_PAGE`). The orchestrator's `llm_usages` and `ocr_pages` are drained into the tracker after each run (`run-discovery.js`'s `runOrchestratorAttempt`), and every per-bank `*.summary.json` carries `total_cost_usd`, `input_tokens`, `output_tokens`.

---

## 5. The orchestrator's role

`lib/orchestrator.js#orchestrate(input)` is **deterministic Node code**, not an LLM loop — per the Sprint 003 decision (Q13) that the LLM should be invoked only *inside* specific actions, never as the control flow itself. Fixed sequence per bank:

1. `find_website` (may itself call the Azure OpenAI Responses API's web-search tool)
2. `commit_to_registry` (persist the discovered domain)
3. For each **product** the bank is expected to offer:
   a. `find_rate_page` → b. `classify_rate_page` → c. extract via the kind-appropriate action (`extract_html_table` / `extract_pdf_table` / `extract_via_vision` / `extract_via_ocr`) → d. `commit_rates`
4. `classify_outcome`

**Which products a bank is expected to offer** — `productsForBank(bankType, bankCode)`:
- **IBU**: `['fd_gift']` only — no domestic FD, no retail NRI.
- **PSB / PVB / FB**, or an **SFB in the `LARGE_SFBS` allowlist** (AU, Equitas, Ujjivan, IDFC First, Bandhan): `['fd', 'fd_nre', 'fd_nro', 'fd_fcnr']`.
- Everyone else (co-op families, RRB, PB, LAB, small SFB): `['fd']` only.

`expectedVariantsForBank` maps this same policy to variant names (`regular`/`nre`/`nro`/`fcnr`/`gift`) and is what `run-discovery.js` feeds into `checkQuality`'s drift gate as the "this bank type should have ≥1 slab here" default (§4) — the mechanism that catches a silent domestic-only ship for a bank that should also have NRI variants.

Two refinements worth knowing:
- **`configuredProductsFromHints`** (Sprint 011 item 18): a registry entry's explicit `rate_pages.<product>` URL or an `extraction.<key>.fulfills_product` hint is authoritative regardless of bank-type policy — this is how a bank whose `bank_type` resolution failed (no `category` in the registry) still gets its curated FCNR/NRE/NRO URLs visited.
- **`--variant <name>`** (`only_products` on the orchestrator input) lets an operator target a single product for a focused refresh, bypassing bank-type policy entirely.

A **"variant coverage guarantee"** post-pass (Phase 3.5) retries any product that ended the main loop with zero committed slabs, directly invoking the PDF/OCR extractor against a resolved hint or cached URL — belt-and-braces against a single flaky pass losing an entire variant.

---

## 6. The behavioural contract: no fabrication, honest confidence

This is the one rule everything else in this doc exists to serve, and it is enforced in layers, not just stated in a prompt:

- **In the fragments themselves** — `RULES_CORE` (`core.md`) and `RATE_SCHEMA` (`schemas.md`) are appended to *every* mode's prompt unconditionally (§2): "never invent numbers," "if zero parseable slabs, write `rate_slabs: []` with `extraction_confidence: "none"` and a warning," "be honest about confidence."
- **In the deterministic write path** — `lib/safe-write.js` (ADR-012) refuses to let a fresh extraction silently clobber a better one: never overwrite curated files, never overwrite non-empty with empty, reject garbage, and divert a <50%-of-established-ladder extraction to a `.pending.json` sidecar instead of overwriting. This is enforcement independent of whatever the model claims about its own confidence.
- **In the quality/drift gate** — `checkQuality` (§4) doesn't trust a self-reported "high confidence" when the slab count itself has silently dropped.
- **In the pack-level gate** — `pack/quality-gate.js` blocks publish on a >10% global slab loss or a >50% loss on any high-confidence baseline bank; the only way past it is a human-signed accept (`bin/approve-accept.js`), never an agent-writable file.
- **In `extraction_confidence` itself and its downstream use** — ADR-016's composite `confidence_score`/`confidence_tier` (`verified` vs `needs_review`) turns per-variant honesty into something the pack can expose to the PM, rather than a value that just sits unused in a JSON file.

See **[quality-checks.md](quality-checks.md)** for the full detail on safe-write, the quality gate, confidence scoring, and signed accepts.

---

## 7. Pointers

**`docs/agent/`** (all five files; `README.md` is the index):
- `core.md` — `IDENTITY` + `RULES_CORE`; loaded in every mode.
- `discovery-workflow.md` — efficiency budget, finding the website, finding rate pages, classifying scraper type, extracting rates. Step 0 (registry pre-check) is human-only prose, not a fragment.
- `field-learnings.md` — `LEARNINGS_FROM_FIELD`; tricky co-op/DCCB sites (multilingual, image-only, umbrella domains).
- `nri-gift-ibu.md` — `STEP_NRI_FCNR` + `STEP_GIFT_CITY`; NRI/FCNR and GIFT-City/IBU discovery.
- `schemas.md` — `CONFIG_SCHEMA`, `RATE_SCHEMA`, `OUTPUT_SLUG`, `BANK_TYPE_TABLE`; the strict field names downstream code depends on.

**ADRs:**
- **ADR-014** (shared validation package) — rate/tenure/format validation consolidated into one shared package (`packages/shared/src/validation/`, CJS-ported for the agent) so the agent's write-gate, the refresh pipeline's sanity-gate, and the DB-import validators can't silently disagree on what's a valid rate.
- **ADR-016** (confidence scoring & tiered publication) — the composite `confidence_score`/`confidence_tier` referenced in §6, gated behind `FIRA_EMIT_CONFIDENCE`.

**Siblings in this guidebook:** [overview.md](overview.md) (whole-system map), [architecture.md](architecture.md) (runtime/control-flow), [extraction.md](extraction.md) (HTML/PDF/vision → rate slabs, the rate schema in depth), [quality-checks.md](quality-checks.md) (safe-write, quality gate, confidence, signed accepts).

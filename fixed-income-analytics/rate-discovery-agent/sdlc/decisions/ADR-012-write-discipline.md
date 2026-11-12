# ADR-012: Centralized write path + required provenance for per-bank artifacts

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — centralized `lib/safe-write.js` + required `extraction_method` field + default-to-merge norm + pending-sidecar routing. Aligned with existing `scraper_type` axis from `scripts/extract_rates.js` and the BIRD pipeline in `packages/scraper/`. |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-12 |
| Date decided | 2026-05-12 |
| Sprint | 002 (addendum to #5) |
| Supersedes | — |

## Context

Sprint 002 Phase B (2026-05-11) exposed a class of silent-data-loss bugs:

1. **`lib/domain-cache.js`'s `updateDomainEntry`** rebuilt registry entries with only `notes`, `status`, `domain_source` preserved — silently dropping operator-curated fields (`extraction_method`, `rate_pdfs`, `confidence`, `last_discovered_at`, `discovery_status`). After the Phase B re-run, four operator-touched registry entries (agra-zilla, bhatinda, indore-premier, nizamabad) lost their curated metadata.

2. **`run-discovery.js`'s copy-to-latest** copied agent-produced files into `output/latest/` unconditionally. Angul's 12 manually-transcribed FD slabs were overwritten with a 0-slab "extraction failed" rates file. The agent re-discovered the same JPG-image rate page that still can't be auto-extracted, and clobbered the operator's transcription.

Both were patched (commit `6ae6c6e`), but the patches are reactive — they fix the destructive paths I observed. The class of bug extends to any future writer that doesn't merge defensively. Other writers exist (`pack/publish.js`, `cloud/sync.js`, the agent's `write_file` tool, the slug-guard's correction path) that haven't been audited. New writers added by future sprints inherit the same risk.

The deeper issue is architectural: **there is no single sanctioned write path for per-bank artifacts, and no required provenance schema.** Each writer has its own merge logic (or lack of it). Operator-curated data has no schema-level marker that says "do not overwrite without operator say-so."

Without an explicit decision, future code edits will continue to silently destroy curated data. Each incident requires forensic recovery from git history (which only works if the data was committed first — uncommitted manual transcriptions are unrecoverable).

## Spec being decided

The proposal has three parts. All three together form the canonical write discipline; partial adoption leaves doors open.

### Part A — One write path: `lib/safe-write.js`

All writes to per-bank artifacts route through `lib/safe-write.js`. "Per-bank artifacts" means:

- `output/latest/<slug>_config.json`
- `output/latest/<slug>_rates.json` and variants (`_nre_rates.json`, etc.)
- `output/latest/<slug>.summary.json`
- `data/bank-domains.json` entries (the per-bank object inside the map)
- Future: any new per-bank artifact added by later sprints

NOT in scope:
- Per-run directory writes (`output/runs/<label>/`) — these are immutable audit artifacts; overwrite collisions are not a real concern.
- Pack outputs (`pack/dist/rates-pack.json`) — derived; can always be rebuilt from `output/latest/`.
- Logs, traces, batch-result indexes — operational by-products.

The helper signature:

```js
safeWriteArtifact({
  path,           // absolute target path
  incoming,       // the new value (object or string)
  kind,           // 'config' | 'rates' | 'summary' | 'registry-entry'
  source,         // who's writing — 'agent' | 'operator' | 'classifier' | 'skip-gate' | ...
  force = false,  // explicit override flag (ergonomic; not the default)
})
  → { wrote: bool, deferredToPending: bool, reason?: string }
```

Behavior:
1. Read `path` if it exists.
2. If existing record has `extraction_method` matching a curated value (see Part B) AND `source !== 'operator'` AND `force === false` → **do not overwrite**; route the incoming value to `<path>.pending.json` instead and return `{ wrote: false, deferredToPending: true }`.
3. Otherwise, write `path` atomically (write-temp + rename, to avoid partial writes).
4. For `kind: 'registry-entry'`, the helper handles read-merge-write of the whole `bank-domains.json` map and does the per-entry curated check internally.

Every existing writer is migrated:

- `lib/domain-cache.js`'s `updateDomainEntry` → calls `safeWriteArtifact({ kind: 'registry-entry', source: 'agent', ... })`.
- `run-discovery.js`'s copy-to-latest → calls `safeWriteArtifact` per file, with `source: 'agent'` for the agent-run path and `source: 'skip-gate'` for synthetic skip outputs.
- `lib/agent.js`'s `write_file` tool → calls `safeWriteArtifact` for any path under `output/`.
- `lib/slug-guard.js`'s `correctBankCodeInPlace` → calls `safeWriteArtifact` (slug corrections are agent-source by definition).
- Manual operator scripts (one-offs that transcribe rates) → call `safeWriteArtifact({ source: 'operator', force: true })` to make the operator-write explicit.

A pre-commit hook (or CI grep) refuses commits that add a `fs.writeFileSync` call with a path under `output/latest/` or `data/bank-domains.json` outside of `lib/safe-write.js`. Mechanical enforcement so the funnel can't be bypassed by mistake.

### Part B — Required `extraction_method` schema field

`extraction_method` is a separate axis from the existing `scraper_type` field. The two coexist:

- **`scraper_type`** — describes what the source page **IS**: `html_static` / `html_js` / `pdf` / `mixed` / `manual` / `government`. Used by the deterministic extractor at `scripts/extract_rates.js` for parser routing.
- **`extraction_method`** — describes the extractor that **produced** the current rates artifact: which path (auto vs manual), which family, which version of the dispatcher.

Their relationship is many-to-one: a `pdf` scraper_type page can be extracted via `automatic_pdf` (pdf-parse), `manual_image_transcription` (if it's actually a scanned image), or `pending_vision` (if awaiting a Vision API pass). Both fields stay; this ADR formalizes only the second.

Every per-bank artifact MUST carry `extraction_method`. Allowed values:

| Value | Maps to scraper_type | Source | Auto-overwriteable by agent? |
|---|---|---|---|
| `automatic_html_static` | `html_static` | agent → extract_rates.js HTML path | Yes |
| `automatic_html_js` | `html_js` | agent → extract_rates.js Playwright path | Yes |
| `automatic_pdf` | `pdf` | agent → extract_rates.js PDF path (pdf-parse) | Yes |
| `automatic_mixed` | `mixed` | agent → extract_rates.js mixed path (HTML then PDF) | Yes |
| `automatic_div_table` | `html_js` | agent → Playwright rendered-text fallback (L13) | Yes |
| `automatic_text_lines` | `html_js` | agent → Playwright rate-line fallback | Yes |
| `llm_inline_extraction` | any | LLM agent extracted inline from a fetched page without invoking extract_rates.js | Yes |
| `registry_skip` | `manual` | skip-gate synthetic | Yes |
| `manual_image_transcription` | `manual` | operator (typed from JPG/PNG rate card image) | **No** |
| `manual_transcription_from_rendered_text` | `html_js` | operator (typed from rendered div-table when extractor missed) | **No** |
| `manual_pdf_transcription` | `pdf` | operator (typed from a scanned PDF page) | **No** |
| `manual_data_entry` | `manual` / `government` | operator (typed from branch contact / phone / paper) | **No** |
| `pending_vision` | any | operator (rate page is image — awaiting Vision API integration) | **No** |
| `pending_ocr` | `pdf` (scanned) | operator (PDF is scanned image, awaiting OCR) | **No** |
| `stale_needs_refresh` | any | operator (explicit "please re-extract on next run") | Yes — opt-in refresh signal |

**Why this list and not a smaller set:** the auto-overwriteable values double as routing hints. The classifier already reads `extraction_method` to bucket banks (L9/L10/L11 in agent-learnings.md). Future workflow orchestrators (deterministic extractor, Vision API path, multilingual extractor) check this field to route. Making it the canonical "which extractor produced this" tag is consistent with how it's already being used informally.

The schema validator in `safeWriteArtifact` rejects writes that don't tag `extraction_method`. Lazy migration: untagged existing artifacts get `llm_inline_extraction` on first re-write (the safest default since that's what the LLM agent's exploratory path produces today — see "Why the deterministic extractor is underused" below).

### Aside — why the deterministic extractor at `scripts/extract_rates.js` is currently underused

`scripts/extract_rates.js` already dispatches by `scraper_type` with dedicated parsers for `html_static` / `html_js` / `pdf` / `mixed`. The LLM agent in `lib/agent.js` is supposed to produce a config (with selectors, column_mapping, rate page URLs) that `extract_rates.js` can consume deterministically — separation of concerns: agent does exploratory discovery, extractor does routine parsing.

In practice the LLM agent does inline extraction during discovery (via `fetch_url` + `run_playwright` + `fetch_pdf` tools, parsing tables in-prompt) rather than handing off a config to the deterministic extractor. Reasons:
- Selectors are hard to predict for unknown sites; the LLM extracts adaptively.
- `run-pipeline.js` calls `run-discovery.js` (LLM path) by default; the deterministic path runs only via `run-extract-only.js` for already-discovered banks.
- The LLM's prompt is end-to-end (discover → extract → classify → write); breaking it back into discover-only would require prompt restructure.

This ADR doesn't change that flow — `llm_inline_extraction` is a first-class `extraction_method` value. The workflow-orientation question explored separately may revisit the split.

### How this ties to the BIRD pipeline at `packages/scraper/`

The parent BIRD repo has `packages/scraper/cli/pipeline.ts` running a multi-step downstream workflow: change-detection → re-extraction-trigger → import-with-validation → staleness-audit. Each step is a discrete module (`change-detector/`, `import/`, `validators/`).

`extraction_method` on each artifact is consumed by:
- **`packages/scraper/src/import/import-discovery.ts`** — the import layer reads the field and tags the DB record's provenance. Already partly supported; this ADR makes it required upstream.
- **`packages/scraper/src/change-detector/`** — when detecting changes, the detector decides whether to re-trigger discovery. Curated artifacts (`manual_*`, `pending_*`) should skip auto-re-triggering even when the source page hashes differ.
- **`packages/scraper/src/validators/staleness.ts`** — staleness checks should treat operator-curated data with a longer expiry than auto-extracted data (operator confirmation is stronger signal than yesterday's HTML scrape).

None of these consumer changes are blockers for this ADR; the field flows through `import-discovery.ts` already as an optional metadata field on the agent config. Making it required upstream just means the consumers can rely on it.

### Part C — Default-to-merge as a behavioral norm

Across all update functions: start with `existing` as the base, spread it, override only specific fields the new run produced. **Never list fields to preserve** (opt-in preservation is the silent-loss anti-pattern); **always list fields to override** (explicit overwrite is auditable).

This is a code-review checklist item, not a new module. Existing `updateDomainEntry` is the template (fixed in `6ae6c6e`).

## Options considered

### Option 1: All three parts (RECOMMENDED)

Implement A + B + C. The funnel is mechanical (Part A), the schema is checked (Part B), and the merge pattern is canonical (Part C). Pending-sidecar routing handles the collision case without operator tooling — files just accumulate at `<file>.pending.json` until an operator merges them in (manually for now; UI in Sprint 003+).

**Pros:** strongest protection. Future writers can't accidentally bypass. Schema rejects ambiguous artifacts at the source. Aligns with ADR-011's pending-changes pattern for `bank-domains-pending.json`.

**Cons:** ~2 days of code work. Migration touches 5+ writer call sites. Operator-side process change: when an operator writes manual data, they call the script with `force: true` explicitly.

### Option 2: Part A + B only, route refusals to errors (not pending sidecar)

Same as Option 1 but skipping the pending-sidecar routing. Refused overwrites throw an error and the agent run logs the conflict. Operator manually inspects and decides.

**Pros:** simpler. No pending-files to manage. Loud-failure is easier to reason about than quiet-defer.

**Cons:** any conflict aborts the agent run for that bank — even though the existing curated data is fine to keep. Wastes the discovery work. Operator has to manually unblock.

### Option 3: Part B + C only — required provenance + merge discipline; no centralization

Make `extraction_method` required, default-to-merge in every update function. No central helper.

**Pros:** lightest touch. ~half-day of work.

**Cons:** the funnel doesn't exist, so future writers can still skip provenance checks unless reviewers catch it. Loss-of-discipline regression is one PR away. The centralization (Part A) is what makes the policy enforceable.

### Option 4: Lighter still — Part C only

Just adopt the merge norm; no schema requirement, no central helper. Tests catch regressions.

**Pros:** no infrastructure work.

**Cons:** the bug we hit yesterday was a classic case of "the merge function thought it was preserving everything; it wasn't." Code review didn't catch it. Tests for the destructive path didn't exist. Norm + tests are necessary but not sufficient.

### Option 5 (out of scope for this ADR): full workflow framework rewrite

Move discovery + extraction + classification into Airflow DAGs or a LangGraph agentic flow. Address the deeper concern that we're managing all of this with ad-hoc Node scripts.

**Why out of scope here:** this ADR addresses the *write discipline* class of bug. Workflow-framework adoption is a separate strategic question being explicitly held for a follow-up reflection turn. The two are compatible — if/when we move to a workflow framework, the safe-write helper still applies and gets called from inside framework tasks.

## Recommendation

**Option 1 — A + B + C.** It's the only option that makes the policy enforceable (Part A's funnel), explicit (Part B's required schema), and culturally embedded (Part C's merge norm). The pending-sidecar routing reuses ADR-011's pattern, so we're consistent across artifact types — registry conflicts go to `bank-domains-pending.json`, rates conflicts go to `<slug>_rates.pending.json`.

Cost is ~2 days of agent-side code work, well-scoped (the call sites are enumerable). Risk is low — the migration is mechanical and tests catch regressions.

## Consequences if accepted

- New module: `lib/safe-write.js`. Centralizes the write policy in ~150 lines.
- `lib/domain-cache.js`, `run-discovery.js`, `lib/agent.js` (write_file tool), `lib/slug-guard.js`: migrated to use `safeWriteArtifact`.
- Schema validator in `safeWriteArtifact` requires `extraction_method`. Existing artifacts that lack it get tagged with `automatic_html` (or the closest match) on first re-write — lazy migration.
- New convention: `<artifact>.pending.json` files accumulate when curated data is at the target. ADR-011's pending-changes operator tooling expands to cover rates pending files in the same workflow.
- Pre-commit hook (or CI step): refuses commits that add a `fs.writeFileSync` to `output/latest/**` or `data/bank-domains.json` outside `lib/safe-write.js`.
- Tests: every existing writer gets a "non-destruction" test asserting curated artifacts survive an agent re-run. ~5-8 new tests.
- Operator runbook update: manual-transcription scripts call `safeWriteArtifact({ source: 'operator', force: true })` rather than `fs.writeFileSync`. The session that just landed manually-transcribed rates for Angul + Nizamabad becomes the template.

## Open questions

1. **Should the pre-commit hook be a hard block or a warning?** Hard block is more reliable but creates friction for legitimate one-offs (e.g., a quick test fixture). Warning gives wiggle room but slowly erodes the discipline. *Lean toward hard block with an explicit `--allow-direct-write` escape for tests.*

2. **Atomicity of `bank-domains.json` writes.** The file is a single map of all banks; an agent run touches one entry. Today we read-merge-write the whole file. Risk: concurrent agent runs (per ADR-010 last-writer-wins is accepted, but the lost-update window is wider than per-bank artifacts). Should `safeWriteArtifact` use file locking for `bank-domains.json`? *Probably yes — `proper-lockfile` or similar — but a separate small decision.*

3. **What about pack/publish.js?** It reads from `output/latest/` and writes to `pack/dist/`. The destination isn't a per-bank artifact; the source IS. If pack reads from latest and the operator has curated rates in latest, the pack already gets them. No write policy needed at the pack layer. *Confirmed out of scope.*

4. **Skip-gate's `source` tag.** When the skip-gate synthesises outputs, it writes with `source: 'skip-gate'`. Is that the same as `source: 'agent'` for overwrite-policy purposes? *Yes — the skip-gate is just an agent-side optimization; it shouldn't override curated data either. Same rules.*

5. **Migration timeline for legacy artifacts.** ~6700 existing `bank-domains.json` entries don't have `extraction_method`. Lazy migration (tag on next write) is simplest, but means the field is non-uniform for some time. Acceptable per ADR-011's lazy-migration pattern for confidence/notes_history fields. *Defer to first-write tagging.*

## Decision log

- 2026-05-12 — Drafted PROPOSED.
- 2026-05-12 — DECIDED by Samir Joshi. Option 1 accepted. Reconciliation added between `extraction_method` (this ADR) and the pre-existing `scraper_type` axis used by `scripts/extract_rates.js` — the two are orthogonal (page-shape vs extractor-used) and both stay. Aside added on why the LLM agent currently bypasses the deterministic extractor (`llm_inline_extraction` becomes the first-class value covering that path). Tie to `packages/scraper/` downstream consumers (`import-discovery.ts`, `change-detector/`, `validators/staleness.ts`) documented — they already read the field as optional; this ADR makes it required upstream so they can rely on it. Sprint 002 #5 addendum tracks the implementation work.

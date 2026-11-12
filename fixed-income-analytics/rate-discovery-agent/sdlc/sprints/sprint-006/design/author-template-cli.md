# Step 1 — Template authoring CLI (Phase A.3)

**Sprint:** 006
**Step:** 1
**Status:** Design — to be implemented in Step 1d.
**Predecessor:** `sdlc/sprints/sprint-005/design/template-fingerprinting.md` (Phase A.3 was deferred from Sprint 5 because it needed the hardened fetch layer)

## Context

Sprint 5 shipped `lib/templating/fingerprint.js` but deferred the authoring CLI because authoring against real banks needed the hardened fetch layer that Phase B (Step 1a-1c above) now provides.

The authoring CLI is what the operator runs per bank to:
1. Fetch the rate page via the new `lib/fetch/fetch_html.js`
2. Compute a fingerprint
3. Suggest a `template_id` (reuse an existing one if the hash matches) OR LLM-propose selectors + column_map on a cluster miss
4. Persist a `template` block to `data/bank-domains.json` via `lib/safe-write.js` after operator confirmation

It is the ONLY path that writes `template` blocks. The agent never auto-writes.

## Goals

- Single CLI: `node scripts/author-template.js <bank-code> [--variant regular] [--from-url <url>] [--reuse-template <id>] [--write]`
- Reuse path: when the fingerprint hash matches an existing template_id, suggest reuse with `[y/N]` operator confirmation
- LLM-propose path: when no match, send rendered HTML + candidate tables to AOAI via `lib/prompts/author-template.md`, parse the structured-JSON response, replay through the deterministic extractor, print the diff vs prior baseline (from `tmp/baseline-pre-reset/`)
- `--write` persists via `lib/safe-write.js`; the agent NEVER auto-persists

## Non-goals (out of scope)

- Bulk authoring of all 50 pilot banks in one run — the CLI is one-bank-at-a-time, operator-driven
- Modifying `lib/templating/fingerprint.js` (Sprint 5 shipped; stable)
- Cloud-side authoring (Sprint 7)

## Files modified / created

**Created:**

- `scripts/author-template.js` — the CLI
- `lib/prompts/author-template.md` — LLM prompt for selector + column_map proposal
- `tests/scripts/author-template.test.js` — integration tests (CLI invocation under controlled env)

**Modified:**

- None. Uses existing `lib/templating/fingerprint.js`, `lib/safe-write.js`, `lib/fetch/fetch_html.js` (new from Step 1a), `lib/extractors/dispatch.js`, `scripts/utils/slugify.js`.

## CLI surface

```
node scripts/author-template.js <bank-code> [options]

Options:
  --variant <name>        Variant to author (regular | nre | nro | fcnr | gift). Default: regular.
  --from-url <url>        Override URL from data/bank-domains.json
  --reuse-template <id>   Skip fingerprint match; reuse this template_id (operator-overrides)
  --propose               Run LLM-propose flow even if fingerprint matches an existing template
  --write                 Persist to data/bank-domains.json (default: dry-run, prints diff only)
  --accepts <path>        Override accepts file path (for testing)
  --help                  Show usage

Refusal checks (mirrors bin/approve-accept.js):
  - Exit 11 if running under an AI agent (CLAUDECODE, CURSOR_*, etc.) WITHOUT --propose-only
    (Reading the operator key for HMAC is not needed here, so the bar is lower than
    approve-accept; --propose mode is safe for agents because it never writes.)
  - --write requires TTY; exit 12 if not.
```

Refusal logic: agent-mode invocations can do everything EXCEPT `--write`. This is intentional — the LLM-propose flow is exactly what the agent CAN do well, and the operator review is the trust boundary, not the proposal itself.

## Flow

1. **Resolve bank** — `slugify(<bank-code>)`, load `data/bank-domains.json[<bank-code>]`. Error if missing.
2. **Resolve URL** — `--from-url` override OR `rate_pages[variant-to-key-map[variant]]`.
3. **Fetch** — `fetchHtml({url, templateFetch: bank.template?.fetch || {}, log})`. If `status !== 'success'`, print diagnostics and exit.
4. **Snapshot** — write fetched HTML to `tmp/author/<bank>/<variant>.html` (safe-write-exempt — diagnostic).
5. **Fingerprint** — `fingerprintPage({html, url, kind: 'html'})`.
6. **Cluster lookup** — scan `data/bank-domains.json` for any bank whose `template.template_hash === fingerprint.template_hash`. If found AND `--reuse-template` not set:
   - Print "Hash matches template_id=<id> used by N other banks: <bank1>, <bank2>, ..."
   - Print the proposed `template.extract.column_map` from the matched template
   - Replay through `pickExtractor({templateId: <matched-id>}).extract({html, templateExtract})`
   - Print extracted slabs + diff vs `tmp/baseline-pre-reset/<bank>_rates.json`
   - Prompt `Use existing template_id "<id>"? [y/N]`
7. **LLM propose** (only on cluster miss or `--propose`):
   - Build prompt from `lib/prompts/author-template.md` template + rendered HTML chunks (use `_cheerio_tables.js#extractTableChunks` to size-cap)
   - Call AOAI via existing `lib/azure-openai-client.js`
   - Parse strict-JSON response: `{template_id_suggestion, table_selector, header_row, column_map, click_to_reveal?, wait_hints?, reason}`
   - Replay through `_generic-html-3col.js` (Step 3a) with the proposed `column_map`
   - Print extracted slabs + diff vs baseline
   - Prompt `Use proposed template_id "<suggested>"? [y/N]`
8. **Persist** — if `--write` AND operator confirmed:
   - Build `template` block per `lib/templating/schema.md`
   - Read current `data/bank-domains.json`, deep-merge `bank.template = {...}`, write via `safeWriteArtifact`
   - Print `[METRIC] template_persisted bank=<code> template_id=<id> variant=<variant>`

## Verification

### Unit tests

- `scripts/author-template.test.js` — runs the CLI via `child_process.spawn` (same pattern as `tests/bin/approve-accept.test.js`). 8 tests:
  - `--help` exits 0 with usage
  - Dry-run against a captured HTML fixture (no fetch — `--from-url file://...`) — prints fingerprint, suggested template, exits 0
  - Cluster-match reuse flow: synthetic bank-domains.json with one existing template_id, fingerprint matches, operator `y` → would write but `--write` not passed so prints diff only
  - `--write` refused without TTY (exit 12)
  - Agent invocation without `--write` succeeds (proposes only)
  - Agent invocation WITH `--write` exits 11
  - LLM-propose flow with mocked AOAI returning structured JSON → replay extracts ≥1 slab
  - `--reuse-template` skips fingerprint match — operator override

### Integration smoke (manual, post-merge)

Operator runs against 3 banks from the pilot 50:
- `apna-sahakari-bank-ltd` — should reuse the existing `coop-bankin-3col-tenure-general-senior` template, no LLM call
- `state-bank-of-india` — should be a cluster miss (no PSB template yet); LLM proposes new template_id `psb-pdf-rate-card-3col` (assuming Step 3a has shipped that extractor)
- `axis-bank-limited` — should be a cluster miss; LLM proposes new template_id `pvb-multi-variant` or similar

## Risks and assumptions

1. **The LLM may propose a column_map that doesn't validate.** Mitigation: the replay step catches this — if extracted slabs is empty, the operator sees that immediately and rejects.

2. **`--write` racing with concurrent edits to bank-domains.json.** Mitigation: `safeWriteArtifact` uses atomic-write (write to .tmp + rename); if the file has changed between read and write, the second writer fails loudly.

3. **The fingerprint may collide on unrelated pages (false-reuse).** Mitigation: operator confirmation `[y/N]` with explicit display of which other banks use that template — operator can say no.

4. **AOAI cost during authoring.** Bounded — one call per cluster-miss bank in the pilot 50. Estimate <$5 total for the sprint.

## Open follow-ups

- Bulk authoring helper script `scripts/author-template-bulk.js` that loops over a list of banks with `--reuse-template <id>` for known same-template families (Sprint 7 if needed)
- HAR replay support for `--from-har` (Sprint 7)

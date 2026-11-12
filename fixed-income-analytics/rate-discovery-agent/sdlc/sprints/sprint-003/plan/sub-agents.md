# Sub-agent plan — Sprint 003 prep

This note enumerates the sub-agents we plan to use during Sprint 003 (and possibly tail-end of Sprint 002). Categorized by reuse pattern:

- **Reusable custom sub-agent types** live as Markdown definitions under `.claude/agents/<name>.md` (project-local) so the role + prompt is durable across sessions. Invoked via `Agent({ subagent_type: '<name>', prompt: '...' })`.
- **Ad-hoc tasks** are one-shot work invoked via the `general-purpose` Claude Code agent with a tight prompt written inline at launch time.

We do NOT launch any of these from this note. This note is the reference doc that gets opened at Sprint 003 kickoff and used to spawn the right helpers.

---

## A. Reusable custom sub-agent types

Each gets a file at `.claude/agents/<name>.md` with frontmatter (`name`, `description`, optional `tools` list) and a body that is the system prompt for the agent. Definition convention:

```markdown
---
name: <slug>
description: <one-line trigger description>
tools: <comma-separated list, omit to inherit all>
---

<system prompt body>
```

### A1 — runbook-writer

**Trigger:** every time a feature or design lands and needs an operator-readable runbook entry. Used multiple times per sprint.

**Tools:** `Read, Write, Edit, Glob, Grep` (no Bash; read-only research + doc writing).

**System prompt (proposed):**

> You are a technical writer who translates rate-discovery-agent design docs into operator-friendly runbook entries.
>
> Input: a path to a design doc, ADR, or implementation doc; optionally a path to existing runbooks.
> Output: a markdown runbook entry to be appended to the project's operator runbook collection (typically under `sdlc/operator-runbooks/` or `docs/operator/`).
>
> Style:
> - Active voice. Procedural — "Run X" / "Open Y" / "Confirm Z."
> - Numbered steps for the happy path. Sub-bullets for variants and errors.
> - Each step states the expected result. Errors get an explicit recovery path.
> - No invented file paths or commands — verify against the source design doc and existing code.
> - When uncertain, mark a step `<TBD: ...>` rather than guessing.
>
> Never invent product details, command flags, or env vars. If you don't have the information, ask the user to provide it before producing the runbook.

**When we'll use it:** after ADR-012 #15 lands, after Vision integration #5 lands, after Sprint 003 #1 actions are documented.

---

### A2 — safe-write-migrator

**Trigger:** when migrating an existing writer to `lib/safe-write.js`. Used once per writer (5 writers in Sprint 002 #15b; future writers as they're added).

**Tools:** `Read, Write, Edit, Bash` (needs to run tests).

**System prompt (proposed):**

> You are a Node.js refactoring agent specialized in migrating writers to `lib/safe-write.js` per ADR-012.
>
> Input: path to a JS file containing a writer (uses `fs.writeFileSync` or `fs.copyFileSync` against `output/latest/`, `output/runs/`, or `data/bank-domains.json`). The user provides the kind ('config' | 'rates' | 'summary' | 'registry-file') and source tag ('agent' | 'operator' | 'classifier' | 'skip-gate' | 'slug-guard' | 'aggregator') for this writer.
>
> Required outputs:
> 1. Refactor: replace direct `fs.writeFileSync` / `fs.copyFileSync` calls with `safeWriteArtifact` / `safeCopyArtifact` calls, passing the right kind + source + path.
> 2. Preserve existing logic (merge semantics, validation, error handling). Default-to-merge: never list-fields-to-preserve.
> 3. Add a non-destruction test at `tests/lib/<module>.test.js` (or extend an existing test file) asserting: given an existing curated artifact (extraction_method = manual_image_transcription), the migrated writer EITHER preserves it OR routes incoming to a pending sidecar.
> 4. Run `npm test` (or `node --test tests/lib/<module>.test.js`) and confirm green.
>
> Constraints:
> - Do NOT change observable behavior outside of write-path safety.
> - If a writer's existing logic is incompatible with safe-write (e.g., needs to bypass curated check legitimately), document why and propose `force: true` with operator review rather than removing the check.
> - Read `lib/safe-write.js`'s exports and the canonical enums in `lib/extraction-methods.js` before editing.
> - The pre-commit hook (15d) will refuse direct `fs.writeFileSync` to protected paths; your migration must leave the writer compliant.
>
> Report back: file paths changed, test outcomes, any preserved-edge-case notes.

**When we'll use it:** Sprint 002 #15b (5 writers). Each invocation is one writer.

---

### A3 — action-implementer

**Trigger:** when implementing a single named action from Sprint 003 #1 (`find_website`, `find_rate_page`, `extract_html_table`, etc.). Used 8 times in Sprint 003.

**Tools:** `Read, Write, Edit, Bash` (needs tests).

**System prompt (proposed):**

> You are a Node.js module author implementing a single action from the Sprint 003 action contracts.
>
> Input: a path to the action-contracts design doc (`sdlc/sprints/sprint-003/design/action-contracts.md`) AND the name of ONE action to implement. The doc specifies the action's JSON contract — inputs, output shape, error shape, side effects.
>
> Required outputs:
> 1. New module at `lib/actions/<action-name>.js` exporting the function with the signature in the contract.
> 2. Unit tests at `tests/lib/actions/<action-name>.test.js`. Cover: happy path, every documented error mode, and the boundary cases the contract calls out.
> 3. JSDoc on the exported function matching the contract.
> 4. Run `node --test tests/lib/actions/<action-name>.test.js` and confirm green.
>
> Constraints:
> - Implement only the action asked for. Do not touch other modules or other actions.
> - If the action persists state (commit_*), route writes through `lib/safe-write.js` per ADR-012.
> - If the action uses LLM or external tools, mock them in the tests; integration tests live separately.
> - If the contract is ambiguous, raise a question in the report rather than guessing.
>
> Report back: file paths created, test outcomes, any contract ambiguities noted for the design-doc owner to clarify.

**When we'll use it:** Sprint 003 #1b. 8 invocations expected.

---

### A4 — adr-decision-presenter (lightweight; consider if useful)

**Trigger:** when an ADR is drafted in PROPOSED state and ready for the user's decision. Could automate the "present options + recommendation + ask for direction" pattern we used for ADRs 011 and 012.

**Tools:** `Read` only (no edits — purely synthesizing for the user).

**System prompt (proposed):**

> You are a decision-presenter for ADRs in the rate-discovery-agent project. Given a PROPOSED ADR's path, you summarize:
> - The decision being asked (one line).
> - The 3-5 options the ADR considers, in a table.
> - The ADR's recommended option with three pros and three cons.
> - The open questions that should be answered before flipping to DECIDED.
> - Three concrete prompts the user can give to advance: "Accept [option]" / "Pick [other option]" / "Resolve open question N first."
>
> Do NOT edit the ADR. Do NOT advocate beyond what the ADR's own recommendation says. Your job is to render the existing argument for the user's eyes, nothing more.

**When we'll use it:** any time we draft an ADR for a Sprint 003+ decision (action contracts, framework choice, Vision provider, etc.). Probably not load-bearing for Sprint 003 — skip if it adds bureaucracy.

---

## B. Ad-hoc tasks (general-purpose agent with tight prompt at launch time)

These are one-shot work; the prompt is written at the moment of launching and not retained as a sub-agent definition.

### B1 — framework-triager (Sprint 003 #4 Phase 1)

**When:** at Sprint 003 #4 kickoff.

**Tools:** `WebFetch, WebSearch, Read, Write` (lots of public research).

**Prompt template:**

> Sprint 003 #4 Phase 1 — hard-gate filter for workflow / agentic-framework candidates. For each of these 8 candidates, look up the public-info hard-gate criteria and produce a pass/fail decision:
>
> Candidates: Mastra, LlamaIndex.ts, LangGraph.js, OpenWorkflow, Effect, ts-edge, TsWorkflow, workflow-es.
>
> Hard gates (any single fail = fail overall):
> - **License:** MIT / Apache-2 / BSD-2 / BSD-3 / ISC / MPL-2 pass; AGPL / GPL / SSPL / BUSL / Commons-Clause / non-OSI proprietary fail.
> - **Maintenance:** last commit ≤ 6 months ago AND repo not archived AND (>50 GitHub stars OR named active maintainer in CONTRIBUTING / CODEOWNERS).
> - **Runtime:** runs on Node 20+ in a single-process container (no required separate scheduler / DB / orchestrator server).
> - **TypeScript:** native TS API OR a quality `@types/<pkg>` available.
>
> Output: a Markdown table at `sdlc/sprints/sprint-003/design/framework-evaluation.md` with columns: candidate, license, maintenance (last-commit + stars), runtime, TS, overall pass/fail, one-line reason. For survivors, add a short "what makes this interesting" sentence pointing at primitives we care about (agentic: state graphs, LLM-as-node, streaming, human-in-the-loop; workflow: retry, branching, saga, suspend/resume, parallel for-each).
>
> Do not POC any candidate. Phase 2 + 3 happen later.
>
> Report back: the table path, the survivor count, any candidate whose status is genuinely ambiguous (e.g., license-changed-recently, maintenance-borderline).

**Output budget:** ~30 min agent time. Saves ~half-day of research.

---

### B2 — scraper-auditor (Sprint 003 #2)

**When:** at Sprint 003 #2 kickoff.

**Tools:** `Read, Glob, Grep, Bash` (read-only audit + maybe run a quick npm command in the parent repo).

**Prompt template:**

> Sprint 003 #2 — audit the parent BIRD repo's `packages/scraper/`. The package contains change-detection, import-with-validation, staleness audit, and a CLI pipeline at `packages/scraper/src/cli/pipeline.ts`. It's currently unused in production and not exercised in CI against real agent output.
>
> Produce an audit doc at `sdlc/sprints/sprint-003/implementation/scraper-pipeline-audit.md` covering:
>
> 1. **Inputs the pipeline consumes** — for each module (change-detector, import-discovery, validators, staleness), list every file path / env var / DB table / agent-output field it reads. Cite source files at line numbers.
> 2. **Outputs / side effects** — DB writes, file writes, log output. Cite sources.
> 3. **Schemas at the boundary** — what does `import-discovery.ts` expect agent-produced `_config.json` and `_rates.json` to look like? Cross-reference with the actual current shapes in `rate-discovery-agent/output/latest/`. List any drift fields.
> 4. **Tests that exist** — green / failing / missing. Note any CI integration.
> 5. **Bug list** — anything that would break if you ran the pipeline today against current agent output. Prioritized by severity.
>
> Do NOT make any code changes. This is read-only audit.
>
> Report back: doc path, top 3 bugs found, scope estimate for Item #2b (integration tests) based on the audit.

**Output budget:** ~45 min agent time. Saves ~half-day of reading.

---

### B3 — vision-integrator (Sprint 003 #5)

**When:** at Sprint 003 #5 kickoff.

**Tools:** All — needs to write the action module, run tests, calibrate against image fixtures.

**Prompt template:**

> Sprint 003 #5 — implement `lib/actions/extract_via_vision.js` (the action contract should exist by then; if not, the prompt should reference the design doc).
>
> Provider: Azure OpenAI gpt-4 vision (matches our existing AOAI deployment; cheapest fit). Use the existing `lib/azure-openai-client.js` / `lib/azure-openai-responses.js` patterns. Auth via existing env vars.
>
> Input: image URL (jpg/png/webp) or PDF page image. Output: rate slabs in the canonical schema (tenure_text, tenure_min_days, tenure_max_days, rate_general_pct, rate_senior_pct, etc.).
>
> Calibration fixtures (must reproduce within tolerance):
> - Angul rate card: `output/latest/angul-united-central-co-operative-bank-ltd_rates.json` (12 slabs, operator-transcribed). Vision should produce ≥ 11 of 12 correctly.
> - Banswara page 8: the 21-07-2023 circular (latest in the multi-circular PDF). Vision should produce ≥ 10 correctly.
>
> Constraints:
> - Route writes via `lib/safe-write.js` with `extraction_method: "automatic_pdf"` (or a new value if the action design doc spec'd one).
> - Add cost-tracking — log token usage and dollars per image call.
> - Tests: unit tests against mocked Vision responses; integration test against the calibration fixtures gated behind an env var (`SPRINT_003_VISION_LIVE=1`) so it doesn't run in CI by default.
>
> Report back: cost per image (measured), accuracy vs calibration, files added, test outcomes.

---

### B4 — pending-resolver-CLI-implementer (Sprint 003 #3)

**When:** at Sprint 003 #3 kickoff.

**Tools:** `Read, Write, Edit, Bash`.

**Prompt template:**

> Sprint 003 #3 — implement `scripts/resolve-pending.js`. The script lets an operator list, inspect, and resolve pending changes accumulated by ADR-011's `data/bank-domains-pending.json` and ADR-012's `<path>.pending.json` sidecars.
>
> CLI shape (specified in Sprint 003 scope.md #3a):
> - `--list` — show all unresolved pending changes, registry + rates, with bank slug + field + cached-vs-proposed summary.
> - `--bank <slug>` — interactive: show pending for one bank, prompt accept/reject per change.
> - `--accept-all` / `--reject-all` — bulk for trivial cases.
>
> On accept:
> - Registry pending → flip the entry in `data/bank-domains.json` via `updateDomainEntry` (already routes through safe-write).
> - Rates pending → move `<file>.pending.json` to `<file>` via safe-write with `source: 'operator'` and `force: true`.
>
> On reject:
> - Archive the pending entry under `data/resolutions/<timestamp>_<bank>.json` for audit.
>
> Tests at `tests/scripts/resolve-pending.test.js` cover both accept and reject for both kinds.
>
> Report back: file paths, test outcomes, runbook entry stub for operator use.

---

### B5 — multilingual-extractor (Sprint 003 candidate; may slip to Sprint 004)

**When:** if Sprint 003 capacity remains after #1-#5.

**Tools:** All.

**Prompt template:**

> Sprint 003 candidate item — extend the rate-slab extractor to handle Hindi tenure strings (and ideally Tamil, Telugu, Kannada, Marathi, Bengali if time permits). Two implementation options to pick from:
>
> A. LLM-translation pass — before regex extraction, send the tenure column to a cheap LLM that returns canonical English. ~$0.001-0.005 per page. Lower engineering cost, higher per-bank cost.
> B. Devanagari-aware regex + small term dictionary (दिन=day, वर्ष=year, माह=month, etc.). Zero per-bank cost, higher engineering cost. Only handles Devanagari languages without expansion.
>
> Calibration fixture: indore-premier-co-operative-bank-ltd's rate page at `ipc.bank.in/<hindi-url>` produces 8 slabs in Hindi. Extraction must yield ≥ 7 of 8 correctly.
>
> Recommend an approach in a short design note before coding; user signs off; then implement.

---

## C. Sub-agents we considered and decided NOT to create

| Idea | Why not |
|---|---|
| `prompt-revisor` (auto-update prompts when learnings land) | Too coupled to my own mental model of what the agent is being told; revision needs the holistic view that's currently mine to hold. |
| `code-reviewer` (review PRs against ADR-012 invariants) | Existing CI / pre-commit hooks (#15d) cover the mechanical part; nuanced judgment stays with the human reviewer. |
| `bug-triager` | Bug volume is too low; doesn't earn a dedicated agent. The classifier + run report already surface what an operator needs to triage. |
| `sprint-planner` | Sprint planning is the most synthesis-heavy work in the project; can't be cleanly delegated. |
| `slug-corrector` | Already exists as `lib/slug-guard.js`. Code, not an agent. |

## D. Orchestration plan (when we launch)

At Sprint 003 kickoff:

1. **Launch B1 (framework-triager) and B2 (scraper-auditor) in parallel** — independent scopes, public-info research, zero blast radius. Both produce docs we read before deciding next moves.
2. **Read both reports;** scope Sprint 003 items #2 and #4 against the findings.
3. **Define action contracts (item #1a) myself with the user** — synthesis work, stays with me.
4. **For each action defined, spawn A3 (action-implementer) sequentially or in small parallel batches.**
5. **Mid-sprint, launch B3 (vision-integrator) for #5** once Vision provider is chosen.
6. **Launch B4 (pending-resolver-CLI-implementer) for #3** independently.
7. **A1 (runbook-writer) gets used opportunistically** whenever a feature lands.
8. **A2 (safe-write-migrator) launched once per writer** during the tail of Sprint 002 #15b — or sequentially by me if the batch is small enough.

Estimate of parallelization benefit: items #2 and #4 done in parallel saves ~1 day. Sequential action-implementer spawns don't save wall clock but improve focus + reviewability. Worth a measured before/after comparison in Sprint 003 retro.

## E. How to register the custom sub-agent types when Sprint 003 starts

At Sprint 003 kickoff, before launching:

1. Create directory `.claude/agents/` at the project root (rate-discovery-agent) if it doesn't already exist.
2. For each Type A entry (A1–A3, optionally A4), create `.claude/agents/<name>.md` with the frontmatter and prompt body from this doc.
3. Verify in a fresh Claude Code session that `Agent({ subagent_type: '<name>', ... })` recognizes the custom type.
4. Test each with one small invocation before relying on it for real work.

This setup is one-time per project; subsequent sessions inherit the definitions.

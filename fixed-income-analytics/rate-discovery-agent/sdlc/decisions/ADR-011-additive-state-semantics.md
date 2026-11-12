# ADR-011: Additive state semantics across cloud runs

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — Additive across runs, with confidence-aware entry merge for `bank-domains.json` and operator-mediated conflict resolution. |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-09 |
| Date decided | 2026-05-10 |
| Sprint | 002 |
| Supersedes | — |

## Context

The cloud-side rate discovery agent is invoked periodically — once per category, once per refresh cadence, ad-hoc per bank. Each invocation produces per-bank artifacts and updates a derived rates-pack. ADR-010 established the blob layout (`agent-state/output/latest/`, `agent-state/runs/<timestamp>/`, `rates-pack/rates-pack.json`) but did not specify how state from one run interacts with state from another. Sprint 001 implementation made an implicit "each run is self-contained" assumption that turns out to violate user expectations in three places:

1. **Pack rebuild is fresh per run.** `pack/publish.js` reads only the local `/app/output/latest/` at end of run, which contains only that run's banks. After the DCCB category run completed, `rates-pack.json` had 72 banks (the run's outputs), losing the 1 HDFC bank from the previous smoke run.

2. **Pull-at-start fetches only `bank-domains.json`.** `cloud/sync.js:127-146` does not download existing per-bank `output/latest/*` blobs into `/app/output/latest/`. So every run's local fs starts empty (apart from bank-domains.json), regardless of accumulated state in blob.

3. **Git commits drop prior files.** `cloud/git-publish.js` (as committed in `725c37c`) bootstraps a fresh repo with `git init` + `git fetch` + `git reset --soft origin/<branch>`. After init the index is empty; `--soft` only moves HEAD without populating the index from origin's tree. The next `git add output/latest/*.json` stages only the working-tree files (this run's banks), and the resulting commit's tree is *only* what we explicitly added — files that were in the prior commit's tree but aren't in this commit's index get dropped. Confirmed by `git diff --name-status 8eb3053 1860c66`: seven `output/latest/hdfc-bank-limited*` files show status `D` (deleted) in the DCCB-run commit.

The blob storage layer is already additive: `cloud/sync.js push` is upsert-only — it writes blobs at fixed paths but never deletes blobs that aren't in the current local fs. So existing per-bank artifacts in `agent-state` survive each run; the bug is in *what each run sees* (via pull) and *what each run publishes downstream* (via pack and git).

Without an explicit decision, future code edits could pick any of three plausible models — fresh-per-run, additive, or hybrid. Locking the spec down now prevents drift.

## Spec being decided (the four invariants)

For each blob/git artifact the system manages, the table below states the intended behavior across runs. The "additive" option below codifies these as the canonical spec.

| Artifact | Path | Per-bank semantics | Cross-run semantics |
|---|---|---|---|
| Per-bank canonical state | `agent-state/output/latest/<slug>_*.json` | Re-discovered bank: file is **overwritten** (rate refresh). New bank: new file added. | Bank not in this run: file is **untouched** (preserved). |
| Per-run audit trail | `agent-state/runs/<timestamp>/<category>/<slug>/*` | Each run writes its own subtree under a unique timestamp prefix. | Always **append** at a new prefix; prior runs untouched. Lifecycle policy expires after 3 years. |
| Rates pack (derived) | `rates-pack/rates-pack.json` (+ schema, README) | Always rebuilt; reflects the **union** of every bank in `agent-state/output/latest/`. | Pack count grows monotonically (modulo banks that are explicitly purged). |
| Bank domain registry | `agent-state/data/bank-domains.json` | Map-level merge (always). Entry-level merge governed by the **confidence-aware merge rule** below — never silently overwrites a non-null cached field. | Append-and-merge at map level; per-entry collisions stage to `bank-domains-pending.json` for operator review. |
| Pending registry changes | `agent-state/data/bank-domains-pending.json` (sidecar) | One entry per unresolved field collision: `{ bank_code, field, cached_value, proposed_value, proposed_at, proposed_run_id, proposed_confidence, status }`. | Append-only by the agent; mutated only by the operator resolution tool (defer to Sprint 003+). Survives across runs until resolved. |
| Per-run report | `agent-state/runs/<timestamp>/_run_report.md` | Markdown summary written at end of each run: counts, failure-class breakdown, conflicts surfaced this run, full backlog of unresolved pending changes. | Append at a new prefix; never modified after write. Lifecycle policy expires with the rest of `runs/<timestamp>/`. |
| Git repo `output/latest/<slug>_*.json` | Same path under `azure-openai-agent` branch | Commit's tree includes the file in its current state for re-discovered banks (modify) or new banks (add). | Files for banks not in this run **persist** in the new commit's tree (unmodified). |

Equivalently: **every artifact follows the bank-domains.json model — read existing state, merge with this run's outputs, write back.**

## Confidence-aware merge rule for `bank-domains.json` entries

The map-level merge (whole-file accumulation) is straightforward. Entry-level merge — what happens when a run re-discovers a bank that already has a registry entry — follows this rule.

Schema additions per entry (lazy on first write to that entry):

- `confidence`: `"high" | "medium" | "low"` — confidence of the latest discovery for this entry.
- `last_discovered_at`: ISO-8601 UTC timestamp of latest discovery.
- `notes_history`: append-only array of `{ at, run_id, confidence, note }`. Existing flat `notes` migrated as one synthetic entry with `confidence: "high"`, `at: "legacy"`, `run_id: "legacy-import"`.
- Flat `notes`: retained as a human-readable mirror of the latest entry in `notes_history` whose confidence ≥ medium.

Per-field merge behavior on re-discovery:

| Situation | Action | Operator review |
|---|---|---|
| Cached `null`, new non-null | Auto-fill the gap. | No |
| Cached non-null, new `null` | Keep cached (run didn't search ≠ field doesn't exist). | No |
| Cached == new | Refresh `last_discovered_at`; promote `confidence` if higher. | No |
| Cached non-null, new non-null, **values differ** | **Keep cached as authoritative.** Append a row to `bank-domains-pending.json` capturing both values. | **Yes** (via run report) |
| `notes` (any case) | Always append to `notes_history`. Promote to flat `notes` only if new confidence ≥ medium. | No |
| New bank (no entry) | Add entry as-is. | No |

Confidence does **not** auto-resolve collisions — the operator does, using the run report as the trigger and the pending-changes sidecar as the queue. Confidence is recorded on each proposal so the operator has it as a signal during review.

**Legacy entry migration:** existing entries in `bank-domains.json` (~6,732 entries from Sprint 001 LLM discovery) are treated as `confidence: "high"` on lazy migration. Trust accumulated state. No big-bang rewrite — entries migrate to the new shape only when next written.

**Operator resolution workflow:** out of scope for Sprint 002 implementation. Operator hand-edits `bank-domains-pending.json` to flip `status: pending` → `accepted` (applies proposed → cached) or `rejected` (drops proposal, keeps audit). A CLI/UI tool to automate this is a Sprint 003+ candidate.

## Options considered

### Option 1: Additive across runs (RECOMMENDED)

**Behavior:** as described in the spec table. Every cloud run reads accumulated state at start, processes its banks, writes back without destroying prior artifacts.

**Implementation deltas required:**

- `cloud/sync.js` — `pull()` fetches all blobs under `agent-state/output/latest/` into `/app/output/latest/`, in addition to `bank-domains.json`. List blobs by prefix, write each to local fs.
- `cloud/git-publish.js` — `ensureGitRepo()` replaces `git reset --soft origin/<branch>` with a sequence that populates the index from origin's tree before staging this run's adds. Cleanest: `git reset` (default `--mixed`) instead of `--soft`. After `--mixed`, the index = origin's tree, and subsequent `git add output/latest/*.json` stages new/modified files on top while origin's other files stay in the index and survive into the new commit.
- `pack/publish.js` — once `pull()` populates the local `output/latest/` from blob, the existing `pack/publish.js` logic is correct (it walks the local dir).

**Pros:**
- Matches operator expectation: "discovery is periodic, runs add to data."
- Pack and git commits monotonically reflect everything we've discovered.
- One bug fix in `sync.js pull` cascades: pack and git become correct without further changes.
- bank-domains.json's existing model is the template — consistent semantics across all artifacts.

**Cons:**
- Pull cost grows linearly with accumulated state. With ~1900 banks fully discovered (the long-term ceiling), output/latest/ holds ~10000+ files (config + 4 rate variants + summary + log per bank). Pull time at run start: maybe 30-60 seconds, negligible relative to a 1-3 hour run.
- Each cloud-bot git commit's diff is small (only this run's deltas, even though the tree is large). Git history stays readable.
- Push cost is unchanged (still upsert-only at fixed paths).

### Option 2: Fresh per run (current accidental behavior)

**Behavior:** each run starts empty, produces only its banks, replaces the pack and the git tip with only this run's outputs.

**Pros:**
- Smaller per-run footprint in local fs.
- Each commit is self-contained — easy to grep "what did the DCCB run do" in isolation.

**Cons:**
- Pack is a misleading artifact ("here are the banks we know about" — but actually only this run's).
- Git history loses "snapshot of all known banks at this date" property — to reconstruct the union, an operator must walk multiple commits.
- Operator confusion (already observed): "where did HDFC go after the DCCB run?"
- Forces a separate "merge runs" tool to produce a consumer-facing pack. PM consumer would have to either (a) tolerate single-run-only data, (b) we run a separate accumulation job. Wasteful.

### Option 3: Additive at blob, fresh at pack/git

**Behavior:** `agent-state/output/latest/` accumulates (it already does, since push is upsert-only). Pack and git reflect only this run.

**Pros:**
- No code changes needed (it's the current state). Operator can manually rebuild pack from blob.
- Smaller pack/git footprint per commit.

**Cons:**
- All the cons of Option 2 for pack and git.
- Internal inconsistency: the canonical state IS additive, but the consumer-facing artifacts aren't. Confusing to reason about.
- Operator wants to know "what's the full state?" — has to query blob, can't just read pack or git.

## Recommendation

**Option 1 — Additive across runs.** It's the only option that matches operator expectation across all artifacts, requires the smallest set of bug fixes (fundamentally one: pull more state at run start), and produces a consumer-facing pack that PM can actually use as a "snapshot of everything we know."

The implementation is small (~1 day of agent-side code), low-risk (each delta is well-scoped to one file), and the behavior change is discoverable from a re-read of this ADR plus the sync.js diff.

## Consequences if accepted

- `cloud/sync.js`, `cloud/git-publish.js`, and `pack/publish.js` change as described above.
- Each cloud run's wall-clock time grows by 30-60s (pull-everything vs pull-bank-domains). Acceptable.
- `output/latest/` blob storage size grows with bank count, capped at ~1900 banks × ~7 files × ~5 KB = ~70 MB. Negligible.
- Operator runbooks (`cloud-manual-trigger.md`) verify this behavior in the smoke checklist: "After the second cloud run, the pack still contains banks from the first run." Sprint 002 docs work.
- Future cloud-bot commits don't drop files. Git diff size stays small (only this run's deltas).
- The "purge a bank" operation becomes an explicit operator action, not an accidental side effect. Sprint 002+ work if it's ever needed.

## Open questions

1. **Concurrency.** What happens if two runs (e.g., a category run and an ad-hoc bank run) overlap? Today they would both pull, both write to the same blob paths, and last-writer-wins per file. ADR-010 explicitly accepted last-writer-wins. Is that still acceptable under the additive model? *Likely yes* — same-bank concurrency is rare, and per-run audit (`runs/<timestamp>/`) preserves what each run actually did.

2. **Schema migration.** If a future agent version changes the per-bank file schema (e.g., adds a required field), accumulated old-format files will be in `output/latest/`. Pack rebuild needs a migration step or a tolerant reader. Out of scope for this ADR; sprint that adds the breaking change owns the migration.

3. ~~**bank-domains.json conflict.**~~ **Resolved 2026-05-10.** Confidence-aware merge rule above governs per-entry behavior: cached non-null values are never silently overwritten; collisions stage to `bank-domains-pending.json` for operator review surfaced through the per-run markdown report. Both cached and newly-discovered values are preserved as evidence — the system never silently picks a winner.

## Decision log

- 2026-05-09 — Drafted PROPOSED. Awaiting Sprint 002 planning review.
- 2026-05-10 — DECIDED by Samir Joshi. Option 1 (Additive across runs) accepted. Open question #3 resolved with confidence-aware merge rule + operator-mediated conflict resolution: cached non-null values are preserved on collision, proposed values stage to `bank-domains-pending.json`, surfaced in per-run markdown report at `runs/<timestamp>/_run_report.md`. Existing 6,732 registry entries treated as `confidence: "high"` on lazy migration. Operator resolution tooling deferred to Sprint 003+.

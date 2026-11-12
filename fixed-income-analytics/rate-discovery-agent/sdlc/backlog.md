# Project backlog — rate-discovery-agent

Cross-sprint strategic items not slotted into a specific sprint's `scope.md` or `deferred.md`. Sprint planning reviews this list before each sprint starts and either pulls an item into scope or leaves it here with an updated note.

Priority labels:
- **P1** — high impact on architecture or operating model; should land within the next 1-2 sprints.
- **P2** — meaningful improvement; land within the next 3-4 sprints.
- **P3** — nice to have; revisit annually.

Items live here until they're either pulled into a sprint scope, completed, or explicitly withdrawn.

---

## P1: Extract `rate-discovery-agent/` into its own repo, generalize as domain-agnostic data-discovery agent

**Added:** 2026-05-10

**What:** Two intertwined changes, sequenced as one strategic move.

**(a) Repo extraction.** `rate-discovery-agent/` currently lives inside the `fixed-income-yield-advisor` (FIA, formerly BIRD) monorepo. Pull it into its own git repo, preserving the relevant history (`git filter-repo` or equivalent). The agent then has its own release cadence, its own CI, and a clean public-facing identity if/when it goes open-source.

**(b) Domain generalization.** The agent's design today is bank-rate-specific — the discovery pipeline assumes the entity is a bank, the artifact is an interest-rate slab table, the canonical state is `bank-domains.json`, and the prompts in `lib/prompts/` describe RBI-mandated domains and bank categories. The generalization: replace bank-specific abstractions with domain-agnostic ones, then push bank-rate logic into a "banking" plugin that conforms to the generic interface. Other plugins could then exist for:
- Bond rates (corporate, government, T-bills) — discover issuer pages, extract YTM/coupon tables.
- Equity research data (P/E, dividend yield) from listed-company IR pages.
- Mutual fund NAVs from AMC sites.
- Real estate listings, commodity price boards, etc. — anywhere the pattern "find the entity's official page → locate a tabular data section → extract structured rows" applies.

Concretely:
- `bank_code` → `entity_id`; `bank_name` → `entity_name`; `bank_type` → `entity_type`.
- `bank-domains.json` → `entity-domains.json`; lookup utility becomes domain-aware via a `domain` field.
- `lib/prompts/discover.md` becomes a template; bank-specific text moves into `domains/banking/prompts/discover.md`.
- `failure_class` enum stays generic (the values from Sprint 002's taxonomy — `website_unreachable`, `rate_page_not_found`, etc. — already are domain-agnostic). The aggregator becomes domain-agnostic by extension.
- Scraper-tier classification (`html_static`, `html_js`, `pdf`) is already generic — no change.
- Output schema (`<entity_id>_config.json`, `<entity_id>_data.json`) replaces the FD-rates-specific shape. Per-domain validators ensure data conforms to the domain's expected schema (banking → rate slabs; bonds → coupon tables).

**Why P1, not deferred or P2:**

1. **It changes architectural decisions we make today.** Where new code goes, how abstractions are named, whether new methods are added to existing bank-specific modules or to a generic core. Naming a function `loadBankDomains()` today is rework debt for the generalization. P1 forces us to consider it during current sprint design rather than after.
2. **The repo split was already on the radar** (per `project_agent_repo_split.md` memory). What's new here is bundling it with the generalization so the new repo lands with the right shape, not bank-specific structure that has to be unwound.
3. **It's not blocking** — the FIA project can continue to consume the agent in-tree until the split happens. So this is high-priority architectural work but doesn't compete with Sprint 002's scope items for execution time.

**Why not P0 / pull into Sprint 002:**

- Sprint 002's theme (trustworthy + analyzable cloud loop) is orthogonal to repo-and-abstraction work. Mixing them muddies both.
- The DCCB-extraction lift (Sprint 002's exit criterion) is the higher-leverage problem right now: the agent's behavior matters more than its packaging.
- Repo extraction has a real cost (preserving history, re-wiring CI, updating runbooks, retraining muscle memory) that should be paid once, deliberately, not as a side effect of feature work.

**Sequencing within the P1 item:**

1. **Inventory bank-specific surface area.** A short audit doc: every file in `rate-discovery-agent/` that mentions "bank", every prompt that references RBI, every schema field hard-coded to FD slabs. Output: a punch list of rename + extract candidates.
2. **Draft the domain-plugin interface.** What does a domain plugin look like? Suggested shape: a directory `domains/<name>/` with `prompts/`, `schemas/`, `validators/`, and a `manifest.js` that registers the domain with the generic core. Generic core stays in `core/` or `lib/`.
3. **Generalize core abstractions.** Rename in place: `bank_code` → `entity_id`, etc. Fail-loudly if tests reference old names. This is where the slug-utility insight from `project_slug_consistency.md` matters — `slugify(name)` becomes the canonical entity_id producer, and the generic core asserts agent-emitted IDs match the deterministic derivation.
4. **Move banking-specific code into `domains/banking/`.** `lib/prompts/discover.md` → `domains/banking/prompts/discover.md`; bank-rate validators → `domains/banking/validators/rate-slab-schema.js`.
5. **Repo split.** With the abstractions clean, `git filter-repo --path rate-discovery-agent/` to extract. New repo, new CI. FIA monorepo references the new repo as a dependency (npm workspace, git submodule, or — most likely — a pinned version of a published package).

**Estimated effort:** 2-3 weeks across someone's calendar, but doable as a Sprint 003 candidate if the DCCB lift in Sprint 002 closes ahead of schedule. Otherwise Sprint 004.

**Revisit when:**
- Sprint 002 closes — re-evaluate whether to slot this into Sprint 003 or hold for one more.
- A second use case appears (someone asks "can the agent also discover bond rates?") — that conversation immediately moves this from P1 backlog to current-sprint scope, since the use case is the cleanest forcing function for the generalization shape.
- The FIA monorepo grows enough that build/test times become friction, making the in-tree agent a drag.

**Related memories / docs:**
- Memory: `project_agent_repo_split.md` (2026-04 era — predates the generalization framing; this backlog item supersedes its priority).
- Memory: `project_slug_consistency.md` (2026-05-10 — the slug-utility consolidation is a prerequisite for clean entity_id semantics).
- Sprint 002 design: `sprints/sprint-002/design/failure-class-taxonomy.md` (the taxonomy's enum is intentionally domain-agnostic and survives the generalization unchanged).

---

## P3: A15 FCNR currency-tag accuracy for stacked single-currency-per-section pages

**Added:** 2026-05-20 (Sprint 4 Track A)

**What:** The A15 text-pattern fallback (`lib/actions/extract_html_table.js:extractViaTextPattern`) recovers FCNR slabs from SPA / mashed-cell pages where cheerio + LLM both fail. It tracks a running currency from text BETWEEN emitted rows. On Equitas FCNR, the GBP/EUR section labels sit inside the same text block as the tenure label ("...TenureGBP (ROI)12 month to <= 18 months 5.00%"), so the currency-context scan (which looks at the inter-row span, not the tenure-lookback window) tags those rows with the previous section's currency (USD).

**Impact:** Rate VALUES are correct. Only the `currency` field is wrong for non-first-currency sections on this layout class. Net for Equitas: 0 → 27 slabs (23 FD + 4 FCNR); 2 of the 4 FCNR slabs carry USD where GBP is correct.

**Fix sketch:** In `extractViaTextPattern`, also scan the per-row tenure-lookback window for a currency code, not just the inter-row span; prefer the lookback match when present. Add a unit test with the Equitas GBP-in-lookback shape.

**Why P3:** single layout class, single bank in the top-12; rate data is usable; only affects FCNR currency attribution. Revisit if the 50/200-bank cohort surfaces ≥ 2 more banks with the same currency-in-lookback pattern.

**Repro:** `node run-discovery.js "Equitas Small Finance Bank Limited" "Small Finance Bank" --path orchestrator --output-dir output/runs/equitas-repro` then inspect `*_fcnr_rates.json` — slabs 2-3 show `currency:"USD"` but tenure rates 5.00%/4.80% are GBP.

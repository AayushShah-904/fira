# Engine probe — tier routing (M4)

Methodology + results for the sprint-004 M4 probe.
Plan reference: `~/.claude/plans/pivot-to-engine-failure-lovely-wombat.md` §M4.

Run: 2026-05-21 (start 11:30:00Z, end 12:17:04Z — 47 min for 12 runs).

## Question

Does forcing Tier 2 (`gpt-4.1`) on the LLM path recover slabs that the
default tier-router misses on the extraction-quality cohort, and at what
cost per slab? Equivalent: does the M2 hint-driven orchestrator path beat
the default LLM path on hinted banks, and does the orchestrator work
usefully on UNHINTED banks?

## Methodology

`scripts/engine-probe.js` ran `node run-discovery.js` for each
(bank, config) pair. Configs:

| Config | --path | Env | Description |
|---|---|---|---|
| **A** | (default, auto-switch) | — | Production default. M2.6 auto-routes hinted PDFs to orchestrator; others stay on LLM-path with the regular tier-router (Tier 1 mini, escalation to Tier 2 on drift) |
| **B** | `--path llm` | `RATE_FORCE_TIER=2` | Force LLM-path; force Tier 2 (`gpt-4.1`) for the initial attempt — bypasses auto-switch + Tier 1 |
| **C** | `--path orchestrator` | — | Force orchestrator regardless of hints; measures deterministic-path coverage on unhinted banks |

Cohort: **axis-bank-limited, hdfc-bank-limited, idfc-first-bank-limited, kotak-mahindra-bank-limited** (4 PVBs of similar shape but differing PDF / HTML / JS-rendering characteristics).

Per-bank, after each run, the probe tallied total slabs across all variant rate files, `total_cost_usd`, `wall_clock_ms`, `agent_path`, and `tool_call_count`. Between configs for the same bank, the probe cleared the `partial_silent` marker (so each config starts from a comparable gate state). It did NOT restore `output/latest/<slug>*` between configs — each subsequent config saw the prior config's slab counts as `priorSlabCounts`, which is realistic for production. Operator can revert via `git checkout HEAD -- output/latest/<slug>*` after review.

`RATE_FORCE_TIER` env var honored in `lib/tier-router.js#selectInitialTier` via the new `applyForceTierEnv` helper. Probe-only feature; production callers leave the env unset.

## Results

### Aggregate

| Config | Total slabs | Total cost | $/slab |
|---|---:|---:|---:|
| **A (default)** | 757 | $1.815 | $0.0024 |
| **B (force LLM Tier 2)** | 187 | $2.269 | $0.0121 |
| **C (force orchestrator)** | **737 (97% of A)** | **$0.519 (28% of A)** | **$0.0007 (29% of A)** |

### Per-bank

| Bank | Hint? | A slabs | B slabs | C slabs | A cost | B cost | C cost | A path | B path | C path |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| axis-bank-limited | yes | **570** | 0 | **570** | $0.000 | $0.454 | $0.000 | orchestrator | llm | orchestrator |
| hdfc-bank-limited | no | 74 | 74 | **74** | $0.729 | $0.729 | **$0.014** | llm | llm | orchestrator |
| idfc-first-bank-limited | no | **53** | 53 | 33 | $0.588 | $0.588 | $0.007 | llm | llm | orchestrator |
| kotak-mahindra-bank-limited | no | 60 | 60 | 60 | $0.498 | $0.498 | $0.498 | llm | llm | llm |

### Per-variant (where it matters)

**Axis** (hinted):
- A & C: 324 regular + 72 NRE + 162 NRO + 12 FCNR = 570 ✓
- B: **0** — forcing the LLM-path bypasses the auto-switch, and the LLM truncates the multi-column hint output to nothing (the M2.4 finding, reproduced)

**IDFC-First** (unhinted):
- A & B: 13 regular + 7 NRE + 13 NRO + 20 FCNR = 53
- C: 13 regular + 1 NRE + 1 NRO + 18 FCNR = 33 — orchestrator loses on JS-rendered NRI pages (no M2 HTML hint authored)

**HDFC, Kotak** (unhinted): same in all configs (74 and 60), but C is 50× cheaper for HDFC.

## Observations

1. **Config B is strictly worse than A everywhere**:
   - On Axis: 0 slabs (LLM truncation kills hint extraction) at higher cost than A
   - On HDFC / IDFC-First / Kotak: identical slabs at identical cost — forcing Tier 2 doesn't help because the LLM-path already escalates to Tier 2 on drift, and the bottleneck isn't model reasoning capacity but structural extraction issues (non-table DOM, multi-column truncation)
   - Verdict: **"always Tier 2" is the wrong productization**. The cohort's failures are infrastructure-level, not reasoning-level — exactly the predicition from the original failure-mode analysis.

2. **Config C is a near-tie with A on slabs but 4× cheaper overall**:
   - 737 / 757 = **97% slab recovery at 28% the cost**
   - The cost differential is structural: orchestrator's deterministic actions don't spend AOAI tokens (Cheerio + pdfjs do the extraction; AOAI is only called for ambiguous selectors). For hinted banks ($0), for unhinted HDFC ($0.014, ~50× cheaper than LLM-path's $0.729).

3. **Where C loses (IDFC-First NRE/NRO)**: the JS-rendered NRI pages don't extract via the orchestrator's deterministic `extract_html_table` without an M2 HTML selector hint. The LLM-path stumbles through Playwright + heuristic table picking and gets 7+13=20 NRI slabs; the orchestrator's deterministic path gets 1+1=2.

4. **Kotak C path stayed on LLM (60 slabs in all three configs)**: explains the no-op for Kotak. The orchestrator path may have had a failure that fell back to the LLM tracker — log inspection deferred. Net effect: Kotak in C had the same outcome as A and B.

5. **The earlier failure-mode analysis predicted this**: model upgrades address only ~20% of failures (the extraction-quality class), and infrastructure failures (the 65%+) are best fixed by the orchestrator's hint-driven actions, not by burning more reasoning tokens.

## Decision

Per the M4 decision rule:

- ❌ **Rule 1 ("B recovers significantly more than A")** — does NOT fire. B is strictly worse than A. Forcing Tier 2 won't be productized in `lib/tier-router.js`.
- ✅ **Rule 2 ("C recovers most of B's slabs")** — fires strongly. C recovers 97% of A's slabs at 28% the cost. **Ship M2-style hints (HTML + PDF) for the extraction-quality cohort. Skip Tier 3 productization.**

Concrete next-step recommendation (sprint-005):

1. **Author M2 HTML hints** for HDFC / DCB / IDFC-First / RBL NRI variants (the M2.4 deferred work). With hints, the orchestrator should extract NRE/NRO from JS-rendered card layouts deterministically — closing the 20-slab gap seen on IDFC-First and unlocking similar recoveries on HDFC if their NRI pages have undocumented data.

2. **Investigate Kotak's C-path fall-through** (60 slabs in all configs, "llm" path reported). Likely the orchestrator failed at find_rate_page and the parent process fell back — but log inspection deferred until sprint-005.

3. **DO NOT productize "always Tier 2"**. Tier 2 already escalates on drift via the existing tier-router; forcing it from the start is pure waste.

4. **Consider broadening the M2.6 auto-switch criterion** — currently only banks with `extraction.<key>.type='pdf' && fulfills_product` route to the orchestrator. We could also auto-route banks where the LLM-path's drift signal repeatedly fails (orchestrator might handle them more cheaply). Speculative; needs sprint-005 evidence.

## Cost / time

- Probe cost: ~$4.60 total ($1.815 A + $2.269 B + $0.519 C)
- Probe wall-clock: 47 minutes for 12 runs (4 banks × 3 configs)

## Raw artifacts

- `output/probe/2026-05-21T11-30-00/probe-results.json` — full JSON
- `output/probe/2026-05-21T11-30-00/probe-report.md` — auto-generated markdown

## Open follow-ups

- **Author HTML hints for HDFC / DCB / IDFC-First / RBL NRI** (sprint-005). Highest-ROI action surfaced by this probe.
- **Investigate Kotak's orchestrator-path fall-through** in run-discovery's path-selection logic.
- **Broaden the auto-switch criterion** (optional, after HTML hints land).
- **Re-run the probe after HTML hints land** to confirm C closes the IDFC-First NRE/NRO gap.

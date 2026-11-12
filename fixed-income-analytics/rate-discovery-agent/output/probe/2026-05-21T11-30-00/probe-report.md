# Engine probe — sprint-004 M4

**Started**: 2026-05-21T11:30:00.595Z
**Completed**: 2026-05-21T12:17:04.279Z
**Cohort**: axis-bank-limited, hdfc-bank-limited, idfc-first-bank-limited, kotak-mahindra-bank-limited (4 banks)
**Configs run**: A, B, C

## Configurations

- **A** (`default`): Production default — M2.6 auto-switch for hinted PDFs; LLM-path tier-router for unhinted.
- **B** (`force-llm-tier2`): Force LLM-path + force Tier 2 (gpt-4.1) for the initial attempt — no auto-switch.
  - flags: `--path llm`
  - env: `RATE_FORCE_TIER=2`
- **C** (`force-orchestrator`): Force orchestrator path regardless of hints — measures deterministic-path coverage on unhinted banks.
  - flags: `--path orchestrator`
  - env: `(none)`

## Results by bank

| Bank | Hint? | A slabs | B slabs | C slabs | A cost | B cost | C cost | A path | B path | C path |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| axis-bank-limited | yes | 570 | 0 | 570 | $0.000 | $0.454 | $0.000 | orchestrator | llm | orchestrator |
| hdfc-bank-limited | no | 74 | 74 | 74 | $0.729 | $0.729 | $0.014 | llm | llm | orchestrator |
| idfc-first-bank-limited | no | 53 | 53 | 33 | $0.588 | $0.588 | $0.007 | llm | llm | orchestrator |
| kotak-mahindra-bank-limited | no | 60 | 60 | 60 | $0.498 | $0.498 | $0.498 | llm | llm | llm |

## Per-variant breakdown

### axis-bank-limited (hint=true)

| Config | regular | nre | nro | fcnr | gift | total | cost | partial_silent |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A | 324 | 72 | 162 | 12 | 0 | 570 | $0.000 | no |
| B | 0 | 0 | 0 | 0 | 0 | 0 | $0.454 | no |
| C | 324 | 72 | 162 | 12 | 0 | 570 | $0.000 | no |

### hdfc-bank-limited (hint=false)

| Config | regular | nre | nro | fcnr | gift | total | cost | partial_silent |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A | 19 | 12 | 19 | 24 | 0 | 74 | $0.729 | no |
| B | 19 | 12 | 19 | 24 | 0 | 74 | $0.729 | no |
| C | 19 | 12 | 19 | 24 | 0 | 74 | $0.014 | no |

### idfc-first-bank-limited (hint=false)

| Config | regular | nre | nro | fcnr | gift | total | cost | partial_silent |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A | 13 | 7 | 13 | 20 | 0 | 53 | $0.588 | no |
| B | 13 | 7 | 13 | 20 | 0 | 53 | $0.588 | no |
| C | 13 | 1 | 1 | 18 | 0 | 33 | $0.007 | no |

### kotak-mahindra-bank-limited (hint=false)

| Config | regular | nre | nro | fcnr | gift | total | cost | partial_silent |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A | 18 | 7 | 18 | 17 | 0 | 60 | $0.498 | no |
| B | 18 | 7 | 18 | 17 | 0 | 60 | $0.498 | no |
| C | 18 | 7 | 18 | 17 | 0 | 60 | $0.498 | no |

## Aggregate

| Config | Total slabs | Total cost | $/slab |
|---|---:|---:|---:|
| A (default) | 757 | $1.815 | $0.0024 |
| B (force-llm-tier2) | 187 | $2.269 | $0.0121 |
| C (force-orchestrator) | 737 | $0.519 | $0.0007 |

## Decision rule (per the M4 plan)

- If config **B** (force Tier 2) recovers significantly more slabs than **A** AND cost-per-slab is comparable → productize "always Tier 2 for these bank types" in `lib/tier-router.js`
- If config **C** (force orchestrator) recovers most of B's slabs → ship M2-style hints (cheaper) and skip Tier 3 productization
- If neither closes the gap → log as evidence for a future deploy-stronger-model decision; no tier change
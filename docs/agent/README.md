# `docs/agent/` — Bank Rate Discovery Agent playbook

**Single source of truth** for the agent's instructions. `../../CLAUDE.md` is a lean router that points here; `lib/prompts/fragments.js` reads the anchored `<!-- @fragment NAME -->` sections in these files and `lib/prompts/build-prompt.js` assembles only the fragments each pipeline mode needs. Edit the section here — never restate it in CLAUDE.md or fragments.js.

| File | Contains (fragments) | Read when |
|---|---|---|
| `core.md` | `IDENTITY`, `RULES_CORE` | always — identity + the "Important Rules" list |
| `discovery-workflow.md` | Step 0 (prose) · `EFFICIENCY_RULES`, `STEP_FIND_WEBSITE`, `STEP_FIND_RATE_PAGES`, `STEP_SCRAPER_TYPE`, `STEP_EXTRACT_RATES` | discovering a bank end-to-end |
| `field-learnings.md` | `LEARNINGS_FROM_FIELD` | tricky co-op / DCCB sites (multilingual, image-only, umbrella domains) |
| `nri-gift-ibu.md` | `STEP_NRI_FCNR`, `STEP_GIFT_CITY` | NRI/FCNR (PSB/PVB/FB/large-SFB) or GIFT/IBU pages |
| `schemas.md` | `CONFIG_SCHEMA`, `RATE_SCHEMA`, `OUTPUT_SLUG`, `BANK_TYPE_TABLE` | writing config/rate JSON (strict field names) or mapping a bank_type |

## Editing rules

- Keep each fragment between its `<!-- @fragment NAME -->` / `<!-- @end NAME -->` anchors. `fragments.js` extracts the text *between* the anchors verbatim, so don't change the anchor lines.
- Prose outside the anchors (e.g. Step 0 in `discovery-workflow.md`) is for human/interactive readers and is **not** assembled into pipeline prompts.
- `tests/prompts/fragments-docs.test.js` fails if an anchor is renamed/removed or a doc goes missing — run `node --test tests/prompts/`.

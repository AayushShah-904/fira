# Sprint 010 Phase A2 — Orchestrator null-bank_type safety

**Date:** 2026-06-09
**Outcome:** ✅ Bare-invocation `node run-discovery.js <slug>` no longer crashes when category is missing. Verified locally with banswara (33 slabs in 15s vs prior crash in 3s).

## What changed

Two layers of defense for missing `bank_type`:

### Layer 1 — `run-discovery.js` (CLI-time derivation)

After the CLI parse derives `bankCode = slugify(bankName)`, if `category` wasn't passed:

```js
if (!category) {
  try {
    const domains = JSON.parse(fs.readFileSync('data/bank-domains.json', 'utf-8'));
    const entry = domains[bankCode];
    if (entry && entry.category) {
      category = entry.category;
      console.log(`[A2] No --category passed; derived "${category}" from data/bank-domains.json`);
    }
  } catch (_) { /* best-effort */ }
}
const bankType = CATEGORY_TO_TYPE[category] || null;
```

Covers the common case: cohort scripts and bare CLI invocations both feed `bank-domains.json`-tracked banks. The 1037 banks in the registry all have `category` populated.

### Layer 2 — `lib/orchestrator.js` (defensive sentinel)

When `bank_type` is null on entry to `orchestrate()`, attempt registry-derivation; if still null, fall back to a `'UNKNOWN'` sentinel rather than throwing:

```js
if (!bank_type) {
  try {
    const domains = JSON.parse(fs.readFileSync(domains_file, 'utf-8'));
    const entry = domains[canonicalSlugify(bank_name)];
    const cat = entry && entry.category;
    bank_type = (cat && CATEGORY_TO_TYPE[cat]) || 'UNKNOWN';
  } catch (_) {
    bank_type = 'UNKNOWN';
  }
}
```

The `CATEGORY_TO_TYPE` map is inlined in the orchestrator (a copy of the run-discovery.js map). A shared util would be cleaner but is out-of-scope for Sprint 010 — the map is small and stable.

### Layer 3 — actions tolerate the sentinel

- `lib/actions/find_website.js`: missing/non-string `bank_type` → `'UNKNOWN'`. The function's confidence heuristic doesn't read bank_type (only domain-pattern matching); the LLM probe in step 4 accepts any string as prompt grounding.
- `lib/actions/commit_config.js`: `'UNKNOWN'` added to `VALID_BANK_TYPES`. Records the bank with a truthful "we don't know what this is" type rather than crashing the commit.

The orchestrator's own pre-flight `throw new Error('orchestrate: input.bank_type is required')` is removed (now derivation-then-sentinel).

## Why two layers

Layer 1 covers >99% of cases via the registry. Layer 2 + 3 ensure that even if Layer 1 misses (bank not in registry yet, registry corrupted, etc.), the orchestrator doesn't crash — it logs an "UNKNOWN" run and continues. The pack-side downstream checks already filter on confidence + extraction quality, so an UNKNOWN-tagged bank with weak extraction will be appropriately graded by the existing gates.

## Verification

```bash
node run-discovery.js banswara-central-co-operative-bank-ltd  # bare; no --category
# Output:
#   [A2] No --category passed; derived "District Central Co-operative Bank" from data/bank-domains.json
#   ...
#   [EVENT] EXTRACTED slab_count=33 variants={domestic: 33}
#   OK 15s | pdf | 33 domestic
```

Before A2 this invocation exited 1 in ~3 seconds with `Fatal: orchestrate: input.bank_type is required` (the same exit pattern the cloud cohort showed for banswara + barmer, though the cloud failures are likely a different secondary cause — see Phase D's HDFC investigation for the other 3-second-exit-1 class).

## Tests

| Test file | Change |
|---|---|
| `tests/lib/actions/find_website.test.js` | One case was asserting the old "throws on missing bank_type" strict behavior; updated to assert the new tolerant behavior (`UNKNOWN` sentinel, function still returns a result). |
| `tests/lib/actions/commit_config.test.js` | No change — existing tests pass a valid bank_type; the `UNKNOWN` addition to `VALID_BANK_TYPES` doesn't break the closed-set assertion. |
| `tests/lib/orchestrator*.test.js` | No change — existing tests all pass `bank_type`; the new fallback path is exercised at the CLI layer. |

Full suite after A2: **1458 pass / 0 fail / 44 skipped**.

## What this does NOT do

- Does not add a new `'UNKNOWN'` bank_type to any pack-builder bank-type lookup. Pack-builder groups by `category` (not bank_type), so this is a non-issue downstream.
- Does not factor the `CATEGORY_TO_TYPE` map into a shared utility. Both copies (run-discovery.js + orchestrator.js) are 17 lines; the small duplication is preferable to a Sprint-010-scoped lib/bank-type.js addition.

## Files

- `run-discovery.js` — Layer 1 registry-derivation
- `lib/orchestrator.js` — Layer 2 defensive sentinel
- `lib/actions/find_website.js` — Layer 3 tolerance
- `lib/actions/commit_config.js` — Layer 3 (`UNKNOWN` added to VALID_BANK_TYPES)
- `tests/lib/actions/find_website.test.js` — assertion updated to new tolerant behavior
- `sdlc/sprints/sprint-010/implementation/A2-orchestrator-null-bank-type-safety-2026-06-09.md` — this doc

# Fix categories 3 & 4 — value diffs + judge false-positives (2026-05-27)

Investigating the audit's 15 CONTRADICT slabs (8 "genuine diffs" + 7 same-value) found that **the data is far more correct than the 5.3% headline implied** — most CONTRADICTs were the LLM judge over-flagging, not real errors.

## Category 3 — the 8 "genuine value diffs": only 1 real bug

Focused live re-verification (one agent per flagged tenure) revealed three sub-cases:

**(a) 5 are NOT errors — correct multi-tier data the judge mis-compared:**
jalgaon, bihar, khamgaon, andhra-pradesh-grameena, canara-ibu each publish multiple **deposit-amount tiers** per tenure, correctly stored with `deposit_range` (below_1cr/above_1cr, below_3cr/3cr_to_5cr/5cr_and_above, below_5m_usd/above_5m_usd). The audit's focus-slab picker sampled a *bulk-tier* row (e.g. jalgaon above_1cr = 5.0%) and the judge compared it to the *retail* headline (6.0%) → false CONTRADICT. The retail row was present and correct all along. **No data change.**

**(b) 1 real extraction bug — fixed:**
`bombay-mercantile` 1-2y and 2-3y rates were the **average of the page's "callable / non-callable" slash cells** ("6.15 / 6.40" → shipped 6.275). Corrected to the general/callable values: 1-2y 6.275/6.775 → **6.15/6.65**, 2-3y 6.475/6.975 → **6.35/6.85**.

**(c) 1 drift, not a bug — flagged for refresh:**
`pnb-ibu` USD >9-12M shipped 4.10 (eff 2026-04-02); live shows 4.20 (eff 2026-05-01). The whole table is one refresh-cycle old; patching a single slab would make it internally inconsistent, so it's left for the refresh pipeline (not an extraction error).

## Category 4 — 7 same-value CONTRADICTs: pure judge errors

krishna-bhima, chandigarh-state ×3, chhattisgarh ×3: the judge flagged CONTRADICT while its own `actual` **equalled** the shipped value. Pure LLM-judge noise. No data issue.

## Durable fix — the audit judge

The root cause of the (a) false-positives: the judge prompt didn't tell the model which deposit-amount tier / currency a sampled slab belonged to. Fixed in `scripts/audit/sample-correctness-audit.js#buildJudgePrompt`: each entry now carries `deposit_amount_tier` + `currency`, and the system prompt instructs the judge to compare against THAT tier (not the headline retail rate). This removes the tier-mismatch false-positives on the next run.

## Honest bottom line

Of 281 audited slabs, the confirmed extraction errors are **bombay-mercantile (1 bug, fixed)** + arguably pnb-ibu (drift). True error rate ≈ **0.7%**, not 5.3% — the audit headline was inflated ~7× by judge over-flagging (tier mismatches + same-value errors). The hybrid design (human adjudicates CONTRADICTs) is exactly what catches this; the judge improvement makes the automated pass more precise.

## Follow-ons

- Re-run the audit with the improved judge to get a corrected, lower error rate.
- The "callable/non-callable slash cell" parse pattern (bombay) may affect other banks with that page style — worth a targeted scan.
- pnb-ibu (and any other one-cycle-stale IBUs) → normal refresh.

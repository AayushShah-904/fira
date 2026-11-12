'use strict';
//
// Shared LLM re-extraction prompt + agreement classifier (Sprint 008, Phase 4).
//
// The extraction prompt is the one thing the deterministic refresh verifier
// (scripts/refresh/verify-with-llm.js) and the systematic cross-check
// (scripts/audit/cross-check-all.js) must NOT fork — both ask the model to
// re-read a source page and emit the same slab schema. It lives here so there
// is a single copy. Moved verbatim from verify-with-llm.js.

function variantInstructions(variant) {
  switch (variant) {
    case 'regular':
      return 'Variant detail: domestic resident FD rates in INR.';
    case 'nre':
      return 'Variant detail: NRE (Non-Resident External) FD rates in INR.';
    case 'nro':
      return 'Variant detail: NRO (Non-Resident Ordinary) FD rates in INR.';
    case 'fcnr':
      return 'Variant detail: FCNR(B) foreign-currency FD rates. Each slab MUST include currency. No senior premium for FCNR.';
    case 'gift':
      return 'Variant detail: GIFT City / IBU foreign-currency deposits. Each slab MUST include currency.';
    default:
      return '';
  }
}

function buildExtractionPrompt(variant, sourceUrl, content, contentKind) {
  const variantNote = variantInstructions(variant);
  return {
    system:
      'You are a careful data extraction system. Your job is to read a fixed-deposit ' +
      'rate page from an Indian bank and return ONLY a strict JSON object describing ' +
      'the rate slabs. Do not include commentary, markdown, or explanations. ' +
      'Output must parse with JSON.parse on the first attempt.',
    user: [
      `Source URL: ${sourceUrl}`,
      `Variant: ${variant}`,
      variantNote,
      '',
      'Schema (no other keys; null where unknown):',
      '{',
      '  "effective_date": "YYYY-MM-DD" | null,',
      '  "rate_slabs": [',
      '    {',
      '      "tenure_text": "<as printed on the page>",',
      '      "tenure_min_days": <int> | null,',
      '      "tenure_max_days": <int> | null,',
      '      "rate_general_pct": <number 0..15> | null,',
      '      "rate_senior_pct":  <number 0..15> | null,',
      '      "rate_super_senior_pct": <number 0..15> | null,',
      '      "currency": "<USD|GBP|EUR|JPY|AUD|CAD|...>"  // for FCNR/GIFT only; null for INR variants',
      '    }',
      '  ],',
      '  "warnings": ["..."]   // notable caveats: discontinued schemes, table covers a specific deposit-amount range, etc.',
      '}',
      '',
      'Rules:',
      '- Extract the **effective date** of the rate table if visible anywhere on the page (look for "w.e.f.", "with effect from", "effective from", "revised as on", "as on", "rates as on", "applicable from", "updated on"). Format as "YYYY-MM-DD" in the "effective_date" field; else null.',
      '- For INR variants (regular / nre / nro), most banks publish a single "<3 Crore" headline table — extract THAT one as rate_slabs. If multiple deposit-amount tiers are shown, prefer the smallest tier (retail).',
      '- rate_general_pct and rate_senior_pct must be different columns. If a column header says "Existing" vs "Revised" rather than "General" vs "Senior", the page is showing a rate-revision comparison — use the REVISED column for rate_general_pct and leave rate_senior_pct as null unless the page has a separate explicit senior column.',
      '- Indian FD rates almost always fall in 2.5% to 8.5%. If you see a rate outside this band that looks like a special-scheme callout (e.g., "Vishesh", "Premium", "Wecare", "Amrit Vrishti"), include it but add a warning naming the scheme.',
      '- For FCNR/GIFT variants, every slab MUST include a "currency" field (USD/GBP/EUR/JPY/AUD/CAD). Use null elsewhere.',
      '- If the page contains no parseable rate table, return rate_slabs: [] with a warning.',
      '',
      `Page content (${contentKind}):`,
      content,
    ].join('\n'),
  };
}

// Classify how well an independent re-extraction (next) agrees with the
// shipped slabs (prior), given a diffSlabs() result.
//   FULL      — no added / removed / changed slabs
//   PARTIAL   — some slabs match, some differ
//   DISAGREE  — nothing matches
//   LLM_NO_DATA — the re-extraction produced no slabs
function classifyAgreement(diff, nextCount) {
  if (!diff) return 'LLM_NO_DATA';
  if (nextCount === 0) return 'LLM_NO_DATA';
  const s = diff.summary || {};
  if ((s.slabs_added || 0) === 0 && (s.slabs_removed || 0) === 0 && (s.slabs_changed || 0) === 0) return 'FULL';
  if ((diff.unchanged_count || 0) > 0) return 'PARTIAL';
  return 'DISAGREE';
}

module.exports = { variantInstructions, buildExtractionPrompt, classifyAgreement };

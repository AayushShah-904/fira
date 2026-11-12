#!/usr/bin/env node
// One-shot: re-align agent-emitted slugs for 8 banks with their canonical
// seed (CSV-derived) slugs. The LLM-prompt path drifted from
// slugify(csv_name) by independently "cleaning" the bank_name. We pin each
// file's bank_code + filename to the seed's slug. bank_name is left as the
// agent emitted it (operator preference for the more-descriptive form).
//
// Idempotent: skips pairs where the old slug no longer exists.

import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from "fs";
import { join } from "path";

const LATEST = "output/latest";

const PAIRS = [
  ["dhule-and-nandurbar-jilha-sarkari-nokaranchi-sahakari-bank-ltd-dhule", "dhule-and-nandurbar-jilha-sarkari-nokaranchi"],
  ["nkgsb-co-operative-bank-ltd", "nkgsb-co-operative-bank-ltd-mumbai"],
  ["shri-kadasiddeshwar-pattan-sahakari-bank-niyamit-banhatti", "shri-kadasiddeshwar-pattan-sahakari-bank-niyamit"],
  ["sri-lakshminarayana-co-operative-bank-ltd-bangalore", "sri-lakshminarayana-co-operative-bank-ltd"],
  ["sri-potti-sriramulu-nellore-district-cooperative-central-bank-ltd", "nellore-district-co-operative-central-bank-ltd"],
  ["sriramnagar-pattana-sahakar-bank-niyamit-sriramnagar", "sriramnagar-pattana-sahakar-bank-niyamit"],
  ["the-ahmedabad-mercantile-co-operative-bank-ltd", "ahmedabad-mercantile-co-op-bank-ltd"],
  ["the-zoroastrian-co-operative-bank-ltd", "zoroastrian-co-operative-bank-ltd"],
];

const entries = readdirSync(LATEST);

for (const [oldSlug, newSlug] of PAIRS) {
  const matching = entries.filter(
    (f) => f === `${oldSlug}.log` ||
           f === `${oldSlug}.summary.json` ||
           f === `${oldSlug}.trace.jsonl` ||
           f.startsWith(`${oldSlug}_`) ||
           f.startsWith(`${oldSlug}.`),
  );
  if (matching.length === 0) {
    console.log(`SKIP  ${oldSlug} (no files)`);
    continue;
  }

  for (const f of matching) {
    const oldPath = join(LATEST, f);
    const newName = f.replace(oldSlug, newSlug);
    const newPath = join(LATEST, newName);

    // Rewrite bank_code field inside JSON content files. Leave .log and
    // .trace.jsonl untouched — those are historical operational records.
    if (f.endsWith("_config.json") || f.endsWith("_rates.json") || f.endsWith(".summary.json")) {
      const txt = readFileSync(oldPath, "utf8");
      let updated = txt;
      try {
        const j = JSON.parse(txt);
        if (j.bank_code === oldSlug) j.bank_code = newSlug;
        updated = JSON.stringify(j, null, 2) + "\n";
      } catch (e) {
        console.log(`WARN  ${f}: JSON parse failed, renaming without rewrite (${e.message})`);
      }
      writeFileSync(oldPath, updated);
    }

    if (existsSync(newPath)) {
      console.log(`WARN  destination exists, skipping rename: ${newName}`);
      continue;
    }
    renameSync(oldPath, newPath);
  }
  console.log(`PIN   ${oldSlug} → ${newSlug}  (${matching.length} files)`);
}

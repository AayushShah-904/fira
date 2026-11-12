#!/usr/bin/env node
// One-shot cleanup: collapse 11 legacy short-form IBU keys in bank-domains.json
// into their slugify(csv_name) canonical counterparts. Preserves parent_bank_code
// when the long-form lacked it. Idempotent: running twice is a no-op once short
// keys are gone.

import { readFileSync, writeFileSync } from "fs";

const PATH = "data/bank-domains.json";

const PAIRS = [
  ["anz-ibu", "australia-and-new-zealand-banking-group-limited-ibu"],
  ["barclays-bank-ibu", "barclays-bank-plc-ibu"],
  ["citibank-ibu", "citi-bank-ibu"],
  ["credit-agricole-ibu", "credit-agricole-corporate-investment-bank-ibu"],
  ["ctbc-bank-ibu", "ctbc-bank-co-ltd-ibu"],
  ["first-abu-dhabi-bank-ibu", "first-abu-dhabi-bank-pjsc-ibu"],
  ["jp-morgan-securities-ibu", "jpmorgan-securities-plc-ibu"],
  ["mashreqbank-ibu", "mashreqbank-psc-ibu"],
  ["qatar-national-bank-ibu", "qatar-national-bank-qpsc-ibu"],
  ["sbi-ibu", "state-bank-of-india-ibu"],
  ["smbc-ibu", "sumitomo-mitsui-banking-corporation-ibu"],
];

const data = JSON.parse(readFileSync(PATH, "utf8"));
const log = [];

for (const [shortKey, longKey] of PAIRS) {
  const short = data[shortKey];
  const long = data[longKey];
  if (!short) {
    log.push(`SKIP  ${shortKey} (already absent)`);
    continue;
  }
  if (!long) {
    log.push(`WARN  ${shortKey} → ${longKey}: long form missing; not deleting short`);
    continue;
  }

  const actions = [];
  if (short.parent_bank_code && !long.parent_bank_code) {
    long.parent_bank_code = short.parent_bank_code;
    actions.push(`merged parent_bank_code=${short.parent_bank_code}`);
  } else if (
    short.parent_bank_code &&
    long.parent_bank_code &&
    short.parent_bank_code !== long.parent_bank_code
  ) {
    actions.push(
      `conflict parent_bank_code short=${short.parent_bank_code} long=${long.parent_bank_code}; kept long`,
    );
  }

  delete data[shortKey];
  log.push(`DROP  ${shortKey} → ${longKey}${actions.length ? "  [" + actions.join("; ") + "]" : ""}`);
}

writeFileSync(PATH, JSON.stringify(data, null, 2) + "\n");
for (const line of log) console.log(line);
console.log(`\nRemaining IBU keys: ${Object.keys(data).filter((k) => k.endsWith("-ibu")).length}`);

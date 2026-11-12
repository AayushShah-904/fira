#!/usr/bin/env node

/**
 * heal_rates_schema.js — one-off migration to normalize existing rate files.
 *
 * Scans `output/latest/` and every folder under `output/runs/` for
 * `*_rates.json` files and renames legacy / alias keys to the canonical
 * schema (see scripts/utils/normalize-rates.js).
 *
 * Safe to run multiple times — canonical files are left untouched. All
 * changes are in-place, idempotent, and deterministic.
 *
 * Usage:
 *   node scripts/heal_rates_schema.js             # heal output/latest + output/runs/*
 *   node scripts/heal_rates_schema.js --dry-run   # report what would change, don't write
 *   node scripts/heal_rates_schema.js <path>      # heal a specific file or folder
 */

const fs = require("fs");
const path = require("path");

const { normalizeRatesObject } = require("./utils/normalize-rates");

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicitPath = args.find((a) => !a.startsWith("--"));

// ── File discovery ───────────────────────────────────────────────────

function collectRateFiles(rootPath) {
  const files = [];
  if (!fs.existsSync(rootPath)) return files;

  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    if (rootPath.endsWith("_rates.json")) files.push(rootPath);
    return files;
  }

  // Directory — walk one level deep (output/latest is flat; output/runs has one level of subdirs)
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRateFiles(full));
    } else if (entry.isFile() && entry.name.endsWith("_rates.json")) {
      files.push(full);
    }
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────────────

const projectRoot = path.resolve(__dirname, "..");
let targets;

if (explicitPath) {
  targets = [path.resolve(explicitPath)];
} else {
  targets = [
    path.join(projectRoot, "output", "latest"),
    path.join(projectRoot, "output", "runs"),
  ];
}

const allFiles = [];
for (const t of targets) {
  allFiles.push(...collectRateFiles(t));
}

console.log(`Scanning ${allFiles.length} rate files${dryRun ? " (dry-run)" : ""}...`);
console.log();

let healed = 0;
let unchanged = 0;
let errored = 0;
const renameTallies = {};

for (const file of allFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.error(`  ERR  ${path.relative(projectRoot, file)}: ${err.message}`);
    errored++;
    continue;
  }

  const result = normalizeRatesObject(data);
  if (!result.changed) {
    unchanged++;
    continue;
  }

  healed++;
  for (const rename of result.fieldsRenamed) {
    renameTallies[rename] = (renameTallies[rename] || 0) + 1;
  }

  const slabCount = Array.isArray(data.rate_slabs) ? data.rate_slabs.length : 0;
  const relPath = path.relative(projectRoot, file);
  console.log(`  HEAL ${relPath}  (${slabCount} slabs)  [${result.fieldsRenamed.join(", ")}]`);

  if (!dryRun) {
    // safe-write-exempt: TODO migrate per ADR-012 — rates-schema healer writes _rates.json (kind: 'rates'); operator-invoked, so likely source: 'operator' with force: true. Queued for follow-up.
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }
}

// ── Summary ──────────────────────────────────────────────────────────

console.log();
console.log("============================================");
console.log(` Healed:    ${healed}`);
console.log(` Unchanged: ${unchanged}`);
console.log(` Errored:   ${errored}`);
console.log(` Total:     ${allFiles.length}`);
if (Object.keys(renameTallies).length > 0) {
  console.log();
  console.log(" Rename tallies:");
  for (const [rename, count] of Object.entries(renameTallies).sort()) {
    console.log(`   ${rename.padEnd(40)} ${count}`);
  }
}
if (dryRun && healed > 0) {
  console.log();
  console.log(" Dry-run — no files were written. Re-run without --dry-run to apply.");
}
console.log("============================================");

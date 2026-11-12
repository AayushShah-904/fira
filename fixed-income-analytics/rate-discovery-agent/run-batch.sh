#!/usr/bin/env bash
#
# run-batch.sh — Run the Rate Discovery Agent for a batch of banks from the master list
#
# Usage:
#   ./run-batch.sh <csv_file> [category_filter] [limit]
#
# Examples:
#   # Discover all Public Sector Banks
#   ./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Public Sector Bank"
#
#   # Discover first 5 Scheduled Urban Co-operative Banks
#   ./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Scheduled Urban Co-operative Bank" 5
#
#   # Discover all Small Finance Banks
#   ./run-batch.sh ../docs/Indian_Banks_Comprehensive_List_RBI.csv "Small Finance Bank"
#
# Prerequisites:
#   - Node.js 20+
#   - Claude Code CLI installed and authenticated
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CSV_FILE="${1:?Usage: $0 <csv_file> [category_filter] [limit]}"
CATEGORY_FILTER="${2:-}"
LIMIT="${3:-0}"

# Extract bank list from CSV using Node.js
# Handles unquoted commas in bank names by scanning for known category values
BANK_LIST=$(node --input-type=module << JSEOF
import { readFileSync } from "fs";

const KNOWN_CATEGORIES = new Set([
  "Public Sector Bank",
  "Private Sector Bank (Indian)",
  "Private Sector Bank",
  "Small Finance Bank",
  "Payments Bank",
  "Foreign Bank",
  "Regional Rural Bank",
  "Scheduled Urban Co-operative Bank",
  "Non-Scheduled Urban Co-operative Bank",
  "Scheduled State Co-operative Bank",
  "Non-Scheduled State Co-operative Bank",
  "District Central Co-operative Bank",
  "Local Area Bank",
  "Financial Institution",
]);

function parseCSVLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      fields.push(field.trim());
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field.trim());
  return fields;
}

function findCategoryInRow(fields) {
  for (let i = 2; i < fields.length; i++) {
    const val = fields[i]?.trim();
    if (KNOWN_CATEGORIES.has(val)) {
      const nameParts = fields.slice(1, i).map(f => f.trim());
      const name = nameParts.join(", ").replace(/,\s*$/, "").trim();
      const state = fields[i + 1]?.trim() || "";
      return { name, category: val, state };
    }
  }
  return null;
}

const csvFile = "${CSV_FILE}";
const categoryFilter = "${CATEGORY_FILTER}";
const limit = ${LIMIT};

const raw = readFileSync(csvFile, "utf-8");
const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
const lines = text.split(/\r?\n/).filter(l => l.trim());

const banks = [];
for (let i = 1; i < lines.length; i++) {
  const fields = parseCSVLine(lines[i]);

  let name = fields[1]?.trim();
  let category = fields[2]?.trim();
  let state = fields[3]?.trim() || "";

  if (!KNOWN_CATEGORIES.has(category)) {
    const found = findCategoryInRow(fields);
    if (found) {
      name = found.name;
      category = found.category;
      state = found.state;
    } else {
      continue;
    }
  }

  if (!name || !category) continue;
  if (categoryFilter && category !== categoryFilter) continue;

  banks.push({ name, category, state });
  if (limit > 0 && banks.length >= limit) break;
}

console.log(JSON.stringify(banks));
JSEOF
)

TOTAL=$(echo "$BANK_LIST" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).length))")

echo "============================================"
echo " Batch Rate Discovery"
echo "============================================"
echo " Source:   $CSV_FILE"
echo " Filter:  ${CATEGORY_FILTER:-All categories}"
echo " Limit:   ${LIMIT:-No limit}"
echo " Banks:   $TOTAL"
echo "============================================"
echo ""

mkdir -p output

# Process each bank
echo "$BANK_LIST" | node -e "
  process.stdin.resume();
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    const banks = JSON.parse(d);
    for (const b of banks) {
      // Tab-separated for easy bash parsing
      console.log(b.name + '\t' + b.category + '\t' + b.state);
    }
  });
" | while IFS=$'\t' read -r NAME CATEGORY STATE; do
    echo ""
    echo ">>> Processing: $NAME"
    echo "    Category:   $CATEGORY"
    echo "    State:      $STATE"
    echo ""

    # Run discovery (continue on failure)
    ./run-discovery.sh "$NAME" "$CATEGORY" "$STATE" || {
        echo "!!! FAILED for $NAME — continuing with next bank"
    }

    # Be respectful — small delay between banks
    sleep 2
done

echo ""
echo "============================================"
echo " Batch complete. Results in output/"
echo "============================================"

# Generate summary
echo ""
echo "=== Summary ==="
ls -1 output/*_config.json 2>/dev/null | while read f; do
    CODE=$(basename "$f" _config.json)
    HAS_RATES="No"
    if [ -f "output/${CODE}_rates.json" ]; then
        SLABS=$(node -e "const d=JSON.parse(require('fs').readFileSync('output/${CODE}_rates.json','utf8')); console.log((d.rate_slabs||[]).length)" 2>/dev/null || echo "0")
        [ "$SLABS" -gt 0 ] && HAS_RATES="Yes ($SLABS slabs)"
    fi
    echo "  $CODE: rates=$HAS_RATES"
done

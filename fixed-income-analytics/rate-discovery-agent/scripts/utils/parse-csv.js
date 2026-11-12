/**
 * CSV parsing utilities for the RBI bank list.
 *
 * Handles quoted fields with internal commas (e.g., "Bank Name, City")
 * and auto-detects shifted columns by scanning for known categories.
 */

const fs = require("fs");

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
  "IFSC Banking Unit (IFSCA)",
  "Housing Finance Company",
]);

/**
 * Parse a single CSV line, respecting quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function parseCSVLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) {
      fields.push(field.trim());
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field.trim());
  return fields;
}

/**
 * Load the RBI bank list CSV and return parsed bank records.
 *
 * CSV format: Sr. No., Bank Name, Category, State / Country, City, Notes
 * Handles quoted bank names with commas by scanning for known categories.
 *
 * @param {string} filePath - Path to the CSV file
 * @param {object} [options]
 * @param {string} [options.categoryFilter] - Filter by category (case-insensitive substring match)
 * @returns {Array<{name: string, category: string, state: string}>}
 */
function loadBanksCSV(filePath, options = {}) {
  const { categoryFilter } = options;

  let raw = fs.readFileSync(filePath, "utf-8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const banks = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    let name = fields[1]?.trim();
    let category = fields[2]?.trim();
    let state = fields[3]?.trim() || "";

    // If category isn't recognized, scan rightward for a known category
    // (handles bank names with commas that shift columns)
    if (!KNOWN_CATEGORIES.has(category)) {
      let found = false;
      for (let j = 2; j < fields.length; j++) {
        if (KNOWN_CATEGORIES.has(fields[j]?.trim())) {
          name = fields
            .slice(1, j)
            .map((f) => f.trim())
            .join(", ")
            .replace(/,\s*$/, "")
            .trim();
          category = fields[j].trim();
          state = fields[j + 1]?.trim() || "";
          found = true;
          break;
        }
      }
      if (!found) continue;
    }

    if (!name || !category) continue;
    if (categoryFilter && !category.toLowerCase().includes(categoryFilter.toLowerCase())) continue;

    banks.push({ name, category, state });
  }

  return banks;
}

module.exports = { parseCSVLine, loadBanksCSV, KNOWN_CATEGORIES };

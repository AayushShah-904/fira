/**
 * Generate a URL-safe slug from a bank name.
 * E.g., "State Bank of India" → "state-bank-of-india"
 *
 * Canonical implementation: packages/api/src/lib/helpers.ts
 * This is a CommonJS port for use by the rate-discovery-agent scripts.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")   // remove non-word chars except spaces and hyphens
    .replace(/[\s_]+/g, "-")    // spaces and underscores to hyphens
    .replace(/-+/g, "-")        // collapse multiple hyphens
    .replace(/^-|-$/g, "");     // trim leading/trailing hyphens
}

module.exports = { slugify };

// CLI mode: node scripts/utils/slugify.js "Bank Name"
if (require.main === module) {
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.error("Usage: node scripts/utils/slugify.js <bank name>");
    process.exit(1);
  }
  console.log(slugify(input));
}

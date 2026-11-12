/**
 * Generate a URL-safe slug from a bank name.
 * E.g., "State Bank of India" → "state-bank-of-india"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // remove non-word chars except spaces and hyphens
    .replace(/[\s_]+/g, "-") // spaces and underscores to hyphens
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
}

/**
 * HTML normalization for change detection.
 * Strips dynamic content that changes on every request without meaning rate data changed.
 */

/**
 * Normalize HTML content for hashing — remove elements that change
 * on every request but don't indicate rate data changes.
 */
export function normalizeHtml(html: string): string {
  let text = html;

  // Strip <script> tags and content
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Strip <style> tags and content
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Strip <noscript> tags and content
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Strip HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Remove all attributes except class and id (strips tokens, nonces, hashes)
  text = text.replace(/<(\w+)\s+[^>]*?>/g, (match, tag: string) => {
    const classMatch = match.match(/class="([^"]*)"/);
    const idMatch = match.match(/id="([^"]*)"/);
    const parts = [`<${tag}`];
    if (idMatch) parts.push(`id="${idMatch[1]}"`);
    if (classMatch) parts.push(`class="${classMatch[1]}"`);
    return parts.join(" ") + ">";
  });

  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

/**
 * Create a content fingerprint for a PDF file using metadata.
 * Avoids downloading the full file — uses HTTP HEAD response headers.
 */
export function pdfFingerprint(
  contentLength: string | null,
  lastModified: string | null,
  etag: string | null,
): string {
  return [contentLength ?? "", lastModified ?? "", etag ?? ""].join("|");
}

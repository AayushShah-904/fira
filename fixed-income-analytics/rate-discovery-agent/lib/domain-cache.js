/**
 * Incremental domain cache updater.
 *
 * Updates a single bank's entry in data/bank-domains.json after a
 * successful discovery run. Used by run-discovery.js post-run hook
 * and by scripts/sync-domains.js for bulk backfill.
 */

const fs = require("fs");
const path = require("path");
const { StorageNotFoundError } = require("./storage");
const { safeWriteArtifact } = require("./safe-write");

/**
 * Update bank-domains.json with a single bank's discovered data.
 * Existing non-null values are preserved; new values fill gaps.
 *
 * @param {object} opts
 * @param {string} opts.bankCode - Canonical bank slug
 * @param {object} opts.config - The bank's config object (from _config.json)
 * @param {string} opts.domainsFile - Path to bank-domains.json (used as the
 *   source-of-truth path in fs mode; converted to a Storage key when
 *   `storage` is provided).
 * @param {object} [opts.storage] - Optional Storage adapter; when present,
 *   reads/writes go through it instead of direct fs.
 * @param {string} [opts.projectRoot] - Project root used to derive the storage
 *   key from `domainsFile`. Required when `storage` is set.
 * @param {object} [opts.logger] - Logger instance
 * @returns {Promise<{wrote: boolean, noChange?: boolean, skipped?: string}>}
 *   - `wrote: true` when the registry was updated (fs or storage path).
 *   - `wrote: false, noChange: true` when the merge produced no diff.
 *   - `wrote: false, skipped: <reason>` when the entry was skipped pre-merge (no website, manual scraper_type, unparseable domain).
 *   Older callers that ignore the return value continue to work — the function used to return void.
 */
async function updateDomainEntry({ bankCode, config, domainsFile, storage, projectRoot, logger }) {
  if (config.scraper_type === "manual") {
    return { wrote: false, skipped: "manual scraper_type" };
  }

  // Read registry up-front so partial updates (e.g., A7 with rate_pages but
  // no domain) can inherit the existing domain. The earlier short-circuit on
  // !config.website rejected legitimate orchestrator calls that pass rate_pages
  // after find_website's domain was committed in a prior step.
  let domains = {};
  if (storage) {
    const key = storageKeyFromPath(domainsFile, projectRoot);
    if (!key) {
      if (logger) logger.warn(`domain-cache: cannot derive storage key from ${domainsFile}; falling back to fs`);
    } else {
      try {
        domains = await storage.readJson(key);
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          // First run — file doesn't exist yet; start fresh
        } else {
          if (logger) logger.warn(`Could not read bank-domains.json from storage (${err.message}), creating fresh`);
        }
      }
    }
  } else {
    try {
      if (fs.existsSync(domainsFile)) {
        domains = JSON.parse(fs.readFileSync(domainsFile, "utf-8"));
      }
    } catch {
      if (logger) logger.warn("Could not read bank-domains.json, creating fresh");
    }
  }

  const existing = domains[bankCode] || {};

  // Resolve the effective domain: prefer the incoming website, fall back to
  // what the registry already records for this bank.
  let domain = config.website ? extractDomain(config.website) : null;
  if (!domain && existing.domain) {
    domain = existing.domain;
  }
  if (!domain) {
    return { wrote: false, skipped: "no website and no prior registry entry" };
  }

  // Convert full URLs to relative paths
  const ratePages = {};
  const urls = config.rate_page_urls || {};
  for (const [key, fullUrl] of Object.entries(urls)) {
    if (fullUrl) {
      ratePages[key] = toRelativePath(fullUrl, domain);
    } else if (fullUrl === null) {
      ratePages[key] = null; // explicitly searched, not found
    }
  }

  // Merge: existing non-null wins
  const mergedRatePages = { ...(existing.rate_pages || {}) };
  for (const [key, val] of Object.entries(ratePages)) {
    if (mergedRatePages[key] === undefined) {
      mergedRatePages[key] = val;
    } else if (mergedRatePages[key] === null && val !== null) {
      mergedRatePages[key] = val;
    }
  }

  // Start with the FULL existing entry so operator-curated fields
  // (extraction_method, extraction_notes, rate_pdfs, confidence,
  // last_discovered_at, discovery_status, notes, ...) survive. Only fields
  // the agent learned this run override.
  const entry = {
    ...existing,
    domain: existing.domain || domain,
    ...(Object.keys(mergedRatePages).length > 0 ? { rate_pages: mergedRatePages } : {}),
    scraper_type: existing.scraper_type || config.scraper_type || existing.scraper_type,
  };
  if (!entry.domain_source && !existing.domain) entry.domain_source = "discovered";

  // Check if anything changed
  if (JSON.stringify(existing) === JSON.stringify(entry)) return { wrote: false, noChange: true };

  domains[bankCode] = entry;

  // Sort for stable diffs
  const sorted = {};
  for (const key of Object.keys(domains).sort()) {
    sorted[key] = domains[key];
  }

  if (storage) {
    const key = storageKeyFromPath(domainsFile, projectRoot);
    if (key) {
      await storage.writeJson(key, sorted);
      if (logger) logger.debug(`Updated bank-domains.json (storage): ${bankCode} → ${domain}`);
      return { wrote: true };
    }
    // Fall through to fs if key derivation failed (warning was already logged on the read side).
  }
  safeWriteArtifact({ path: domainsFile, incoming: sorted, kind: 'registry-file', source: 'agent', logger });
  if (logger) logger.debug(`Updated bank-domains.json: ${bankCode} → ${domain}`);
  return { wrote: true };
}

/**
 * Derive a Storage key from a project-relative or absolute filesystem path.
 * Returns null if the path is outside the project root or contains key-incompatible chars.
 */
function storageKeyFromPath(filePath, projectRoot) {
  if (!filePath || !projectRoot) return null;
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const key = rel.split(path.sep).join("/").toLowerCase();
  if (!key || key.endsWith("/") || /[?#\\\x00-\x1f\x7f]/.test(key) || /\/\//.test(key)) return null;
  return key;
}

/** Extract domain from a full URL, stripping www. */
function extractDomain(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Convert a full URL to a relative path given a domain. */
function toRelativePath(fullUrl, domain) {
  if (!fullUrl || !domain) return null;
  try {
    const u = new URL(fullUrl);
    if (u.hostname.replace(/^www\./, "") !== domain) return null;
    return u.pathname + u.search + u.hash || "/";
  } catch {
    return null;
  }
}

module.exports = { updateDomainEntry, extractDomain, toRelativePath };

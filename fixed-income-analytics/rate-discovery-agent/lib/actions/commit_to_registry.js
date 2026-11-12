'use strict';

/**
 * Action: commit_to_registry — update `data/bank-domains.json` with a single
 * bank's discovered or refined fields per ADR-011's confidence-aware merge
 * intent.
 *
 * Sprint 003 #1a contract — see sdlc/sprints/sprint-003/design/action-contracts.md (A7).
 *
 * Thin adapter over `lib/domain-cache.js::updateDomainEntry` which already
 * implements existing-non-null-wins merge + atomic safe-write via
 * `safeWriteArtifact` (kind='registry-file'). Confidence-aware merge and the
 * `bank-domains-pending.json` sidecar from ADR-011 are not yet implemented —
 * the contract field `deferred_to_pending` is wired for forward-compat and
 * currently always returns false. The pending-sidecar writer ships in
 * Sprint 003 #3 (operator resolution tooling).
 *
 * Input:
 *   {
 *     bank_code:    string,                           // canonical slug
 *     updates: {
 *       domain?:    string,                           // homepage URL (e.g. "https://abbl.com" or "abbl.com")
 *       confidence?:"high"|"medium"|"low"|"none",
 *       rate_pages?:{ fd?, fd_nre?, fd_nro?, fd_fcnr?, fd_nri_combined?, savings?, rd? },
 *                                                     // values may be full URLs or relative paths;
 *                                                     // updateDomainEntry stores them as relative paths
 *       scraper_type?: string,
 *       discovery_metadata?: { last_discovered_at?, discovery_method?, notes? },
 *     },
 *     domains_file: string,                           // absolute path to bank-domains.json
 *     storage?:     object,                           // optional Storage adapter for cloud mode
 *     project_root?:string,                           // required if storage is set
 *     logger?:      object,
 *   }
 *
 * Output:
 *   {
 *     ok: true,
 *     wrote: boolean,                                 // false on no-change or skip
 *     deferred_to_pending: boolean,                   // always false today (see header)
 *     pending_path?: string,
 *     reason?: string,                                // populated when wrote=false (e.g. "no_change", "no_website")
 *   }
 */

const path = require('node:path');

const { updateDomainEntry } = require('../domain-cache');
const { slugify: canonicalSlugify } = require('../../scripts/utils/slugify');

const VALID_CONFIDENCE = new Set(['high', 'medium', 'low', 'none']);

async function commitToRegistry(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('commitToRegistry: input must be an object');
  }
  const { bank_code, updates, domains_file, storage, project_root, logger } = input;

  if (!bank_code || typeof bank_code !== 'string') {
    throw new Error('commitToRegistry: input.bank_code is required (canonical slug)');
  }
  const canonical = canonicalSlugify(bank_code);
  if (canonical !== bank_code) {
    throw new Error(`commitToRegistry: input.bank_code "${bank_code}" is not canonical (would slugify to "${canonical}")`);
  }
  if (!updates || typeof updates !== 'object') {
    throw new Error('commitToRegistry: input.updates must be an object');
  }
  if (!domains_file || typeof domains_file !== 'string') {
    throw new Error('commitToRegistry: input.domains_file is required');
  }
  if (updates.confidence !== undefined && !VALID_CONFIDENCE.has(updates.confidence)) {
    throw new Error(`commitToRegistry: updates.confidence must be one of ${[...VALID_CONFIDENCE].join(', ')} (got "${updates.confidence}")`);
  }

  // Build the synthetic config that updateDomainEntry consumes. The agent's
  // historical pattern is to pass a full _config.json object; here we
  // reconstruct only the fields that drive registry merging.
  const syntheticConfig = buildSyntheticConfig(updates);

  // updateDomainEntry's pre-merge skips: no website or scraper_type=manual.
  // Surface those as ok:true wrote:false reason:<>.
  let result;
  try {
    result = await updateDomainEntry({
      bankCode: bank_code,
      config: syntheticConfig,
      domainsFile: path.resolve(domains_file),
      storage,
      projectRoot: project_root,
      logger,
    });
  } catch (err) {
    throw new Error(`commitToRegistry: updateDomainEntry failed: ${err.message}`);
  }

  // updateDomainEntry returns { wrote, noChange?, skipped? } since 2026-05-16.
  const out = {
    ok: true,
    wrote: !!(result && result.wrote),
    deferred_to_pending: false, // ADR-011 pending sidecar — wired for forward-compat; Sprint 003 #3 implements
  };
  if (result && result.noChange) out.reason = 'no_change';
  else if (result && result.skipped) out.reason = result.skipped;

  return out;
}

/**
 * Compose the config-shaped object that updateDomainEntry expects from the
 * action's delta-style `updates`. Maps:
 *   updates.domain       → config.website  (prefixes https:// if no scheme)
 *   updates.scraper_type → config.scraper_type
 *   updates.rate_pages   → config.rate_page_urls (full URLs reconstructed when domain known)
 *   updates.discovery_metadata + updates.confidence → not consumed by updateDomainEntry today;
 *     a future ADR-011 implementation can read them.
 */
function buildSyntheticConfig(updates) {
  const config = {};
  if (updates.domain) {
    config.website = updates.domain.startsWith('http://') || updates.domain.startsWith('https://')
      ? updates.domain
      : `https://${updates.domain}`;
  }
  if (updates.scraper_type) config.scraper_type = updates.scraper_type;

  if (updates.rate_pages && typeof updates.rate_pages === 'object') {
    config.rate_page_urls = {};
    const host = config.website ? safeHost(config.website) : null;
    for (const [key, val] of Object.entries(updates.rate_pages)) {
      if (val === null) {
        config.rate_page_urls[key] = null; // explicitly searched, not found
      } else if (typeof val === 'string' && val.length > 0) {
        // Pass through full URLs as-is; updateDomainEntry strips them to paths.
        // For relative paths, prefix with the host so updateDomainEntry's
        // toRelativePath() can re-strip back to the same value.
        if (val.startsWith('http://') || val.startsWith('https://')) {
          config.rate_page_urls[key] = val;
        } else if (host) {
          const prefixed = val.startsWith('/') ? val : '/' + val;
          config.rate_page_urls[key] = `https://${host}${prefixed}`;
        } else {
          // No host context — best-effort: pass through, updateDomainEntry's
          // toRelativePath() will return null and the entry just won't include it.
          config.rate_page_urls[key] = val;
        }
      }
    }
  }

  // Carry through metadata for future ADR-011 confidence-aware merge.
  if (updates.discovery_metadata && typeof updates.discovery_metadata === 'object') {
    config.discovery_metadata = updates.discovery_metadata;
  }
  if (updates.confidence) {
    config.discovery_metadata = { ...(config.discovery_metadata || {}), confidence: updates.confidence };
  }

  return config;
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

module.exports = { commitToRegistry, buildSyntheticConfig };

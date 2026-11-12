'use strict';

/**
 * Extractor dispatcher — Sprint 005 Phase C.
 *
 * Resolves a bank's templateId into a concrete extractor module. Falls back to
 * structurally-compatible defaults when no templateId is set, and surfaces a
 * "needs_template_authoring" signal when the LLM-fallback path engages.
 *
 * Design: ../../sdlc/sprints/sprint-005/design/extractor-registry.md
 */

const path = require('node:path');

// Registry — each entry is { template_id, module_path, applies_to }.
// Module is lazy-required so adding new extractors doesn't slow down startup
// for callers that only use one or two.
//
// Sprint 6 Step 3b adds the four new template extractors + the two fallback
// modules (_generic-html-3col, _llm-fallback). Order matters for the fallback
// chain — first match wins when templateId is explicit; the implicit chain
// walks _generic-html-3col before _llm-fallback when no templateId given.
const REGISTRY = [
  // Sprint 5 — first shipped extractor
  { template_id: 'coop-bankin-3col-tenure-general-senior', module_path: './coop-bankin-3col-tenure-general-senior' },
  // Sprint 6 Step 3b — new template extractors (PSB / PVB / FB / IBU)
  { template_id: 'psb-pdf-rate-card-3col',  module_path: './psb-pdf-rate-card-3col' },
  { template_id: 'pvb-multi-variant',       module_path: './pvb-multi-variant' },
  { template_id: 'fb-multi-variant',        module_path: './fb-multi-variant' },
  { template_id: 'ibu-static-pdf-quarterly', module_path: './ibu-static-pdf-quarterly' },
  // Sprint 6 Step 3a — fallback chain
  { template_id: '_generic-html-3col', module_path: './_generic-html-3col' },
  { template_id: '_llm-fallback',      module_path: './_llm-fallback' },
];

const REGISTRY_BY_ID = new Map(REGISTRY.map((e) => [e.template_id, e]));

/**
 * @param {object} input
 * @param {string} [input.templateId]   from bank-domains.json template.extract.extractor
 * @param {string} input.kind            'html_static' | 'html_js' | 'pdf' | 'image'
 * @param {object} [input.fingerprint]   optional — { template_hash } from lib/templating/fingerprint
 * @param {object} [input.productContext] {bank_code, bank_type, variant, ...}
 * @returns {{
 *   extractor:           function | null,   // the extract(ctx) function, or null if no match
 *   template_id:         string | null,
 *   resolution:          'registry' | 'fallback-generic' | 'fallback-llm' | 'unresolved',
 *   needs_template_authoring: boolean,
 *   reason:              string,
 * }}
 */
function pickExtractor({ templateId, kind, fingerprint, productContext } = {}) {
  // 1. Explicit templateId from bank-domains.json
  if (templateId) {
    const entry = REGISTRY_BY_ID.get(templateId);
    if (entry) {
      // eslint-disable-next-line global-require
      const mod = require(entry.module_path);
      const acceptable = !mod.applies_to || !mod.applies_to.kinds || mod.applies_to.kinds.includes(kind);
      if (!acceptable) {
        return {
          extractor: null,
          template_id: templateId,
          resolution: 'unresolved',
          needs_template_authoring: false,
          reason: `template "${templateId}" does not apply to kind="${kind}" (declares kinds=${JSON.stringify(mod.applies_to.kinds)})`,
        };
      }
      return {
        extractor: mod.extract,
        template_id: templateId,
        resolution: 'registry',
        needs_template_authoring: false,
        reason: `matched template_id="${templateId}" from registry`,
      };
    }
    // templateId set but not in registry — extractor module not yet shipped.
    return {
      extractor: null,
      template_id: templateId,
      resolution: 'unresolved',
      needs_template_authoring: false,
      reason: `template_id="${templateId}" declared in bank-domains.json but no matching extractor module in lib/extractors/`,
    };
  }

  // 2. Sprint 6 Step 3a: real fallback chain.
  //    No templateId → try _generic-html-3col for html_static / html_js kinds.
  //    If kind is incompatible (pdf-text, image), skip directly to _llm-fallback.
  if (kind === 'html_static' || kind === 'html_js') {
    // eslint-disable-next-line global-require
    const generic = require('./_generic-html-3col');
    return {
      extractor: generic.extract,
      template_id: '_generic-html-3col',
      resolution: 'fallback-generic',
      needs_template_authoring: true,
      reason: 'no templateId — falling back to _generic-html-3col. Operator should author a template via scripts/author-template.js.',
    };
  }

  // 3. Last resort: _llm-fallback. Implements the contract; today returns 0
  //    slabs with explicit needs_template_authoring signal (Sprint 7 wires
  //    the real AOAI integration). Per design/extract-html-table-split.md.
  // eslint-disable-next-line global-require
  const llmFallback = require('./_llm-fallback');
  return {
    extractor: llmFallback.extract,
    template_id: '_llm-fallback',
    resolution: 'fallback-llm',
    needs_template_authoring: true,
    reason: `no templateId — kind="${kind}" not compatible with _generic-html-3col, routing to _llm-fallback (stubbed in Sprint 6; AOAI wiring is Sprint 7). Operator should author a template via scripts/author-template.js.`,
  };
}

/**
 * Convenience: list every registered template_id. Used by tests and by the
 * authoring CLI to suggest reusable templates.
 */
function listRegistered() {
  return REGISTRY.map((e) => e.template_id);
}

module.exports = {
  pickExtractor,
  listRegistered,
  REGISTRY,
};

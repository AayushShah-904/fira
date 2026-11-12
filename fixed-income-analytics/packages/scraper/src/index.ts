/**
 * @bird/scraper — Scraping pipeline for BIRD
 *
 * Hybrid architecture:
 * - Rate-discovery-agent handles extraction (HTML/JS/PDF)
 * - This package handles: change detection, import, validation, scheduling
 */
export const VERSION = "0.2.0";

export { createDb } from "./db.js";
export { runImport, printSummary } from "./import/import-discovery.js";
export { detectChanges } from "./change-detector/index.js";
export {
  validateImport,
  validateFormat,
  validateRange,
  validateDelta,
  validateMonotonicity,
  validateCompleteness,
  validateStaleness,
} from "./validators/index.js";

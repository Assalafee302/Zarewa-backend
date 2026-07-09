/**
 * AI Intelligence Router — confidence scoring for routing decisions.
 *
 * @module server/aiIntelligenceRouter/services/confidenceService
 */

/** @typedef {'auto' | 'suggest' | 'fallback'} ResponseMode */

export const CONFIDENCE_HIGH = 0.75;
export const CONFIDENCE_MEDIUM = 0.45;

/**
 * Extract top search relevance score from knowledge search results.
 *
 * @param {Array<Record<string, unknown>>} records
 * @returns {number}
 */
export function computeSearchConfidence(records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return 0;

  const top = list[0];
  const candidates = [
    top.searchScore,
    top.semanticScore,
    top.keywordScore,
  ].map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);

  if (candidates.length) return Math.max(0, Math.min(1, Math.max(...candidates)));

  return Math.max(0.25, Math.min(0.55, 0.5 / list.length + 0.2));
}

/**
 * Combine intent and search confidence into a single routing confidence.
 *
 * @param {number} intentConfidence
 * @param {number} searchConfidence
 * @returns {{ combinedConfidence: number; intentConfidence: number; searchConfidence: number }}
 */
export function computeCombinedConfidence(intentConfidence, searchConfidence) {
  const ic = Math.max(0, Math.min(1, Number(intentConfidence) || 0));
  const sc = Math.max(0, Math.min(1, Number(searchConfidence) || 0));
  const combinedConfidence = ic * 0.4 + sc * 0.6;
  return { combinedConfidence, intentConfidence: ic, searchConfidence: sc };
}

/**
 * Map combined confidence to response mode.
 *
 * @param {number} combinedConfidence
 * @returns {ResponseMode}
 */
export function resolveResponseMode(combinedConfidence) {
  const c = Number(combinedConfidence) || 0;
  if (c >= CONFIDENCE_HIGH) return 'auto';
  if (c >= CONFIDENCE_MEDIUM) return 'suggest';
  return 'fallback';
}

/**
 * Limit results based on response mode.
 *
 * @param {Array<unknown>} records
 * @param {ResponseMode} mode
 * @returns {unknown[]}
 */
export function trimResultsForMode(records, mode) {
  const list = Array.isArray(records) ? records : [];
  if (mode === 'auto') return list.slice(0, 3);
  if (mode === 'suggest') return list.slice(0, 3);
  return list.slice(0, 5);
}

/**
 * Build human-readable explanation for the routing decision.
 *
 * @param {object} opts
 */
export function buildRoutingExplanation(opts) {
  const parts = [
    `Intent: ${opts.intent} (${Math.round((opts.intentConfidence || 0) * 100)}%)`,
    `Search relevance: ${Math.round((opts.searchConfidence || 0) * 100)}%`,
    `Route: ${opts.routeUsed}`,
    `Mode: ${opts.mode}`,
  ];
  if (opts.fallbackUsed) parts.push('Used fallback routing.');
  return parts.join(' · ');
}

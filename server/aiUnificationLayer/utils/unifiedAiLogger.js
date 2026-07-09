/**
 * Structured logging for the unified AI orchestration layer.
 *
 * @module server/aiUnificationLayer/utils/unifiedAiLogger
 */

/**
 * @param {string} event
 * @param {Record<string, unknown>} [meta]
 */
export function logUnified(event, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    ...meta,
  };
  console.info(`[ai-unified] ${event}`, JSON.stringify(payload));
}

/**
 * @param {object} opts
 */
export function logUnifiedQueryComplete(opts = {}) {
  logUnified('query_complete', {
    source: opts.source,
    moduleOrigin: opts.moduleOrigin,
    fallbackChain: opts.fallbackChain,
    confidence: opts.confidence,
    mode: opts.mode,
    latencyMs: opts.latencyMs,
    fallbackUsed: Boolean(opts.fallbackUsed),
    intent: opts.intent,
    routeUsed: opts.routeUsed,
  });
}

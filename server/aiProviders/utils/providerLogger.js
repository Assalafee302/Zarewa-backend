/**
 * Structured logging for AI provider layer.
 *
 * @module server/aiProviders/utils/providerLogger
 */

/**
 * @param {string} event
 * @param {Record<string, unknown>} [meta]
 */
export function logProvider(event, meta = {}) {
  console.info(`[ai-provider] ${event}`, JSON.stringify({ ts: new Date().toISOString(), ...meta }));
}

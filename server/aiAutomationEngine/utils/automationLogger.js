/**
 * Structured logging for AI automation engine.
 *
 * @module server/aiAutomationEngine/utils/automationLogger
 */

/**
 * @param {string} event
 * @param {Record<string, unknown>} [meta]
 */
export function logAutomation(event, meta = {}) {
  console.info(`[ai-automation] ${event}`, JSON.stringify({ ts: new Date().toISOString(), ...meta }));
}

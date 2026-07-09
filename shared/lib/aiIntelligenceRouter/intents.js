/**
 * AI Intelligence Router — intent identifiers.
 *
 * @module shared/lib/aiIntelligenceRouter/intents
 */

/** @typedef {'SOP_REQUEST' | 'SQL_REQUEST' | 'TROUBLESHOOTING' | 'GLOSSARY_LOOKUP' | 'CONVERSATION_CHAT' | 'UNKNOWN'} RouterIntent */

/** @readonly */
export const ROUTER_INTENTS = Object.freeze({
  SOP_REQUEST: 'SOP_REQUEST',
  SQL_REQUEST: 'SQL_REQUEST',
  TROUBLESHOOTING: 'TROUBLESHOOTING',
  GLOSSARY_LOOKUP: 'GLOSSARY_LOOKUP',
  CONVERSATION_CHAT: 'CONVERSATION_CHAT',
  UNKNOWN: 'UNKNOWN',
});

/** @type {ReadonlySet<string>} */
export const ROUTER_INTENT_VALUES = new Set(Object.values(ROUTER_INTENTS));

/**
 * @param {string} intent
 * @returns {boolean}
 */
export function isRouterIntent(intent) {
  return ROUTER_INTENT_VALUES.has(String(intent || '').trim());
}

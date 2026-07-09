/**
 * AI Intelligence Router — maps intents to Knowledge Center search strategies.
 *
 * @module server/aiIntelligenceRouter/services/routingEngineService
 */

import { KNOWLEDGE_TYPES } from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';
import { ROUTER_INTENTS } from '../../../shared/lib/aiIntelligenceRouter/intents.js';

/** @typedef {import('../../../shared/lib/aiIntelligenceRouter/intents.js').RouterIntent} RouterIntent */

/**
 * @typedef {object} RoutePlan
 * @property {string} routeUsed
 * @property {string} searchMode
 * @property {string} [knowledgeType]
 * @property {string} [module]
 * @property {number} limit
 * @property {boolean} highRecall
 * @property {boolean} useLlmSynthesis
 * @property {string} description
 */

/**
 * Build search execution plan from classified intent.
 *
 * @param {RouterIntent} intent
 * @param {object} [context]
 * @returns {RoutePlan}
 */
export function buildRoutePlan(intent, context = {}) {
  const module = String(context.suggestedModule || context.module || 'general').trim() || 'general';

  switch (intent) {
    case ROUTER_INTENTS.SOP_REQUEST:
      return {
        routeUsed: 'knowledge_sop_search',
        searchMode: 'hybrid',
        knowledgeType: KNOWLEDGE_TYPES.SOP_ARTICLE,
        module: module !== 'general' ? module : undefined,
        limit: 10,
        highRecall: false,
        useLlmSynthesis: true,
        description: 'SOP and workflow guides via hybrid Knowledge Center search.',
      };

    case ROUTER_INTENTS.SQL_REQUEST:
      return {
        routeUsed: 'knowledge_sql_examples',
        searchMode: 'keyword',
        knowledgeType: KNOWLEDGE_TYPES.SQL_EXAMPLE,
        module: undefined,
        limit: 8,
        highRecall: false,
        useLlmSynthesis: false,
        description: 'Read-only SQL examples from Knowledge Center.',
      };

    case ROUTER_INTENTS.TROUBLESHOOTING:
      return {
        routeUsed: 'knowledge_troubleshoot_semantic',
        searchMode: 'hybrid',
        knowledgeType: KNOWLEDGE_TYPES.TROUBLESHOOTING_EXAMPLE,
        module: module !== 'general' ? module : undefined,
        limit: 15,
        highRecall: true,
        useLlmSynthesis: true,
        description: 'High-recall hybrid search for troubleshooting patterns.',
      };

    case ROUTER_INTENTS.GLOSSARY_LOOKUP:
      return {
        routeUsed: 'knowledge_glossary',
        searchMode: 'hybrid',
        knowledgeType: KNOWLEDGE_TYPES.GLOSSARY_TERM,
        module: undefined,
        limit: 8,
        highRecall: false,
        useLlmSynthesis: true,
        description: 'Glossary term lookup via Knowledge Center.',
      };

    case ROUTER_INTENTS.CONVERSATION_CHAT:
      return {
        routeUsed: 'conversation_llm_placeholder',
        searchMode: 'none',
        knowledgeType: undefined,
        module: undefined,
        limit: 0,
        highRecall: false,
        useLlmSynthesis: true,
        description: 'Conversational response via LLM synthesis layer (placeholder).',
      };

    case ROUTER_INTENTS.UNKNOWN:
    default:
      return {
        routeUsed: 'knowledge_hybrid_fallback',
        searchMode: 'hybrid',
        knowledgeType: undefined,
        module: module !== 'general' ? module : undefined,
        limit: 10,
        highRecall: true,
        useLlmSynthesis: true,
        description: 'Hybrid Knowledge Center search fallback.',
      };
  }
}

/**
 * Build Knowledge Center search payload from route plan.
 *
 * @param {string} query
 * @param {RoutePlan} plan
 */
export function buildSearchPayload(query, plan) {
  if (plan.searchMode === 'none') return null;

  /** @type {Record<string, unknown>} */
  const payload = {
    query,
    mode: plan.searchMode,
    limit: plan.limit,
  };

  if (plan.knowledgeType) payload.knowledgeType = plan.knowledgeType;
  if (plan.module) payload.module = plan.module;

  return payload;
}

/**
 * Fallback plan when primary route returns no results.
 *
 * @param {object} [context]
 * @returns {RoutePlan}
 */
export function buildFallbackRoutePlan(context = {}) {
  return buildRoutePlan(ROUTER_INTENTS.UNKNOWN, context);
}

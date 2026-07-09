/**
 * AI Intelligence Router — core orchestration service.
 *
 * @module server/aiIntelligenceRouter/services/aiRouterService
 */

import { KNOWLEDGE_TYPES } from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';
import { ROUTER_INTENTS } from '../../../shared/lib/aiIntelligenceRouter/intents.js';
import { searchKnowledge } from '../../aiKnowledgeCenter/services/knowledgeSearchService.js';
import {
  buildRoutingExplanation,
  computeCombinedConfidence,
  computeSearchConfidence,
  resolveResponseMode,
  trimResultsForMode,
} from './confidenceService.js';
import {
  calculateIntentConfidence,
  detectIntent,
} from './intentClassifierService.js';
import {
  buildFallbackRoutePlan,
  buildRoutePlan,
  buildSearchPayload,
} from './routingEngineService.js';
import {
  synthesizeAnswer,
  synthesizeConversationReply,
} from './llmSynthesizerService.js';
import {
  getRouterAnalytics,
  insertRouterQueryLog,
  newRouterLogId,
} from '../repository/routerAnalyticsRepository.js';

/**
 * Analyze query and context without executing search.
 *
 * @param {string} query
 * @param {object} [context]
 */
export function analyzeQuery(query, context = {}) {
  const intentResult = detectIntent(query, context);
  const plan = buildRoutePlan(intentResult.intent, {
    ...context,
    suggestedModule: intentResult.suggestedModule,
  });
  return {
    query: String(query || '').trim(),
    intent: intentResult.intent,
    intentConfidence: calculateIntentConfidence(intentResult),
    matchedKeywords: intentResult.matchedKeywords,
    suggestedModule: intentResult.suggestedModule,
    routePlan: plan,
    intentScores: intentResult.scores,
  };
}

/**
 * Execute knowledge search for a route plan; optional SOP FAQ widen.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {import('./routingEngineService.js').RoutePlan} plan
 */
async function executeKnowledgeSearch(db, query, plan) {
  const payload = buildSearchPayload(query, plan);
  if (!payload) return { records: [], searchMeta: null };

  let result = await searchKnowledge(db, payload);

  if (
    plan.knowledgeType === KNOWLEDGE_TYPES.SOP_ARTICLE &&
    (!result.records?.length || result.records.length < 2)
  ) {
    const faqResult = await searchKnowledge(db, {
      ...payload,
      knowledgeType: KNOWLEDGE_TYPES.OPERATIONAL_FAQ,
    });
    const seen = new Set((result.records || []).map((r) => r.id));
    const merged = [...(result.records || [])];
    for (const rec of faqResult.records || []) {
      if (!seen.has(rec.id)) merged.push(rec);
    }
    result = { ...result, records: merged, total: merged.length };
  }

  return { records: result.records || [], searchMeta: result };
}

/**
 * Execute routed search and optional synthesis.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('../../../shared/lib/aiIntelligenceRouter/intents.js').RouterIntent} intent
 * @param {string} query
 * @param {import('./routingEngineService.js').RoutePlan} plan
 * @param {object} [opts]
 */
export async function executeRoute(db, intent, query, plan, opts = {}) {
  let fallbackUsed = false;
  let routeUsed = plan.routeUsed;
  let records = [];
  let searchMeta = null;
  let answer = null;
  let synthesized = false;

  if (intent === ROUTER_INTENTS.CONVERSATION_CHAT) {
    const conv = await synthesizeConversationReply(query);
    return {
      records: [],
      routeUsed: plan.routeUsed,
      fallbackUsed: false,
      searchMeta: null,
      answer: conv.answer,
      synthesized: conv.synthesized,
    };
  }

  const primary = await executeKnowledgeSearch(db, query, plan);
  records = primary.records;
  searchMeta = primary.searchMeta;
  routeUsed = plan.routeUsed;

  if (!records.length && intent !== ROUTER_INTENTS.UNKNOWN) {
    const fallbackPlan = buildFallbackRoutePlan({
      suggestedModule: opts.suggestedModule,
      module: opts.module,
    });
    const fallback = await executeKnowledgeSearch(db, query, fallbackPlan);
    records = fallback.records;
    searchMeta = fallback.searchMeta;
    routeUsed = fallbackPlan.routeUsed;
    fallbackUsed = true;
  }

  if (plan.useLlmSynthesis && records.length) {
    const syn = await synthesizeAnswer(query, records, {
      lowConfidence: opts.mode === 'suggest' || opts.mode === 'fallback',
    });
    answer = syn.answer;
    synthesized = syn.synthesized;
  }

  return { records, routeUsed, fallbackUsed, searchMeta, answer, synthesized };
}

/**
 * Main router entry — classify, route, score, and respond.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} request
 */
export async function routeQuery(db, request) {
  const started = Date.now();
  const query = String(request?.query || '').trim();
  if (!query) {
    return { ok: false, error: 'Query is required.' };
  }

  const userContext = request?.userContext && typeof request.userContext === 'object'
    ? request.userContext
    : {};

  const analysis = analyzeQuery(query, userContext);
  const plan = buildRoutePlan(analysis.intent, {
    ...userContext,
    suggestedModule: analysis.suggestedModule,
  });

  console.info(
    `[ai-router] intent=${analysis.intent} confidence=${analysis.intentConfidence.toFixed(2)} route=${plan.routeUsed} module=${analysis.suggestedModule}`
  );

  const executed = await executeRoute(db, analysis.intent, query, plan, {
    suggestedModule: analysis.suggestedModule,
    module: userContext.module,
  });

  const searchConfidence = computeSearchConfidence(executed.records);
  const { combinedConfidence, intentConfidence } = computeCombinedConfidence(
    analysis.intentConfidence,
    searchConfidence
  );
  const mode = resolveResponseMode(combinedConfidence);
  const results = trimResultsForMode(executed.records, mode);

  let answer = executed.answer;
  if (!answer && mode === 'fallback' && !results.length) {
    answer =
      'I\'m not confident I found the right guide. Try asking *how do I…* with the screen name, or check with your supervisor.';
  } else if (!answer && results.length && mode !== 'auto') {
    const syn = await synthesizeAnswer(query, results, { lowConfidence: true });
    answer = syn.answer;
  }

  const explanation = buildRoutingExplanation({
    intent: analysis.intent,
    intentConfidence,
    searchConfidence,
    routeUsed: executed.routeUsed,
    mode,
    fallbackUsed: executed.fallbackUsed,
  });

  const responseMs = Date.now() - started;

  console.info(
    `[ai-router] complete mode=${mode} combined=${combinedConfidence.toFixed(2)} results=${results.length} fallback=${executed.fallbackUsed} ms=${responseMs}`
  );

  if (db && request?.userId) {
    try {
      insertRouterQueryLog(db, {
        id: newRouterLogId(),
        userId: request.userId,
        queryText: query,
        intent: analysis.intent,
        routeUsed: executed.routeUsed,
        mode,
        confidence: combinedConfidence,
        intentConfidence,
        searchConfidence,
        resultCount: results.length,
        fallbackUsed: executed.fallbackUsed,
        module: analysis.suggestedModule,
        responseMs,
      });
    } catch (e) {
      console.warn('[ai-router] analytics log failed', e?.message || e);
    }
  }

  return {
    ok: true,
    intent: analysis.intent,
    confidence: combinedConfidence,
    intentConfidence,
    searchConfidence,
    routeUsed: executed.routeUsed,
    results,
    answer: answer || null,
    synthesized: Boolean(executed.synthesized),
    explanation,
    mode,
    matchedKeywords: analysis.matchedKeywords,
    suggestedModule: analysis.suggestedModule,
    fallbackUsed: executed.fallbackUsed,
    timingMs: responseMs,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} [days]
 */
export function getRouterAnalyticsSummary(db, days = 30) {
  return { ok: true, analytics: getRouterAnalytics(db, days) };
}

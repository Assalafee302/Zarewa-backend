/**
 * Unified AI orchestration — central connector for Router, Knowledge Center, and Help.
 *
 * Priority (when unified mode enabled):
 *   1. AI Router (confidence ≥ threshold)
 *   2. AI Knowledge Center hybrid search
 *   3. Help system (helpKnowledge.js)
 *   4. Local rule-based response
 *
 * @module server/aiUnificationLayer/services/aiOrchestratorService
 */

import { matchHelpArticles } from '../../../shared/lib/helpKnowledge.js';
import { classifyAgentRoute } from '../../../shared/lib/helpAgentIntent.js';
import { synthesizeHelpReply } from '../../../shared/lib/helpSynthesize.js';
import {
  buildUnifiedResponse,
  helpResultToUnifiedResponse,
  UNIFIED_AI_MODES,
  UNIFIED_AI_ORIGINS,
  UNIFIED_AI_SOURCES,
} from '../../../shared/lib/aiUnification/unifiedResponseTypes.js';
import { routeQuery } from '../../aiIntelligenceRouter/services/aiRouterService.js';
import { CONFIDENCE_MEDIUM } from '../../aiIntelligenceRouter/services/confidenceService.js';
import { searchKnowledge } from '../../aiKnowledgeCenter/services/knowledgeSearchService.js';
import { formatResultsAsDraft } from '../../aiIntelligenceRouter/services/llmSynthesizerService.js';
import { runHelpChat } from '../../helpAgent.js';
import { readUnifiedAiConfig, isUnifiedAiEnabled } from '../config/unifiedAiConfig.js';
import { logUnified, logUnifiedQueryComplete } from '../utils/unifiedAiLogger.js';
import { routeAIRequest } from '../../aiProviders/aiProviderRouter.js';
import { isProviderLayerAvailable } from '../../aiProviders/config/providerConfig.js';

const ERP_AGENT_ROUTES = new Set([
  'erp_data',
  'hybrid',
  'analytics',
  'clearance',
  'coaching',
  'meta',
]);

/**
 * Optional LLM enhancement via multi-provider layer (additive; falls back to draft).
 *
 * @param {string} taskType
 * @param {string} query
 * @param {string} draft
 * @param {object} [context]
 */
async function maybeEnhanceAnswerWithProvider(taskType, query, draft, context = {}) {
  if (!isProviderLayerAvailable() || !draft) return draft;
  try {
    const routed = await routeAIRequest({
      taskType: taskType || 'help_synthesis',
      prompt: query,
      context: { draft, ...context },
      options: { maxTokens: 900, temperature: 0.35 },
    });
    if (routed?.content?.trim() && routed.provider !== 'rule_based') {
      logUnified('provider_enhanced_answer', {
        provider: routed.provider,
        fallbackUsed: routed.fallbackUsed,
        taskType,
      });
      return routed.content.trim();
    }
  } catch (e) {
    logUnified('provider_enhance_failed', { error: String(e?.message || e), taskType });
  }
  return draft;
}

/**
 * @param {string} query
 * @param {object} [context]
 */
function buildLocalHelpFallback(query, context = {}) {
  const articles = matchHelpArticles(query, {
    limit: 3,
    minScore: 3,
    pathname: context.pathname || '',
    learnedBoosts: context.learnedBoosts || {},
  }).map((m) => m.article);

  if (!articles.length) {
    return buildUnifiedResponse({
      source: UNIFIED_AI_SOURCES.FALLBACK,
      mode: UNIFIED_AI_MODES.FALLBACK,
      answer:
        'I could not find a matching guide. Try asking *how do I…* with the screen name, or check with your supervisor.',
      fallbackChain: ['local_rules'],
      moduleOrigin: context.moduleOrigin,
    });
  }

  const content = synthesizeHelpReply({
    message: query,
    history: context.history || [],
    articles,
    pathname: context.pathname || '',
    userDisplay: context.userDisplay,
    roleKey: context.roleKey,
    user: context.user,
    externalAiEnabled: false,
  });

  return buildUnifiedResponse({
    source: UNIFIED_AI_SOURCES.HELP,
    mode: UNIFIED_AI_MODES.SUGGEST,
    answer: content,
    confidence: 0.4,
    suggestions: articles.slice(0, 3).map((a) => a.title),
    fallbackChain: ['help_knowledge', 'local_rules'],
    moduleOrigin: context.moduleOrigin,
    links: articles.slice(0, 2).map((a) => ({ label: a.title, to: a.route || '/settings' })),
    results: articles.slice(0, 3).map((a) => ({ id: a.id, title: a.title })),
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {object} userContext
 */
async function tryKnowledgeCenterSearch(db, query, userContext = {}) {
  const result = await searchKnowledge(db, {
    query,
    mode: 'hybrid',
    limit: 5,
    module: userContext.module,
    status: 'active',
  });
  const records = result.records || [];
  if (!records.length) return null;

  const draft = formatResultsAsDraft(query, records);
  const topScore = Number(records[0]?.searchScore || records[0]?.semanticScore || 0.5);
  const answer = await maybeEnhanceAnswerWithProvider('help_synthesis', query, draft, {
    results: records,
    moduleOrigin: userContext.moduleOrigin,
  });

  return buildUnifiedResponse({
    source: UNIFIED_AI_SOURCES.KNOWLEDGE_CENTER,
    mode: topScore >= 0.75 ? UNIFIED_AI_MODES.AUTO : UNIFIED_AI_MODES.SUGGEST,
    answer,
    confidence: topScore,
    suggestions: records.slice(0, 3).map((r) => String(r.title || r.id)),
    routeUsed: 'knowledge_center_hybrid',
    results: records.slice(0, 5),
    moduleOrigin: userContext.moduleOrigin,
  });
}

/**
 * @param {object} routed
 * @param {string[]} chain
 * @param {string} moduleOrigin
 * @param {string} query
 */
function routerResultToUnified(routed, chain, moduleOrigin, query) {
  const links = (routed.results || []).slice(0, 3).map((r) => ({
    label: String(r.title || 'Guide'),
    to: r.module ? `/${r.module}` : '/settings',
  }));

  return buildUnifiedResponse({
    source: UNIFIED_AI_SOURCES.ROUTER,
    intent: routed.intent,
    confidence: routed.confidence,
    mode: routed.mode || UNIFIED_AI_MODES.SUGGEST,
    answer: routed.answer || formatResultsAsDraft(query, routed.results || []),
    suggestions: (routed.results || []).slice(0, 3).map((r) => String(r.title || '')),
    routeUsed: routed.routeUsed,
    fallbackUsed: routed.fallbackUsed,
    fallbackChain: chain,
    moduleOrigin,
    results: routed.results,
    links,
  });
}

/**
 * Central unified query entry — all AI modules can call this.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} request
 * @param {string} request.query
 * @param {object} [request.context]
 * @param {string} [request.source] help | memo | expense | letter | ui | router
 * @param {'auto' | 'suggest' | 'fallback'} [request.mode]
 * @param {string} [request.userId]
 */
export async function unifiedQuery(db, request = {}) {
  const started = Date.now();
  const query = String(request?.query || '').trim();
  const context = request?.context && typeof request.context === 'object' ? request.context : {};
  const moduleOrigin = String(request?.source || UNIFIED_AI_ORIGINS.UI);
  const config = readUnifiedAiConfig();
  const chain = [];

  if (!query) {
    return {
      ok: false,
      error: 'Query is required.',
      ...buildUnifiedResponse({
        source: UNIFIED_AI_SOURCES.FALLBACK,
        mode: UNIFIED_AI_MODES.FALLBACK,
        answer: '',
        moduleOrigin,
      }),
    };
  }

  if (!config.enabled) {
    logUnified('unified_disabled', { moduleOrigin, query: query.slice(0, 80) });
    const local = buildLocalHelpFallback(query, { ...context, moduleOrigin });
    const latency = Date.now() - started;
    logUnifiedQueryComplete({
      source: local.source,
      moduleOrigin,
      fallbackChain: ['unified_disabled', 'local_rules'],
      confidence: local.confidence,
      mode: local.mode,
      latencyMs: latency,
      fallbackUsed: true,
    });
    return { ok: true, unified: true, disabled: true, ...local, metadata: { ...local.metadata, latency } };
  }

  logUnified('query_start', { moduleOrigin, query: query.slice(0, 120) });

  // 1. AI Router
  try {
    chain.push('router');
    const routed = await routeQuery(db, {
      query,
      userContext: {
        ...context,
        module: context.module || moduleOrigin,
      },
      userId: request.userId,
    });

    if (
      routed.ok &&
      routed.answer &&
      Number(routed.confidence) >= config.routerConfidenceThreshold &&
      routed.mode !== UNIFIED_AI_MODES.FALLBACK
    ) {
      const unified = routerResultToUnified(routed, chain, moduleOrigin, query);
      const latency = Date.now() - started;
      logUnifiedQueryComplete({
        source: unified.source,
        moduleOrigin,
        fallbackChain: chain,
        confidence: unified.confidence,
        mode: unified.mode,
        latencyMs: latency,
        fallbackUsed: Boolean(routed.fallbackUsed),
        intent: unified.intent,
        routeUsed: unified.metadata?.routeUsed,
      });
      return { ok: true, unified: true, ...unified, metadata: { ...unified.metadata, latency } };
    }
  } catch (e) {
    logUnified('router_error', { moduleOrigin, error: String(e?.message || e) });
  }

  // 2. Knowledge Center hybrid
  if (config.kcFallbackEnabled && db) {
    try {
      chain.push('knowledge_center');
      const kc = await tryKnowledgeCenterSearch(db, query, { ...context, moduleOrigin });
      if (kc?.answer) {
        const latency = Date.now() - started;
        logUnifiedQueryComplete({
          source: kc.source,
          moduleOrigin,
          fallbackChain: chain,
          confidence: kc.confidence,
          mode: kc.mode,
          latencyMs: latency,
          fallbackUsed: true,
        });
        return { ok: true, unified: true, ...kc, metadata: { ...kc.metadata, latency } };
      }
    } catch (e) {
      logUnified('kc_error', { moduleOrigin, error: String(e?.message || e) });
    }
  }

  // 3. Help knowledge (local articles)
  if (config.helpFallbackEnabled) {
    chain.push('help_knowledge');
    const helpLocal = buildLocalHelpFallback(query, { ...context, moduleOrigin });
    if (helpLocal.answer) {
      const latency = Date.now() - started;
      logUnifiedQueryComplete({
        source: helpLocal.source,
        moduleOrigin,
        fallbackChain: chain,
        confidence: helpLocal.confidence,
        mode: helpLocal.mode,
        latencyMs: latency,
        fallbackUsed: true,
      });
      return { ok: true, unified: true, ...helpLocal, metadata: { ...helpLocal.metadata, latency } };
    }
  }

  // 4. Local rules fallback
  chain.push('local_rules');
  const fallback = buildUnifiedResponse({
    source: UNIFIED_AI_SOURCES.FALLBACK,
    mode: request.mode || UNIFIED_AI_MODES.FALLBACK,
    answer:
      'I\'m not sure how to help with that yet. Try rephrasing with the screen or task name, or ask your supervisor.',
    fallbackChain: chain,
    moduleOrigin,
  });
  const latency = Date.now() - started;
  logUnifiedQueryComplete({
    source: fallback.source,
    moduleOrigin,
    fallbackChain: chain,
    mode: fallback.mode,
    latencyMs: latency,
    fallbackUsed: true,
  });
  return { ok: true, unified: true, ...fallback, metadata: { ...fallback.metadata, latency } };
}

/**
 * Safe wrapper for HelpChatDock backend — preserves helpAgent when router is insufficient.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts — same shape as runHelpChat
 */
export async function runUnifiedHelpChat(db, opts = {}) {
  const started = Date.now();
  const message = String(opts.message || '').trim();
  const config = readUnifiedAiConfig();

  if (!config.enabled) {
    return runHelpChat({ ...opts, db });
  }

  const history = Array.isArray(opts.messages) ? opts.messages : [];
  const pageContext = opts.pageContext && typeof opts.pageContext === 'object' ? opts.pageContext : {};
  const agentRoute = classifyAgentRoute(message, history, pageContext);

  // ERP-data and special routes must use full helpAgent (preserves tools, coaching, logging).
  if (ERP_AGENT_ROUTES.has(agentRoute) || pageContext.mode === 'transaction_help') {
    logUnified('help_skip_router', { agentRoute, reason: 'erp_or_special_route' });
    return runHelpChat({ ...opts, db });
  }

  const chain = ['router'];

  try {
    const routed = await routeQuery(db, {
      query: message,
      userContext: {
        module: pageContext.module,
        role: opts.roleKey,
        pathname: opts.pathname,
      },
      userId: opts.userId,
    });

    if (
      routed.ok &&
      routed.answer &&
      Number(routed.confidence) >= CONFIDENCE_MEDIUM &&
      routed.mode !== UNIFIED_AI_MODES.FALLBACK
    ) {
      const links = (routed.results || []).slice(0, 3).map((r) => ({
        label: String(r.title || 'Guide'),
        to: r.module ? `/${r.module}` : '/settings',
      }));

      logUnifiedQueryComplete({
        source: UNIFIED_AI_SOURCES.ROUTER,
        moduleOrigin: UNIFIED_AI_ORIGINS.HELP,
        fallbackChain: chain,
        confidence: routed.confidence,
        mode: routed.mode,
        latencyMs: Date.now() - started,
        fallbackUsed: Boolean(routed.fallbackUsed),
        intent: routed.intent,
        routeUsed: routed.routeUsed,
      });

      return {
        content: routed.answer,
        source: 'router',
        links,
        matchedArticleIds: (routed.results || []).map((r) => r.id).filter(Boolean),
        topScore: Math.round((routed.confidence || 0) * 10),
        agentRoute: 'guide',
        sources: (routed.results || []).slice(0, 3).map((r) => ({
          id: r.id,
          title: r.title,
        })),
        coaching: null,
        logId: null,
        unifiedMeta: {
          source: UNIFIED_AI_SOURCES.ROUTER,
          confidence: routed.confidence,
          mode: routed.mode,
          intent: routed.intent,
          fallbackChain: chain,
        },
      };
    }
  } catch (e) {
    logUnified('help_router_error', { error: String(e?.message || e) });
  }

  // KC fallback before full helpAgent
  if (db) {
    chain.push('knowledge_center');
    try {
      const kc = await tryKnowledgeCenterSearch(db, message, {
        module: pageContext.module,
        moduleOrigin: UNIFIED_AI_ORIGINS.HELP,
        pathname: opts.pathname,
        learnedBoosts: opts.learnedBoosts,
      });
      if (kc?.answer && Number(kc.confidence) >= CONFIDENCE_MEDIUM) {
        logUnifiedQueryComplete({
          source: UNIFIED_AI_SOURCES.KNOWLEDGE_CENTER,
          moduleOrigin: UNIFIED_AI_ORIGINS.HELP,
          fallbackChain: chain,
          confidence: kc.confidence,
          mode: kc.mode,
          latencyMs: Date.now() - started,
          fallbackUsed: true,
        });
        return {
          content: kc.answer,
          source: 'knowledge_center',
          links: kc.metadata?.links || [],
          matchedArticleIds: [],
          topScore: Math.round((kc.confidence || 0) * 10),
          agentRoute: 'guide',
          sources: (kc.metadata?.results || []).map((r) => ({
            id: r.id,
            title: r.title,
          })),
          coaching: null,
          logId: null,
          unifiedMeta: {
            source: UNIFIED_AI_SOURCES.KNOWLEDGE_CENTER,
            confidence: kc.confidence,
            mode: kc.mode,
            fallbackChain: chain,
          },
        };
      }
    } catch (e) {
      logUnified('help_kc_error', { error: String(e?.message || e) });
    }
  }

  chain.push('help_agent');
  logUnified('help_fallback_agent', { fallbackChain: chain });
  const helpResult = await runHelpChat({ ...opts, db });
  return {
    ...helpResult,
    unifiedMeta: {
      source: UNIFIED_AI_SOURCES.HELP,
      fallbackChain: chain,
      fallbackUsed: true,
    },
  };
}

/**
 * Convert unified query result to HTTP gateway JSON.
 *
 * @param {object} result
 */
export function formatUnifiedQueryHttpResponse(result) {
  if (!result?.ok) {
    return { ok: false, error: result?.error || 'Query failed.' };
  }
  return {
    ok: true,
    source: result.source,
    intent: result.intent,
    confidence: result.confidence,
    mode: result.mode,
    answer: result.answer,
    suggestions: result.suggestions,
    metadata: result.metadata,
    unified: Boolean(result.unified),
  };
}

export { helpResultToUnifiedResponse, isUnifiedAiEnabled };

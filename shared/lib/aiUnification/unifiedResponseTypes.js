/**
 * Unified AI response contract — shared by orchestrator, HTTP gateway, and module bridges.
 *
 * @module shared/lib/aiUnification/unifiedResponseTypes
 */

/** @typedef {'router' | 'knowledge_center' | 'help' | 'fallback'} UnifiedAiSource */

/** @typedef {'auto' | 'suggest' | 'fallback'} UnifiedAiMode */

/** @typedef {'help' | 'memo' | 'expense' | 'letter' | 'ui' | 'router'} UnifiedAiOrigin */

export const UNIFIED_AI_SOURCES = Object.freeze({
  ROUTER: 'router',
  KNOWLEDGE_CENTER: 'knowledge_center',
  HELP: 'help',
  FALLBACK: 'fallback',
});

export const UNIFIED_AI_MODES = Object.freeze({
  AUTO: 'auto',
  SUGGEST: 'suggest',
  FALLBACK: 'fallback',
});

export const UNIFIED_AI_ORIGINS = Object.freeze({
  HELP: 'help',
  MEMO: 'memo',
  EXPENSE: 'expense',
  LETTER: 'letter',
  UI: 'ui',
  ROUTER: 'router',
});

/**
 * Build a normalized unified AI response.
 *
 * @param {object} opts
 * @returns {import('./unifiedResponseTypes.js').UnifiedAiResponse}
 */
export function buildUnifiedResponse(opts = {}) {
  const source = String(opts.source || UNIFIED_AI_SOURCES.FALLBACK);
  const mode = String(opts.mode || UNIFIED_AI_MODES.FALLBACK);
  const answer = String(opts.answer || '').trim();

  return {
    source,
    intent: opts.intent != null ? String(opts.intent) : undefined,
    confidence:
      opts.confidence != null && Number.isFinite(Number(opts.confidence))
        ? Number(opts.confidence)
        : undefined,
    mode,
    answer,
    suggestions: Array.isArray(opts.suggestions)
      ? opts.suggestions.map((s) => String(s)).filter(Boolean)
      : undefined,
    metadata: {
      routeUsed: opts.metadata?.routeUsed ?? opts.routeUsed ?? null,
      latency: opts.metadata?.latency ?? opts.latency ?? null,
      fallbackUsed: Boolean(opts.metadata?.fallbackUsed ?? opts.fallbackUsed),
      fallbackChain: Array.isArray(opts.metadata?.fallbackChain)
        ? opts.metadata.fallbackChain
        : Array.isArray(opts.fallbackChain)
          ? opts.fallbackChain
          : [],
      moduleOrigin: opts.metadata?.moduleOrigin ?? opts.moduleOrigin ?? null,
      results: opts.metadata?.results ?? opts.results ?? undefined,
      links: opts.metadata?.links ?? opts.links ?? undefined,
    },
  };
}

/**
 * Map help-agent result shape to unified response (help chat bridge).
 *
 * @param {object} helpResult
 * @param {object} [meta]
 */
export function helpResultToUnifiedResponse(helpResult, meta = {}) {
  return buildUnifiedResponse({
    source: meta.source || UNIFIED_AI_SOURCES.HELP,
    intent: meta.intent,
    confidence: meta.confidence,
    mode: meta.mode || UNIFIED_AI_MODES.AUTO,
    answer: helpResult?.content || '',
    suggestions: meta.suggestions,
    metadata: {
      routeUsed: helpResult?.agentRoute || meta.routeUsed,
      latency: meta.latency,
      fallbackUsed: Boolean(meta.fallbackUsed),
      fallbackChain: meta.fallbackChain || [],
      moduleOrigin: UNIFIED_AI_ORIGINS.HELP,
      links: helpResult?.links,
      logId: helpResult?.logId,
      agentRoute: helpResult?.agentRoute,
      sources: helpResult?.sources,
      coaching: helpResult?.coaching,
    },
  });
}

/**
 * Memo assist enrichment via unified AI layer (suggestion-only).
 *
 * @module server/aiUnificationLayer/services/memoUnifiedAssist
 */

import { analyzeQuery } from '../../aiIntelligenceRouter/services/aiRouterService.js';
import { searchKnowledge } from '../../aiKnowledgeCenter/services/knowledgeSearchService.js';
import { KNOWLEDGE_TYPES } from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';
import { isUnifiedAiEnabled } from '../config/unifiedAiConfig.js';
import { logUnified } from '../utils/unifiedAiLogger.js';
import { UNIFIED_AI_ORIGINS } from '../../../shared/lib/aiUnification/unifiedResponseTypes.js';

const MEMO_TYPE_HINTS = [
  { pattern: /\b(request|please approve|seek approval)\b/i, type: 'request' },
  { pattern: /\b(complaint|grievance|dissatisfied)\b/i, type: 'complaint' },
  { pattern: /\b(approval|endorse|sign off)\b/i, type: 'approval' },
  { pattern: /\b(report|summary|update|status)\b/i, type: 'report' },
];

/**
 * @param {string} text
 */
function inferMemoTypeFromText(text) {
  for (const { pattern, type } of MEMO_TYPE_HINTS) {
    if (pattern.test(text)) return type;
  }
  return null;
}

/**
 * Enrich memo-assist result with unified AI suggestions (non-destructive).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 * @param {object} baseResult — output from runMemoAssist
 */
export async function enrichMemoAssist(db, user, body, baseResult) {
  if (!isUnifiedAiEnabled()) return baseResult;

  const subject = String(body?.subject || '');
  const memoBody = String(body?.body || '');
  const text = `${subject}\n${memoBody}`.trim();
  if (!text) return baseResult;

  const suggestions = [];
  const warnings = [...(baseResult.warnings || [])];
  let unifiedAi = {
    enabled: true,
    source: null,
    intent: null,
    confidence: null,
    mode: 'suggest',
  };

  try {
    const analysis = analyzeQuery(text, {
      module: 'office',
      role: user?.roleKey,
    });
    unifiedAi.intent = analysis.intent;
    unifiedAi.confidence = analysis.intentConfidence;

    const inferredType = inferMemoTypeFromText(text);
    if (inferredType && !baseResult.memoType) {
      suggestions.push(`Suggested memo type: ${inferredType}`);
      unifiedAi.suggestedMemoType = inferredType;
    }

    if (analysis.suggestedModule === 'office') {
      suggestions.push('Route: Office Desk workflow');
    }

    if (db) {
      const kc = await searchKnowledge(db, {
        query: text.slice(0, 200),
        mode: 'hybrid',
        knowledgeType: KNOWLEDGE_TYPES.SOP_ARTICLE,
        module: 'office',
        limit: 2,
        status: 'active',
      });
      const top = kc.records?.[0];
      if (top?.title) {
        suggestions.push(`Related SOP: ${top.title}`);
        unifiedAi.relatedSop = top.title;
      }
      if (top?.category && !baseResult.filingCategory) {
        unifiedAi.suggestedFilingCategory = top.category;
        suggestions.push(`Filing category hint: ${top.category}`);
      }
    }

    const structureTips = [];
    if (!subject.trim()) structureTips.push('Add a clear subject line.');
    if (memoBody.length < 40) structureTips.push('Expand the body with context, dates, and requested action.');
    if (!/\b(request|please|action|approve)\b/i.test(text)) {
      structureTips.push('State the requested action explicitly.');
    }
    if (structureTips.length) {
      unifiedAi.structureTips = structureTips;
      suggestions.push(...structureTips);
    }

    unifiedAi.source = 'router';
    logUnified('memo_assist_enriched', {
      moduleOrigin: UNIFIED_AI_ORIGINS.MEMO,
      intent: unifiedAi.intent,
      confidence: unifiedAi.confidence,
      suggestionCount: suggestions.length,
    });
  } catch (e) {
    logUnified('memo_assist_enrich_error', { error: String(e?.message || e) });
    return baseResult;
  }

  return {
    ...baseResult,
    unifiedAi,
    unifiedSuggestions: suggestions,
    warnings,
    aiSuggestionOnly: true,
  };
}

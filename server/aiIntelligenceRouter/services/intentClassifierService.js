/**
 * AI Intelligence Router — rules-based intent classification (no ML).
 *
 * @module server/aiIntelligenceRouter/services/intentClassifierService
 */

import { KNOWLEDGE_MODULE_VALUES } from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';
import { ROUTER_INTENTS } from '../../../shared/lib/aiIntelligenceRouter/intents.js';

/** @typedef {import('../../../shared/lib/aiIntelligenceRouter/intents.js').RouterIntent} RouterIntent */

const INTENT_RULES = [
  {
    intent: ROUTER_INTENTS.CONVERSATION_CHAT,
    patterns: [
      /^(hi|hello|hey|good morning|good afternoon|salam)\b/i,
      /^(thanks|thank you|bye|goodbye)\b/i,
      /\b(who are you|what are you|what can you do)\b/i,
    ],
    keywords: ['hello', 'thanks', 'who are you'],
    weight: 0.85,
  },
  {
    intent: ROUTER_INTENTS.SQL_REQUEST,
    patterns: [
      /\b(select|sql|text-to-sql|text to sql)\b/i,
      /\b(query (the )?database|database query)\b/i,
      /\b(how many|count of|total number of)\b.+\b(in (the )?system|records|rows)\b/i,
      /\bshow me (all |the )?(quotations|receipts|products|customers)\b/i,
    ],
    keywords: ['sql', 'select', 'count', 'database', 'query'],
    weight: 0.9,
  },
  {
    intent: ROUTER_INTENTS.GLOSSARY_LOOKUP,
    patterns: [
      /\b(what is|what's|what does|meaning of|define|definition of)\b/i,
      /\b(glossary|term|acronym)\b/i,
      /\bwhat (does|do) .+ mean\b/i,
    ],
    keywords: ['what is', 'meaning', 'define', 'glossary'],
    weight: 0.82,
  },
  {
    intent: ROUTER_INTENTS.TROUBLESHOOTING,
    patterns: [
      /\b(error|failed|failure|blocked|locked|denied)\b/i,
      /\b(not working|doesn't work|does not work|won't work)\b/i,
      /\b(wrong|mistake|incorrect|fix|stuck|pending forever)\b/i,
      /\b(why can't|why cant|cannot|can't)\b/i,
    ],
    keywords: ['error', 'failed', 'wrong', 'stuck', 'fix', 'blocked'],
    weight: 0.88,
  },
  {
    intent: ROUTER_INTENTS.SOP_REQUEST,
    patterns: [
      /\b(how do i|how to|how can i|steps to|walk me through)\b/i,
      /\b(sop|procedure|workflow|process for)\b/i,
      /\b(where do i|help me)\b.+\b(record|create|post|approve|save)\b/i,
    ],
    keywords: ['how do i', 'how to', 'steps', 'workflow', 'sop', 'procedure'],
    weight: 0.9,
  },
];

const MODULE_HINTS = [
  { module: 'sales', patterns: /\b(quotation|quote|receipt|customer|sales)\b/i },
  { module: 'finance', patterns: /\b(payment|ledger|receipt|treasury|finance|bank)\b/i },
  { module: 'procurement', patterns: /\b(purchase|po|grn|supplier|procurement)\b/i },
  { module: 'operations', patterns: /\b(inventory|stock|coil|operations|store)\b/i },
  { module: 'production', patterns: /\b(production|cutting|manufacturing)\b/i },
  { module: 'hr', patterns: /\b(payroll|staff|hr|leave|employee)\b/i },
  { module: 'accounting', patterns: /\b(accounting|gl|journal|depreciation)\b/i },
  { module: 'office', patterns: /\b(memo|office|filing)\b/i },
];

/**
 * Tokenize query for keyword matching.
 *
 * @param {string} q
 * @returns {string[]}
 */
function tokens(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Infer ERP module from query and optional user context.
 *
 * @param {string} query
 * @param {object} [context]
 * @returns {string}
 */
export function inferSuggestedModule(query, context = {}) {
  const ctxModule = String(context.module || '').trim().toLowerCase();
  if (ctxModule && KNOWLEDGE_MODULE_VALUES.includes(ctxModule)) return ctxModule;

  const q = String(query || '');
  for (const hint of MODULE_HINTS) {
    if (hint.patterns.test(q)) return hint.module;
  }
  return 'general';
}

/**
 * Classify user query intent with lightweight rule scoring.
 *
 * @param {string} query
 * @param {object} [context]
 * @returns {{ intent: RouterIntent; confidence: number; matchedKeywords: string[]; suggestedModule: string; scores: Record<string, number> }}
 */
export function detectIntent(query, context = {}) {
  const q = String(query || '').trim();
  const qLower = q.toLowerCase();
  const qTokens = new Set(tokens(q));

  /** @type {Record<string, number>} */
  const scores = {};
  /** @type {Record<string, string[]>} */
  const matchedByIntent = {};

  for (const rule of INTENT_RULES) {
    let score = 0;
    /** @type {string[]} */
    const matched = [];

    for (const pat of rule.patterns) {
      if (pat.test(q)) {
        score += rule.weight * 0.6;
        matched.push(pat.source.slice(0, 40));
      }
    }

    for (const kw of rule.keywords) {
      const parts = kw.toLowerCase().split(/\s+/).filter(Boolean);
      const allPresent = parts.every((p) => qLower.includes(p) || qTokens.has(p));
      if (allPresent) {
        score += rule.weight * 0.25;
        matched.push(kw);
      }
    }

    if (score > 0) {
      scores[rule.intent] = Math.min(1, (scores[rule.intent] || 0) + score);
      matchedByIntent[rule.intent] = [...(matchedByIntent[rule.intent] || []), ...matched];
    }
  }

  let intent = ROUTER_INTENTS.UNKNOWN;
  let confidence = 0.35;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    const [topIntent, topScore] = ranked[0];
    const secondScore = ranked[1]?.[1] || 0;
    intent = /** @type {RouterIntent} */ (topIntent);
    confidence = Math.min(0.98, topScore * (secondScore > topScore * 0.85 ? 0.75 : 1));
  }

  if (q.length < 3) {
    intent = ROUTER_INTENTS.UNKNOWN;
    confidence = 0.2;
  }

  const suggestedModule = inferSuggestedModule(q, context);
  const matchedKeywords = [...new Set(matchedByIntent[intent] || [])].slice(0, 12);

  return {
    intent,
    confidence,
    matchedKeywords,
    suggestedModule,
    scores,
  };
}

/**
 * @param {ReturnType<typeof detectIntent>} intentResult
 * @returns {number}
 */
export function calculateIntentConfidence(intentResult) {
  return Math.max(0, Math.min(1, Number(intentResult?.confidence) || 0));
}

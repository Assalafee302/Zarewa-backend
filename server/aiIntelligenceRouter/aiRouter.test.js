import { describe, it, expect } from 'vitest';
import { ROUTER_INTENTS } from '../../shared/lib/aiIntelligenceRouter/intents.js';
import { detectIntent, inferSuggestedModule } from './services/intentClassifierService.js';
import {
  computeCombinedConfidence,
  computeSearchConfidence,
  resolveResponseMode,
} from './services/confidenceService.js';
import { buildRoutePlan } from './services/routingEngineService.js';
import { KNOWLEDGE_TYPES } from '../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';
import { formatResultsAsDraft } from './services/llmSynthesizerService.js';

describe('intentClassifierService', () => {
  it('detects SOP_REQUEST for how-to questions', () => {
    const r = detectIntent('How do I record a payment receipt?', { module: 'sales' });
    expect(r.intent).toBe(ROUTER_INTENTS.SOP_REQUEST);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.suggestedModule).toBe('sales');
  });

  it('detects GLOSSARY_LOOKUP for definition questions', () => {
    const r = detectIntent('What is GRN?');
    expect(r.intent).toBe(ROUTER_INTENTS.GLOSSARY_LOOKUP);
  });

  it('detects SQL_REQUEST for database queries', () => {
    const r = detectIntent('Show me SQL to count quotations in the system');
    expect(r.intent).toBe(ROUTER_INTENTS.SQL_REQUEST);
  });

  it('detects TROUBLESHOOTING for errors', () => {
    const r = detectIntent('Payment failed with error blocked');
    expect(r.intent).toBe(ROUTER_INTENTS.TROUBLESHOOTING);
  });

  it('detects CONVERSATION_CHAT for greetings', () => {
    const r = detectIntent('Hello');
    expect(r.intent).toBe(ROUTER_INTENTS.CONVERSATION_CHAT);
  });

  it('infers module from query keywords', () => {
    expect(inferSuggestedModule('procurement GRN supplier')).toBe('procurement');
  });
});

describe('confidenceService', () => {
  it('computeSearchConfidence uses top searchScore', () => {
    expect(computeSearchConfidence([{ searchScore: 0.82 }])).toBeCloseTo(0.82, 2);
    expect(computeSearchConfidence([])).toBe(0);
  });

  it('resolveResponseMode maps thresholds', () => {
    expect(resolveResponseMode(0.9)).toBe('auto');
    expect(resolveResponseMode(0.6)).toBe('suggest');
    expect(resolveResponseMode(0.3)).toBe('fallback');
  });

  it('computeCombinedConfidence weights search higher', () => {
    const r = computeCombinedConfidence(0.5, 1);
    expect(r.combinedConfidence).toBeCloseTo(0.8, 2);
  });
});

describe('routingEngineService', () => {
  it('routes SOP to sop_article hybrid search', () => {
    const plan = buildRoutePlan(ROUTER_INTENTS.SOP_REQUEST, { suggestedModule: 'finance' });
    expect(plan.routeUsed).toBe('knowledge_sop_search');
    expect(plan.knowledgeType).toBe(KNOWLEDGE_TYPES.SOP_ARTICLE);
    expect(plan.searchMode).toBe('hybrid');
  });

  it('routes UNKNOWN to hybrid fallback', () => {
    const plan = buildRoutePlan(ROUTER_INTENTS.UNKNOWN, {});
    expect(plan.routeUsed).toBe('knowledge_hybrid_fallback');
    expect(plan.searchMode).toBe('hybrid');
  });
});

describe('llmSynthesizerService', () => {
  it('formatResultsAsDraft formats knowledge hits', () => {
    const text = formatResultsAsDraft('receipt', [
      { title: 'Record receipt', bodyText: 'Open Sales then Payments tab.' },
    ]);
    expect(text).toContain('Record receipt');
    expect(text).toContain('Payments tab');
  });
});

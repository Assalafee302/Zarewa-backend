import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildUnifiedResponse,
  UNIFIED_AI_SOURCES,
  UNIFIED_AI_MODES,
} from '../../shared/lib/aiUnification/unifiedResponseTypes.js';
import { isUnifiedAiEnabled, readUnifiedAiConfig } from './config/unifiedAiConfig.js';
import { suggestHrLetterAssist } from './services/hrLetterUnifiedAssist.js';
import { classifyAgentRoute } from '../../shared/lib/helpAgentIntent.js';

describe('unifiedAiConfig', () => {
  let saved;

  beforeEach(() => {
    saved = process.env.ZARE_AI_UNIFIED_MODE;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ZARE_AI_UNIFIED_MODE;
    else process.env.ZARE_AI_UNIFIED_MODE = saved;
  });

  it('is disabled by default', () => {
    delete process.env.ZARE_AI_UNIFIED_MODE;
    expect(isUnifiedAiEnabled()).toBe(false);
  });

  it('enables on true values', () => {
    process.env.ZARE_AI_UNIFIED_MODE = 'true';
    expect(isUnifiedAiEnabled()).toBe(true);
    process.env.ZARE_AI_UNIFIED_MODE = '1';
    expect(isUnifiedAiEnabled()).toBe(true);
  });

  it('readUnifiedAiConfig returns threshold', () => {
    const cfg = readUnifiedAiConfig();
    expect(cfg.routerConfidenceThreshold).toBeGreaterThan(0);
    expect(cfg.routerConfidenceThreshold).toBeLessThanOrEqual(1);
  });
});

describe('unifiedResponseTypes', () => {
  it('buildUnifiedResponse normalizes shape', () => {
    const r = buildUnifiedResponse({
      source: UNIFIED_AI_SOURCES.ROUTER,
      mode: UNIFIED_AI_MODES.AUTO,
      answer: 'Test answer',
      confidence: 0.82,
      intent: 'SOP_REQUEST',
      fallbackChain: ['router'],
      moduleOrigin: 'help',
      routeUsed: 'sop_hybrid',
      latency: 42,
    });
    expect(r.source).toBe('router');
    expect(r.mode).toBe('auto');
    expect(r.answer).toBe('Test answer');
    expect(r.confidence).toBe(0.82);
    expect(r.metadata.fallbackChain).toEqual(['router']);
    expect(r.metadata.routeUsed).toBe('sop_hybrid');
    expect(r.metadata.latency).toBe(42);
  });
});

describe('hrLetterUnifiedAssist', () => {
  it('suggests disciplinary template for warning text', () => {
    const r = suggestHrLetterAssist({
      purpose: 'Written warning for misconduct and disciplinary action',
      draftText: 'Dear John, This is a formal warning.',
    });
    expect(r.ok).toBe(true);
    expect(r.aiSuggestionOnly).toBe(true);
    expect(r.suggestedTone).toBe('disciplinary');
    expect(r.unifiedSuggestions.length).toBeGreaterThan(0);
  });
});

describe('help agent route guard', () => {
  it('routes ERP data queries to erp_data', () => {
    expect(classifyAgentRoute('How many open quotations do we have?')).toBe('erp_data');
  });

  it('routes how-to queries to guide', () => {
    expect(classifyAgentRoute('How do I record a payment receipt?')).toBe('guide');
  });
});

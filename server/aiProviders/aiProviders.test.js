import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProviderResponse, estimateTokens } from '../../shared/lib/aiProviders/providerResponseTypes.js';
import { isHuggingFaceEnabled } from './config/providerConfig.js';
import { getTaskRouting, isOpenAiOnlyTask, isHuggingFacePreferredTask } from './modelRegistry.js';
import {
  buildProviderChain,
  getOpenAiDailyTokenUsage,
  recordProviderUsage,
  _resetUsageForTests,
} from './costController.js';
import { normalizeVector } from './embeddingProvider.js';
import { routeAIRequest } from './aiProviderRouter.js';

describe('providerConfig', () => {
  let saved;

  beforeEach(() => {
    saved = process.env.ZARE_AI_HUGGINGFACE_ENABLED;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ZARE_AI_HUGGINGFACE_ENABLED;
    else process.env.ZARE_AI_HUGGINGFACE_ENABLED = saved;
  });

  it('HF disabled by default', () => {
    delete process.env.ZARE_AI_HUGGINGFACE_ENABLED;
    expect(isHuggingFaceEnabled()).toBe(false);
  });

  it('HF enabled flag parses true', () => {
    process.env.ZARE_AI_HUGGINGFACE_ENABLED = 'true';
    expect(isHuggingFaceEnabled()).toBe(true);
  });
});

describe('modelRegistry', () => {
  it('memo_polish prefers huggingface', () => {
    const r = getTaskRouting('memo_polish');
    expect(r.primary).toBe('huggingface');
    expect(r.fallback).toBe('openai');
  });

  it('finance_critical is openai only', () => {
    expect(isOpenAiOnlyTask('finance_critical')).toBe(true);
    expect(getTaskRouting('finance_critical').fallback).toBeNull();
  });

  it('expense is HF preferred task', () => {
    expect(isHuggingFacePreferredTask('expense')).toBe(true);
  });
});

describe('costController', () => {
  beforeEach(() => _resetUsageForTests());

  it('records and sums OpenAI daily usage', () => {
    recordProviderUsage('openai', 'help_synthesis', 1000);
    recordProviderUsage('openai', 'memo_polish', 500);
    expect(getOpenAiDailyTokenUsage()).toBe(1500);
  });

  it('redirects to huggingface when openai over limit', () => {
    for (let i = 0; i < 600; i += 1) {
      recordProviderUsage('openai', 'test', 1000);
    }
    process.env.ZARE_AI_HUGGINGFACE_ENABLED = 'true';
    process.env.HUGGINGFACE_API_KEY = 'hf_test';
    const chain = buildProviderChain('memo_polish', getTaskRouting('memo_polish'));
    expect(chain[0]).toBe('huggingface');
    delete process.env.HUGGINGFACE_API_KEY;
  });
});

describe('providerResponseTypes', () => {
  it('buildProviderResponse normalizes shape', () => {
    const r = buildProviderResponse({
      provider: 'huggingface',
      content: 'Hello',
      confidence: 0.8,
      usage: { tokens: 12 },
      fallbackUsed: true,
    });
    expect(r.provider).toBe('huggingface');
    expect(r.content).toBe('Hello');
    expect(r.fallbackUsed).toBe(true);
    expect(r.usage?.tokens).toBe(12);
  });

  it('estimateTokens is positive', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });
});

describe('embeddingProvider', () => {
  it('normalizeVector unit length', () => {
    const v = normalizeVector([3, 4]);
    const norm = Math.sqrt(v[0] ** 2 + v[1] ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe('routeAIRequest fallback', () => {
  it('returns rule-based when no providers configured', async () => {
    const prev = process.env.ZARE_AI_HUGGINGFACE_ENABLED;
    delete process.env.ZARE_AI_HUGGINGFACE_ENABLED;
    const r = await routeAIRequest({
      taskType: 'help_synthesis',
      prompt: 'How do I record a receipt?',
      context: { draft: 'Draft answer' },
    });
    expect(r.content).toBeTruthy();
    expect(r.fallbackUsed).toBe(true);
    if (prev !== undefined) process.env.ZARE_AI_HUGGINGFACE_ENABLED = prev;
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultChatModelIdForBaseUrl,
  inferAiProviderLabel,
  readAiAssistConfig,
} from './aiAssist.js';

describe('aiAssist config', () => {
  const saved = {};

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function saveEnv(key) {
    saved[key] = process.env[key];
  }

  it('detects Gemini provider from base URL', () => {
    expect(
      inferAiProviderLabel('https://generativelanguage.googleapis.com/v1beta/openai/')
    ).toBe('gemini');
    expect(defaultChatModelIdForBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe(
      'gemini-2.0-flash'
    );
  });

  it('exposes help and polish model overrides', () => {
    saveEnv('ZAREWA_AI_API_KEY');
    saveEnv('ZAREWA_AI_HELP_MODEL');
    saveEnv('ZAREWA_AI_POLISH_MODEL');
    process.env.ZAREWA_AI_API_KEY = 'test';
    process.env.ZAREWA_AI_HELP_MODEL = 'gpt-4o';
    process.env.ZAREWA_AI_POLISH_MODEL = 'gpt-4o-mini';
    const cfg = readAiAssistConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.helpModel).toBe('gpt-4o');
    expect(cfg.polishModel).toBe('gpt-4o-mini');
    expect(cfg.helpMaxTokens).toBeGreaterThanOrEqual(400);
  });
});

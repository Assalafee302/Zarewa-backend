import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chatCompletionsUrl,
  defaultChatModelIdForBaseUrl,
  parseMemoPolishJson,
  parseOfficeFilingExtractJson,
  readAiAssistConfig,
  runAiChat,
  runOfficeMemoPolish,
  sanitizeClientMessages,
} from './aiAssist.js';

describe('aiAssist', () => {
  it('defaultChatModelIdForBaseUrl prefers llama3.2 for Ollama default port 11434', () => {
    expect(defaultChatModelIdForBaseUrl('http://127.0.0.1:11434/v1')).toBe('llama3.2');
    expect(defaultChatModelIdForBaseUrl('HTTP://LOCALHOST:11434')).toBe('llama3.2');
    expect(defaultChatModelIdForBaseUrl('https://api.openai.com/v1')).toBe('gpt-4o-mini');
  });

  it('readAiAssistConfig uses default model from base URL when ZAREWA_AI_MODEL unset', () => {
    const saved = {
      ZAREWA_AI_API_KEY: process.env.ZAREWA_AI_API_KEY,
      ZAREWA_AI_BASE_URL: process.env.ZAREWA_AI_BASE_URL,
      ZAREWA_AI_MODEL: process.env.ZAREWA_AI_MODEL,
    };
    try {
      process.env.ZAREWA_AI_API_KEY = 'k';
      delete process.env.ZAREWA_AI_MODEL;
      process.env.ZAREWA_AI_BASE_URL = 'http://127.0.0.1:11434/v1';
      expect(readAiAssistConfig().model).toBe('llama3.2');
      process.env.ZAREWA_AI_BASE_URL = 'https://api.openai.com/v1';
      expect(readAiAssistConfig().model).toBe('gpt-4o-mini');
    } finally {
      for (const k of ['ZAREWA_AI_API_KEY', 'ZAREWA_AI_BASE_URL', 'ZAREWA_AI_MODEL']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('chatCompletionsUrl handles base with or without /v1', () => {
    expect(chatCompletionsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatCompletionsUrl('https://example.com/api/')).toBe('https://example.com/api/v1/chat/completions');
  });

  it('sanitizeClientMessages keeps user/assistant and caps length', () => {
    const long = 'x'.repeat(9000);
    const out = sanitizeClientMessages([
      { role: 'system', content: 'ignore' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: long },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[2].content.endsWith('…')).toBe(true);
    expect(out[2].content.length).toBeLessThanOrEqual(8001);
  });

  it('parseMemoPolishJson strips fences and extra prose', () => {
    const raw = 'Here you go:\n```json\n{"subject":"A","body":"B"}\n```\n';
    const r = parseMemoPolishJson(raw, 'fbS', 'fbB');
    expect(r.subject).toBe('A');
    expect(r.body).toBe('B');
  });

  it('parseMemoPolishJson derives subject from polished body when model omits subject', () => {
    const raw = '{"subject":"","body":"Request for diesel refill\\nQty: 200L"}';
    const r = parseMemoPolishJson(raw, '', 'rough');
    expect(r.subject).toContain('Request for diesel');
    expect(r.body).toContain('200L');
  });

  it('parseOfficeFilingExtractJson normalizes category and cost', () => {
    const raw = JSON.stringify({
      categoryKey: 'fuel_request',
      categoryLabel: 'Fuel',
      summary: 'Diesel for generator',
      costNgn: 45000,
      tags: ['diesel'],
      keyFacts: { approvalStatus: 'pending' },
    });
    const r = parseOfficeFilingExtractJson(raw);
    expect(r.categoryKey).toBe('fuel_request');
    expect(r.costNgn).toBe(45000);
    expect(r.keyFacts.approvalStatus).toBe('pending');
  });

  describe('runAiChat with env + fetch mock', () => {
    const saved = {};

    beforeEach(() => {
      saved.ZAREWA_AI_API_KEY = process.env.ZAREWA_AI_API_KEY;
      saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      saved.ZAREWA_AI_BASE_URL = process.env.ZAREWA_AI_BASE_URL;
      saved.ZAREWA_AI_MODEL = process.env.ZAREWA_AI_MODEL;
      process.env.ZAREWA_AI_API_KEY = 'test-key';
      process.env.ZAREWA_AI_BASE_URL = 'https://api.openai.com/v1';
      process.env.ZAREWA_AI_MODEL = 'gpt-test';
    });

    afterEach(() => {
      for (const k of ['ZAREWA_AI_API_KEY', 'OPENAI_API_KEY', 'ZAREWA_AI_BASE_URL', 'ZAREWA_AI_MODEL']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      vi.restoreAllMocks();
    });

    it('readAiAssistConfig picks ZAREWA_AI_API_KEY over OPENAI_API_KEY', () => {
      process.env.OPENAI_API_KEY = 'openai';
      process.env.ZAREWA_AI_API_KEY = 'zarewa';
      const c = readAiAssistConfig();
      expect(c.enabled).toBe(true);
      expect(c.apiKey).toBe('zarewa');
    });

    it('runAiChat returns assistant content', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'Hello from mock.' } }],
            }),
        }))
      );
      const r = await runAiChat({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(r.content).toBe('Hello from mock.');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('runOfficeMemoPolish parses JSON subject/body from model', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '{"subject":"Fuel run","body":"Please approve diesel for the site visit."}',
                  },
                },
              ],
            }),
        }))
      );
      const r = await runOfficeMemoPolish({ subject: 'fuel', body: 'need diesel' });
      expect(r.subject).toBe('Fuel run');
      expect(r.body).toContain('diesel');
    });
  });
});

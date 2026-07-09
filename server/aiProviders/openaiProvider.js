/**
 * OpenAI-compatible provider adapter (wraps existing aiAssist.js).
 *
 * @module server/aiProviders/openaiProvider
 */

import {
  readAiAssistConfig,
  postChatCompletions,
  normalizeCompletionContent,
  inferAiProviderLabel,
} from '../aiAssist.js';
import { buildProviderResponse, estimateTokens } from '../../shared/lib/aiProviders/providerResponseTypes.js';
import { logProvider } from './utils/providerLogger.js';

/**
 * @returns {boolean}
 */
export function isOpenAiProviderAvailable() {
  const cfg = readAiAssistConfig();
  return cfg.enabled && inferAiProviderLabel(cfg.baseUrl) !== 'ollama';
}

/**
 * @param {string} prompt
 * @param {object} [options]
 */
export async function generateText(prompt, options = {}) {
  const cfg = readAiAssistConfig();
  if (!cfg.enabled) throw new Error('OpenAI provider is not configured.');

  const started = Date.now();
  const model = options.model || options.helpModel || cfg.helpModel || cfg.model;
  const maxTokens = Math.min(4096, Math.max(64, Number(options.maxTokens) || 900));

  const messages = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: String(options.systemPrompt).slice(0, 4000) });
  }
  messages.push({ role: 'user', content: String(prompt).slice(0, 12000) });

  const { ok, json, raw } = await postChatCompletions(cfg, {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: options.temperature ?? 0.35,
  });

  if (!ok) {
    const err = json?.error?.message || raw || 'OpenAI request failed';
    logProvider('openai_error', { model, error: String(err).slice(0, 200) });
    throw new Error(String(err).slice(0, 300));
  }

  const content = normalizeCompletionContent(json?.choices?.[0]?.message).trim();
  const usage = json?.usage || {};
  const tokens = Number(usage.total_tokens) || estimateTokens(prompt) + estimateTokens(content);

  logProvider('openai_success', {
    model,
    latencyMs: Date.now() - started,
    tokens,
  });

  return buildProviderResponse({
    provider: 'openai',
    content,
    confidence: content ? 0.85 : 0.2,
    usage: { tokens, cost: estimateOpenAiCost(tokens, model) },
    fallbackUsed: false,
    metadata: { model },
  });
}

/**
 * Rough cost estimate (USD) for monitoring — not billing-grade.
 *
 * @param {number} tokens
 * @param {string} model
 */
function estimateOpenAiCost(tokens, model) {
  const m = String(model || '').toLowerCase();
  const rate = m.includes('gpt-4o') && !m.includes('mini') ? 0.00001 : 0.000002;
  return Math.round(tokens * rate * 10000) / 10000;
}

/**
 * @param {string} prompt
 * @param {object} [options]
 */
export async function generateJSON(prompt, options = {}) {
  const system =
    (options.systemPrompt || '') +
    '\nRespond with valid JSON only.';
  const result = await generateText(prompt, { ...options, systemPrompt: system.trim() });
  let json = null;
  try {
    const cleaned = String(result.content || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/i, '');
    json = JSON.parse(cleaned);
  } catch {
    json = null;
  }
  return { ...result, json };
}

/**
 * @returns {Promise<{ ok: boolean; latencyMs: number; error?: string }>}
 */
export async function healthCheck() {
  if (!isOpenAiProviderAvailable()) return { ok: false, error: 'not_configured' };
  const started = Date.now();
  try {
    await generateText('Say OK', { maxTokens: 5, temperature: 0 });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.message || e) };
  }
}

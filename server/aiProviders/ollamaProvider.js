/**
 * Ollama provider adapter (OpenAI-compatible local shim).
 *
 * @module server/aiProviders/ollamaProvider
 */

import {
  readAiAssistConfig,
  postChatCompletions,
  normalizeCompletionContent,
  inferAiProviderLabel,
  defaultChatModelIdForBaseUrl,
} from '../aiAssist.js';
import { buildProviderResponse, estimateTokens } from '../../shared/lib/aiProviders/providerResponseTypes.js';
import { logProvider } from './utils/providerLogger.js';

/**
 * @returns {boolean}
 */
export function isOllamaProviderAvailable() {
  const cfg = readAiAssistConfig();
  return cfg.enabled && inferAiProviderLabel(cfg.baseUrl) === 'ollama';
}

/**
 * @param {string} prompt
 * @param {object} [options]
 */
export async function generateText(prompt, options = {}) {
  const cfg = readAiAssistConfig();
  if (!isOllamaProviderAvailable()) {
    throw new Error('Ollama provider is not configured.');
  }

  const started = Date.now();
  const model = options.model || cfg.model || defaultChatModelIdForBaseUrl(cfg.baseUrl);
  const maxTokens = Math.min(2048, Math.max(64, Number(options.maxTokens) || 900));

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
    throw new Error(String(json?.error?.message || raw).slice(0, 300));
  }

  const content = normalizeCompletionContent(json?.choices?.[0]?.message).trim();
  const tokens = estimateTokens(prompt) + estimateTokens(content);

  logProvider('ollama_success', { model, latencyMs: Date.now() - started, tokens });

  return buildProviderResponse({
    provider: 'ollama',
    content,
    confidence: content ? 0.7 : 0.2,
    usage: { tokens, cost: 0 },
    fallbackUsed: false,
    metadata: { model },
  });
}

/**
 * @returns {Promise<{ ok: boolean; latencyMs: number; error?: string }>}
 */
export async function healthCheck() {
  if (!isOllamaProviderAvailable()) return { ok: false, error: 'not_configured' };
  const started = Date.now();
  try {
    await generateText('OK', { maxTokens: 4, temperature: 0 });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.message || e) };
  }
}

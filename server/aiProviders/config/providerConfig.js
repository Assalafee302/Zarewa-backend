/**
 * AI provider layer configuration and feature flags.
 *
 * @module server/aiProviders/config/providerConfig
 */

import { readAiAssistConfig, inferAiProviderLabel } from '../../aiAssist.js';

/**
 * @returns {boolean}
 */
export function isHuggingFaceEnabled() {
  const raw = process.env.ZARE_AI_HUGGINGFACE_ENABLED;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

/**
 * @returns {string}
 */
export function readHuggingFaceApiKey() {
  return String(
    process.env.HUGGINGFACE_API_KEY ||
      process.env.HF_TOKEN ||
      process.env.ZARE_AI_HF_API_KEY ||
      ''
  ).trim();
}

/**
 * @returns {{
 *   huggingFaceEnabled: boolean;
 *   huggingFaceApiKey: string;
 *   huggingFaceBaseUrl: string;
 *   selfHosted: boolean;
 *   openAiDailyTokenLimit: number;
 *   providerLayerActive: boolean;
 * }}
 */
export function readProviderConfig() {
  const hfKey = readHuggingFaceApiKey();
  const ai = readAiAssistConfig();
  const baseUrl = String(
    process.env.ZARE_AI_HF_BASE_URL || 'https://api-inference.huggingface.co'
  )
    .trim()
    .replace(/\/+$/, '');

  const selfHosted = /^(1|true|yes|on)$/i.test(
    String(process.env.ZARE_AI_HF_SELF_HOSTED || '').trim()
  );

  const openAiDailyTokenLimit = Math.max(
    1000,
    Number(process.env.ZARE_AI_OPENAI_DAILY_TOKEN_LIMIT) || 500_000
  );

  return {
    huggingFaceEnabled: isHuggingFaceEnabled() && Boolean(hfKey),
    huggingFaceApiKey: hfKey,
    huggingFaceBaseUrl: baseUrl,
    selfHosted,
    openAiDailyTokenLimit,
    providerLayerActive: isHuggingFaceEnabled() || ai.enabled,
    ollamaEnabled: inferAiProviderLabel(ai.baseUrl) === 'ollama' && ai.enabled,
    openAiEnabled: ai.enabled && inferAiProviderLabel(ai.baseUrl) !== 'ollama',
  };
}

/**
 * @returns {boolean}
 */
export function isProviderLayerAvailable() {
  const cfg = readProviderConfig();
  return cfg.huggingFaceEnabled || cfg.openAiEnabled || cfg.ollamaEnabled;
}

/**
 * Aggregate health checks for all configured providers.
 *
 * @module server/aiProviders/healthCheck
 */

import { readProviderConfig } from './config/providerConfig.js';
import * as hf from './huggingfaceProvider.js';
import * as openai from './openaiProvider.js';
import * as ollama from './ollamaProvider.js';

/**
 * @returns {Promise<object>}
 */
export async function healthCheckProviders() {
  const cfg = readProviderConfig();
  const out = {
    ok: false,
    huggingface: { configured: cfg.huggingFaceEnabled, ok: false },
    openai: { configured: cfg.openAiEnabled, ok: false },
    ollama: { configured: cfg.ollamaEnabled, ok: false },
  };

  if (cfg.huggingFaceEnabled) {
    out.huggingface = { ...out.huggingface, ...(await hf.healthCheck()) };
  }
  if (cfg.openAiEnabled) {
    out.openai = { ...out.openai, ...(await openai.healthCheck()) };
  }
  if (cfg.ollamaEnabled) {
    out.ollama = { ...out.ollama, ...(await ollama.healthCheck()) };
  }

  out.ok =
    out.huggingface.ok || out.openai.ok || out.ollama.ok;
  return out;
}

/**
 * Hugging Face Inference API provider (with optional self-host base URL).
 *
 * @module server/aiProviders/huggingfaceProvider
 */

import { readProviderConfig } from './config/providerConfig.js';
import { HF_MODELS } from './modelRegistry.js';
import { buildProviderResponse, estimateTokens } from '../../shared/lib/aiProviders/providerResponseTypes.js';
import { logProvider } from './utils/providerLogger.js';

const DEFAULT_LLM = HF_MODELS.MISTRAL_INSTRUCT;
const DEFAULT_EMBED = HF_MODELS.BGE_SMALL;

/**
 * @returns {{ enabled: boolean; apiKey: string; baseUrl: string; selfHosted: boolean }}
 */
export function readHuggingFaceConfig() {
  const cfg = readProviderConfig();
  return {
    enabled: cfg.huggingFaceEnabled,
    apiKey: cfg.huggingFaceApiKey,
    baseUrl: cfg.huggingFaceBaseUrl,
    selfHosted: cfg.selfHosted,
  };
}

/**
 * @param {string} model
 */
function modelUrl(model) {
  const { baseUrl, selfHosted } = readHuggingFaceConfig();
  const modelId = encodeURIComponent(model);
  if (selfHosted) {
    return `${baseUrl}/v1/chat/completions`;
  }
  return `${baseUrl}/models/${modelId}`;
}

/**
 * @param {string} model
 */
function embeddingUrl(model) {
  const { baseUrl, selfHosted } = readHuggingFaceConfig();
  const modelId = encodeURIComponent(model);
  if (selfHosted) {
    return `${baseUrl}/v1/embeddings`;
  }
  return `${baseUrl}/pipeline/feature-extraction/${modelId}`;
}

/**
 * Extract generated text from HF inference response shapes.
 *
 * @param {unknown} json
 */
function extractGeneratedText(json) {
  if (typeof json === 'string') return json;
  if (Array.isArray(json)) {
    const first = json[0];
    if (typeof first === 'string') return first;
    if (first?.generated_text) return String(first.generated_text);
    if (first?.summary_text) return String(first.summary_text);
  }
  if (json && typeof json === 'object') {
    if (json.generated_text) return String(json.generated_text);
    if (json[0]?.generated_text) return String(json[0].generated_text);
    if (json.choices?.[0]?.message?.content) return String(json.choices[0].message.content);
    if (json.choices?.[0]?.text) return String(json.choices[0].text);
  }
  return '';
}

/**
 * @param {string} prompt
 * @param {object} [options]
 */
export async function generateText(prompt, options = {}) {
  const cfg = readHuggingFaceConfig();
  if (!cfg.enabled) {
    throw new Error('Hugging Face provider is disabled.');
  }

  const model = options.model || DEFAULT_LLM;
  const started = Date.now();
  const maxTokens = Math.min(2048, Math.max(64, Number(options.maxTokens) || 512));
  const temperature = Number(options.temperature) ?? 0.35;

  let url;
  let body;
  let headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  if (cfg.selfHosted) {
    url = modelUrl(model);
    body = {
      model,
      messages: [
        ...(options.systemPrompt
          ? [{ role: 'system', content: String(options.systemPrompt).slice(0, 4000) }]
          : []),
        { role: 'user', content: String(prompt).slice(0, 12000) },
      ],
      max_tokens: maxTokens,
      temperature,
    };
  } else {
    url = modelUrl(model);
    const fullPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;
    body = {
      inputs: String(fullPrompt).slice(0, 12000),
      parameters: {
        max_new_tokens: maxTokens,
        temperature,
        return_full_text: false,
      },
      options: { wait_for_model: true },
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const err = json?.error || json?.message || raw || `HTTP ${res.status}`;
    logProvider('huggingface_error', { model, status: res.status, error: String(err).slice(0, 200) });
    throw new Error(String(err).slice(0, 300));
  }

  const content = extractGeneratedText(json).trim();
  const tokens = estimateTokens(prompt) + estimateTokens(content);

  logProvider('huggingface_success', {
    model,
    latencyMs: Date.now() - started,
    tokens,
  });

  return buildProviderResponse({
    provider: 'huggingface',
    content,
    confidence: content ? 0.75 : 0.2,
    usage: { tokens, cost: 0 },
    fallbackUsed: false,
    metadata: { model },
  });
}

/**
 * @param {string} prompt
 * @param {object} [options]
 */
export async function generateJSON(prompt, options = {}) {
  const jsonPrompt = `${prompt}\n\nRespond with valid JSON only. No markdown fences.`;
  const result = await generateText(jsonPrompt, {
    ...options,
    temperature: options.temperature ?? 0.1,
    maxTokens: options.maxTokens || 800,
  });

  let parsed = null;
  try {
    const text = String(result.content || '').trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = null;
  }

  return {
    ...result,
    json: parsed,
  };
}

/**
 * @param {string} text
 * @param {object} [options]
 */
export async function generateEmbedding(text, options = {}) {
  const cfg = readHuggingFaceConfig();
  if (!cfg.enabled) throw new Error('Hugging Face provider is disabled.');

  const model = options.model || DEFAULT_EMBED;
  const started = Date.now();

  if (cfg.selfHosted) {
    const res = await fetch(embeddingUrl(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: String(text || '').slice(0, 8000),
      }),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error(String(json?.error?.message || raw).slice(0, 200));
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error('HF self-host embedding returned no vector.');
    logProvider('huggingface_embed_success', { model, latencyMs: Date.now() - started, dims: vec.length });
    return vec;
  }

  const url = embeddingUrl(model);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ inputs: String(text || '').slice(0, 8000) }),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(String(json?.error || raw).slice(0, 200));
  }

  const vec = flattenEmbedding(json);
  if (!vec?.length) throw new Error('HF embedding returned empty vector.');

  logProvider('huggingface_embed_success', {
    model,
    latencyMs: Date.now() - started,
    dims: vec.length,
  });

  return vec;
}

/**
 * Flatten HF feature-extraction nested arrays to 1D vector (mean pool if 2D).
 *
 * @param {unknown} data
 */
function flattenEmbedding(data) {
  if (!Array.isArray(data)) return null;
  if (typeof data[0] === 'number') return data;
  if (Array.isArray(data[0]) && typeof data[0][0] === 'number') {
    const rows = data;
    const dim = rows[0].length;
    const out = new Array(dim).fill(0);
    for (const row of rows) {
      for (let i = 0; i < dim; i += 1) out[i] += Number(row[i]) || 0;
    }
    return out.map((v) => v / rows.length);
  }
  if (Array.isArray(data[0]) && Array.isArray(data[0][0])) {
    return flattenEmbedding(data[0]);
  }
  return null;
}

/**
 * @returns {Promise<{ ok: boolean; latencyMs: number; model?: string; error?: string }>}
 */
export async function healthCheck() {
  const cfg = readHuggingFaceConfig();
  if (!cfg.enabled) return { ok: false, error: 'disabled' };

  const started = Date.now();
  try {
    await generateText('Reply with OK only.', {
      model: DEFAULT_LLM,
      maxTokens: 8,
      temperature: 0,
    });
    return { ok: true, latencyMs: Date.now() - started, model: DEFAULT_LLM };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.message || e) };
  }
}

/**
 * Embedding provider — Hugging Face primary, OpenAI/Ollama compatible fallback.
 * Compatible with aic_knowledge_embeddings vector storage.
 *
 * @module server/aiProviders/embeddingProvider
 */

import { generateEmbedding as hfEmbed } from './huggingfaceProvider.js';
import { readProviderConfig } from './config/providerConfig.js';
import { HF_MODELS } from './modelRegistry.js';
import { embedTexts, readEmbeddingConfig } from '../helpEmbeddings.js';
import { localFallbackEmbedding } from '../helpEmbeddings.js';
import { logProvider } from './utils/providerLogger.js';

/**
 * L2-normalize embedding vector (standard for cosine similarity).
 *
 * @param {number[]} vector
 * @returns {number[]}
 */
export function normalizeVector(vector) {
  if (!Array.isArray(vector) || !vector.length) return [];
  let sum = 0;
  for (const v of vector) sum += (Number(v) || 0) ** 2;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((v) => (Number(v) || 0) / norm);
}

/**
 * @param {string} text
 * @param {object} [options]
 */
export async function createEmbedding(text, options = {}) {
  const vectors = await createBatchEmbeddings([text], options);
  return vectors[0] || [];
}

/**
 * @param {string[]} texts
 * @param {object} [options]
 */
export async function createBatchEmbeddings(texts, options = {}) {
  const list = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (!list.length) return [];

  const cfg = readProviderConfig();
  const model = options.model || HF_MODELS.BGE_SMALL;
  const started = Date.now();

  if (cfg.huggingFaceEnabled && options.provider !== 'openai') {
    try {
      const vectors = [];
      for (const text of list) {
        const raw = await hfEmbed(text, { model });
        vectors.push(normalizeVector(raw));
      }
      logProvider('embedding_batch', {
        provider: 'huggingface',
        count: vectors.length,
        dims: vectors[0]?.length,
        latencyMs: Date.now() - started,
      });
      return vectors;
    } catch (e) {
      logProvider('embedding_hf_failed', { error: String(e?.message || e) });
      if (options.hfOnly) throw e;
    }
  }

  const embedCfg = readEmbeddingConfig();
  if (embedCfg.enabled && embedCfg.apiKey) {
    try {
      const vectors = await embedTexts(embedCfg, list);
      if (vectors?.length) {
        const normalized = vectors.map((v) => normalizeVector(v));
        logProvider('embedding_batch', {
          provider: 'openai_compatible',
          count: normalized.length,
          dims: normalized[0]?.length,
          latencyMs: Date.now() - started,
        });
        return normalized;
      }
    } catch (e) {
      logProvider('embedding_openai_failed', { error: String(e?.message || e) });
    }
  }

  const fallback = list.map((t) => normalizeVector(localFallbackEmbedding(t)));
  logProvider('embedding_batch', {
    provider: 'local_fallback',
    count: fallback.length,
    dims: fallback[0]?.length,
    latencyMs: Date.now() - started,
  });
  return fallback;
}

/**
 * AI Knowledge Center — pluggable embedding generation (adapter pattern).
 *
 * Supports OpenAI-compatible APIs (OpenAI, Gemini, Hugging Face router, Ollama)
 * and a local fallback when no API key is configured.
 *
 * Extension point: add adapters in EMBEDDING_ADAPTERS without changing callers.
 *
 * @module server/aiKnowledgeCenter/services/embeddingService
 */

import { createHash } from 'node:crypto';
import {
  embedTexts,
  localFallbackEmbedding,
  readEmbeddingConfig,
} from '../../helpEmbeddings.js';

const LOCAL_FALLBACK_DIM = 256;

/**
 * @typedef {object} EmbeddingModelConfig
 * @property {string} provider
 * @property {string} model
 * @property {number|null} dimensions
 * @property {boolean} apiEnabled
 * @property {string} adapterId
 */

/**
 * Read active embedding model configuration (no side effects).
 *
 * @returns {EmbeddingModelConfig}
 */
export function readEmbeddingModelConfig() {
  const cfg = readEmbeddingConfig();
  const apiEnabled = Boolean(cfg.enabled && cfg.apiKey);
  const baseUrl = String(cfg.baseUrl || '').toLowerCase();

  let adapterId = 'openai_compatible';
  let provider = 'openai_compatible';

  if (!apiEnabled) {
    adapterId = 'local_fallback';
    provider = 'local_fallback';
  } else if (baseUrl.includes('huggingface') || baseUrl.includes('router.huggingface')) {
    provider = 'huggingface';
  } else if (/:11434(?:\/|$)/.test(baseUrl) || baseUrl.includes('ollama')) {
    provider = 'ollama';
  } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
    provider = 'gemini';
  }

  return {
    provider,
    model: apiEnabled ? cfg.embeddingModel : `local-tf-${LOCAL_FALLBACK_DIM}`,
    dimensions: apiEnabled ? null : LOCAL_FALLBACK_DIM,
    apiEnabled,
    adapterId,
    raw: {
      baseUrl: cfg.baseUrl,
      embeddingModel: cfg.embeddingModel,
    },
  };
}

/**
 * @param {EmbeddingModelConfig} config
 */
function selectAdapter(config) {
  if (config.apiEnabled) return embedViaOpenAiCompatible;
  return embedViaLocalFallback;
}

/**
 * OpenAI-compatible /v1/embeddings adapter (OpenAI, HF router, Ollama, Gemini).
 *
 * @param {string[]} texts
 * @param {EmbeddingModelConfig} config
 */
async function embedViaOpenAiCompatible(texts, config) {
  const cfg = readEmbeddingConfig();
  const vectors = await embedTexts(cfg, texts);
  if (!vectors?.length) {
    throw new Error('Embedding provider returned no vectors.');
  }
  return vectors;
}

/**
 * Local TF-hash fallback — enables offline semantic structure without an API key.
 *
 * @param {string[]} texts
 */
async function embedViaLocalFallback(texts) {
  return texts.map((t) => localFallbackEmbedding(t));
}

/**
 * Generate a single embedding vector for text.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text) {
  const batch = await batchGenerateEmbeddings([text]);
  if (!batch?.[0]?.length) throw new Error('Failed to generate embedding.');
  return batch[0];
}

/**
 * Batch-generate embeddings for multiple texts (preserves order).
 *
 * @param {string[]} records
 * @returns {Promise<number[][]>}
 */
export async function batchGenerateEmbeddings(records) {
  const texts = (Array.isArray(records) ? records : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (!texts.length) return [];

  const config = readEmbeddingModelConfig();
  const adapter = selectAdapter(config);
  const started = Date.now();

  if (process.env.ZARE_AI_HUGGINGFACE_ENABLED &&
      /^(1|true|yes|on)$/i.test(String(process.env.ZARE_AI_HUGGINGFACE_ENABLED))) {
    try {
      const { createBatchEmbeddings } = await import('../../aiProviders/embeddingProvider.js');
      const vectors = await createBatchEmbeddings(texts);
      if (vectors?.length) {
        console.info(
          `[aic-knowledge] embeddings via provider layer count=${vectors.length} ms=${Date.now() - started}`
        );
        return vectors;
      }
    } catch (e) {
      console.warn('[aic-knowledge] provider embeddings failed, using default adapter', e?.message || e);
    }
  }

  try {
    const vectors = await adapter(texts, config);
    console.info(
      `[aic-knowledge] embeddings generated provider=${config.provider} model=${config.model} count=${vectors.length} ms=${Date.now() - started}`
    );
    return vectors;
  } catch (e) {
    console.error(
      `[aic-knowledge] embedding generation failed provider=${config.provider} model=${config.model} ms=${Date.now() - started}`,
      e?.message || e
    );
    throw e;
  }
}

/**
 * Stable hash of indexable text — skip re-embedding when content unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function hashEmbeddingContent(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

/** Exported for tests and hybrid search. */
export { cosineSimilarity, normalizeSemanticScore } from '../utils/vectorMath.js';

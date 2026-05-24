import { readAiAssistConfig } from './aiAssist.js';

const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

function trimBaseUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '');
}

export function readEmbeddingConfig() {
  const base = readAiAssistConfig();
  const model = String(process.env.ZAREWA_AI_EMBEDDING_MODEL || DEFAULT_EMBED_MODEL).trim();
  return { ...base, embeddingModel: model };
}

export function embeddingsUrl(baseUrl) {
  const b = trimBaseUrl(baseUrl);
  if (!b) return 'https://api.openai.com/v1/embeddings';
  return b.endsWith('/v1') ? `${b}/embeddings` : `${b}/v1/embeddings`;
}

/**
 * @param {{ apiKey: string; baseUrl: string; embeddingModel: string }} cfg
 * @param {string | string[]} input
 */
export async function embedTexts(cfg, input) {
  if (!cfg?.enabled || !cfg.apiKey) return null;
  const texts = Array.isArray(input) ? input : [input];
  const url = embeddingsUrl(cfg.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.embeddingModel || DEFAULT_EMBED_MODEL,
      input: texts,
    }),
  });
  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(
      (json?.error?.message || raw || `HTTP ${res.status}`).toString().slice(0, 240)
    );
  }
  const data = json?.data;
  if (!Array.isArray(data)) return null;
  return data
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => row.embedding)
    .filter((v) => Array.isArray(v));
}

/**
 * Local fallback vector (TF bag) when no embedding API — enables RAG structure offline.
 * @param {string} text
 * @returns {number[]}
 */
export function localFallbackEmbedding(text) {
  const dim = 256;
  /** @type {number[]} */
  const vec = new Array(dim).fill(0);
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    vec[h % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

export { DEFAULT_EMBED_MODEL };

/**
 * Vector math utilities for semantic search (provider-agnostic).
 *
 * @module server/aiKnowledgeCenter/utils/vectorMath
 */

/**
 * Cosine similarity between two embedding vectors.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} value in [-1, 1], typically [0, 1] for normalized embeddings
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * Normalize cosine similarity to a 0–1 ranking score.
 *
 * @param {number} similarity
 * @returns {number}
 */
export function normalizeSemanticScore(similarity) {
  const s = Number(similarity) || 0;
  return Math.max(0, Math.min(1, (s + 1) / 2));
}

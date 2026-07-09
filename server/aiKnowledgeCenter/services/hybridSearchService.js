/**
 * AI Knowledge Center — hybrid ranking (keyword + semantic fusion).
 *
 * @module server/aiKnowledgeCenter/services/hybridSearchService
 */

export const HYBRID_KEYWORD_WEIGHT = 0.4;
export const HYBRID_SEMANTIC_WEIGHT = 0.6;
export const HYBRID_DEFAULT_TOP_N = 10;

/**
 * Build normalized keyword scores from ranked keyword results (0–1).
 *
 * @param {Array<{ id: string }>} records
 * @returns {Map<string, number>}
 */
export function buildKeywordScoreMap(records) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  const list = Array.isArray(records) ? records : [];
  const denom = Math.max(list.length, 1);
  list.forEach((rec, index) => {
    if (!rec?.id) return;
    const rankScore = 1 - index / denom;
    scores.set(rec.id, Math.max(0, Math.min(1, rankScore)));
  });
  return scores;
}

/**
 * @param {Array<{ record: { id: string }; semanticScore: number }>} semanticHits
 * @returns {Map<string, number>}
 */
export function buildSemanticScoreMap(semanticHits) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const hit of semanticHits || []) {
    const id = hit?.record?.id;
    if (!id) continue;
    scores.set(id, Math.max(0, Math.min(1, Number(hit.semanticScore) || 0)));
  }
  return scores;
}

/**
 * Merge keyword and semantic hits with weighted scoring.
 *
 * @param {object} opts
 * @param {Array<{ id: string }>} opts.keywordRecords
 * @param {Array<{ record: object; semanticScore: number }>} opts.semanticHits
 * @param {number} [opts.topN]
 * @returns {Array<{ record: object; score: number; keywordScore: number; semanticScore: number }>}
 */
export function mergeHybridResults(opts) {
  const keywordScores = buildKeywordScoreMap(opts.keywordRecords);
  const semanticScores = buildSemanticScoreMap(opts.semanticHits);

  /** @type {Map<string, object>} */
  const recordsById = new Map();
  for (const r of opts.keywordRecords || []) {
    if (r?.id) recordsById.set(r.id, r);
  }
  for (const hit of opts.semanticHits || []) {
    if (hit?.record?.id) recordsById.set(hit.record.id, hit.record);
  }

  const allIds = new Set([...keywordScores.keys(), ...semanticScores.keys()]);
  const ranked = [...allIds]
    .map((id) => {
      const keywordScore = keywordScores.get(id) || 0;
      const semanticScore = semanticScores.get(id) || 0;
      const score =
        HYBRID_KEYWORD_WEIGHT * keywordScore + HYBRID_SEMANTIC_WEIGHT * semanticScore;
      return {
        record: recordsById.get(id),
        score,
        keywordScore,
        semanticScore,
      };
    })
    .filter((row) => row.record)
    .sort((a, b) => b.score - a.score);

  const topN = Math.max(1, Number(opts.topN) || HYBRID_DEFAULT_TOP_N);
  return ranked.slice(0, topN);
}

/**

 * AI Knowledge Center — search service (keyword + semantic + hybrid).

 *

 * @module server/aiKnowledgeCenter/services/knowledgeSearchService

 */



import { listSearchableEmbeddings } from '../repository/embeddingRepository.js';

import { keywordSearchRecords } from '../repository/knowledgeRepository.js';

import { validateSearchKnowledge } from '../validators/knowledgeValidator.js';

import { initKnowledgeCenter } from './knowledgeService.js';

import {

  cosineSimilarity,

  generateEmbedding,

  normalizeSemanticScore,

  readEmbeddingModelConfig,

} from './embeddingService.js';

import {

  HYBRID_DEFAULT_TOP_N,

  mergeHybridResults,

} from './hybridSearchService.js';



/**

 * Semantic vector search over indexed knowledge embeddings.

 *

 * @param {import('better-sqlite3').Database} db

 * @param {object} opts

 */

export async function runSemanticSearch(db, opts) {

  const started = Date.now();

  const query = String(opts.query || '').trim();

  if (!query) {

    return {

      records: [],

      hits: [],

      semanticSearchAvailable: false,

      message: 'Query is required for semantic search.',

    };

  }



  const candidates = listSearchableEmbeddings(db, {

    knowledgeType: opts.knowledgeType,

    category: opts.category,

    module: opts.module,

    tags: opts.tags,

    status: opts.status,

    includeArchived: opts.includeArchived,

  });



  if (!candidates.length) {

    return {

      records: [],

      hits: [],

      semanticSearchAvailable: false,

      message:

        'No indexed embeddings yet. Records are indexed automatically on create/update, or run reindex.',

      timingMs: Date.now() - started,

    };

  }



  let queryVector;

  try {

    queryVector = await generateEmbedding(query);

  } catch (e) {

    console.error('[aic-knowledge] semantic search embedding failed', e?.message || e);

    return {

      records: [],

      hits: [],

      semanticSearchAvailable: false,

      message: String(e?.message || 'Embedding provider unavailable'),

      timingMs: Date.now() - started,

    };

  }



  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 25));



  const hits = candidates

    .map((row) => {

      const raw = cosineSimilarity(queryVector, row.vector);

      const semanticScore = normalizeSemanticScore(raw);

      return { record: row.record, semanticScore, rawSimilarity: raw };

    })

    .sort((a, b) => b.semanticScore - a.semanticScore)

    .slice(0, limit);



  const records = hits.map((h) => ({

    ...h.record,

    semanticScore: h.semanticScore,

  }));



  console.info(

    `[aic-knowledge] search mode=semantic query="${query.slice(0, 80)}" hits=${hits.length} candidates=${candidates.length} ms=${Date.now() - started}`

  );



  return {

    records,

    hits,

    semanticSearchAvailable: true,

    timingMs: Date.now() - started,

  };

}



/**

 * Keyword search across title, body, keywords, and tags.

 *

 * @param {import('better-sqlite3').Database} db

 * @param {object} opts

 */

export function runKeywordSearch(db, opts) {

  const started = Date.now();

  const result = keywordSearchRecords(db, opts.query, {

    knowledgeType: opts.knowledgeType,

    category: opts.category,

    module: opts.module,

    tags: opts.tags,

    status: opts.status,

    includeArchived: Boolean(opts.includeArchived),

    limit: opts.limit,

    offset: opts.offset,

  });

  console.info(

    `[aic-knowledge] search mode=keyword query="${String(opts.query || '').slice(0, 80)}" hits=${result.records.length} ms=${Date.now() - started}`

  );

  return { ...result, timingMs: Date.now() - started };

}



/**

 * Unified search entry point.

 *

 * @param {import('better-sqlite3').Database} db

 * @param {Record<string, unknown>} body

 */

export async function searchKnowledge(db, body) {

  const started = Date.now();

  initKnowledgeCenter(db);

  const validated = validateSearchKnowledge(body);

  if (!validated.ok) return { ok: false, error: validated.error };



  const opts = validated.value;

  const embeddingConfig = readEmbeddingModelConfig();



  if (opts.mode === 'semantic') {

    const semantic = await runSemanticSearch(db, opts);

    return {

      ok: true,

      mode: 'semantic',

      query: opts.query,

      total: semantic.records.length,

      records: semantic.records,

      semanticSearchAvailable: semantic.semanticSearchAvailable,

      notice: semantic.message || null,

      embeddingProvider: embeddingConfig.provider,

      timingMs: Date.now() - started,

    };

  }



  if (opts.mode === 'hybrid') {

    const keyword = runKeywordSearch(db, { ...opts, limit: Math.max(opts.limit, 50) });

    const semantic = await runSemanticSearch(db, { ...opts, limit: Math.max(opts.limit, 50) });



    const merged = mergeHybridResults({

      keywordRecords: keyword.records,

      semanticHits: semantic.hits || [],

      topN: HYBRID_DEFAULT_TOP_N,

    });



    const records = merged.map((row) => ({

      ...row.record,

      searchScore: row.score,

      keywordScore: row.keywordScore,

      semanticScore: row.semanticScore,

    }));



    console.info(

      `[aic-knowledge] search mode=hybrid query="${String(opts.query || '').slice(0, 80)}" results=${records.length} ms=${Date.now() - started}`

    );



    return {

      ok: true,

      mode: 'hybrid',

      query: opts.query,

      total: records.length,

      records,

      semanticSearchAvailable: semantic.semanticSearchAvailable,

      keywordHitCount: keyword.records.length,

      semanticHitCount: semantic.records.length,

      notice: semantic.semanticSearchAvailable

        ? null

        : 'Hybrid results use keyword ranking only; no embeddings indexed yet.',

      embeddingProvider: embeddingConfig.provider,

      timingMs: Date.now() - started,

    };

  }



  const keyword = runKeywordSearch(db, opts);



  return {

    ok: true,

    mode: 'keyword',

    query: opts.query,

    total: keyword.total,

    records: keyword.records,

    semanticSearchAvailable: Boolean(

      listSearchableEmbeddings(db, { includeArchived: opts.includeArchived }).length

    ),

    embeddingProvider: embeddingConfig.provider,

    timingMs: Date.now() - started,

  };

}



export { cosineSimilarity } from './embeddingService.js';



import { HELP_ARTICLES } from '../shared/lib/helpKnowledge.js';
import { matchHelpArticles, buildHelpSearchText } from '../shared/lib/helpKnowledge.js';
import {
  cosineSimilarity,
  embedTexts,
  localFallbackEmbedding,
  readEmbeddingConfig,
} from './helpEmbeddings.js';

const INDEX_BLOB = 'help.rag_index_version';

function chunkArticle(article) {
  /** @type {{ id: string; sourceType: string; sourceId: string; text: string }[]} */
  const chunks = [];
  const moduleHint = (article.keywords || []).slice(0, 6).join(', ');
  const base = `[${article.id}] ${article.title}\nModule keywords: ${moduleHint}\n${article.answer}`;
  chunks.push({ id: `${article.id}:summary`, sourceType: 'article', sourceId: article.id, text: base });
  if (article.steps?.length) {
    const stepText = article.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    chunks.push({
      id: `${article.id}:steps`,
      sourceType: 'article',
      sourceId: article.id,
      text: `[${article.id}] ${article.title} steps:\n${stepText}`,
    });
  }
  return chunks;
}

export function ensureHelpRagTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS help_rag_chunks (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding_json TEXT,
      embedding_model TEXT,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_help_rag_source ON help_rag_chunks(source_type, source_id);
  `);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function ragIndexVersion(db) {
  try {
    const row = db.prepare(`SELECT payload_json FROM app_json_blobs WHERE key = ?`).get(INDEX_BLOB);
    return row?.payload_json ? JSON.parse(String(row.payload_json)) : null;
  } catch {
    return null;
  }
}

/**
 * Index HELP_ARTICLES into vector store (OpenAI embeddings or local fallback).
 * @param {import('better-sqlite3').Database} db
 */
export async function indexHelpKnowledgeBase(db) {
  ensureHelpRagTables(db);
  const cfg = readEmbeddingConfig();
  const chunks = HELP_ARTICLES.flatMap(chunkArticle);
  const texts = chunks.map((c) => c.text);

  /** @type {number[][] | null} */
  let vectors = null;
  let model = 'local-tf';

  if (cfg.enabled) {
    try {
      vectors = await embedTexts(cfg, texts);
      model = cfg.embeddingModel;
    } catch (e) {
      console.warn('[zarewa] help RAG embedding failed, using local fallback', e?.message || e);
    }
  }

  if (!vectors) {
    vectors = texts.map(localFallbackEmbedding);
    model = 'local-tf';
  }

  const upsert = db.prepare(
    `INSERT INTO help_rag_chunks (id, source_type, source_id, chunk_text, embedding_json, embedding_model, updated_at_iso)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       chunk_text = excluded.chunk_text,
       embedding_json = excluded.embedding_json,
       embedding_model = excluded.embedding_model,
       updated_at_iso = excluded.updated_at_iso`
  );
  const at = new Date().toISOString();
  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      upsert.run(
        c.id,
        c.sourceType,
        c.sourceId,
        c.text.slice(0, 8000),
        JSON.stringify(vectors[i]),
        model,
        at
      );
    }
    db.prepare(
      `INSERT INTO app_json_blobs (key, payload_json, updated_at_iso)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at_iso = excluded.updated_at_iso`
    ).run(
      INDEX_BLOB,
      JSON.stringify({ articleCount: HELP_ARTICLES.length, model, at }),
      at
    );
  });
  tx();
  return { chunks: chunks.length, model };
}

/**
 * Semantic + keyword hybrid retrieval (RAG).
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {{ limit?: number; pathname?: string; learnedBoosts?: Record<string, number> }} [opts]
 */
export async function retrieveHelpContext(db, query, opts = {}) {
  const q = String(query || '').trim();
  const limit = Math.min(6, Math.max(2, Number(opts.limit) || 4));
  if (!q || !db) {
    return { chunks: [], articleIds: [], mode: 'none' };
  }

  ensureHelpRagTables(db);
  const rows = db.prepare(`SELECT id, source_id, chunk_text, embedding_json, embedding_model FROM help_rag_chunks`).all();
  const cfg = readEmbeddingConfig();

  /** @type {number[] | null} */
  let queryVec = null;
  if (rows.length && cfg.enabled) {
    try {
      const emb = await embedTexts(cfg, q);
      queryVec = emb?.[0] || null;
    } catch {
      queryVec = null;
    }
  }
  if (!queryVec) queryVec = localFallbackEmbedding(q);

  /** @type {{ sourceId: string; text: string; score: number }[]} */
  const ranked = [];
  for (const row of rows) {
    let vec;
    try {
      vec = JSON.parse(String(row.embedding_json || '[]'));
    } catch {
      continue;
    }
    const score = cosineSimilarity(queryVec, vec);
    ranked.push({ sourceId: String(row.source_id), text: String(row.chunk_text), score });
  }
  ranked.sort((a, b) => b.score - a.score);

  const keyword = matchHelpArticles(q, {
    limit: 3,
    minScore: 4,
    pathname: opts.pathname,
    learnedBoosts: opts.learnedBoosts,
  });

  /** @type {Map<string, { sourceId: string; text: string; score: number }>} */
  const merged = new Map();
  for (const r of ranked.slice(0, limit)) {
    merged.set(r.sourceId, r);
  }
  for (const m of keyword) {
    const prev = merged.get(m.article.id);
    const boost = (prev?.score || 0) + m.score / 20;
    merged.set(m.article.id, {
      sourceId: m.article.id,
      text: prev?.text || `${m.article.title}\n${m.article.answer}`,
      score: boost,
    });
  }

  const chunks = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return {
    chunks,
    articleIds: chunks.map((c) => c.sourceId),
    mode: cfg.enabled && rows.some((r) => r.embedding_model?.includes('embedding')) ? 'vector' : 'local',
  };
}

/**
 * @param {{ chunks: { text: string; sourceId: string }[] }} retrieval
 */
export function formatRetrievedContext(retrieval) {
  if (!retrieval?.chunks?.length) return '';
  return retrieval.chunks
    .map((c, i) => `[${i + 1}] (${c.sourceId})\n${c.text}`)
    .join('\n\n')
    .slice(0, 14000);
}

/**
 * Re-index if article count changed.
 * @param {import('better-sqlite3').Database} db
 */
export async function indexHelpKnowledgeBaseIfStale(db) {
  const ver = ragIndexVersion(db);
  if (ver?.articleCount === HELP_ARTICLES.length) return ver;
  return indexHelpKnowledgeBase(db);
}

/**
 * AI Knowledge Center — embedding persistence (SQLite).
 *
 * @module server/aiKnowledgeCenter/repository/embeddingRepository
 */

import { mapRowToKnowledgeRecord } from '../models/knowledgeRecordModel.js';
import { ensureAiKnowledgeCenterTables } from './knowledgeRepository.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
function ensureEmbeddingColumns(db) {
  const cols = new Set(
    db.prepare(`PRAGMA table_info(aic_knowledge_embeddings)`).all().map((c) => c.name)
  );
  if (!cols.has('content_hash')) {
    db.exec(`ALTER TABLE aic_knowledge_embeddings ADD COLUMN content_hash TEXT`);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function ensureTables(db) {
  ensureAiKnowledgeCenterTables(db);
  ensureEmbeddingColumns(db);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} recordId
 */
export function getEmbeddingRow(db, recordId) {
  ensureTables(db);
  return (
    db
      .prepare(
        `SELECT record_id, embedding_model, embedding_json, dimensions, status,
                indexed_at_iso, error_message, content_hash
         FROM aic_knowledge_embeddings WHERE record_id = ? LIMIT 1`
      )
      .get(String(recordId || '').trim()) || null
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 */
export function saveReadyEmbedding(db, opts) {
  ensureTables(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO aic_knowledge_embeddings (
      record_id, embedding_model, embedding_json, dimensions, status,
      indexed_at_iso, error_message, content_hash
    ) VALUES (?, ?, ?, ?, 'ready', ?, NULL, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      embedding_model = excluded.embedding_model,
      embedding_json = excluded.embedding_json,
      dimensions = excluded.dimensions,
      status = 'ready',
      indexed_at_iso = excluded.indexed_at_iso,
      error_message = NULL,
      content_hash = excluded.content_hash`
  ).run(
    opts.recordId,
    opts.model,
    JSON.stringify(opts.vector),
    Number(opts.dimensions) || opts.vector.length,
    now,
    opts.contentHash || null
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} recordId
 * @param {string} message
 */
export function markEmbeddingFailed(db, recordId, message) {
  ensureTables(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO aic_knowledge_embeddings (record_id, status, indexed_at_iso, error_message)
     VALUES (?, 'failed', ?, ?)
     ON CONFLICT(record_id) DO UPDATE SET
       status = 'failed',
       indexed_at_iso = excluded.indexed_at_iso,
       error_message = excluded.error_message`
  ).run(recordId, now, String(message || 'Embedding failed').slice(0, 500));
}

/**
 * List records with ready embeddings for semantic search.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [filters]
 */
export function listSearchableEmbeddings(db, filters = {}) {
  ensureTables(db);
  const where = [`e.status = 'ready'`, `e.embedding_json IS NOT NULL`];
  const args = [];

  if (!filters.includeArchived) {
    where.push(`r.status != 'archived'`);
  }
  if (filters.knowledgeType) {
    where.push('r.knowledge_type = ?');
    args.push(String(filters.knowledgeType));
  }
  if (filters.category) {
    where.push('r.category = ?');
    args.push(String(filters.category));
  }
  if (filters.module) {
    where.push('r.module = ?');
    args.push(String(filters.module));
  }
  if (filters.status) {
    where.push('r.status = ?');
    args.push(String(filters.status));
  }
  if (Array.isArray(filters.tags) && filters.tags.length) {
    for (const tag of filters.tags) {
      where.push(`r.tags_json LIKE ?`);
      args.push(`%"${String(tag).replace(/"/g, '')}"%`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT r.*, e.embedding_json, e.embedding_model, e.dimensions
       FROM aic_knowledge_records r
       INNER JOIN aic_knowledge_embeddings e ON e.record_id = r.id
       ${whereSql}
       ORDER BY r.updated_at_iso DESC`
    )
    .all(...args);

  return rows
    .map((row) => {
      const record = mapRowToKnowledgeRecord(row);
      if (!record) return null;
      let vector;
      try {
        vector = JSON.parse(String(row.embedding_json || '[]'));
      } catch {
        vector = null;
      }
      if (!Array.isArray(vector) || !vector.length) return null;
      return { record, vector, model: String(row.embedding_model || '') };
    })
    .filter(Boolean);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listRecordIdsNeedingIndex(db) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT r.id
       FROM aic_knowledge_records r
       LEFT JOIN aic_knowledge_embeddings e ON e.record_id = r.id
       WHERE e.record_id IS NULL OR e.status IN ('pending', 'failed')`
    )
    .all();
  return rows.map((r) => String(r.id));
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function countEmbeddingsByStatus(db) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM aic_knowledge_embeddings GROUP BY status`
    )
    .all();
  /** @type {Record<string, number>} */
  const out = {};
  for (const row of rows) out[String(row.status)] = Number(row.c) || 0;
  return out;
}

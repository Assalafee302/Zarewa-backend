/**
 * AI Knowledge Center — data access layer (SQLite).
 *
 * @module server/aiKnowledgeCenter/repository/knowledgeRepository
 */

import {
  buildBodyText,
  mapRowToKnowledgeRecord,
  newKnowledgeRecordId,
  newKnowledgeVersionId,
  parseJsonObject,
} from '../models/knowledgeRecordModel.js';

/**
 * Ensure AI Knowledge Center tables exist (idempotent).
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureAiKnowledgeCenterTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aic_knowledge_records (
      id TEXT PRIMARY KEY,
      knowledge_type TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      tags_json TEXT NOT NULL DEFAULT '[]',
      module TEXT NOT NULL DEFAULT 'general',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      content_json TEXT NOT NULL DEFAULT '{}',
      body_text TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT,
      created_by_name TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_type ON aic_knowledge_records(knowledge_type);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_status ON aic_knowledge_records(status);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_module ON aic_knowledge_records(module);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_category ON aic_knowledge_records(category);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_updated ON aic_knowledge_records(updated_at_iso DESC);

    CREATE TABLE IF NOT EXISTS aic_knowledge_versions (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      change_note TEXT,
      changed_by_user_id TEXT,
      changed_by_name TEXT,
      changed_at_iso TEXT NOT NULL,
      FOREIGN KEY (record_id) REFERENCES aic_knowledge_records(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_versions_record
      ON aic_knowledge_versions(record_id, version DESC);

    CREATE TABLE IF NOT EXISTS aic_knowledge_embeddings (
      record_id TEXT PRIMARY KEY,
      embedding_model TEXT,
      embedding_json TEXT,
      dimensions INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      indexed_at_iso TEXT,
      error_message TEXT,
      FOREIGN KEY (record_id) REFERENCES aic_knowledge_records(id) ON DELETE CASCADE
    );
  `);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function findKnowledgeRecordById(db, id) {
  const row = db
    .prepare(
      `SELECT * FROM aic_knowledge_records WHERE id = ? LIMIT 1`
    )
    .get(String(id || '').trim());
  return mapRowToKnowledgeRecord(row);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} filters
 */
export function listKnowledgeRecords(db, filters = {}) {
  const where = [];
  const args = [];

  if (filters.knowledgeType) {
    where.push('knowledge_type = ?');
    args.push(String(filters.knowledgeType));
  }
  if (filters.category) {
    where.push('category = ?');
    args.push(String(filters.category));
  }
  if (filters.module) {
    where.push('module = ?');
    args.push(String(filters.module));
  }
  if (filters.status) {
    where.push('status = ?');
    args.push(String(filters.status));
  } else if (!filters.includeArchived) {
    where.push(`status != 'archived'`);
  }

  if (Array.isArray(filters.tags) && filters.tags.length) {
    for (const tag of filters.tags) {
      where.push(`tags_json LIKE ?`);
      args.push(`%"${String(tag).replace(/"/g, '')}"%`);
    }
  }

  if (filters.q) {
    const q = `%${String(filters.q).trim().toLowerCase()}%`;
    where.push(`(
      LOWER(title) LIKE ? OR
      LOWER(body_text) LIKE ? OR
      LOWER(keywords_json) LIKE ? OR
      LOWER(tags_json) LIKE ?
    )`);
    args.push(q, q, q, q);
  }

  const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
  const offset = Math.max(0, Number(filters.offset) || 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM aic_knowledge_records ${whereSql}`)
    .get(...args)?.c;

  const rows = db
    .prepare(
      `SELECT * FROM aic_knowledge_records ${whereSql}
       ORDER BY updated_at_iso DESC, title ASC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);

  return {
    total: Number(total) || 0,
    records: rows.map((row) => mapRowToKnowledgeRecord(row)).filter(Boolean),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload
 * @param {{ id: string; displayName?: string; username?: string }} actor
 */
export function insertKnowledgeRecord(db, payload, actor) {
  const id = newKnowledgeRecordId();
  const now = new Date().toISOString();
  const bodyText = buildBodyText(payload);
  const createdByName = String(actor.displayName || actor.username || '').trim();

  db.prepare(
    `INSERT INTO aic_knowledge_records (
      id, knowledge_type, title, category, tags_json, module, keywords_json,
      content_json, body_text, created_by_user_id, created_by_name,
      created_at_iso, updated_at_iso, version, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    payload.knowledgeType,
    payload.title,
    payload.category || 'general',
    JSON.stringify(payload.tags || []),
    payload.module || 'general',
    JSON.stringify(payload.keywords || []),
    JSON.stringify(payload.content || {}),
    bodyText,
    actor.id,
    createdByName,
    now,
    now,
    1,
    payload.status || 'active',
    JSON.stringify(payload.metadata || {})
  );

  insertVersionSnapshot(db, {
    recordId: id,
    version: 1,
    snapshot: payload,
    changeNote: 'Initial version',
    actor,
  });

  ensureEmbeddingPlaceholder(db, id);

  return findKnowledgeRecordById(db, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} payload
 * @param {{ id: string; displayName?: string; username?: string }} actor
 * @param {string} [changeNote]
 */
export function updateKnowledgeRecord(db, id, payload, actor, changeNote = '') {
  const existing = findKnowledgeRecordById(db, id);
  if (!existing) return null;

  const nextVersion = (Number(existing.version) || 1) + 1;
  const now = new Date().toISOString();
  const merged = {
    knowledgeType: payload.knowledgeType ?? existing.knowledgeType,
    title: payload.title ?? existing.title,
    category: payload.category ?? existing.category,
    tags: payload.tags ?? existing.tags,
    module: payload.module ?? existing.module,
    keywords: payload.keywords ?? existing.keywords,
    content: payload.content ?? existing.content,
    status: payload.status ?? existing.status,
    metadata: payload.metadata ?? existing.metadata,
    bodyText: payload.bodyText,
  };
  const bodyText = buildBodyText(merged);

  db.prepare(
    `UPDATE aic_knowledge_records SET
      knowledge_type = ?,
      title = ?,
      category = ?,
      tags_json = ?,
      module = ?,
      keywords_json = ?,
      content_json = ?,
      body_text = ?,
      updated_at_iso = ?,
      version = ?,
      status = ?,
      metadata_json = ?
     WHERE id = ?`
  ).run(
    merged.knowledgeType,
    merged.title,
    merged.category,
    JSON.stringify(merged.tags || []),
    merged.module,
    JSON.stringify(merged.keywords || []),
    JSON.stringify(merged.content || {}),
    bodyText,
    now,
    nextVersion,
    merged.status,
    JSON.stringify(merged.metadata || {}),
    id
  );

  insertVersionSnapshot(db, {
    recordId: id,
    version: nextVersion,
    snapshot: merged,
    changeNote: changeNote || `Updated to v${nextVersion}`,
    actor,
  });

  markEmbeddingStale(db, id);

  return findKnowledgeRecordById(db, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{ id: string; displayName?: string; username?: string }} actor
 */
export function archiveKnowledgeRecord(db, id, actor) {
  return updateKnowledgeRecord(
    db,
    id,
    { status: 'archived' },
    actor,
    'Archived'
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 */
function insertVersionSnapshot(db, opts) {
  const versionId = newKnowledgeVersionId();
  const now = new Date().toISOString();
  const actorName = String(opts.actor?.displayName || opts.actor?.username || '').trim();

  db.prepare(
    `INSERT INTO aic_knowledge_versions (
      id, record_id, version, snapshot_json, change_note,
      changed_by_user_id, changed_by_name, changed_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    versionId,
    opts.recordId,
    opts.version,
    JSON.stringify(opts.snapshot || {}),
    String(opts.changeNote || '').slice(0, 500),
    opts.actor?.id || null,
    actorName,
    now
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} recordId
 */
export function listKnowledgeVersions(db, recordId) {
  const rows = db
    .prepare(
      `SELECT id, record_id, version, snapshot_json, change_note,
              changed_by_user_id, changed_by_name, changed_at_iso
       FROM aic_knowledge_versions
       WHERE record_id = ?
       ORDER BY version DESC`
    )
    .all(String(recordId || '').trim());

  return rows.map((row) => ({
    id: String(row.id),
    recordId: String(row.record_id),
    version: Number(row.version) || 1,
    snapshot: parseJsonObject(row.snapshot_json),
    changeNote: String(row.change_note || ''),
    changedBy: String(row.changed_by_user_id || ''),
    changedByName: String(row.changed_by_name || ''),
    changedAt: String(row.changed_at_iso || ''),
  }));
}

/**
 * Future-ready: reserve embedding row without computing vectors.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} recordId
 */
export function ensureEmbeddingPlaceholder(db, recordId) {
  const existing = db
    .prepare(`SELECT record_id FROM aic_knowledge_embeddings WHERE record_id = ?`)
    .get(recordId);
  if (existing) return;

  db.prepare(
    `INSERT INTO aic_knowledge_embeddings (record_id, status) VALUES (?, 'pending')`
  ).run(recordId);
}

/**
 * Mark embedding as stale when content changes (future RAG re-index hook).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} recordId
 */
export function markEmbeddingStale(db, recordId) {
  db.prepare(
    `INSERT INTO aic_knowledge_embeddings (record_id, status)
     VALUES (?, 'pending')
     ON CONFLICT(record_id) DO UPDATE SET
       status = 'pending',
       embedding_json = NULL,
       indexed_at_iso = NULL,
       error_message = NULL`
  ).run(recordId);
}

/**
 * Aggregate counts for dashboard statistics.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function aggregateKnowledgeStats(db) {
  const byType = db
    .prepare(
      `SELECT knowledge_type, status, COUNT(*) AS c
       FROM aic_knowledge_records
       GROUP BY knowledge_type, status`
    )
    .all();

  /** @type {Record<string, number>} */
  const typeCounts = {};
  let total = 0;
  let pendingReview = 0;
  let archived = 0;

  for (const row of byType) {
    const c = Number(row.c) || 0;
    const type = String(row.knowledge_type);
    const status = String(row.status);
    total += c;
    typeCounts[type] = (typeCounts[type] || 0) + c;
    if (status === 'pending_review') pendingReview += c;
    if (status === 'archived') archived += c;
  }

  return { total, typeCounts, pendingReview, archived };
}

/**
 * Keyword search across active records (repository-level; service may add semantic layer).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {object} [opts]
 */
export function keywordSearchRecords(db, query, opts = {}) {
  return listKnowledgeRecords(db, {
    q: query,
    knowledgeType: opts.knowledgeType,
    category: opts.category,
    module: opts.module,
    tags: opts.tags,
    status: opts.status,
    includeArchived: Boolean(opts.includeArchived),
    limit: opts.limit,
    offset: opts.offset,
  });
}

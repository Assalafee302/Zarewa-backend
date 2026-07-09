/**
 * AI Knowledge Center — core business operations.
 *
 * @module server/aiKnowledgeCenter/services/knowledgeService
 */

import { appendAuditLog } from '../../controlOps.js';
import {
  archiveKnowledgeRecord,
  ensureAiKnowledgeCenterTables,
  findKnowledgeRecordById,
  insertKnowledgeRecord,
  listKnowledgeRecords,
  listKnowledgeVersions,
  updateKnowledgeRecord,
} from '../repository/knowledgeRepository.js';
import {
  validateCreateKnowledge,
  validateListQuery,
  validateUpdateKnowledge,
} from '../validators/knowledgeValidator.js';
import { scheduleIndexKnowledgeRecord } from './embeddingIndexerService.js';

/**
 * Initialize tables on first use.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function initKnowledgeCenter(db) {
  ensureAiKnowledgeCenterTables(db);
}

/**
 * Create a knowledge record.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} body
 * @param {object} actor
 */
export function createKnowledge(db, body, actor) {
  initKnowledgeCenter(db);
  const validated = validateCreateKnowledge(body);
  if (!validated.ok) return { ok: false, error: validated.error };

  const record = insertKnowledgeRecord(db, validated.value, actor);
  appendAuditLog(db, {
    actor,
    action: 'ai_knowledge.create',
    entityKind: 'ai_knowledge',
    entityId: record?.id,
    note: record?.title,
    details: { knowledgeType: record?.knowledgeType, version: 1 },
  });

  if (record?.id) scheduleIndexKnowledgeRecord(db, record.id);

  return { ok: true, record };
}

/**
 * Update a knowledge record (creates version snapshot).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {Record<string, unknown>} body
 * @param {object} actor
 */
export function updateKnowledge(db, id, body, actor) {
  initKnowledgeCenter(db);
  const validated = validateUpdateKnowledge(body);
  if (!validated.ok) return { ok: false, error: validated.error };

  const { changeNote, ...patch } = validated.value;
  const record = updateKnowledgeRecord(db, id, patch, actor, changeNote || '');
  if (!record) return { ok: false, error: 'Knowledge record not found.', code: 'NOT_FOUND' };

  appendAuditLog(db, {
    actor,
    action: 'ai_knowledge.update',
    entityKind: 'ai_knowledge',
    entityId: record.id,
    note: record.title,
    details: { knowledgeType: record.knowledgeType, version: record.version },
  });

  scheduleIndexKnowledgeRecord(db, record.id);

  return { ok: true, record };
}

/**
 * Archive a knowledge record (soft delete).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} actor
 */
export function archiveKnowledge(db, id, actor) {
  initKnowledgeCenter(db);
  const record = archiveKnowledgeRecord(db, id, actor);
  if (!record) return { ok: false, error: 'Knowledge record not found.', code: 'NOT_FOUND' };

  appendAuditLog(db, {
    actor,
    action: 'ai_knowledge.archive',
    entityKind: 'ai_knowledge',
    entityId: record.id,
    note: record.title,
  });

  return { ok: true, record };
}

/**
 * Retrieve a single record by id.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function getKnowledgeById(db, id) {
  initKnowledgeCenter(db);
  const record = findKnowledgeRecordById(db, id);
  if (!record) return { ok: false, error: 'Knowledge record not found.', code: 'NOT_FOUND' };
  return { ok: true, record };
}

/**
 * List records with filters.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} query
 */
export function listKnowledge(db, query) {
  initKnowledgeCenter(db);
  const filters = validateListQuery(query);
  if (filters.error) return { ok: false, error: filters.error };

  const result = listKnowledgeRecords(db, filters);
  return { ok: true, ...result };
}

/**
 * List version history for a record.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function getKnowledgeVersions(db, id) {
  initKnowledgeCenter(db);
  const record = findKnowledgeRecordById(db, id);
  if (!record) return { ok: false, error: 'Knowledge record not found.', code: 'NOT_FOUND' };

  const versions = listKnowledgeVersions(db, id);
  return { ok: true, recordId: id, currentVersion: record.version, versions };
}

/**
 * Retrieve records by category.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} category
 * @param {object} [opts]
 */
export function getKnowledgeByCategory(db, category, opts = {}) {
  return listKnowledge(db, { ...opts, category });
}

/**
 * Retrieve records by module.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} module
 * @param {object} [opts]
 */
export function getKnowledgeByModule(db, module, opts = {}) {
  return listKnowledge(db, { ...opts, module });
}

/**
 * Retrieve records by tags (all tags must match).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} tags
 * @param {object} [opts]
 */
export function getKnowledgeByTags(db, tags, opts = {}) {
  return listKnowledge(db, { ...opts, tags: tags.join(',') });
}

/**
 * AI Knowledge Center — HTTP controllers (thin; no business logic).
 *
 * @module server/aiKnowledgeCenter/controllers/knowledgeController
 */

import {
  archiveKnowledge,
  createKnowledge,
  getKnowledgeById,
  getKnowledgeVersions,
  listKnowledge,
  updateKnowledge,
} from '../services/knowledgeService.js';
import { searchKnowledge } from '../services/knowledgeSearchService.js';
import { getKnowledgeCenterStats } from '../services/knowledgeStatsService.js';
import { reindexAllKnowledge } from '../services/embeddingIndexerService.js';
import { listKnowledgeTypeIds, KNOWLEDGE_TYPE_REGISTRY } from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleGetStats(db, req, res) {
  try {
    const payload = getKnowledgeCenterStats(db);
    return res.json(payload);
  } catch (e) {
    console.error('[ai-knowledge] stats error', e);
    return res.status(500).json({ ok: false, error: 'Could not load knowledge center statistics.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleListTypes(_db, _req, res) {
  return res.json({
    ok: true,
    types: listKnowledgeTypeIds().map((id) => ({ id, ...KNOWLEDGE_TYPE_REGISTRY[id] })),
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleListRecords(db, req, res) {
  try {
    const result = listKnowledge(db, req.query || {});
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, total: result.total, records: result.records });
  } catch (e) {
    console.error('[ai-knowledge] list error', e);
    return res.status(500).json({ ok: false, error: 'Could not list knowledge records.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleGetRecord(db, req, res) {
  try {
    const result = getKnowledgeById(db, req.params.id);
    if (!result.ok) return res.status(404).json(result);
    return res.json({ ok: true, record: result.record });
  } catch (e) {
    console.error('[ai-knowledge] get error', e);
    return res.status(500).json({ ok: false, error: 'Could not load knowledge record.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleCreateRecord(db, req, res) {
  try {
    const result = createKnowledge(db, req.body || {}, req.user);
    if (!result.ok) return res.status(400).json(result);
    return res.status(201).json({ ok: true, record: result.record });
  } catch (e) {
    console.error('[ai-knowledge] create error', e);
    return res.status(500).json({ ok: false, error: 'Could not create knowledge record.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleUpdateRecord(db, req, res) {
  try {
    const result = updateKnowledge(db, req.params.id, req.body || {}, req.user);
    if (!result.ok) {
      return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json(result);
    }
    return res.json({ ok: true, record: result.record });
  } catch (e) {
    console.error('[ai-knowledge] update error', e);
    return res.status(500).json({ ok: false, error: 'Could not update knowledge record.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleArchiveRecord(db, req, res) {
  try {
    const result = archiveKnowledge(db, req.params.id, req.user);
    if (!result.ok) {
      return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json(result);
    }
    return res.json({ ok: true, record: result.record });
  } catch (e) {
    console.error('[ai-knowledge] archive error', e);
    return res.status(500).json({ ok: false, error: 'Could not archive knowledge record.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleListVersions(db, req, res) {
  try {
    const result = getKnowledgeVersions(db, req.params.id);
    if (!result.ok) return res.status(404).json(result);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[ai-knowledge] versions error', e);
    return res.status(500).json({ ok: false, error: 'Could not load version history.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleSearch(db, req, res) {
  try {
    const result = await searchKnowledge(db, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (e) {
    console.error('[ai-knowledge] search error', e);
    return res.status(500).json({ ok: false, error: 'Knowledge search failed.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleReindex(db, req, res) {
  try {
    const limit = Number(req.body?.limit) || undefined;
    const result = await reindexAllKnowledge(db, { limit });
    return res.json({ ok: true, result });
  } catch (e) {
    console.error('[ai-knowledge] reindex error', e);
    return res.status(500).json({ ok: false, error: 'Embedding reindex failed.' });
  }
}

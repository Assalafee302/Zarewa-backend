/**
 * AI Knowledge Center — embedding indexer (sync records ↔ vectors).
 *
 * @module server/aiKnowledgeCenter/services/embeddingIndexerService
 */

import { buildBodyText } from '../models/knowledgeRecordModel.js';
import { findKnowledgeRecordById } from '../repository/knowledgeRepository.js';
import {
  getEmbeddingRow,
  listRecordIdsNeedingIndex,
  markEmbeddingFailed,
  saveReadyEmbedding,
} from '../repository/embeddingRepository.js';
import {
  batchGenerateEmbeddings,
  hashEmbeddingContent,
  readEmbeddingModelConfig,
} from './embeddingService.js';

/**
 * Build indexable text from a knowledge record.
 *
 * @param {import('../models/knowledgeRecordModel.js').KnowledgeRecord | null} record
 * @returns {string}
 */
export function indexableTextFromRecord(record) {
  if (!record) return '';
  return buildBodyText({
    title: record.title,
    keywords: record.keywords,
    content: record.content,
    bodyText: record.bodyText,
  });
}

/**
 * Index a single knowledge record (synchronous; call via scheduler for async).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} recordId
 * @returns {Promise<{ ok: boolean; skipped?: boolean; recordId: string; error?: string }>}
 */
export async function indexKnowledgeRecord(db, recordId) {
  const id = String(recordId || '').trim();
  const started = Date.now();
  const record = findKnowledgeRecordById(db, id);
  if (!record) {
    return { ok: false, recordId: id, error: 'Record not found' };
  }

  const text = indexableTextFromRecord(record);
  if (!text.trim()) {
    markEmbeddingFailed(db, id, 'Empty indexable content');
    return { ok: false, recordId: id, error: 'Empty content' };
  }

  const contentHash = hashEmbeddingContent(text);
  const existing = getEmbeddingRow(db, id);
  if (
    existing?.status === 'ready' &&
    existing?.content_hash === contentHash &&
    existing?.embedding_json
  ) {
    console.info(`[aic-knowledge] embedding index skipped (unchanged) record=${id} ms=${Date.now() - started}`);
    return { ok: true, skipped: true, recordId: id };
  }

  const config = readEmbeddingModelConfig();

  try {
    const [vector] = await batchGenerateEmbeddings([text]);
    if (!vector?.length) throw new Error('Empty embedding vector');

    saveReadyEmbedding(db, {
      recordId: id,
      vector,
      model: config.model,
      dimensions: vector.length,
      contentHash,
    });

    console.info(
      `[aic-knowledge] embedding indexed record=${id} model=${config.model} dims=${vector.length} ms=${Date.now() - started}`
    );
    return { ok: true, recordId: id };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    markEmbeddingFailed(db, id, msg);
    console.error(`[aic-knowledge] embedding index failed record=${id} ms=${Date.now() - started}`, msg);
    return { ok: false, recordId: id, error: msg };
  }
}

/** Alias for explicit update calls. */
export const updateEmbedding = indexKnowledgeRecord;

/**
 * Reindex all records that are pending, failed, or missing embeddings.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 */
export async function reindexAllKnowledge(db, opts = {}) {
  const started = Date.now();
  const ids = listRecordIdsNeedingIndex(db);
  const limit = Math.max(1, Number(opts.limit) || ids.length);
  const batch = ids.slice(0, limit);

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const id of batch) {
    const result = await indexKnowledgeRecord(db, id);
    if (result.skipped) skipped += 1;
    else if (result.ok) ok += 1;
    else failed += 1;
  }

  console.info(
    `[aic-knowledge] reindex complete total=${batch.length} ok=${ok} skipped=${skipped} failed=${failed} ms=${Date.now() - started}`
  );

  return { total: batch.length, ok, skipped, failed, pending: Math.max(0, ids.length - batch.length) };
}

/**
 * Schedule async indexing without blocking the HTTP response.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} recordId
 */
export function scheduleIndexKnowledgeRecord(db, recordId) {
  const id = String(recordId || '').trim();
  if (!id) return;

  setImmediate(() => {
    indexKnowledgeRecord(db, id).catch((e) => {
      console.error(`[aic-knowledge] async index error record=${id}`, e?.message || e);
    });
  });
}

/**
 * AI Knowledge Center — domain model mappers (DB row ↔ API record).
 *
 * @module server/aiKnowledgeCenter/models/knowledgeRecordModel
 */

import { isKnownKnowledgeType } from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';

/**
 * @typedef {object} KnowledgeRecord
 * @property {string} id
 * @property {string} knowledgeType
 * @property {string} title
 * @property {string} category
 * @property {string[]} tags
 * @property {string} module
 * @property {string[]} keywords
 * @property {Record<string, unknown>} content
 * @property {string} bodyText
 * @property {string} createdBy
 * @property {string} createdByName
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} version
 * @property {string} status
 * @property {Record<string, unknown>} metadata
 */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseJsonStringArray(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function parseJsonObject(raw) {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Map a database row to a KnowledgeRecord API object.
 *
 * @param {Record<string, unknown> | undefined | null} row
 * @returns {KnowledgeRecord | null}
 */
export function mapRowToKnowledgeRecord(row) {
  if (!row) return null;
  const knowledgeType = String(row.knowledge_type || '').trim();
  if (!isKnownKnowledgeType(knowledgeType)) return null;

  return {
    id: String(row.id || ''),
    knowledgeType,
    title: String(row.title || ''),
    category: String(row.category || 'general'),
    tags: parseJsonStringArray(row.tags_json),
    module: String(row.module || 'general'),
    keywords: parseJsonStringArray(row.keywords_json),
    content: parseJsonObject(row.content_json),
    bodyText: String(row.body_text || ''),
    createdBy: String(row.created_by_user_id || ''),
    createdByName: String(row.created_by_name || ''),
    createdAt: String(row.created_at_iso || ''),
    updatedAt: String(row.updated_at_iso || ''),
    version: Number(row.version) || 1,
    status: String(row.status || 'active'),
    metadata: parseJsonObject(row.metadata_json),
  };
}

/**
 * Build searchable body text from structured fields.
 *
 * @param {{ title?: string; keywords?: string[]; content?: Record<string, unknown>; bodyText?: string }} input
 * @returns {string}
 */
export function buildBodyText(input) {
  const parts = [
    String(input.title || '').trim(),
    ...(Array.isArray(input.keywords) ? input.keywords : []),
    String(input.bodyText || '').trim(),
  ];

  const content = input.content && typeof input.content === 'object' ? input.content : {};
  for (const key of ['answer', 'summary', 'definition', 'prompt', 'sql', 'userMessage', 'assistantMessage', 'steps']) {
    const val = content[key];
    if (typeof val === 'string' && val.trim()) parts.push(val.trim());
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) parts.push(item.trim());
      }
    }
  }

  return parts.join('\n').slice(0, 50000);
}

/**
 * @returns {string}
 */
export function newKnowledgeRecordId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `AKC-${ts}-${rnd}`;
}

/**
 * @returns {string}
 */
export function newKnowledgeVersionId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AKCV-${ts}-${rnd}`;
}

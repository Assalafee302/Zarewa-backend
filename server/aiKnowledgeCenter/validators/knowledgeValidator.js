/**
 * AI Knowledge Center — input validation.
 *
 * @module server/aiKnowledgeCenter/validators/knowledgeValidator
 */

import {
  isKnownKnowledgeType,
  KNOWLEDGE_MODULE_VALUES,
  KNOWLEDGE_STATUS_VALUES,
} from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';

const MAX_TITLE = 500;
const MAX_CATEGORY = 120;
const MAX_MODULE = 80;
const MAX_TAG_LEN = 80;
const MAX_TAGS = 30;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_LEN = 120;
const MAX_BODY = 50000;
const MAX_CHANGE_NOTE = 500;

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeStringArray(raw, maxItems, maxLen) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => String(v || '').trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * Validate create payload.
 *
 * @param {Record<string, unknown>} body
 * @returns {{ ok: true; value: object } | { ok: false; error: string }}
 */
export function validateCreateKnowledge(body) {
  const knowledgeType = String(body?.knowledgeType || '').trim();
  if (!isKnownKnowledgeType(knowledgeType)) {
    return { ok: false, error: 'Invalid or missing knowledgeType.' };
  }

  const title = String(body?.title || '').trim().slice(0, MAX_TITLE);
  if (!title) return { ok: false, error: 'Title is required.' };

  const category = String(body?.category || 'general').trim().slice(0, MAX_CATEGORY) || 'general';
  const module = String(body?.module || 'general').trim().slice(0, MAX_MODULE) || 'general';
  if (!KNOWLEDGE_MODULE_VALUES.includes(module)) {
    return { ok: false, error: `Invalid module. Use one of: ${KNOWLEDGE_MODULE_VALUES.join(', ')}` };
  }

  const status = String(body?.status || 'active').trim();
  if (!KNOWLEDGE_STATUS_VALUES.has(status)) {
    return { ok: false, error: 'Invalid status.' };
  }

  const content =
    body?.content != null && typeof body.content === 'object' && !Array.isArray(body.content)
      ? body.content
      : {};

  const metadata =
    body?.metadata != null && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

  return {
    ok: true,
    value: {
      knowledgeType,
      title,
      category,
      module,
      status,
      tags: normalizeStringArray(body?.tags, MAX_TAGS, MAX_TAG_LEN),
      keywords: normalizeStringArray(body?.keywords, MAX_KEYWORDS, MAX_KEYWORD_LEN),
      content,
      metadata,
      bodyText: String(body?.bodyText || '').trim().slice(0, MAX_BODY),
    },
  };
}

/**
 * Validate partial update payload.
 *
 * @param {Record<string, unknown>} body
 * @returns {{ ok: true; value: object } | { ok: false; error: string }}
 */
export function validateUpdateKnowledge(body) {
  /** @type {Record<string, unknown>} */
  const value = {};

  if (body?.knowledgeType != null) {
    const knowledgeType = String(body.knowledgeType).trim();
    if (!isKnownKnowledgeType(knowledgeType)) {
      return { ok: false, error: 'Invalid knowledgeType.' };
    }
    value.knowledgeType = knowledgeType;
  }

  if (body?.title != null) {
    const title = String(body.title).trim().slice(0, MAX_TITLE);
    if (!title) return { ok: false, error: 'Title cannot be empty.' };
    value.title = title;
  }

  if (body?.category != null) {
    value.category = String(body.category).trim().slice(0, MAX_CATEGORY) || 'general';
  }

  if (body?.module != null) {
    const module = String(body.module).trim().slice(0, MAX_MODULE) || 'general';
    if (!KNOWLEDGE_MODULE_VALUES.includes(module)) {
      return { ok: false, error: `Invalid module.` };
    }
    value.module = module;
  }

  if (body?.status != null) {
    const status = String(body.status).trim();
    if (!KNOWLEDGE_STATUS_VALUES.has(status)) {
      return { ok: false, error: 'Invalid status.' };
    }
    value.status = status;
  }

  if (body?.tags != null) {
    value.tags = normalizeStringArray(body.tags, MAX_TAGS, MAX_TAG_LEN);
  }

  if (body?.keywords != null) {
    value.keywords = normalizeStringArray(body.keywords, MAX_KEYWORDS, MAX_KEYWORD_LEN);
  }

  if (body?.content != null) {
    if (typeof body.content !== 'object' || Array.isArray(body.content)) {
      return { ok: false, error: 'content must be an object.' };
    }
    value.content = body.content;
  }

  if (body?.metadata != null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      return { ok: false, error: 'metadata must be an object.' };
    }
    value.metadata = body.metadata;
  }

  if (body?.bodyText != null) {
    value.bodyText = String(body.bodyText).trim().slice(0, MAX_BODY);
  }

  if (body?.changeNote != null) {
    value.changeNote = String(body.changeNote).trim().slice(0, MAX_CHANGE_NOTE);
  }

  if (!Object.keys(value).length) {
    return { ok: false, error: 'No valid fields to update.' };
  }

  return { ok: true, value };
}

/**
 * Validate search request body.
 *
 * @param {Record<string, unknown>} body
 * @returns {{ ok: true; value: object } | { ok: false; error: string }}
 */
export function validateSearchKnowledge(body) {
  const query = String(body?.query || body?.q || '').trim();
  if (!query) return { ok: false, error: 'Search query is required.' };

  const mode = String(body?.mode || 'keyword').trim().toLowerCase();
  if (!['keyword', 'semantic', 'hybrid'].includes(mode)) {
    return { ok: false, error: 'Invalid search mode.' };
  }

  const knowledgeType = body?.knowledgeType ? String(body.knowledgeType).trim() : undefined;
  if (knowledgeType && !isKnownKnowledgeType(knowledgeType)) {
    return { ok: false, error: 'Invalid knowledgeType filter.' };
  }

  return {
    ok: true,
    value: {
      query,
      mode,
      knowledgeType,
      category: body?.category ? String(body.category).trim() : undefined,
      module: body?.module ? String(body.module).trim() : undefined,
      tags: normalizeStringArray(body?.tags, MAX_TAGS, MAX_TAG_LEN),
      status: body?.status ? String(body.status).trim() : undefined,
      includeArchived: Boolean(body?.includeArchived),
      limit: Math.min(100, Math.max(1, Number(body?.limit) || 25)),
      offset: Math.max(0, Number(body?.offset) || 0),
    },
  };
}

/**
 * Validate list query params.
 *
 * @param {Record<string, unknown>} query
 * @returns {object}
 */
export function validateListQuery(query) {
  const knowledgeType = query?.knowledgeType ? String(query.knowledgeType).trim() : undefined;
  if (knowledgeType && !isKnownKnowledgeType(knowledgeType)) {
    return { error: 'Invalid knowledgeType filter.' };
  }

  const status = query?.status ? String(query.status).trim() : undefined;
  if (status && !KNOWLEDGE_STATUS_VALUES.has(status)) {
    return { error: 'Invalid status filter.' };
  }

  const tagsRaw = query?.tags ? String(query.tags) : '';
  const tags = tagsRaw
    ? tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  return {
    knowledgeType,
    category: query?.category ? String(query.category).trim() : undefined,
    module: query?.module ? String(query.module).trim() : undefined,
    tags,
    status,
    q: query?.q ? String(query.q).trim() : undefined,
    includeArchived: String(query?.includeArchived || '') === '1',
    limit: Math.min(200, Math.max(1, Number(query?.limit) || 50)),
    offset: Math.max(0, Number(query?.offset) || 0),
  };
}

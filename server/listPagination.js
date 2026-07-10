/**
 * Shared pagination query parsing and response shape for list endpoints.
 */

import { DEFAULT_LIST_LIMIT } from './listQueryOpts.js';

/**
 * @param {import('express').Request} req
 * @param {{ defaultLimit?: number; maxLimit?: number }} [opts]
 * @returns {{ limit: number; offset: number; unlimited: boolean }}
 */
export function parseListQuery(req, opts = {}) {
  const maxLimit = Math.min(50_000, Math.max(1, Number(opts.maxLimit) || 5000));
  const defaultLimit = Math.min(maxLimit, Number(opts.defaultLimit) || DEFAULT_LIST_LIMIT);
  const unlimited = String(req.query?.unlimited || '') === '1';
  if (unlimited) return { limit: 0, offset: 0, unlimited: true };
  const limitRaw = req.query?.limit;
  const offsetRaw = req.query?.offset;
  let limit = defaultLimit;
  if (limitRaw != null && limitRaw !== '') {
    const n = Number(limitRaw);
    limit = Number.isFinite(n) && n > 0 ? Math.min(maxLimit, Math.floor(n)) : defaultLimit;
  }
  let offset = 0;
  if (offsetRaw != null && offsetRaw !== '') {
    const n = Number(offsetRaw);
    offset = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return { limit, offset, unlimited: false };
}

/**
 * @param {import('express').Response} res
 * @param {{ items: unknown[]; total?: number; limit: number; offset: number; key?: string }} payload
 */
export function sendPaginatedList(res, payload) {
  const key = payload.key || 'items';
  const body = {
    ok: true,
    total: payload.total ?? payload.items.length,
    limit: payload.limit,
    offset: payload.offset,
    truncated: payload.total != null ? payload.offset + payload.items.length < payload.total : undefined,
    [key]: payload.items,
  };
  return res.json(body);
}

/**
 * @param {unknown[]} items
 * @param {number} offset
 * @param {number} limit 0 = no slice
 */
export function slicePage(items, offset, limit) {
  if (limit <= 0) return items.slice(offset);
  return items.slice(offset, offset + limit);
}

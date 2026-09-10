/**
 * Shared pagination query parsing and response shape for list endpoints.
 */

import { DEFAULT_LIST_LIMIT, UNLIMITED_LIST_HARD_CAP } from './listQueryOpts.js';

/** Deepest page a list endpoint will serve; beyond this callers should be searching. */
const MAX_LIST_OFFSET = Math.min(
  1_000_000,
  Math.max(1000, Number(process.env.ZAREWA_MAX_LIST_OFFSET) || 50_000)
);

/**
 * @param {import('express').Request} req
 * @param {{ defaultLimit?: number; maxLimit?: number; allowUnlimited?: boolean }} [opts]
 * @returns {{ limit: number; offset: number; unlimited: boolean }}
 */
export function parseListQuery(req, opts = {}) {
  const maxLimit = Math.min(50_000, Math.max(1, Number(opts.maxLimit) || 5000));
  const defaultLimit = Math.min(maxLimit, Number(opts.defaultLimit) || DEFAULT_LIST_LIMIT);
  const unlimitedRequested = String(req.query?.unlimited || '') === '1';
  // HTTP unlimited=1 is capped unless the route opts into true unbounded (known-bounded queries only).
  if (unlimitedRequested && opts.allowUnlimited === true) {
    return { limit: 0, offset: 0, unlimited: true };
  }
  if (unlimitedRequested) {
    const hardCap = Math.min(maxLimit, UNLIMITED_LIST_HARD_CAP);
    return { limit: hardCap, offset: 0, unlimited: false };
  }
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
    // Capped: an uncapped offset reaches MySQL as `OFFSET 999999999`, which it serves by
    // walking and discarding that many rows. One query string should not be able to pin
    // a worker, and no desk pages past this depth anyway — it searches instead.
    offset = Number.isFinite(n) && n > 0 ? Math.min(MAX_LIST_OFFSET, Math.floor(n)) : 0;
  }
  return { limit, offset, unlimited: false };
}

/**
 * @param {import('express').Response} res
 * @param {{ items: unknown[]; total?: number; limit: number; offset: number; key?: string; cacheSeconds?: number; staleWhileRevalidateSeconds?: number }} payload
 */
export function sendPaginatedList(res, payload) {
  const key = payload.key || 'items';
  const cacheSec = payload.cacheSeconds != null ? Number(payload.cacheSeconds) : 60;
  if (Number.isFinite(cacheSec) && cacheSec > 0) {
    // Credentialed desk GETs: a short private browser cache is worth real seconds on a
    // mill link. stale-while-revalidate is NOT the default: it serves a knowingly stale
    // body while refetching, so a cashier who just posted a receipt could reload, not see
    // it, and post again. Routes whose staleness is harmless opt in per-route.
    const swrSec = Number(payload.staleWhileRevalidateSeconds) || 0;
    const swr = swrSec > 0 ? `, stale-while-revalidate=${Math.floor(swrSec)}` : '';
    res.setHeader('Cache-Control', `private, max-age=${Math.floor(cacheSec)}${swr}`);
  }
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

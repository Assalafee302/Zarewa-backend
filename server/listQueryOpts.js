const DEFAULT_LIST_LIMIT = Math.min(
  50_000,
  Math.max(50, Number(process.env.ZAREWA_DEFAULT_LIST_LIMIT) || 500)
);

/**
 * Shared list-query limit helpers for readModel list functions.
 * @param {{ limit?: number; unlimited?: boolean; useDefaultLimit?: boolean }} [opts]
 * @returns {number} 0 = no SQL LIMIT
 */
export function resolveListLimit(opts) {
  if (opts?.unlimited) return 0;
  const raw = opts?.limit;
  if (raw == null) {
    return opts?.useDefaultLimit === false ? 0 : DEFAULT_LIST_LIMIT;
  }
  const n = Number(raw);
  // limit=0 / NaN must not mean unbounded — use unlimited: true explicitly.
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(50_000, Math.max(1, Math.floor(n)));
}

export { DEFAULT_LIST_LIMIT };

/**
 * List opts for production queue / cutting-list history.
 * Default: capped recent history (desk responsiveness). Opt into full history with
 * `ZAREWA_PRODUCTION_HISTORY_LIMIT=0` or a positive integer override.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function productionHistoryListOpts() {
  const raw = process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') {
    return { limit: Math.min(50_000, Math.max(500, Number(process.env.ZAREWA_PRODUCTION_HISTORY_DEFAULT) || 5000)) };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/** Desk-safe default for finance history lists (covers ~3 months live volume; override via env). */
export const DEFAULT_FINANCE_HISTORY_LIMIT = Math.min(
  50_000,
  Math.max(500, Number(process.env.ZAREWA_FINANCE_HISTORY_DEFAULT) || 3000)
);

/**
 * List opts for Finance desk expenses / payment requests / treasury movements.
 * Default: capped recent history for bootstrap/desk responsiveness (live KD branch ~2k treasury rows).
 * Set `ZAREWA_FINANCE_HISTORY_LIMIT=0` for unlimited, or a positive integer to override the cap.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function financeHistoryListOpts() {
  const raw = process.env.ZAREWA_FINANCE_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') return { limit: DEFAULT_FINANCE_HISTORY_LIMIT };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/**
 * List opts for Sales customer directory (quotations / receipts pickers).
 * Default: capped directory; use server search for large books.
 * Cap/override with env `ZAREWA_SALES_CUSTOMERS_LIMIT` (0 = unlimited).
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function salesCustomersListOpts() {
  const raw = process.env.ZAREWA_SALES_CUSTOMERS_LIMIT;
  if (raw == null || String(raw).trim() === '') {
    return { limit: Math.min(50_000, Math.max(500, Number(process.env.ZAREWA_SALES_CUSTOMERS_DEFAULT) || 5000)) };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/** Desk-safe default for receipts history (~3 months live KD volume was ~1,061). */
export const DEFAULT_RECEIPTS_HISTORY_LIMIT = Math.min(
  50_000,
  Math.max(500, Number(process.env.ZAREWA_RECEIPTS_HISTORY_DEFAULT) || 3000)
);

/**
 * List opts for sales receipts (Sales filters + Cashier desk confirmation queue).
 * Default: capped recent history. Uncleared/pending receipts are merged in separately
 * so cashier queues are not silently truncated.
 * Set `ZAREWA_RECEIPTS_HISTORY_LIMIT=0` for unlimited, or a positive integer to override.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function receiptsHistoryListOpts() {
  const raw = process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') return { limit: DEFAULT_RECEIPTS_HISTORY_LIMIT };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/** @param {number} limit */
export function sqlLimitClause(limit) {
  return limit > 0 ? ' LIMIT ?' : '';
}

/**
 * LIMIT / OFFSET for paginated list endpoints (MySQL).
 * @param {number} limit 0 = no LIMIT (unless offset > 0, then a hard cap is applied)
 * @param {number} [offset]
 * @returns {{ sql: string; args: number[] }}
 */
export function sqlLimitOffsetClause(limit, offset = 0) {
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  if (limit > 0) {
    return { sql: ' LIMIT ? OFFSET ?', args: [limit, off] };
  }
  if (off > 0) {
    return { sql: ' LIMIT ? OFFSET ?', args: [50_000, off] };
  }
  return { sql: '', args: [] };
}

/**
 * @param {{ listLimits?: Record<string, number | undefined> }} [opts]
 * @param {string} key
 */
export function rowListOpts(opts, key) {
  const lim = opts?.listLimits?.[key];
  if (lim == null) return {};
  if (Number(lim) <= 0) return { unlimited: true };
  return { limit: Number(lim) };
}

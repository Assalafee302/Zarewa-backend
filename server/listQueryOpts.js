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
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(50_000, Math.max(1, Math.floor(n)));
}

export { DEFAULT_LIST_LIMIT };

/**
 * List opts for production queue / cutting-list history.
 * Default: unlimited so Operations / Sales history does not silently drop older rows.
 * Cap with env `ZAREWA_PRODUCTION_HISTORY_LIMIT` (positive integer) when needed.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function productionHistoryListOpts() {
  const raw = process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') return { unlimited: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/**
 * List opts for Finance desk expenses / payment requests / treasury movements.
 * Default: unlimited so Account → Payouts & expenses does not look like “only ~3 weeks”
 * when volume exceeds the generic 500/600 bootstrap row caps.
 * Cap with env `ZAREWA_FINANCE_HISTORY_LIMIT` (positive integer) when needed.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function financeHistoryListOpts() {
  const raw = process.env.ZAREWA_FINANCE_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') return { unlimited: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/**
 * List opts for Sales customer directory (quotations / receipts pickers).
 * Default: unlimited so QuotationModal does not hide customers past the generic 500/600 caps
 * (lists are ordered by name, so later alphabet names disappear).
 * Cap with env `ZAREWA_SALES_CUSTOMERS_LIMIT` (positive integer) when needed.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function salesCustomersListOpts() {
  const raw = process.env.ZAREWA_SALES_CUSTOMERS_LIMIT;
  if (raw == null || String(raw).trim() === '') return { unlimited: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/** @param {number} limit */
export function sqlLimitClause(limit) {
  return limit > 0 ? ' LIMIT ?' : '';
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

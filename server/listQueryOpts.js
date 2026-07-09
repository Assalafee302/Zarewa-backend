/**
 * Shared list-query limit helpers for readModel list functions.
 * @param {{ limit?: number; unlimited?: boolean }} [opts]
 * @returns {number} 0 = no SQL LIMIT
 */
export function resolveListLimit(opts) {
  if (opts?.unlimited) return 0;
  const raw = opts?.limit;
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(50_000, Math.max(1, Math.floor(n)));
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

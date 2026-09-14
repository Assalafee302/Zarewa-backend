const DEFAULT_LIST_LIMIT = Math.min(
  50_000,
  Math.max(50, Number(process.env.ZAREWA_DEFAULT_LIST_LIMIT) || 150)
);

/**
 * First desk page size: recent rows only. SPA background-hydrates older pages via
 * `bootstrapMeta.backgroundHydrate` without waiting for search.
 * Override with `ZAREWA_DESK_PAGE_SIZE` (positive int) or `0` for unlimited history.
 */
export const DEFAULT_DESK_PAGE_SIZE = Math.min(
  50_000,
  Math.max(50, Number(process.env.ZAREWA_DESK_PAGE_SIZE) || 150)
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
 * @param {string} envKey
 * @param {number} fallback
 * @returns {{ unlimited: true } | { limit: number }}
 */
function envCappedListOpts(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw == null || String(raw).trim() === '') {
    return { limit: Math.min(50_000, Math.max(50, fallback)) };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
}

/**
 * Shared recent-first desk page (snapshots + background hydrate).
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function deskPageListOpts() {
  const raw = process.env.ZAREWA_DESK_PAGE_SIZE;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
    return { limit: Math.min(50_000, Math.max(1, Math.floor(n))) };
  }
  return { limit: DEFAULT_DESK_PAGE_SIZE };
}

/**
 * List opts for production queue / cutting-list history.
 * Default: recent desk page. Opt into full history with `ZAREWA_PRODUCTION_HISTORY_LIMIT=0`.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function productionHistoryListOpts() {
  const raw = process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') {
    return deskPageListOpts();
  }
  return envCappedListOpts('ZAREWA_PRODUCTION_HISTORY_LIMIT', DEFAULT_DESK_PAGE_SIZE);
}

/** Desk-safe default for finance history lists (recent-first page). */
export const DEFAULT_FINANCE_HISTORY_LIMIT = DEFAULT_DESK_PAGE_SIZE;

/**
 * List opts for Finance desk expenses / payment requests / treasury movements.
 * Set `ZAREWA_FINANCE_HISTORY_LIMIT=0` for unlimited.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function financeHistoryListOpts() {
  const raw = process.env.ZAREWA_FINANCE_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') {
    return deskPageListOpts();
  }
  return envCappedListOpts('ZAREWA_FINANCE_HISTORY_LIMIT', DEFAULT_FINANCE_HISTORY_LIMIT);
}

/**
 * List opts for Sales customer directory (recently entered first on desks).
 * Cap/override with env `ZAREWA_SALES_CUSTOMERS_LIMIT` (0 = unlimited).
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function salesCustomersListOpts() {
  const raw = process.env.ZAREWA_SALES_CUSTOMERS_LIMIT;
  if (raw == null || String(raw).trim() === '') {
    return deskPageListOpts();
  }
  return envCappedListOpts('ZAREWA_SALES_CUSTOMERS_LIMIT', DEFAULT_DESK_PAGE_SIZE);
}

/** Desk-safe default for receipts history. */
export const DEFAULT_RECEIPTS_HISTORY_LIMIT = DEFAULT_DESK_PAGE_SIZE;

/** Open AP / bank-recon lines on finance snapshots. */
export const DEFAULT_FINANCE_REGISTER_LIMIT = DEFAULT_DESK_PAGE_SIZE;

/**
 * List opts for accounts payable / bank reconciliation snapshot slices.
 * Set `ZAREWA_FINANCE_REGISTER_LIMIT=0` for unlimited.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function financeRegisterListOpts() {
  const raw = process.env.ZAREWA_FINANCE_REGISTER_LIMIT;
  if (raw == null || String(raw).trim() === '') {
    return deskPageListOpts();
  }
  return envCappedListOpts('ZAREWA_FINANCE_REGISTER_LIMIT', DEFAULT_FINANCE_REGISTER_LIMIT);
}

/**
 * List opts for sales receipts (Sales filters + Cashier desk confirmation queue).
 * Uncleared/pending receipts are merged in separately so cashier queues are not
 * silently truncated.
 * Set `ZAREWA_RECEIPTS_HISTORY_LIMIT=0` for unlimited.
 * @returns {{ unlimited: true } | { limit: number }}
 */
export function receiptsHistoryListOpts() {
  const raw = process.env.ZAREWA_RECEIPTS_HISTORY_LIMIT;
  if (raw == null || String(raw).trim() === '') {
    return deskPageListOpts();
  }
  return envCappedListOpts('ZAREWA_RECEIPTS_HISTORY_LIMIT', DEFAULT_RECEIPTS_HISTORY_LIMIT);
}

/**
 * Coil register for bootstrap / domain snapshots.
 *
 * Default `activeOnly`: complete on-hand pack (qty remaining or reserved). Never a
 * recent-N slice — that previously hid live stock (e.g. CL-26-2043) from Stock Management.
 * Consumed/finished history loads via `/api/coil-lots`, `/api/coil-lots/search`, or
 * `/api/production/eligible-coils`.
 *
 * Escape hatch: `ZAREWA_COIL_DESK_FULL=1` or `ZAREWA_COIL_DESK_LIMIT=0` → full historical register.
 * @returns {{ unlimited: true } | { activeOnly: true }}
 */
export function coilDeskListOpts() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.ZAREWA_COIL_DESK_FULL || ''))) {
    return { unlimited: true };
  }
  const raw = process.env.ZAREWA_COIL_DESK_LIMIT;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { unlimited: true };
  }
  return { activeOnly: true };
}

/**
 * SPA hint: keep loading older pages in the background (newest/recent first already shipped).
 * Does not require the user to search or open a row.
 *
 * @param {{ key: string; path: string; limit: number; loaded: number; querySuffix?: string }[]} resources
 * @param {{ pageSize?: number }} [opts]
 */
export function buildBackgroundHydrateMeta(resources, opts = {}) {
  const pageSize = Math.max(1, Number(opts.pageSize) || DEFAULT_DESK_PAGE_SIZE);
  const cont = (resources || [])
    .filter((r) => Number(r.loaded) >= Number(r.limit) && Number(r.limit) > 0)
    .map((r) => {
      const limit = Number(r.limit) || pageSize;
      const offset = limit;
      const suffix = r.querySuffix ? String(r.querySuffix) : '';
      const join = r.path.includes('?') ? '&' : '?';
      return {
        key: r.key,
        href: `${r.path}${join}limit=${limit}&offset=${offset}${suffix}`,
        offset,
        limit,
      };
    });
  return {
    enabled: cont.length > 0,
    strategy: 'recent_first',
    pageSize,
    resources: cont,
  };
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

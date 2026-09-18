/**
 * Branch-level refund lock window — admin closes quotations and receipts in a date range
 * on one branch (treated as already settled / not refundable). Other branches and
 * transactions outside the window stay open. Quotation-level blocks remain separate.
 */

export const BRANCH_REFUNDS_BLOCK_REASON_MIN_LEN = 10;

/**
 * Calendar day YYYY-MM-DD from a date or timestamp. Empty if unparseable.
 * @param {string | null | undefined} raw
 */
export function calendarDayFromIso(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

/** @param {string | null | undefined} raw */
export function normalizeBranchRefundsBlockedFromIso(raw) {
  const day = calendarDayFromIso(raw);
  return day ? `${day}T00:00:00.000Z` : '';
}

/** @param {string | null | undefined} raw */
export function normalizeBranchRefundsBlockedToIso(raw) {
  const day = calendarDayFromIso(raw);
  return day ? `${day}T23:59:59.999Z` : '';
}

/**
 * True when a lock window is stored (from-date set).
 * @param {{ refunds_blocked_from_iso?: string | null; refundsBlockedFromISO?: string | null } | null | undefined} row
 */
export function branchHasRefundLockWindow(row) {
  return Boolean(calendarDayFromIso(row?.refunds_blocked_from_iso ?? row?.refundsBlockedFromISO));
}

/**
 * True when `dayISO` falls in the branch lock window (inclusive).
 * Open-ended when to-date is blank (on/after from-date).
 * @param {string | null | undefined} dayISO
 * @param {{
 *   refunds_blocked_from_iso?: string | null;
 *   refundsBlockedFromISO?: string | null;
 *   refunds_blocked_to_iso?: string | null;
 *   refundsBlockedToISO?: string | null;
 * } | null | undefined} freeze
 */
export function dateInBranchRefundLockWindow(dayISO, freeze) {
  const day = calendarDayFromIso(dayISO);
  const from = calendarDayFromIso(freeze?.refunds_blocked_from_iso ?? freeze?.refundsBlockedFromISO);
  if (!day || !from) return false;
  if (day < from) return false;
  const to = calendarDayFromIso(freeze?.refunds_blocked_to_iso ?? freeze?.refundsBlockedToISO);
  if (to && day > to) return false;
  return true;
}

/**
 * Quotation is locked when the quote date or any receipt date sits in the window.
 * @param {{ quotationDateISO?: string | null; receiptDateISOs?: Array<string | null | undefined> }} input
 * @param {object | null | undefined} freeze
 */
export function quotationHitsBranchRefundLockWindow(input, freeze) {
  if (!branchHasRefundLockWindow(freeze)) return false;
  if (dateInBranchRefundLockWindow(input?.quotationDateISO, freeze)) return true;
  const receipts = Array.isArray(input?.receiptDateISOs) ? input.receiptDateISOs : [];
  return receipts.some((d) => dateInBranchRefundLockWindow(d, freeze));
}

/**
 * @deprecated Use {@link branchHasRefundLockWindow} — a configured window, not "frozen right now".
 */
export function branchRefundsFrozen(row) {
  return branchHasRefundLockWindow(row);
}

/**
 * @param {object | null | undefined} row
 * @param {string} [branchLabel]
 */
export function formatBranchRefundsFrozenError(row, branchLabel) {
  const name = String(branchLabel || row?.name || '').trim() || 'this branch';
  const from = calendarDayFromIso(row?.refunds_blocked_from_iso ?? row?.refundsBlockedFromISO);
  const to = calendarDayFromIso(row?.refunds_blocked_to_iso ?? row?.refundsBlockedToISO);
  const range = from ? (to ? `${from} to ${to}` : `from ${from} onward`) : '';
  const why = String(row?.refunds_blocked_reason ?? row?.refundsBlockedReason ?? '').trim();
  const base = range
    ? `No refunds on ${name} quotations or receipts dated ${range}. Those transactions are treated as already settled.`
    : `No refunds on ${name} quotations or receipts in the locked period. Those transactions are treated as already settled.`;
  return why ? `${base} ${why}` : base;
}

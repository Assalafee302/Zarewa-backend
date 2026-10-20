/**
 * Finance attention list start date.
 * Items whose underlying record date is before ATTENTION_FROM_DATE drop out of the
 * list, the chip counts, and the bell. Nothing is deleted or acknowledged.
 * Frontend copy via `npm run sync:shared` → src/shared/lib/attentionFromDate.js
 */

/** Policy key in branch settings (org policy, one date per branch). */
export const ATTENTION_FROM_DATE_SETTING = 'ATTENTION_FROM_DATE';

/** Used when a branch has no stored date. */
export const ATTENTION_FROM_DATE_DEFAULT = '2026-08-01';

const TYPE_BY_KIND = {
  clearance: 'orders',
  production: 'orders',
  flagged: 'orders',
  staff_purchase_credit: 'orders',
  price_exception: 'orders',
  payments: 'cash',
  refunds: 'cash',
  register_settlement: 'cash',
  overtime: 'cash',
  conversions: 'floor',
  material: 'floor',
  purchase_orders: 'floor',
  purchase_order: 'floor',
  governance: 'control',
  edit_approvals: 'edits',
  edit_approval: 'edits',
};

export const ATTENTION_LIST_TYPES = ['orders', 'cash', 'floor', 'control', 'edits', 'stock review'];

/** @param {unknown} value */
export function attentionDay(value) {
  const s = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * Calendar day of the record that raised the flag (quote date, request date, job
 * completion, stock-period end). Empty when the row has no record date.
 * @param {object | null | undefined} item
 */
export function attentionRecordDay(item) {
  const it = item || {};
  const row = it.row || {};
  const kind = String(it.kind || '').toLowerCase();
  const missingManager =
    kind === 'governance' &&
    (it.integrityKind === 'missing_branch_manager' || row.integrityKind === 'missing_branch_manager');
  if (missingManager) return '';

  let raw = it.recordDateIso;
  if (!attentionDay(raw)) {
    if (kind === 'clearance' || kind === 'price_exception') raw = row.date_iso;
    else if (kind === 'flagged') raw = row.date_iso || row.manager_flagged_at_iso;
    else if (kind === 'production') raw = row.date_iso;
    else if (kind === 'conversions') raw = row.completed_at_iso;
    else if (kind === 'refunds') raw = row.requested_at_iso;
    else if (kind === 'register_settlement') raw = row.requestedAtIso || row.requested_at_iso;
    else if (kind === 'payments') raw = row.request_date || row.requestDate;
    else if (kind === 'overtime') raw = row.submittedAtIso || row.updatedAtIso || row.createdAtIso || row.dayIso;
    else if (kind === 'material') raw = row.date_iso;
    else if (kind === 'edit_approvals' || kind === 'edit_approval') raw = row.requestedAtISO || row.requested_at_iso;
    else if (kind === 'staff_purchase_credit') raw = row.createdAtIso || row.updatedAtIso || row.created_at_iso;
    else if (kind === 'governance') raw = row.completedAtIso || row.atIso;
    else raw = row.periodEndIso || row.period_end_iso;
  }
  return attentionDay(raw) || attentionDay(it.atIso) || attentionDay(row.periodEndIso) || '';
}

/** @param {string | null | undefined} kind */
export function attentionListType(kind) {
  return TYPE_BY_KIND[String(kind || '').trim().toLowerCase()] || '';
}

/**
 * @param {object | null | undefined} item
 * @param {string} fromDate YYYY-MM-DD
 */
export function attentionItemIsBeforeFromDate(item, fromDate) {
  const from = attentionDay(fromDate) || ATTENTION_FROM_DATE_DEFAULT;
  const day = attentionRecordDay(item);
  if (!day) return false;
  return day < from;
}

/**
 * Branch start date for one item. `perBranch` overrides the scope date.
 * @param {object | null | undefined} item
 * @param {{ dateISO?: string, perBranch?: Record<string, string> }} window
 */
export function attentionFromDateForItem(item, window = {}) {
  if (window.uniform && attentionDay(window.dateISO)) return attentionDay(window.dateISO);
  const per = window.perBranch || {};
  const bid = String(item?.branchId || item?.row?.branch_id || item?.row?.branchId || '').trim();
  const branchDate = bid ? attentionDay(per[bid]) : '';
  return branchDate || attentionDay(window.dateISO) || ATTENTION_FROM_DATE_DEFAULT;
}

/**
 * @param {object[]} items
 * @param {{ dateISO?: string, perBranch?: Record<string, string> }} window
 * @param {'visible' | 'hidden'} mode
 */
export function selectAttentionItemsByFromDate(items, window, mode = 'visible') {
  const list = Array.isArray(items) ? items : [];
  const wantHidden = mode === 'hidden';
  return list.filter((it) => attentionItemIsBeforeFromDate(it, attentionFromDateForItem(it, window)) === wantHidden);
}

/** @param {object[]} items */
export function countAttentionByType(items) {
  const out = { orders: 0, cash: 0, floor: 0, control: 0, edits: 0, 'stock review': 0 };
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.kind === 'stock_review' || it?.listType === 'stock review') {
      out['stock review'] += 1;
      continue;
    }
    const type = attentionListType(it?.kind);
    if (type) out[type] += 1;
  }
  return out;
}

/** @param {string | null | undefined} iso */
export function formatAttentionFromDateLabel(iso) {
  const d = attentionDay(iso) || ATTENTION_FROM_DATE_DEFAULT;
  const dt = new Date(`${d}T12:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return d;
  const mon = dt.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${dt.getUTCDate()} ${mon} ${dt.getUTCFullYear()}`;
}

/**
 * Line under the attention list.
 * @param {string} fromDate
 * @param {number} hiddenCount
 */
export function attentionFromDateLine(fromDate, hiddenCount) {
  const n = Math.max(0, Math.round(Number(hiddenCount) || 0));
  const noun = n === 1 ? 'item' : 'items';
  return `Showing items from ${formatAttentionFromDateLabel(fromDate)}. ${n} older ${noun} hidden.`;
}

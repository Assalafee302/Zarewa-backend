/**
 * Stop a second haulage posting when this PO already has a payment request
 * for the same payee and the same amount inside 30 days.
 * The bank line on that request is the payment. A new treasury movement would pay it twice.
 */

export const PO_TRANSPORT_DUPLICATE_WINDOW_DAYS = 30;

function normName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isoDay(value) {
  const day = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

export function daysBetweenIso(a, b) {
  const left = Date.parse(`${isoDay(a)}T00:00:00.000Z`);
  const right = Date.parse(`${isoDay(b)}T00:00:00.000Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(Math.round((left - right) / 86_400_000));
}

/**
 * @param {Array<{ request_id?: string, payee_name?: string, amount_requested_ngn?: number, paid_amount_ngn?: number, paid_at_iso?: string, request_date?: string }>} requests
 * @param {{ payeeName: string, amountNgn: number, postedDay: string, windowDays?: number }} needle
 */
export function matchingLinkedHaulageRequest(requests, needle) {
  const payee = normName(needle?.payeeName);
  const amount = Math.round(Number(needle?.amountNgn) || 0);
  const postedDay = isoDay(needle?.postedDay);
  const windowDays = Number.isFinite(Number(needle?.windowDays))
    ? Number(needle.windowDays)
    : PO_TRANSPORT_DUPLICATE_WINDOW_DAYS;
  if (!payee || amount <= 0 || !postedDay) return null;
  for (const row of Array.isArray(requests) ? requests : []) {
    if (normName(row?.payee_name) !== payee) continue;
    const requested = Math.round(Number(row?.amount_requested_ngn) || 0);
    const paid = Math.round(Number(row?.paid_amount_ngn) || 0);
    if (requested !== amount && paid !== amount) continue;
    const paidDay = isoDay(row?.paid_at_iso) || isoDay(row?.request_date);
    const gap = daysBetweenIso(postedDay, paidDay);
    if (gap == null || gap > windowDays) continue;
    return row;
  }
  return null;
}

/**
 * Payment requests already tied to this PO (`request_reference` is the PO id).
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {{ payeeName: string, amountNgn: number, postedDay: string }} needle
 * @returns {null | { ok: false, code: string, error: string, requestId: string }}
 */
export function poTransportDuplicatePaymentBlock(db, poId, needle) {
  const id = String(poId || '').trim();
  if (!id || !db) return null;
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT request_id, payee_name, amount_requested_ngn, paid_amount_ngn, paid_at_iso, request_date
         FROM payment_requests
         WHERE request_reference = ?`
      )
      .all(id);
  } catch {
    return null;
  }
  const hit = matchingLinkedHaulageRequest(rows, needle);
  if (!hit) return null;
  const amount = Math.round(Number(needle.amountNgn) || 0);
  const payee = String(needle.payeeName || '').trim();
  return {
    ok: false,
    code: 'PO_TRANSPORT_DUPLICATE_PAYMENT',
    error: `Haulage ₦${amount.toLocaleString('en-NG')} to ${payee} is already ${hit.request_id}, linked to ${id} within ${PO_TRANSPORT_DUPLICATE_WINDOW_DAYS} days. Do not post it again.`,
    requestId: String(hit.request_id || ''),
  };
}

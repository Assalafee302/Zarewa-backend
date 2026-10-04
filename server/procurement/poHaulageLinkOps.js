/**
 * Tie an existing paid request to a PO as its haulage, and set the agreed fee.
 * Neither function posts a treasury movement.
 */
import { appendAuditLog } from '../controlOps.js';

const NOTE = 'Sept 2026 bank reconciliation – investigation';

/**
 * Point a payment request at a PO so a later haulage posting can see it.
 * Amounts and treasury lines stay as they are.
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 * @param {{ poId: string, payeeName?: string }} payload
 * @param {object | null} [actor]
 */
export function linkPaymentRequestToPurchaseOrderTx(db, requestId, payload, actor = null) {
  const id = String(requestId || '').trim();
  const poId = String(payload?.poId || '').trim();
  const payeeName = String(payload?.payeeName || '').trim();
  if (!id || !poId) return { ok: false, error: 'Payment request and PO are required.' };
  const row = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Payment request not found.' };
  const currentRef = String(row.request_reference || '').trim();
  if (currentRef && currentRef !== poId) {
    return { ok: false, error: `${id} is already linked to ${currentRef}.` };
  }
  const currentPayee = String(row.payee_name || '').trim();
  const nextPayee = currentPayee || payeeName || null;
  db.prepare(
    `UPDATE payment_requests SET request_reference = ?, payee_name = ? WHERE request_id = ?`
  ).run(poId, nextPayee, id);
  appendAuditLog(db, {
    actor,
    action: 'payment_request.link_po_haulage',
    entityKind: 'payment_request',
    entityId: id,
    note: NOTE,
    details: { requestId: id, poId, payeeName: nextPayee },
  });
  return { ok: true, requestId: id, poId, payeeName: nextPayee };
}

/**
 * Set the agreed haulage fee. Does not post cash and does not change PO status.
 * Caller syncs transport_paid from the treasury lines afterwards.
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {number} agreedAmountNgn
 * @param {object | null} [actor]
 */
export function agreePoHaulageFeeTx(db, poId, agreedAmountNgn, actor = null) {
  const id = String(poId || '').trim();
  const agreed = Math.round(Number(agreedAmountNgn) || 0);
  if (!id || agreed <= 0) return { ok: false, error: 'PO and an agreed haulage amount are required.' };
  const row = db.prepare(`SELECT po_id, transport_amount_ngn FROM purchase_orders WHERE po_id = ?`).get(id);
  if (!row) return { ok: false, error: 'PO not found.' };
  const previous = Math.round(Number(row.transport_amount_ngn) || 0);
  if (previous > 0 && agreed > previous) {
    return { ok: false, error: 'Agreed haulage cannot be higher than the fee already on the PO.' };
  }
  db.prepare(`UPDATE purchase_orders SET transport_amount_ngn = ? WHERE po_id = ?`).run(agreed, id);
  appendAuditLog(db, {
    actor,
    action: 'purchase_order.haulage_fee_agreed',
    entityKind: 'purchase_order',
    entityId: id,
    note: NOTE,
    details: { poId: id, previousAmountNgn: previous, agreedAmountNgn: agreed },
  });
  return { ok: true, poId: id, previousAmountNgn: previous, agreedAmountNgn: agreed };
}

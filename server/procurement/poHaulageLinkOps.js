/**
 * Tie an existing paid request to a PO as its haulage, and set the agreed fee.
 * Neither function posts a treasury movement.
 */
import { appendAuditLog } from '../controlOps.js';
import { setPoTransportPayoutHold } from './poTransportPayoutHold.js';
import { reclassifyTreasuryOutflowSourceTx } from '../sales/refundPayoutReclass.js';
import { syncPurchaseOrderTransportPaymentState } from '../writeOps.js';

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

/**
 * Point an already-paid request's bank line at a PO as haulage.
 * Amount, account, and day stay as they are. No new treasury line.
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 * @param {{ poId: string, movementId?: string, payeeName?: string }} payload
 * @param {object | null} [actor]
 */
export function attachPaidRequestAsPoHaulageTx(db, requestId, payload, actor = null) {
  const id = String(requestId || '').trim();
  const poId = String(payload?.poId || '').trim();
  if (!id || !poId) return { ok: false, error: 'Payment request and PO are required.' };
  const po = db
    .prepare(`SELECT po_id, transport_agent_id, transport_agent_name FROM purchase_orders WHERE po_id = ?`)
    .get(poId);
  if (!po) return { ok: false, error: 'PO not found.' };
  const req = db
    .prepare(`SELECT request_id, payee_name FROM payment_requests WHERE request_id = ?`)
    .get(id);
  if (!req) return { ok: false, error: 'Payment request not found.' };

  let movementId = String(payload?.movementId || '').trim();
  if (!movementId) {
    const lines = db
      .prepare(
        `SELECT id FROM treasury_movements
         WHERE source_kind = 'PAYMENT_REQUEST' AND source_id = ?
           AND amount_ngn < 0
           AND reverses_movement_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM treasury_movements rev WHERE rev.reverses_movement_id = treasury_movements.id
           )`
      )
      .all(id);
    if (lines.length !== 1) {
      return {
        ok: false,
        error:
          lines.length === 0
            ? 'No bank line is linked to this request.'
            : 'This request has more than one bank line. Link the specific line.',
      };
    }
    movementId = lines[0].id;
  }

  const payee = String(payload?.payeeName || req.payee_name || po.transport_agent_name || '').trim();
  if (!payee) return { ok: false, error: 'A payee name is required to link this payment as haulage.' };

  const linked = linkPaymentRequestToPurchaseOrderTx(db, id, { poId, payeeName: payee }, actor);
  if (!linked.ok) return linked;

  const moved = reclassifyTreasuryOutflowSourceTx(
    db,
    movementId,
    {
      type: 'TRANSPORT_PAYMENT',
      sourceKind: 'PURCHASE_ORDER',
      sourceId: poId,
      counterpartyName: payee,
      counterpartyKind: po.transport_agent_id ? 'TRANSPORT_AGENT' : '',
      counterpartyId: po.transport_agent_id || '',
      note: NOTE,
    },
    actor
  );
  if (!moved.ok) return moved;

  syncPurchaseOrderTransportPaymentState(db, poId, actor);
  return { ok: true, requestId: id, poId, movementId, payeeName: payee };
}

/**
 * Close the unpaid haulage remainder by agreeing the fee at the amount already on the PO.
 * Does not post cash. Clears the haulage hold and keeps the previous hold reason.
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {object | null} [actor]
 */
export function settlePoHaulageAtAmountAlreadyPaidTx(db, poId, actor = null) {
  const id = String(poId || '').trim();
  if (!id) return { ok: false, error: 'PO is required.' };
  syncPurchaseOrderTransportPaymentState(db, id, actor);
  const row = db
    .prepare(
      `SELECT transport_paid_ngn, transport_payout_hold FROM purchase_orders WHERE po_id = ?`
    )
    .get(id);
  if (!row) return { ok: false, error: 'PO not found.' };
  const paid = Math.round(Number(row.transport_paid_ngn) || 0);
  if (paid <= 0) return { ok: false, error: 'No haulage has been paid on this PO yet.' };
  const agreed = agreePoHaulageFeeTx(db, id, paid, actor);
  if (!agreed.ok) return agreed;
  syncPurchaseOrderTransportPaymentState(db, id, actor);
  let holdStillSet = false;
  if (Number(row.transport_payout_hold) === 1) {
    const cleared = setPoTransportPayoutHold(db, id, { hold: false }, actor);
    if (!cleared.ok && cleared.code !== 'FORBIDDEN') return cleared;
    holdStillSet = !cleared.ok;
  }
  return { ok: true, poId: id, agreedAmountNgn: paid, holdStillSet };
}

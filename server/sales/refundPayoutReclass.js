/**
 * Move an expense payout onto a customer refund without changing the cash amount,
 * the bank account, or the calendar day. The stored till balance is not adjusted.
 */
import { appendAuditLog } from '../controlOps.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} movementId
 * @param {{
 *   refundId: string,
 *   counterpartyName: string,
 *   postedAtISO?: string,
 *   note?: string,
 *   cancelPaymentRequest?: boolean,
 * }} payload
 * @param {object | null} actor
 */
export function movePaymentRequestOutflowOntoRefundTx(db, movementId, payload = {}, actor = null) {
  const mid = String(movementId || '').trim();
  const refundId = String(payload.refundId || '').trim();
  const counterpartyName = String(payload.counterpartyName || '').trim();
  if (!mid || !refundId || !counterpartyName) {
    return { ok: false, error: 'Movement, refund, and payee name are required.' };
  }
  const row = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(mid);
  if (!row) return { ok: false, error: 'Treasury movement not found.' };
  if (String(row.type) !== 'PAYMENT_REQUEST_OUT' || String(row.source_kind) !== 'PAYMENT_REQUEST') {
    return { ok: false, error: 'Only a payment-request payout can be moved onto a refund here.' };
  }
  const amount = roundMoney(row.amount_ngn);
  if (amount >= 0) return { ok: false, error: 'Expected an outflow.' };
  const refund = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundId);
  if (!refund) return { ok: false, error: 'Refund not found.' };
  const oldDay = String(row.posted_at_iso || '').slice(0, 10);
  const nextPosted = String(payload.postedAtISO || row.posted_at_iso || '').trim();
  if (nextPosted.slice(0, 10) !== oldDay) {
    return { ok: false, error: 'The payout must stay on the same calendar day, so the bank balance does not move.' };
  }
  const requestId = String(row.source_id || '').trim();
  const note = String(payload.note || '').trim();
  db.prepare(
    `UPDATE treasury_movements
     SET type = 'REFUND_PAYOUT',
         source_kind = 'REFUND',
         source_id = ?,
         counterparty_kind = 'CUSTOMER',
         counterparty_id = ?,
         counterparty_name = ?,
         posted_at_iso = ?,
         note = ?
     WHERE id = ?`
  ).run(refundId, refund.customer_id, counterpartyName, nextPosted, note || null, mid);

  const nextPaid = roundMoney(refund.paid_amount_ngn) + Math.abs(amount);
  db.prepare(`UPDATE customer_refunds SET paid_amount_ngn = ? WHERE refund_id = ?`).run(nextPaid, refundId);

  let requestCancelled = false;
  if (requestId) {
    const preq = db
      .prepare(`SELECT request_id, paid_amount_ngn, payment_note FROM payment_requests WHERE request_id = ?`)
      .get(requestId);
    if (preq) {
      const nextRequestPaid = Math.max(0, roundMoney(preq.paid_amount_ngn) - Math.abs(amount));
      const prevNote = String(preq.payment_note || '').trim();
      const requestNote = note && !prevNote.includes(note) ? (prevNote ? `${prevNote} ${note}` : note) : prevNote;
      if (payload.cancelPaymentRequest && nextRequestPaid === 0) {
        db.prepare(
          `UPDATE payment_requests
           SET paid_amount_ngn = 0, approval_status = 'Cancelled', paid_at_iso = '', paid_by = '', payment_note = ?
           WHERE request_id = ?`
        ).run(requestNote || null, requestId);
        requestCancelled = true;
      } else {
        db.prepare(`UPDATE payment_requests SET paid_amount_ngn = ?, payment_note = ? WHERE request_id = ?`).run(
          nextRequestPaid,
          requestNote || null,
          requestId
        );
      }
    }
  }

  appendAuditLog(db, {
    actor,
    action: 'treasury.payout_moved_to_refund',
    entityKind: 'treasury_movement',
    entityId: mid,
    note: note || `Moved ${mid} onto ${refundId}`,
    details: {
      movementId: mid,
      refundId,
      previousSourceId: requestId,
      amountNgn: amount,
      treasuryAccountId: Number(row.treasury_account_id),
      balanceUnchanged: true,
      requestCancelled,
    },
  });
  return {
    ok: true,
    movementId: mid,
    refundId,
    amountNgn: amount,
    paidAmountNgn: nextPaid,
    requestId,
    requestCancelled,
  };
}

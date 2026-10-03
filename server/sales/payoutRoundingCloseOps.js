/**
 * Close a payout remainder of ₦200 or less without moving cash.
 * The approved amount, company cut, and paid_amount stay as they are.
 * remainder_closed_ngn is what makes the settlement outstanding hit zero.
 */
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { appendAuditLog } from '../controlOps.js';
import { PAYOUT_ROUNDING_CLOSE_MAX_NGN } from '../../shared/lib/payoutRoundingClose.js';
import {
  buildRefundSettlementSummary,
  resolveRefundStatus,
} from './refundPayoutStatus.js';

const NOTE = 'Sept 2026 bank reconciliation – investigation';
const ROUNDING_LABEL = 'settled – rounding';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

export function ensureRefundRemainderClosedColumns(db) {
  const add = [
    ['remainder_closed_ngn', 'INTEGER NOT NULL DEFAULT 0'],
    ['remainder_closed_reason', 'TEXT'],
  ];
  for (const [name, ddl] of add) {
    if (hasColumn(db, 'customer_refunds', name)) continue;
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN ${name} ${ddl}`);
  }
}

function appendNote(existing, sentence) {
  const prev = String(existing || '').trim();
  if (prev.includes(sentence)) return prev;
  return prev ? `${prev} ${sentence}` : sentence;
}

/**
 * @param {'rounding' | 'cancelled'} kind
 */
export function closeRefundUnpaidRemainder(db, refundId, actor, kind = 'rounding') {
  const id = String(refundId || '').trim();
  if (!id) return { ok: false, error: 'Refund id is required.' };
  if (kind !== 'rounding' && kind !== 'cancelled') {
    return { ok: false, error: 'Remainder close kind must be rounding or cancelled.' };
  }
  ensureRefundRemainderClosedColumns(db);
  const before = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  if (!before) return { ok: false, error: 'Refund not found.' };
  const status = String(before.status || '').trim();
  if (status === 'Cancelled' || status === 'Rejected') {
    return { ok: false, error: `Refund is ${status}.` };
  }
  const summary = buildRefundSettlementSummary(db, before);
  const outstanding = roundMoney(summary.cashOutstandingNgn);
  if (outstanding <= 1) {
    return { ok: true, noOp: true, refundId: id, outstandingNgn: outstanding, status };
  }
  if (outstanding > PAYOUT_ROUNDING_CLOSE_MAX_NGN) {
    return {
      ok: false,
      error: `Remainder ₦${outstanding.toLocaleString('en-NG')} is above ₦${PAYOUT_ROUNDING_CLOSE_MAX_NGN}. It is not a rounding close.`,
    };
  }
  const sentence =
    kind === 'cancelled'
      ? `Cancelled unpaid remainder ₦${outstanding.toLocaleString('en-NG')}. No money out. ${NOTE}`
      : `${ROUNDING_LABEL}. Remainder ₦${outstanding.toLocaleString('en-NG')} closed with no money out. ${NOTE}`;
  const nextClosed = roundMoney(before.remainder_closed_ngn) + outstanding;
  let after = null;
  db.transaction(() => {
    db.prepare(
      `UPDATE customer_refunds
       SET remainder_closed_ngn = ?,
           remainder_closed_reason = ?,
           payment_note = ?
       WHERE refund_id = ?`
    ).run(nextClosed, kind, appendNote(before.payment_note, sentence), id);
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
    const nextStatus = resolveRefundStatus(db, row);
    if (nextStatus && nextStatus !== String(row.status || '').trim()) {
      db.prepare(`UPDATE customer_refunds SET status = ? WHERE refund_id = ?`).run(nextStatus, id);
    }
    appendAuditLog(db, {
      actor,
      action: kind === 'cancelled' ? 'refund.remainder_cancelled' : 'refund.remainder_rounding',
      entityKind: 'refund',
      entityId: id,
      note: sentence,
      details: {
        previousStatus: status,
        previousApprovedNgn: roundMoney(before.approved_amount_ngn),
        previousPaidNgn: roundMoney(before.paid_amount_ngn),
        remainderClosedNgn: outstanding,
        paidAmountUnchanged: true,
      },
    });
    after = db.prepare(`SELECT status, approved_amount_ngn, paid_amount_ngn, remainder_closed_ngn, payment_note FROM customer_refunds WHERE refund_id = ?`).get(id);
  })();
  const afterSummary = buildRefundSettlementSummary(db, db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id));
  return {
    ok: true,
    refundId: id,
    kind,
    before: {
      status,
      approvedNgn: roundMoney(before.approved_amount_ngn),
      paidNgn: roundMoney(before.paid_amount_ngn),
      outstandingNgn: outstanding,
    },
    after: {
      status: after?.status,
      approvedNgn: roundMoney(after?.approved_amount_ngn),
      paidNgn: roundMoney(after?.paid_amount_ngn),
      remainderClosedNgn: roundMoney(after?.remainder_closed_ngn),
      outstandingNgn: roundMoney(afterSummary.cashOutstandingNgn),
    },
  };
}

export function closePaymentRequestRemainderAsRounding(db, requestId, actor) {
  const id = String(requestId || '').trim();
  if (!id) return { ok: false, error: 'Payment request id is required.' };
  const before = db
    .prepare(
      `SELECT request_id, amount_requested_ngn, paid_amount_ngn, approval_status, payment_note
       FROM payment_requests WHERE request_id = ?`
    )
    .get(id);
  if (!before) return { ok: false, error: 'Payment request not found.' };
  const requested = roundMoney(before.amount_requested_ngn);
  const paid = roundMoney(before.paid_amount_ngn);
  const outstanding = Math.max(0, requested - paid);
  if (outstanding <= 1) {
    return { ok: true, noOp: true, requestId: id, outstandingNgn: outstanding };
  }
  if (outstanding > PAYOUT_ROUNDING_CLOSE_MAX_NGN) {
    return {
      ok: false,
      error: `Remainder ₦${outstanding.toLocaleString('en-NG')} is above ₦${PAYOUT_ROUNDING_CLOSE_MAX_NGN}. It is not a rounding close.`,
    };
  }
  const sentence = `${ROUNDING_LABEL}. Remainder ₦${outstanding.toLocaleString('en-NG')} closed with no money out. ${NOTE}`;
  const nextStatus = paid > 0 ? 'Paid' : String(before.approval_status || '').trim();
  db.transaction(() => {
    db.prepare(
      `UPDATE payment_requests
       SET amount_requested_ngn = ?, approval_status = ?, payment_note = ?
       WHERE request_id = ?`
    ).run(paid, nextStatus, appendNote(before.payment_note, sentence), id);
    appendAuditLog(db, {
      actor,
      action: 'payment_request.remainder_rounding',
      entityKind: 'payment_request',
      entityId: id,
      note: sentence,
      details: {
        previousRequestedNgn: requested,
        previousPaidNgn: paid,
        previousStatus: before.approval_status,
        nextRequestedNgn: paid,
        nextStatus,
        paidAmountUnchanged: true,
      },
    });
  })();
  const after = db
    .prepare(
      `SELECT amount_requested_ngn, paid_amount_ngn, approval_status FROM payment_requests WHERE request_id = ?`
    )
    .get(id);
  return {
    ok: true,
    requestId: id,
    before: { requestedNgn: requested, paidNgn: paid, status: before.approval_status, outstandingNgn: outstanding },
    after: {
      requestedNgn: roundMoney(after?.amount_requested_ngn),
      paidNgn: roundMoney(after?.paid_amount_ngn),
      status: after?.approval_status,
      outstandingNgn: Math.max(0, roundMoney(after?.amount_requested_ngn) - roundMoney(after?.paid_amount_ngn)),
    },
  };
}

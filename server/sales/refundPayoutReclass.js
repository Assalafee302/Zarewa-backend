/**
 * Move an expense payout onto a customer refund without changing the cash amount,
 * the bank account, or the calendar day. The stored till balance is not adjusted.
 */
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { appendAuditLog } from '../controlOps.js';
import { userMayManageInvestigations } from '../../shared/lib/investigationRegister.js';
import { assertInvestigationAllowsMutation } from '../office/investigationLock.js';
import { refundCreditSettledNgn } from './refundCreditLedger.js';
import { refundTreasuryPaidNgn } from '../refundCreditApplyOps.js';
import { refundSettledAtApprovalNgn } from '../finance/partnerWalletCredit.js';
import {
  correctRefundPaidAmountNgn,
  resolveRefundStatus,
  buildRefundSettlementSummary,
  refundMoneyOutWithinApproved,
  refundWalletWithdrawnNgn,
} from './refundPayoutStatus.js';

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

/**
 * Point an existing outflow at another source without changing its amount, bank
 * account, or calendar day. The stored till balance is not adjusted.
 * @param {import('better-sqlite3').Database} db
 * @param {string} movementId
 * @param {{
 *   type: string,
 *   sourceKind: string,
 *   sourceId: string,
 *   counterpartyKind?: string,
 *   counterpartyId?: string,
 *   counterpartyName: string,
 *   note?: string,
 *   investigationCaseId?: string,
 * }} payload
 * @param {object | null} actor
 */
export function reclassifyTreasuryOutflowSourceTx(db, movementId, payload = {}, actor = null) {
  const mid = String(movementId || '').trim();
  const nextType = String(payload.type || '').trim();
  const sourceKind = String(payload.sourceKind || '').trim();
  const sourceId = String(payload.sourceId || '').trim();
  const counterpartyName = String(payload.counterpartyName || '').trim();
  if (!mid || !nextType || !sourceKind || !sourceId || !counterpartyName) {
    return { ok: false, error: 'Movement, type, source, and payee name are required.' };
  }
  const row = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(mid);
  if (!row) return { ok: false, error: 'Treasury movement not found.' };
  const amount = roundMoney(row.amount_ngn);
  if (amount >= 0) return { ok: false, error: 'Expected an outflow.' };
  const caseId = String(payload.investigationCaseId || '').trim();
  const bypass = Boolean(caseId && userMayManageInvestigations(actor));
  const lock = assertInvestigationAllowsMutation(db, 'treasury_movement', mid);
  if (!lock.ok && !bypass) return lock;
  if (String(row.source_kind) === 'REFUND' && row.source_id) {
    const refundLock = assertInvestigationAllowsMutation(db, 'refund', row.source_id);
    if (!refundLock.ok && !bypass) return refundLock;
  }
  const note = String(payload.note || '').trim();
  db.prepare(
    `UPDATE treasury_movements
     SET type = ?,
         source_kind = ?,
         source_id = ?,
         counterparty_kind = ?,
         counterparty_id = ?,
         counterparty_name = ?,
         note = ?
     WHERE id = ?`
  ).run(
    nextType,
    sourceKind,
    sourceId,
    String(payload.counterpartyKind || row.counterparty_kind || '').trim() || null,
    payload.counterpartyId != null ? String(payload.counterpartyId).trim() || null : row.counterparty_id,
    counterpartyName,
    note || row.note || null,
    mid
  );
  appendAuditLog(db, {
    actor,
    action: 'treasury.outflow_resourced',
    entityKind: 'treasury_movement',
    entityId: mid,
    note: note || `Re-sourced ${mid}`,
    details: {
      movementId: mid,
      previousType: row.type,
      previousSourceKind: row.source_kind,
      previousSourceId: row.source_id,
      type: nextType,
      sourceKind,
      sourceId,
      amountNgn: amount,
      treasuryAccountId: Number(row.treasury_account_id),
      postedAtIso: row.posted_at_iso,
      balanceUnchanged: true,
    },
  });
  return { ok: true, movementId: mid, amountNgn: amount, treasuryAccountId: Number(row.treasury_account_id) };
}

/**
 * Set paid amount from the refund's treasury lines and resolve status.
 * Does not change the approved amount or move cash.
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @param {string} [note]
 */
export function syncRefundPaidFromTreasuryTx(db, refundId, note = '') {
  const id = String(refundId || '').trim();
  const before = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  if (!before) return { ok: false, error: 'Refund not found.' };
  const paid = correctRefundPaidAmountNgn(db, before);
  const extra = String(note || '').trim();
  const prev = String(before.payment_note || '').trim();
  const paymentNote = extra && !prev.includes(extra) ? (prev ? `${prev} ${extra}` : extra) : prev;
  db.prepare(`UPDATE customer_refunds SET paid_amount_ngn = ?, payment_note = ? WHERE refund_id = ?`).run(
    paid,
    paymentNote || null,
    id
  );
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  const status = resolveRefundStatus(db, row);
  if (status && status !== String(row.status || '').trim()) {
    db.prepare(`UPDATE customer_refunds SET status = ? WHERE refund_id = ?`).run(status, id);
  }
  const fresh = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  return { ok: true, refundId: id, paidAmountNgn: paid, status: fresh.status, summary: buildRefundSettlementSummary(db, fresh) };
}

/**
 * Re-base one refund onto a customer share. Sets the approved amount and the
 * split lines. Does not move cash, change paid amount, or touch credit already applied.
 * Refuses if treasury, credit, and any remaining company cut would exceed the new approved amount.
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @param {{
 *   approvedNgn: number,
 *   payeeName: string,
 *   payeeBankName?: string,
 *   payeeAccountNo?: string,
 *   splits: object[],
 *   note?: string,
 * }} payload
 * @param {object | null} actor
 */
export function rebaseRefundCustomerShareTx(db, refundId, payload = {}, actor = null) {
  const id = String(refundId || '').trim();
  const approved = roundMoney(payload.approvedNgn);
  const payeeName = String(payload.payeeName || '').trim();
  const splits = Array.isArray(payload.splits) ? payload.splits : [];
  if (!id || approved <= 0) return { ok: false, error: 'Refund and approved amount are required.' };
  if (!payeeName) return { ok: false, error: 'Payee name is required.' };
  if (!splits.length) return { ok: false, error: 'A customer split is required.' };
  const before = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  if (!before) return { ok: false, error: 'Refund not found.' };
  const status = String(before.status || '').trim();
  if (status === 'Cancelled' || status === 'Rejected') {
    return { ok: false, error: `Refund is ${status}.` };
  }
  const preview = {
    ...before,
    approved_amount_ngn: approved,
    amount_ngn: approved,
    split_distributions_json: JSON.stringify(splits),
  };
  const within = refundMoneyOutWithinApproved({
    approvedNgn: approved,
    treasuryPaidNgn: refundTreasuryPaidNgn(db, id),
    walletWithdrawnNgn: refundWalletWithdrawnNgn(db, id),
    companyCutSettledNgn: refundSettledAtApprovalNgn(db, preview, approved),
    creditAppliedNgn: refundCreditSettledNgn(db, before),
  });
  if (!within) {
    return { ok: false, error: 'The new approved amount is below money already out on this refund.' };
  }
  const payeeBankName = String(payload.payeeBankName || '').trim();
  const payeeAccountNo = String(payload.payeeAccountNo || '').trim();
  const extra = String(payload.note || '').trim();
  const prev = String(before.payment_note || '').trim();
  const paymentNote = extra && !prev.includes(extra) ? (prev ? `${prev} ${extra}` : extra) : prev;
  if (hasColumn(db, 'customer_refunds', 'payee_account_no')) {
    db.prepare(
      `UPDATE customer_refunds
       SET amount_ngn = ?, approved_amount_ngn = ?,
           payee_name = ?, payee_bank_name = ?, payee_account_no = ?,
           split_distributions_json = ?, payment_note = ?
       WHERE refund_id = ?`
    ).run(
      approved,
      approved,
      payeeName,
      payeeBankName || null,
      payeeAccountNo || null,
      JSON.stringify(splits),
      paymentNote || null,
      id
    );
  } else {
    db.prepare(
      `UPDATE customer_refunds
       SET amount_ngn = ?, approved_amount_ngn = ?,
           payee_name = ?, payee_bank_name = ?,
           split_distributions_json = ?, payment_note = ?
       WHERE refund_id = ?`
    ).run(approved, approved, payeeName, payeeBankName || null, JSON.stringify(splits), paymentNote || null, id);
  }
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  const nextStatus = resolveRefundStatus(db, row);
  if (nextStatus && nextStatus !== String(row.status || '').trim()) {
    db.prepare(`UPDATE customer_refunds SET status = ? WHERE refund_id = ?`).run(nextStatus, id);
  }
  appendAuditLog(db, {
    actor,
    action: 'refund.customer_share_rebase',
    entityKind: 'refund',
    entityId: id,
    note: extra || 'Re-based the customer share.',
    details: {
      previousApprovedNgn: roundMoney(before.approved_amount_ngn),
      approvedNgn: approved,
      previousPaidNgn: roundMoney(before.paid_amount_ngn),
      paidAmountUnchanged: true,
    },
  });
  const fresh = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  return {
    ok: true,
    refundId: id,
    status: fresh.status,
    approvedNgn: approved,
    summary: buildRefundSettlementSummary(db, fresh),
  };
}

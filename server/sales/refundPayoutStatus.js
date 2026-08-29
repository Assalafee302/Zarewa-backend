/**
 * Refund payout status from till/bank (treasury) only — partner-wallet withdrawals
 * do not affect Paid / Partially paid / Approved labels.
 */
import { PAYMENT_OUTSTANDING_TOLERANCE_NGN } from '../../shared/lib/paymentOutstandingTolerance.js';
import {
  refundNetCashDueNgn,
  refundSettledAtApprovalNgn,
} from '../finance/partnerWalletCredit.js';
import { refundTreasuryPaidNgn } from '../refundCreditApplyOps.js';

export const REFUND_STATUS_PARTIALLY_PAID = 'Partially paid';

const PAYOUT_LIFECYCLE_STATUSES = new Set(['Approved', REFUND_STATUS_PARTIALLY_PAID, 'Paid']);

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Sum of partner-wallet withdrawal allocations linked to this refund (informational only). */
export function refundWalletWithdrawnNgn(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return 0;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM partner_wallet_withdrawal_allocations
         WHERE refund_id = ?`
      )
      .get(rid);
    return Math.max(0, roundMoney(row?.s));
  } catch {
    return 0;
  }
}

/** Net till/bank still owed — treasury only (wallet ignored). */
export function refundCashOutstandingNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) return 0;

  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const netCashDue = refundNetCashDueNgn(db, row, approved);
  const treasuryPaid = refundTreasuryPaidNgn(db, refundId);
  return Math.max(0, netCashDue - treasuryPaid);
}

function treasuryCoversNetCashDue(treasuryPaidNgn, netCashDueNgn) {
  const net = roundMoney(netCashDueNgn);
  if (net <= 0) return true;
  return roundMoney(treasuryPaidNgn) >= net - PAYMENT_OUTSTANDING_TOLERANCE_NGN;
}

export function refundStatusAllowsTreasuryPayout(status) {
  const s = String(status || '').trim();
  return s === 'Approved' || s === REFUND_STATUS_PARTIALLY_PAID;
}

/**
 * Paid when till/bank covers net cash due (or nothing was due via treasury).
 * Partially paid when some treasury payout posted but net cash remains.
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row
 */
export function resolveRefundStatus(db, row) {
  const stored = String(row?.status || '').trim();
  if (!PAYOUT_LIFECYCLE_STATUSES.has(stored)) return stored;

  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const netCashDue = refundNetCashDueNgn(db, row, approved);
  const treasuryPaid = refundTreasuryPaidNgn(db, refundId);

  if (treasuryCoversNetCashDue(treasuryPaid, netCashDue)) {
    return 'Paid';
  }
  if (treasuryPaid > 0) {
    return REFUND_STATUS_PARTIALLY_PAID;
  }
  return 'Approved';
}

/** Recompute paid_amount from treasury + approval settlement (not wallet). */
export function correctRefundPaidAmountNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const treasury = refundTreasuryPaidNgn(db, refundId);
  const settledAtApproval = refundSettledAtApprovalNgn(db, row, approved);
  return Math.min(approved, treasury + settledAtApproval);
}

/**
 * Repair stored status / paid_amount when approval marked Paid without treasury payout.
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 */
export function repairRefundPayoutStateTx(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return { ok: false, error: 'refundId required' };

  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(rid);
  if (!row) return { ok: false, error: 'Refund not found.' };

  const storedStatus = String(row.status || '').trim();
  if (!PAYOUT_LIFECYCLE_STATUSES.has(storedStatus)) {
    return { ok: true, changed: false };
  }

  const resolvedStatus = resolveRefundStatus(db, row);
  const correctPaid = correctRefundPaidAmountNgn(db, row);
  const storedPaid = roundMoney(row.paid_amount_ngn);
  const statusChanged = resolvedStatus !== storedStatus;
  const paidChanged = Math.abs(correctPaid - storedPaid) > 0;

  if (!statusChanged && !paidChanged) {
    return { ok: true, changed: false, status: storedStatus, paidAmountNgn: storedPaid };
  }

  db.prepare(
    `UPDATE customer_refunds
     SET status = ?,
         paid_amount_ngn = ?,
         paid_at_iso = CASE WHEN ? IN ('Paid', ?) THEN paid_at_iso ELSE '' END,
         paid_by = CASE WHEN ? IN ('Paid', ?) THEN paid_by ELSE '' END
     WHERE refund_id = ?`
  ).run(
    resolvedStatus,
    correctPaid,
    resolvedStatus,
    REFUND_STATUS_PARTIALLY_PAID,
    resolvedStatus,
    REFUND_STATUS_PARTIALLY_PAID,
    rid
  );

  return {
    ok: true,
    changed: true,
    fromStatus: storedStatus,
    toStatus: resolvedStatus,
    fromPaidAmountNgn: storedPaid,
    toPaidAmountNgn: correctPaid,
  };
}

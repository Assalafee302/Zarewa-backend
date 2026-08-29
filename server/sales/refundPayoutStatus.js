/**
 * Refund payout completeness — Paid only when net cash to payees is covered by
 * treasury movements or partner-wallet withdrawals, and no open wallet credit remains.
 */
import { effectiveOutstandingNgn } from '../../shared/lib/paymentOutstandingTolerance.js';
import {
  refundHasOpenWalletCredit,
  refundNetCashDueNgn,
  refundSettledAtApprovalNgn,
} from '../finance/partnerWalletCredit.js';
import { refundTreasuryPaidNgn } from '../refundCreditApplyOps.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Sum of partner-wallet withdrawal allocations linked to this refund. */
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

/** Net till/bank still owed to payees after treasury + wallet withdrawals. */
export function refundCashOutstandingNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) return 0;
  if (refundHasOpenWalletCredit(db, refundId)) return 0;

  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const netCashDue = refundNetCashDueNgn(db, row, approved);
  const treasuryPaid = refundTreasuryPaidNgn(db, refundId);
  const walletWithdrawn = refundWalletWithdrawnNgn(db, refundId);
  return Math.max(0, netCashDue - treasuryPaid - walletWithdrawn);
}

/**
 * Resolve whether an approved refund is truly Paid (cash complete) vs still awaiting payout.
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row
 */
export function resolveRefundStatus(db, row) {
  const stored = String(row?.status || '').trim();
  if (stored !== 'Approved' && stored !== 'Paid') return stored;

  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const paid = roundMoney(row.paid_amount_ngn ?? row.paidAmountNgn);

  if (refundHasOpenWalletCredit(db, refundId)) return 'Approved';

  const cashOutstanding = refundCashOutstandingNgn(db, row);
  if (cashOutstanding > 0) return 'Approved';

  if (effectiveOutstandingNgn(approved, paid) > 0) return 'Approved';

  return 'Paid';
}

/** Recompute paid_amount from treasury, wallet, and approval settlement (not premature Paid). */
export function correctRefundPaidAmountNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const treasury = refundTreasuryPaidNgn(db, refundId);
  const wallet = refundWalletWithdrawnNgn(db, refundId);
  const settledAtApproval = refundSettledAtApprovalNgn(db, row, approved);
  return Math.min(approved, treasury + wallet + settledAtApproval);
}

/**
 * Repair stored status / paid_amount when approval marked Paid without completing cash payout.
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 */
export function repairRefundPayoutStateTx(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return { ok: false, error: 'refundId required' };

  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(rid);
  if (!row) return { ok: false, error: 'Refund not found.' };

  const storedStatus = String(row.status || '').trim();
  if (storedStatus !== 'Approved' && storedStatus !== 'Paid') {
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
         paid_at_iso = CASE WHEN ? = 'Paid' THEN paid_at_iso ELSE '' END,
         paid_by = CASE WHEN ? = 'Paid' THEN paid_by ELSE '' END
     WHERE refund_id = ?`
  ).run(resolvedStatus, correctPaid, resolvedStatus, resolvedStatus, rid);

  return {
    ok: true,
    changed: true,
    fromStatus: storedStatus,
    toStatus: resolvedStatus,
    fromPaidAmountNgn: storedPaid,
    toPaidAmountNgn: correctPaid,
  };
}

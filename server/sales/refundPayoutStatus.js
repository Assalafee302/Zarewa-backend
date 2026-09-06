/**
 * Refund payout status and settlement summary.
 * paid_amount_ngn = payee money out (treasury + wallet withdrawn + credit apply).
 * Company cut is retention ledger only — never counted as paid to the payee.
 */
import { PAYMENT_OUTSTANDING_TOLERANCE_NGN } from '../../shared/lib/paymentOutstandingTolerance.js';
import {
  openWalletCreditNgnForRefund,
  partnerWalletEnabled,
  refundHeldNetCashDueNgn,
  refundNetCashDueNgn,
  refundSettledAtApprovalNgn,
} from '../finance/partnerWalletCredit.js';
import { refundTillPayableNgn } from '../refundHandlers.js';
import { refundTreasuryPaidNgn } from '../refundCreditApplyOps.js';

export const REFUND_STATUS_PARTIALLY_PAID = 'Partially paid';

const PAYOUT_LIFECYCLE_STATUSES = new Set(['Approved', REFUND_STATUS_PARTIALLY_PAID, 'Paid']);

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

/**
 * Net till/bank/wallet/credit still owed to payees (after company cut).
 */
export function refundCashOutstandingNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) return 0;

  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const netCashDue = refundNetCashDueNgn(db, row, approved);
  const treasuryPaid = refundTreasuryPaidNgn(db, refundId);
  const walletWithdrawn = refundWalletWithdrawnNgn(db, refundId);
  const creditApplied = roundMoney(row.credit_applied_ngn ?? row.creditAppliedNgn);
  return Math.max(0, netCashDue - treasuryPaid - walletWithdrawn - creditApplied);
}

/** Money that has already discharged the payee obligation (not company cut). */
export function refundPayeeSettledNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) return 0;
  const treasuryPaid = refundTreasuryPaidNgn(db, refundId);
  const walletWithdrawn = refundWalletWithdrawnNgn(db, refundId);
  const creditApplied = roundMoney(row.credit_applied_ngn ?? row.creditAppliedNgn);
  return Math.max(0, treasuryPaid + walletWithdrawn + creditApplied);
}

function payeeCoversNetCashDue(payeeSettledNgn, netCashDueNgn) {
  const net = roundMoney(netCashDueNgn);
  if (net <= 0) return true;
  return roundMoney(payeeSettledNgn) >= net - PAYMENT_OUTSTANDING_TOLERANCE_NGN;
}

export function refundStatusAllowsTreasuryPayout(status) {
  const s = String(status || '').trim();
  return s === 'Approved' || s === REFUND_STATUS_PARTIALLY_PAID;
}

/**
 * Paid when till + wallet withdrawals + credit cover net cash due to payees.
 * Company cut alone never marks Paid.
 */
export function resolveRefundStatus(db, row) {
  const stored = String(row?.status || '').trim();
  if (!PAYOUT_LIFECYCLE_STATUSES.has(stored)) return stored;

  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const netCashDue = refundNetCashDueNgn(db, row, approved);
  const payeeSettled = refundPayeeSettledNgn(db, row);

  if (payeeCoversNetCashDue(payeeSettled, netCashDue)) {
    return 'Paid';
  }
  if (payeeSettled > 0) {
    return REFUND_STATUS_PARTIALLY_PAID;
  }
  return 'Approved';
}

/**
 * Guard: cash that left (till + wallet + company cut + credit apply) cannot exceed approved.
 */
export function refundMoneyOutWithinApproved({
  approvedNgn = 0,
  treasuryPaidNgn = 0,
  walletWithdrawnNgn = 0,
  companyCutSettledNgn = 0,
  creditAppliedNgn = 0,
  toleranceNgn = 1,
} = {}) {
  const approved = Math.max(0, roundMoney(approvedNgn));
  const out =
    Math.max(0, roundMoney(treasuryPaidNgn)) +
    Math.max(0, roundMoney(walletWithdrawnNgn)) +
    Math.max(0, roundMoney(companyCutSettledNgn)) +
    Math.max(0, roundMoney(creditAppliedNgn));
  return out <= approved + Math.max(0, roundMoney(toleranceNgn));
}

export function assertRefundMoneyOutWithinApproved(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) throw new Error('Refund id required for money-out check.');
  const approved = roundMoney(
    row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn
  );
  const ok = refundMoneyOutWithinApproved({
    approvedNgn: approved,
    treasuryPaidNgn: refundTreasuryPaidNgn(db, refundId),
    walletWithdrawnNgn: refundWalletWithdrawnNgn(db, refundId),
    companyCutSettledNgn: refundSettledAtApprovalNgn(db, row, approved),
    creditAppliedNgn: row.credit_applied_ngn ?? row.creditAppliedNgn,
  });
  if (!ok) {
    throw new Error('Refund money out exceeds the approved amount.');
  }
  return { ok: true };
}

/**
 * paid_amount = payee channels only (treasury + wallet withdrawn + credit).
 * Company cut is excluded — it lives on the retention ledger.
 */
export function correctRefundPaidAmountNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const treasury = refundTreasuryPaidNgn(db, refundId);
  const walletWithdrawn = refundWalletWithdrawnNgn(db, refundId);
  const creditApplied = roundMoney(row.credit_applied_ngn ?? row.creditAppliedNgn);
  return Math.min(approved, treasury + walletWithdrawn + creditApplied);
}

/**
 * True when no cash/credit has left to payees yet (company cut alone does not block cancel).
 */
export function refundHasPayeeMoneyOut(db, row) {
  return refundPayeeSettledNgn(db, row) > 0;
}

/**
 * Unified settlement snapshot for list/detail APIs and cashier UX.
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row
 * @param {{ walletOpenNgn?: number }} [opts]
 */
export function buildRefundSettlementSummary(db, row, opts = {}) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const storedStatus = String(row?.status || '').trim();
  const approvedNgn = roundMoney(
    row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn
  );
  const companyCutNgn = refundSettledAtApprovalNgn(db, row, approvedNgn);
  const netCashDueNgn = refundNetCashDueNgn(db, row, approvedNgn);
  const treasuryPaidNgn = refundId ? refundTreasuryPaidNgn(db, refundId) : 0;
  const walletWithdrawnNgn = refundId ? refundWalletWithdrawnNgn(db, refundId) : 0;
  const creditAppliedNgn = roundMoney(row.credit_applied_ngn ?? row.creditAppliedNgn);
  const payeeSettledNgn = Math.max(0, treasuryPaidNgn + walletWithdrawnNgn + creditAppliedNgn);
  const cashOutstandingNgn = Math.max(0, netCashDueNgn - payeeSettledNgn);
  const heldUnclearedNgn = PAYOUT_LIFECYCLE_STATUSES.has(storedStatus) || storedStatus === 'Paid'
    ? refundHeldNetCashDueNgn(db, row, approvedNgn)
    : 0;
  const walletOpenNgn =
    opts.walletOpenNgn != null
      ? Math.max(0, roundMoney(opts.walletOpenNgn))
      : partnerWalletEnabled() && refundId
        ? openWalletCreditNgnForRefund(db, refundId)
        : 0;
  const tillPayableNgn = refundTillPayableNgn({
    cashOutstandingNgn,
    heldNetNgn: heldUnclearedNgn,
    adminMayPayUncleared: false,
    openWalletNgn: walletOpenNgn,
  });

  const lifecycleStatus = PAYOUT_LIFECYCLE_STATUSES.has(storedStatus)
    ? resolveRefundStatus(db, row)
    : storedStatus;

  let publicLabel = lifecycleStatus || 'Pending';
  if (PAYOUT_LIFECYCLE_STATUSES.has(lifecycleStatus) || lifecycleStatus === 'Paid') {
    if (cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN && walletOpenNgn <= 0) {
      publicLabel = 'Settled';
    } else if (walletOpenNgn > 0 && tillPayableNgn > 0) {
      publicLabel = 'Ready — till & wallet';
    } else if (walletOpenNgn > 0 && tillPayableNgn <= 0) {
      publicLabel = 'Ready — partner wallet';
    } else if (heldUnclearedNgn > 0 && tillPayableNgn <= 0 && walletOpenNgn <= 0) {
      publicLabel = 'Blocked — clear receipts';
    } else if (payeeSettledNgn > 0 || tillPayableNgn < cashOutstandingNgn) {
      publicLabel =
        tillPayableNgn > 0 && heldUnclearedNgn > 0
          ? 'Partially ready'
          : lifecycleStatus === REFUND_STATUS_PARTIALLY_PAID || payeeSettledNgn > 0
            ? 'Partially settled'
            : 'Ready';
    } else if (tillPayableNgn > 0) {
      publicLabel = 'Ready';
    } else {
      publicLabel = 'Approved';
    }
  }

  return {
    approvedNgn,
    companyCutNgn,
    netCashDueNgn,
    heldUnclearedNgn,
    walletOpenNgn,
    walletWithdrawnNgn,
    treasuryPaidNgn,
    creditAppliedNgn,
    payeeSettledNgn,
    cashOutstandingNgn,
    tillPayableNgn,
    status: lifecycleStatus,
    publicLabel,
    canCancelBeforePay: Boolean(
      (lifecycleStatus === 'Approved' || storedStatus === 'Approved') &&
        payeeSettledNgn <= 0 &&
        walletWithdrawnNgn <= 0
    ),
  };
}

/**
 * Repair stored status / paid_amount when approval marked Paid without payee payout,
 * or when paid_amount still includes legacy company-cut inflation.
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

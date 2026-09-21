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
  resolveCreditTargets,
  listPartnerWalletOpenCreditsForRefund,
} from '../finance/partnerWalletCredit.js';
import { refundCashierPayRelaxed } from '../financeFeatureFlags.js';
import { refundTillPayableNgn } from '../refundHandlers.js';
import { CASHIER_UNCLEARED_HOLD_OVERRIDE_MAX_NGN } from '../../shared/lib/refundUnclearedPayoutHold.js';
import { listActiveRefundCreditApplicationsBySourceQuotation, refundTreasuryPaidNgn } from '../refundCreditApplyOps.js';
import { refundCreditSettledNgn } from './refundCreditLedger.js';
import {
  listCancelableConflictingOverpayRefunds,
  quotationOverpayResidualExcludingRefund,
} from './refundPayReleaseOverpayCredit.js';
import {
  overpayResidualNeededForPayoutNgn,
  sumRefundCalculationLinesByCategoryNgn,
} from '../../shared/lib/refundQuotationMoney.js';

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

function fmtNgn(n) {
  return `₦${Math.max(0, roundMoney(n)).toLocaleString('en-NG')}`;
}

/**
 * Cashier-facing story: what already happened to this refund balance, and how to fix mistakes.
 * Surfaced on payout View / Release refund UI via settlementSummary.situationBrief.
 *
 * @param {{
 *   approvedNgn?: number,
 *   companyCutNgn?: number,
 *   netCashDueNgn?: number,
 *   creditAppliedNgn?: number,
 *   treasuryPaidNgn?: number,
 *   walletWithdrawnNgn?: number,
 *   walletOpenNgn?: number,
 *   cashOutstandingNgn?: number,
 *   tillPayableNgn?: number,
 *   heldUnclearedNgn?: number,
 *   unclearedReceiptIds?: string[],
 *   publicLabel?: string,
 *   canCancelBeforePay?: boolean,
 *   creditAppliedToQuotationRef?: string,
 * }} s
 */
export function buildRefundSituationBrief(s = {}) {
  const approvedNgn = roundMoney(s.approvedNgn);
  const companyCutNgn = roundMoney(s.companyCutNgn);
  const netCashDueNgn = roundMoney(s.netCashDueNgn);
  const creditAppliedNgn = roundMoney(s.creditAppliedNgn);
  const treasuryPaidNgn = roundMoney(s.treasuryPaidNgn);
  const walletWithdrawnNgn = roundMoney(s.walletWithdrawnNgn);
  const walletOpenNgn = roundMoney(s.walletOpenNgn);
  const cashOutstandingNgn = roundMoney(s.cashOutstandingNgn);
  const tillPayableNgn = roundMoney(s.tillPayableNgn);
  const heldUnclearedNgn = roundMoney(s.heldUnclearedNgn);
  const unclearedReceiptIds = Array.isArray(s.unclearedReceiptIds)
    ? s.unclearedReceiptIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const appliedTo = String(s.creditAppliedToQuotationRef || '').trim();
  const publicLabel = String(s.publicLabel || '').trim();

  /** @type {string[]} */
  const whatHappened = [];
  /** @type {string[]} */
  const howToResolve = [];

  if (approvedNgn > 0) {
    whatHappened.push(`Manager approved ${fmtNgn(approvedNgn)} on this refund.`);
  }
  if (companyCutNgn > 0) {
    whatHappened.push(
      `Company cut ${fmtNgn(companyCutNgn)} was retained at approval (never paid to the customer).`
    );
  }
  if (creditAppliedNgn > 0) {
    whatHappened.push(
      appliedTo
        ? `${fmtNgn(creditAppliedNgn)} was already used from this refund onto quotation ${appliedTo} — that is why the cash due dropped.`
        : `${fmtNgn(creditAppliedNgn)} was already used from this refund onto another quotation — that is why the cash due dropped.`
    );
  }
  if (treasuryPaidNgn > 0) {
    whatHappened.push(`${fmtNgn(treasuryPaidNgn)} has already been paid from till/bank.`);
  }
  if (walletWithdrawnNgn > 0) {
    whatHappened.push(`${fmtNgn(walletWithdrawnNgn)} was released from partner wallet.`);
  }
  if (walletOpenNgn > 0) {
    whatHappened.push(`${fmtNgn(walletOpenNgn)} is still sitting on partner wallet for this refund.`);
  }
  if (heldUnclearedNgn > 0) {
    whatHappened.push(
      unclearedReceiptIds.length
        ? `${fmtNgn(heldUnclearedNgn)} is held until receipt(s) ${unclearedReceiptIds.join(', ')} are confirmed.`
        : `${fmtNgn(heldUnclearedNgn)} is held until unconfirmed receipts on this quotation are confirmed.`
    );
  }
  if (tillPayableNgn > 0) {
    whatHappened.push(`Only ${fmtNgn(tillPayableNgn)} is ready to pay from till/bank now.`);
  } else if (cashOutstandingNgn > PAYMENT_OUTSTANDING_TOLERANCE_NGN && heldUnclearedNgn > 0) {
    whatHappened.push('No till amount is ready yet — clear or override the receipt hold first.');
  } else if (
    cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN &&
    walletOpenNgn <= 0 &&
    (creditAppliedNgn > 0 || treasuryPaidNgn > 0 || walletWithdrawnNgn > 0)
  ) {
    whatHappened.push('Nothing is left to pay from till — this refund is already settled for the payee.');
  } else if (netCashDueNgn > 0 && cashOutstandingNgn > 0 && tillPayableNgn <= 0) {
    whatHappened.push(`${fmtNgn(cashOutstandingNgn)} is still owed but not payable from till right now.`);
  }

  if (s.willReleaseOverpayCreditOnPay) {
    const residual = roundMoney(s.overpaymentResidualNgn);
    whatHappened.push(
      residual <= 0
        ? 'Overpayment on this quotation was already held by confirm-payment credit or another unpaid overpayment refund (residual ₦0).'
        : `Only ${fmtNgn(residual)} overpayment residual remains — the rest is held by confirm-payment credit or another unpaid overpayment refund.`
    );
    howToResolve.push(
      `Pay ${fmtNgn(tillPayableNgn)} from till/bank — the system will undo those confirmations and cancel conflicting unpaid overpayment refunds first, then post payout.`
    );
  }

  if (creditAppliedNgn > 0 && tillPayableNgn > 0) {
    howToResolve.push(
      `Pay only the leftover ${fmtNgn(tillPayableNgn)} from till/bank — do not pay the original approved total.`
    );
  } else if (creditAppliedNgn > 0 && cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN) {
    howToResolve.push('Do not pay more cash. Open View to confirm the quotation the fund was applied to.');
  }
  if (walletOpenNgn > 0) {
    howToResolve.push('Release partner wallet from this Pay dialog (same treasury account), then pay any leftover till due.');
  }
  if (heldUnclearedNgn > 0 && tillPayableNgn <= 0) {
    howToResolve.push(
      unclearedReceiptIds.length
        ? `Confirm receipt(s) ${unclearedReceiptIds.join(', ')} on the receipts desk, then return here to Pay.`
        : 'Confirm unconfirmed receipts on this quotation, then return here to Pay.'
    );
  } else if (heldUnclearedNgn > 0 && tillPayableNgn > 0) {
    howToResolve.push(
      `You may pay the ready ${fmtNgn(tillPayableNgn)} now, or confirm receipts first to release the held ${fmtNgn(heldUnclearedNgn)}.`
    );
  }
  if (treasuryPaidNgn > 0) {
    howToResolve.push(
      'If till/bank was paid in error or for too much: ask a manager (finance.reverse) to reverse the treasury payout, then recover the physical cash/transfer.'
    );
  }
  if (creditAppliedNgn > 0) {
    howToResolve.push(
      'If the fund was applied to the wrong quotation: ask a manager to reverse the credit apply, then re-check the till due before paying.'
    );
  }
  if (s.canCancelBeforePay) {
    howToResolve.push('If nothing should be paid at all: cancel this approved refund before any payee money leaves.');
  }
  if (
    tillPayableNgn > 0 &&
    creditAppliedNgn <= 0 &&
    heldUnclearedNgn <= 0 &&
    walletOpenNgn <= 0 &&
    !s.willReleaseOverpayCreditOnPay
  ) {
    howToResolve.push(`Pay ${fmtNgn(tillPayableNgn)} from till/bank to the payee shown on this form.`);
  }
  if (!howToResolve.length && cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN && walletOpenNgn <= 0) {
    howToResolve.push('No further cashier action — refund is settled.');
  }

  let headline = publicLabel || 'Refund payout';
  if (s.willReleaseOverpayCreditOnPay && tillPayableNgn > 0) {
    headline = `Ready to pay ${fmtNgn(tillPayableNgn)} — will undo confirm-payment credit first`;
  } else if (creditAppliedNgn > 0 && tillPayableNgn > 0) {
    headline = 'Part of this refund was already used on a quotation — only the leftover is payable';
  } else if (creditAppliedNgn > 0 && cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN) {
    headline = 'Refund fund already applied — no till payout left';
  } else if (heldUnclearedNgn > 0 && tillPayableNgn <= 0) {
    headline = 'Payout blocked until receipts are confirmed';
  } else if (walletOpenNgn > 0 && tillPayableNgn <= 0) {
    headline = 'Release partner wallet (no till amount ready)';
  } else if (tillPayableNgn > 0) {
    headline = `Ready to pay ${fmtNgn(tillPayableNgn)} from till/bank`;
  } else if (treasuryPaidNgn > 0 && cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN) {
    headline = 'Already paid from till/bank';
  }

  return {
    headline,
    whatHappened,
    howToResolve,
    tone:
      s.willReleaseOverpayCreditOnPay || creditAppliedNgn > 0 || heldUnclearedNgn > 0
        ? 'amber'
        : tillPayableNgn > 0 || walletOpenNgn > 0
          ? 'sky'
          : 'slate',
  };
}

/**
 * Net till/bank/wallet/credit still owed to payees (after company cut).
 */
export function refundCashOutstandingNgn(db, row, creditAppliedByRefundId = null, resolveOpts = {}) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) return 0;

  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const netCashDue = refundNetCashDueNgn(db, row, approved, resolveOpts);
  const treasuryPaid = refundTreasuryPaidNgn(db, refundId);
  const walletWithdrawn = refundWalletWithdrawnNgn(db, refundId);
  const creditApplied = refundCreditSettledNgn(db, row, creditAppliedByRefundId);
  return Math.max(0, netCashDue - treasuryPaid - walletWithdrawn - creditApplied);
}

/** Money that has already discharged the payee obligation (not company cut). */
export function refundPayeeSettledNgn(db, row, creditAppliedByRefundId = null) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) return 0;
  const treasuryPaid = refundTreasuryPaidNgn(db, refundId);
  const walletWithdrawn = refundWalletWithdrawnNgn(db, refundId);
  const creditApplied = refundCreditSettledNgn(db, row, creditAppliedByRefundId);
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
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row
 * @param {Map<string, number> | null} [creditAppliedByRefundId]
 * @param {{ targets?: object[], hrKeys?: Set<string>, skipUnclearedFloat?: boolean }} [resolveOpts]
 */
export function resolveRefundStatus(db, row, creditAppliedByRefundId = null, resolveOpts = {}) {
  const stored = String(row?.status || '').trim();
  if (!PAYOUT_LIFECYCLE_STATUSES.has(stored)) return stored;

  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const netCashDue = refundNetCashDueNgn(db, row, approved, resolveOpts);
  const payeeSettled = refundPayeeSettledNgn(db, row, creditAppliedByRefundId);

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
    creditAppliedNgn: refundCreditSettledNgn(db, row),
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
export function correctRefundPaidAmountNgn(db, row, creditAppliedByRefundId = null) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const approved = roundMoney(row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn);
  const treasury = refundTreasuryPaidNgn(db, refundId);
  const walletWithdrawn = refundWalletWithdrawnNgn(db, refundId);
  const creditApplied = refundCreditSettledNgn(db, row, creditAppliedByRefundId);
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
 * @param {{
 *   walletOpenNgn?: number,
 *   actor?: object,
 *   hasPermission?: (p: string) => boolean,
 *   creditAppliedByRefundId?: Map<string, number> | null,
 *   hrKeys?: Set<string>,
 *   targets?: object[],
 * }} [opts]
 */
export function buildRefundSettlementSummary(db, row, opts = {}) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const storedStatus = String(row?.status || '').trim();
  const approvedNgn = roundMoney(
    row.approved_amount_ngn ?? row.approvedAmountNgn ?? row.amount_ngn ?? row.amountNgn
  );
  // Open payouts need live company-cut + uncleared holds. Paid history only needs cut math
  // (skip uncleared float). Pending/Rejected skip resolveCreditTargets entirely.
  const needsOpenTargets =
    storedStatus === 'Approved' || storedStatus === REFUND_STATUS_PARTIALLY_PAID;
  const needsPaidTargets = storedStatus === 'Paid';
  const resolveOpts = {
    hrKeys: opts.hrKeys instanceof Set ? opts.hrKeys : undefined,
    // Paid history always skips live float; relaxed desk also skips for open Approved payouts.
    skipUnclearedFloat:
      (needsPaidTargets && !needsOpenTargets) || (needsOpenTargets && refundCashierPayRelaxed()),
  };
  let targets = Array.isArray(opts.targets) ? opts.targets : null;
  if ((needsOpenTargets || needsPaidTargets) && approvedNgn > 0) {
    if (!targets) {
      targets = resolveCreditTargets(db, row, approvedNgn, resolveOpts);
    }
  } else {
    targets = targets || [];
  }
  const targetOpts = { ...resolveOpts, targets };
  const companyCutNgn =
    needsOpenTargets || needsPaidTargets
      ? refundSettledAtApprovalNgn(db, row, approvedNgn, targetOpts)
      : 0;
  const netCashDueNgn =
    needsOpenTargets || needsPaidTargets
      ? refundNetCashDueNgn(db, row, approvedNgn, targetOpts)
      : Math.max(0, approvedNgn);
  const treasuryPaidNgn = refundId ? refundTreasuryPaidNgn(db, refundId) : 0;
  const walletWithdrawnNgn = refundId ? refundWalletWithdrawnNgn(db, refundId) : 0;
  const creditAppliedNgn = refundCreditSettledNgn(db, row, opts.creditAppliedByRefundId ?? null);
  const payeeSettledNgn = Math.max(0, treasuryPaidNgn + walletWithdrawnNgn + creditAppliedNgn);
  const cashOutstandingNgn = Math.max(0, netCashDueNgn - payeeSettledNgn);
  const heldUnclearedNgn = needsOpenTargets
    ? refundHeldNetCashDueNgn(db, row, approvedNgn, targetOpts)
    : 0;
  const walletOpenNgn =
    opts.walletOpenNgn != null
      ? Math.max(0, roundMoney(opts.walletOpenNgn))
      : partnerWalletEnabled() && refundId
        ? openWalletCreditNgnForRefund(db, refundId)
        : 0;

  let unclearedReceipts = [];
  let unclearedReceiptIds = [];
  if (heldUnclearedNgn > 0 || needsOpenTargets) {
    try {
      const seen = new Set();
      for (const t of targets) {
        for (const r of Array.isArray(t.unclearedReceipts) ? t.unclearedReceipts : []) {
          const id = String(r?.id || '').trim();
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          unclearedReceipts.push({
            id: id || null,
            amountNgn: roundMoney(r?.amountNgn),
            quotationRef: String(r?.quotationRef || '').trim(),
            customerId: String(r?.customerId || t.partyId || '').trim(),
          });
        }
        for (const id of Array.isArray(t.unclearedReceiptIds) ? t.unclearedReceiptIds : []) {
          const rid = String(id || '').trim();
          if (rid && !seen.has(rid)) {
            seen.add(rid);
            unclearedReceiptIds.push(rid);
          }
        }
      }
      unclearedReceiptIds = [...seen];
    } catch {
      unclearedReceipts = [];
      unclearedReceiptIds = [];
    }
  }

  const tillPayableNgn = refundTillPayableNgn({
    cashOutstandingNgn,
    heldNetNgn: heldUnclearedNgn,
    adminMayPayUncleared: false,
    openWalletNgn: walletOpenNgn,
  });

  const lifecycleStatus = PAYOUT_LIFECYCLE_STATUSES.has(storedStatus)
    ? resolveRefundStatus(db, row, opts.creditAppliedByRefundId ?? null, targetOpts)
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

  /** @type {{ code: string, message: string, action: string }[]} */
  const payoutBlockers = [];
  if (heldUnclearedNgn > 0 && tillPayableNgn <= 0 && walletOpenNgn <= 0) {
    payoutBlockers.push({
      code: 'REFUND_PAYOUT_HELD_UNCLEARED',
      message: `₦${heldUnclearedNgn.toLocaleString('en-NG')} held until unconfirmed receipts on this quotation are confirmed.`,
      action:
        unclearedReceiptIds.length > 0
          ? `Confirm receipt(s) ${unclearedReceiptIds.join(', ')}, then Pay.`
          : 'Confirm unconfirmed receipts for this quotation, then Pay.',
    });
  } else if (heldUnclearedNgn > 0 && tillPayableNgn > 0) {
    payoutBlockers.push({
      code: 'REFUND_PAYOUT_PARTIAL_HOLD',
      message: `₦${heldUnclearedNgn.toLocaleString('en-NG')} still held; ₦${tillPayableNgn.toLocaleString('en-NG')} ready from till/bank.`,
      action:
        unclearedReceiptIds.length > 0
          ? `You can pay the ready slice now, or confirm ${unclearedReceiptIds.join(', ')} first.`
          : 'You can pay the ready slice now, or confirm receipts first.',
    });
  }
  if (walletOpenNgn > 0) {
    payoutBlockers.push({
      code: 'PARTNER_WALLET_WITHDRAWAL_REQUIRED',
      message: `₦${walletOpenNgn.toLocaleString('en-NG')} sits on partner wallet for this refund.`,
      action: 'Release partner wallet from this Pay dialog (same treasury account), then till/bank if anything remains.',
    });
  }

  /** When confirm-payment credit or other unpaid overpay refunds ate residual, till pay will free them. */
  let overpaymentResidualNgn = null;
  let overpayResidualNeededNgn = 0;
  let releasableOverpayCreditApplications = [];
  let cancelableConflictingOverpayRefunds = [];
  const qrefSettle = String(row.quotation_ref || row.quotationRef || '').trim();
  let overpayLineNgn = 0;
  try {
    const rawLines = row.calculation_lines_json ?? row.calculationLinesJson ?? row.calculationLines;
    const parsed =
      typeof rawLines === 'string' && rawLines.trim()
        ? JSON.parse(rawLines)
        : Array.isArray(rawLines)
          ? rawLines
          : [];
    overpayLineNgn = roundMoney(
      sumRefundCalculationLinesByCategoryNgn(Array.isArray(parsed) ? parsed : []).Overpayment
    );
  } catch {
    overpayLineNgn = 0;
  }
  const looksOverpaySettle =
    overpayLineNgn > 0 ||
    /overpay/i.test(String(row.reason_category || row.reasonCategory || '')) ||
    /overpay/i.test(String(row.calculation_lines_json || row.calculationLinesJson || ''));
  if (needsOpenTargets && qrefSettle && tillPayableNgn > 0 && looksOverpaySettle) {
    try {
      overpaymentResidualNgn = quotationOverpayResidualExcludingRefund(db, qrefSettle, refundId);
      // Multi-reason refunds: residual gate is the Overpayment line only, not full till payable.
      overpayResidualNeededNgn = overpayResidualNeededForPayoutNgn({
        overpayLineNgn,
        payoutAmountNgn: tillPayableNgn,
      });
      releasableOverpayCreditApplications = listActiveRefundCreditApplicationsBySourceQuotation(
        db,
        qrefSettle
      ).filter((a) => String(a.refundId || a.refund_id || '').trim() !== refundId);
      cancelableConflictingOverpayRefunds = listCancelableConflictingOverpayRefunds(
        db,
        qrefSettle,
        refundId
      );
      if (
        overpayResidualNeededNgn > overpaymentResidualNgn &&
        (releasableOverpayCreditApplications.length > 0 ||
          cancelableConflictingOverpayRefunds.length > 0)
      ) {
        const creditNgn = releasableOverpayCreditApplications.reduce(
          (s, a) => s + roundMoney(a.amountNgn),
          0
        );
        const conflictIds = cancelableConflictingOverpayRefunds.map((r) => r.refundId).join(', ');
        // Informational only — BM approval authorizes till pay; release runs automatically on pay.
        payoutBlockers.push({
          code: 'REFUND_OVERPAYMENT_CREDIT_WILL_RELEASE',
          message:
            releasableOverpayCreditApplications.length > 0 &&
            cancelableConflictingOverpayRefunds.length > 0
              ? `Overpayment residual is ₦${overpaymentResidualNgn.toLocaleString('en-NG')} — ₦${creditNgn.toLocaleString('en-NG')} confirm-payment credit and unpaid refund(s) ${conflictIds} still hold this cash.`
              : releasableOverpayCreditApplications.length > 0
                ? `Overpayment residual on this quotation is ₦${overpaymentResidualNgn.toLocaleString('en-NG')} because ₦${creditNgn.toLocaleString('en-NG')} was used to confirm another receipt.`
                : `Overpayment residual is ₦${overpaymentResidualNgn.toLocaleString('en-NG')} because unpaid overpayment refund(s) ${conflictIds} still reserve this cash.`,
          action:
            'Pay from till/bank anyway — the system will undo confirmations and cancel those unpaid overpayment refunds first, then post this payout.',
        });
      }
      // Do not add REFUND_OVERPAYMENT_ALREADY_SETTLED after BM approval — cashier may pay the approved amount.
    } catch {
      overpaymentResidualNgn = null;
      overpayResidualNeededNgn = 0;
      releasableOverpayCreditApplications = [];
      cancelableConflictingOverpayRefunds = [];
    }
  }

  const nextActions = [];
  if (unclearedReceiptIds.length > 0) {
    nextActions.push({
      code: 'confirm_receipts',
      label: 'Confirm receipts',
      receiptIds: unclearedReceiptIds,
    });
  }
  if (walletOpenNgn > 0) {
    nextActions.push({
      code: 'release_partner_wallet',
      label: 'Release partner wallet',
      amountNgn: walletOpenNgn,
    });
  }
  if (
    tillPayableNgn > 0 &&
    overpaymentResidualNgn != null &&
    overpayResidualNeededNgn > overpaymentResidualNgn &&
    (releasableOverpayCreditApplications.length > 0 ||
      cancelableConflictingOverpayRefunds.length > 0)
  ) {
    nextActions.push({
      code: 'pay_till_release_overpay_credit',
      label:
        cancelableConflictingOverpayRefunds.length > 0 &&
        releasableOverpayCreditApplications.length === 0
          ? 'Pay till/bank (cancel conflicting unpaid overpay refunds first)'
          : 'Pay till/bank (undo confirm-payment credit first)',
      amountNgn: tillPayableNgn,
      releasableCreditApplications: releasableOverpayCreditApplications,
      cancelableConflictingRefunds: cancelableConflictingOverpayRefunds,
    });
  } else if (tillPayableNgn > 0) {
    nextActions.push({
      code: 'pay_till',
      label: 'Pay till/bank',
      amountNgn: tillPayableNgn,
    });
  }
  if (heldUnclearedNgn > 0 && tillPayableNgn <= 0) {
    nextActions.push({
      code: 'cashier_override_hold',
      label: 'Override uncleared hold with payment note',
      amountNgn: heldUnclearedNgn,
    });
  }
  if (creditAppliedNgn > 0 && cashOutstandingNgn > PAYMENT_OUTSTANDING_TOLERANCE_NGN) {
    nextActions.push({
      code: 'pay_remaining_after_credit',
      label: 'Pay only the leftover till due (credit already used part of this refund)',
      amountNgn: tillPayableNgn > 0 ? tillPayableNgn : cashOutstandingNgn,
    });
  }
  if (creditAppliedNgn > 0 && cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN && treasuryPaidNgn <= 0) {
    nextActions.push({
      code: 'no_till_needed',
      label: 'No till payout needed — refund fund was applied to another quotation',
    });
  }
  if (treasuryPaidNgn > 0 && cashOutstandingNgn <= PAYMENT_OUTSTANDING_TOLERANCE_NGN && walletOpenNgn <= 0) {
    nextActions.push({
      code: 'if_mistaken_payout_reverse',
      label: 'If cash was paid in error: manager reverses till/bank payout (finance.reverse), then recover cash',
    });
  }
  if (creditAppliedNgn > 0) {
    nextActions.push({
      code: 'if_wrong_credit_reverse',
      label: 'If credit was applied to the wrong quotation: reverse the credit apply (finance.reverse), then re-check till due',
    });
  }

  const situationBrief = buildRefundSituationBrief({
    approvedNgn,
    companyCutNgn,
    netCashDueNgn,
    creditAppliedNgn,
    treasuryPaidNgn,
    walletWithdrawnNgn,
    walletOpenNgn,
    cashOutstandingNgn,
    tillPayableNgn,
    heldUnclearedNgn,
    unclearedReceiptIds,
    publicLabel,
    creditAppliedToQuotationRef:
      row?.credit_applied_to_quotation_ref || row?.creditAppliedToQuotationRef || '',
    canCancelBeforePay:
      (lifecycleStatus === 'Approved' || storedStatus === 'Approved') &&
      payeeSettledNgn <= 0 &&
      walletWithdrawnNgn <= 0,
    willReleaseOverpayCreditOnPay:
      (releasableOverpayCreditApplications.length > 0 ||
        cancelableConflictingOverpayRefunds.length > 0) &&
      overpaymentResidualNgn != null &&
      overpayResidualNeededNgn > overpaymentResidualNgn,
    overpaymentResidualNgn,
  });

  let walletOpenCredits = [];
  if (opts.includeWalletOpenCredits !== false) {
    try {
      walletOpenCredits = refundId ? listPartnerWalletOpenCreditsForRefund(db, refundId) : [];
    } catch {
      walletOpenCredits = [];
    }
  }

  return {
    approvedNgn,
    companyCutNgn,
    netCashDueNgn,
    heldUnclearedNgn,
    unclearedReceiptIds,
    unclearedReceipts,
    walletOpenNgn,
    walletOpenCredits,
    walletWithdrawnNgn,
    treasuryPaidNgn,
    creditAppliedNgn,
    /**
     * Money that actually left the business, credit excluded. `paid_amount_ngn` on the
     * refund row counts applied credit as paid — correct for "what is still owed",
     * wrong for "what did we disburse". Cash reporting wants this field.
     */
    cashPaidNgn: Math.max(0, treasuryPaidNgn + walletWithdrawnNgn),
    payeeSettledNgn,
    cashOutstandingNgn,
    tillPayableNgn,
    overpaymentResidualNgn,
    releasableOverpayCreditApplications,
    cancelableConflictingOverpayRefunds,
    status: lifecycleStatus,
    publicLabel,
    payoutBlockers,
    nextActions,
    situationBrief,
    cashierOverrideHoldMaxNgn: CASHIER_UNCLEARED_HOLD_OVERRIDE_MAX_NGN,
    canCancelBeforePay: Boolean(
      (lifecycleStatus === 'Approved' || storedStatus === 'Approved') &&
        payeeSettledNgn <= 0 &&
        walletWithdrawnNgn <= 0
    ),
    /** Internal: reuse for split live-enrich without a second resolveCreditTargets. */
    creditTargets: targets,
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

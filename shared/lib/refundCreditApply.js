/**
 * Pure helpers: apply prior overpay / approved refund credit onto a new quotation.
 * Overpayment may apply without manager approval (Pending or Approved) and does not
 * require production — Finance may use it for cashier referral/confirmation on receipts
 * even when roofing metres are not produced yet. Other refund kinds need Approved status.
 */

import { normalizeRefundReasonCategoriesForApi } from '../refundConstants.js';
import { effectiveOutstandingNgn } from './paymentOutstandingTolerance.js';
import {
  sumRefundStaffCompanyDeductionNgn,
  sumRefundStaffNetPayoutNgn,
} from './refundStaffAllocationDeduction.js';

export const REFUND_CREDIT_CONFIRMATION_STATUS = 'Credit confirmation';
export const REFUND_CREDIT_REVERSED_STATUS = 'Reversed';
/** Ledger `bank_reference` prefix for refund-fund apply (not same-quote OVERPAY_APPLY). */
export const REFUND_CREDIT_LEDGER_REF_PREFIX = 'CREDIT_APPLY:';
/** Compensating rows for {@link REFUND_CREDIT_LEDGER_REF_PREFIX} (finance.reverse). */
export const REFUND_CREDIT_REVERSE_LEDGER_REF_PREFIX = 'CREDIT_APPLY_REVERSE:';

/**
 * @param {unknown} reasonCategory
 * @param {Array<{ category?: string }> | null | undefined} calculationLines
 */
export function refundCategoriesAreOverpaymentOnly(reasonCategory, calculationLines) {
  const cats = normalizeRefundReasonCategoriesForApi(reasonCategory);
  if (cats.length > 0) {
    return cats.every((c) => String(c).toLowerCase().includes('overpay'));
  }
  const lines = Array.isArray(calculationLines) ? calculationLines : [];
  const withCat = lines
    .map((l) => String(l?.category || '').trim())
    .filter(Boolean);
  if (!withCat.length) return false;
  return withCat.every((c) => c.toLowerCase().includes('overpay'));
}

/**
 * Service-fee refunds (transport, installation) are cash-out only — not transferable credit.
 * @param {unknown} reasonCategory
 * @param {Array<{ category?: string, label?: string }> | null | undefined} calculationLines
 */
function refundIncludesNonTransferableServiceCategory(reasonCategory, calculationLines) {
  const blocked = ['transport', 'install'];
  const matchesBlocked = (value) => {
    const v = String(value || '').toLowerCase();
    return blocked.some((b) => v.includes(b));
  };
  const cats = normalizeRefundReasonCategoriesForApi(reasonCategory);
  if (cats.some((c) => matchesBlocked(c))) return true;
  const lines = Array.isArray(calculationLines) ? calculationLines : [];
  return lines.some((l) => matchesBlocked(l?.category) || matchesBlocked(l?.label));
}

/**
 * Status/category gate only — does not check open balance (use with stored-row open helpers).
 * @param {{ status?: string, reasonCategory?: unknown, calculationLines?: unknown }} refund
 */
export function refundIsEligibleCreditSourceKind(refund) {
  const status = String(refund?.status || '').trim();
  if (refundIncludesNonTransferableServiceCategory(refund?.reasonCategory, refund?.calculationLines)) {
    return false;
  }
  const overpayOnly = refundCategoriesAreOverpaymentOnly(
    refund?.reasonCategory,
    refund?.calculationLines
  );
  if (overpayOnly) {
    return status === 'Pending' || status === 'Approved';
  }
  return status === 'Approved';
}

/** True when a ledger/credit error is the quotation-has-open-refund payment lock. */
export function isQuotationActiveRefundLockError(error) {
  const s = String(error || '');
  return /active refund request/i.test(s) || /cannot receive credit from another job/i.test(s);
}

/**
 * Whether this refund row may be used as transferable credit onto another quotation.
 * @param {{ status?: string, reasonCategory?: unknown, calculationLines?: unknown, amountNgn?: number, approvedAmountNgn?: number, paidAmountNgn?: number }} refund
 */
export function refundIsEligibleCreditSource(refund) {
  return refundIsEligibleCreditSourceKind(refund) && refundCreditOpenAmountNgn(refund) > 0;
}

/**
 * Cashier / receipt UI hint when a refund row exists but cannot be pooled as credit.
 * @param {{ status?: string, reasonCategory?: unknown, calculationLines?: unknown }} refund
 * @param {number} openNgn transferable open from {@link refundCreditOpenAmountFromStoredRefund}
 * @param {boolean} [kindEligible]
 */
export function refundCreditUnavailableReason(refund, openNgn, kindEligible = refundIsEligibleCreditSourceKind(refund)) {
  const overpayOnly = refundCategoriesAreOverpaymentOnly(
    refund?.reasonCategory,
    refund?.calculationLines
  );
  if (refundIncludesNonTransferableServiceCategory(refund?.reasonCategory, refund?.calculationLines)) {
    return 'Transport/installation refunds are cash payout only.';
  }
  if (String(refund?.status || '').trim() === 'Pending' && !overpayOnly) {
    return 'Needs manager approval before it can cover a receipt.';
  }
  const paidAt = String(refund?.paidAtISO ?? refund?.paid_at_iso ?? '').trim();
  const paidBy = String(refund?.paidBy ?? refund?.paid_by ?? '').trim();
  if (openNgn <= 0 && (paidAt || paidBy)) {
    const when = paidAt.slice(0, 10);
    return overpayOnly
      ? `Already paid out${when ? ` on ${when}` : ''} — cannot cover another receipt. Do not confirm the same ₦ as new bank cash.`
      : `Already paid out${when ? ` on ${when}` : ''}.`;
  }
  if (openNgn <= 0 && kindEligible && !paidAt && !paidBy) {
    return overpayOnly
      ? 'Looks fully paid on the refund row but no till payout was posted — still on file. View the refund or wait for repair; do not hide it.'
      : 'Looks settled without a till payout date. View the refund — company cut may already be in paid_amount.';
  }
  if (openNgn <= 0 && kindEligible) {
    return overpayOnly
      ? 'Already used, paid out, or no balance left after company cut.'
      : 'Already used, paid out, or no net balance left after company cut.';
  }
  if (openNgn <= 0) {
    return 'Already used or paid out.';
  }
  return 'Not available to cover a receipt yet.';
}

export function refundCreditAppliedNgn(refund) {
  return Math.max(0, Math.round(Number(refund?.creditAppliedNgn ?? refund?.credit_applied_ngn) || 0));
}

/**
 * Requested cash still waiting on the manager after refund fund was used on a receipt.
 */
export function refundLeftoverAwaitingApprovalNgn(refund) {
  const requested = Math.round(Number(refund?.amountNgn) || 0);
  return Math.max(0, requested - refundCreditAppliedNgn(refund));
}

/**
 * Open transferable amount on a refund (requested minus paid and fund already applied, for Pending overpay).
 * @param {{ status?: string, reasonCategory?: unknown, calculationLines?: unknown, amountNgn?: number, approvedAmountNgn?: number, paidAmountNgn?: number, creditAppliedNgn?: number }} refund
 */
export function refundCreditOpenAmountNgn(refund) {
  const status = String(refund?.status || '').trim();
  const paid = Math.round(Number(refund?.paidAmountNgn) || 0);
  const creditApplied = refundCreditAppliedNgn(refund);
  const overpayOnly = refundCategoriesAreOverpaymentOnly(
    refund?.reasonCategory,
    refund?.calculationLines
  );
  if (status === 'Pending' && overpayOnly) {
    const requested = Math.round(Number(refund?.amountNgn) || 0);
    return Math.max(0, requested - paid - creditApplied);
  }
  const approved =
    Math.round(Number(refund?.approvedAmountNgn) || 0) ||
    (status === 'Approved' || status === 'Paid' ? Math.round(Number(refund?.amountNgn) || 0) : 0);
  return effectiveOutstandingNgn(approved, paid);
}

function parseRefundSplitDistributions(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Open transferable credit on a stored refund row, capping staff-split refunds at net payout
 * after company cut (when gross approved/paid would overstate usable fund).
 *
 * @param {object} row DB or API refund row
 */
export function refundCreditOpenAmountFromStoredRefund(row) {
  const shape = {
    status: row?.status,
    reasonCategory: row?.reason_category ?? row?.reasonCategory,
    calculationLines:
      row?.calculationLines ??
      (typeof row?.calculation_lines_json === 'string'
        ? (() => {
            try {
              return JSON.parse(row.calculation_lines_json || '[]');
            } catch {
              return [];
            }
          })()
        : []),
    amountNgn: row?.amount_ngn ?? row?.amountNgn,
    approvedAmountNgn: row?.approved_amount_ngn ?? row?.approvedAmountNgn,
    paidAmountNgn: row?.paid_amount_ngn ?? row?.paidAmountNgn,
    creditAppliedNgn: row?.credit_applied_ngn ?? row?.creditAppliedNgn,
  };
  let open = refundCreditOpenAmountNgn(shape);
  if (!(open > 0)) return 0;

  const overpayOnly = refundCategoriesAreOverpaymentOnly(shape.reasonCategory, shape.calculationLines);
  // Overpayment fund applied as credit is an internal customer transfer — staff split / company
  // cut caps apply to treasury cash payout, not transferable credit on another quotation.
  if (overpayOnly) return open;

  const splits = parseRefundSplitDistributions(
    row?.split_distributions_json ?? row?.splitDistributions ?? row?.refundSplits
  );
  if (!splits.length) return open;

  const netPool = sumRefundStaffNetPayoutNgn(splits);
  const companyCut = sumRefundStaffCompanyDeductionNgn(splits);
  if (!(netPool > 0) && !(companyCut > 0)) return open;

  const paid = Math.round(Number(shape.paidAmountNgn) || 0);
  const creditApplied = refundCreditAppliedNgn(shape);
  const settledCut = Math.min(companyCut, paid);
  const cashPaid = Math.max(0, paid - settledCut);
  const netOpen = Math.max(0, netPool - cashPaid - creditApplied);
  return Math.min(open, netOpen);
}

/**
 * True when an active refund on the payment target should block credit from other quotations.
 * Pending overpay-only refunds do not block — they can be applied explicitly or ignored.
 *
 * @param {object} row customer_refunds row
 */
export function refundBlocksExternalCreditOnQuotation(row) {
  const shape = {
    status: row?.status,
    reasonCategory: row?.reason_category ?? row?.reasonCategory,
    calculationLines:
      typeof row?.calculation_lines_json === 'string'
        ? (() => {
            try {
              return JSON.parse(row.calculation_lines_json || '[]');
            } catch {
              return [];
            }
          })()
        : row?.calculationLines,
    amountNgn: row?.amount_ngn ?? row?.amountNgn,
    approvedAmountNgn: row?.approved_amount_ngn ?? row?.approvedAmountNgn,
    paidAmountNgn: row?.paid_amount_ngn ?? row?.paidAmountNgn,
    creditAppliedNgn: row?.credit_applied_ngn ?? row?.creditAppliedNgn,
  };
  const status = String(shape.status || '').trim();
  const overpayOnly = refundCategoriesAreOverpaymentOnly(shape.reasonCategory, shape.calculationLines);
  if (status === 'Pending') {
    return !overpayOnly;
  }
  if (status === 'Approved') {
    if (overpayOnly) return false;
    return refundCreditOpenAmountFromStoredRefund(row) > 0;
  }
  return false;
}

/**
 * Cap apply amount to target due and available credit.
 * @param {{ targetDueNgn: number, availableNgn: number, requestedNgn?: number | null }} p
 */
export function planRefundCreditApplyAmount({ targetDueNgn, availableNgn, requestedNgn = null }) {
  const due = Math.max(0, Math.round(Number(targetDueNgn) || 0));
  const available = Math.max(0, Math.round(Number(availableNgn) || 0));
  const requested =
    requestedNgn == null || requestedNgn === ''
      ? due
      : Math.max(0, Math.round(Number(requestedNgn) || 0));
  const applyNgn = Math.min(due, available, requested);
  return {
    ok: applyNgn > 0,
    applyNgn,
    targetDueNgn: due,
    availableNgn: available,
    remainderDueNgn: Math.max(0, due - applyNgn),
    leftoverCreditNgn: Math.max(0, available - applyNgn),
    error: applyNgn > 0 ? null : 'No refund fund to apply against this quotation balance.',
  };
}

/**
 * Leftover overpayment that can cover another receipt without a refund request.
 * Sales posts full cash as one RECEIPT (no OVERPAY_ADVANCE split), so economic excess
 * (cash in minus quote total) must be pooled even when the ledger overpay bucket is empty.
 * Named refund opens, till/wallet payouts, and credit already moved off this quote are subtracted
 * so the same ₦ is not listed twice (e.g. RF-KD-26-9456 already paid out must not reappear on confirm).
 * @param {{
 *   ledgerPoolNgn?: number,
 *   economicExcessNgn?: number,
 *   refundOpenNgn?: number,
 *   refundConsumedNgn?: number,
 *   creditAppliedOutNgn?: number,
 * }} p
 */
export function unclaimedOverpayCreditNgn({
  ledgerPoolNgn = 0,
  economicExcessNgn = 0,
  refundOpenNgn = 0,
  refundConsumedNgn = 0,
  creditAppliedOutNgn = 0,
} = {}) {
  const ledger = Math.max(0, Math.round(Number(ledgerPoolNgn) || 0));
  const economic = Math.max(0, Math.round(Number(economicExcessNgn) || 0));
  const refundOpen = Math.max(0, Math.round(Number(refundOpenNgn) || 0));
  const refundConsumed = Math.max(0, Math.round(Number(refundConsumedNgn) || 0));
  const creditOut = Math.max(0, Math.round(Number(creditAppliedOutNgn) || 0));
  return Math.max(0, Math.max(ledger, economic) - refundOpen - refundConsumed - creditOut);
}

/**
 * Overpayment already taken off this refund as a real till/wallet payout.
 * Approval-only `paid_amount` with no payout date/actor is ignored (false Paid — still usable as credit).
 * Credit already moved onto another quote is subtracted separately (`creditAppliedOutNgn`).
 * @param {object} refund
 * @param {number} [treasuryPayoutNgn]
 */
export function refundOverpayConsumedNgn(refund, treasuryPayoutNgn = 0) {
  if (!refundCategoriesAreOverpaymentOnly(refund?.reasonCategory ?? refund?.reason_category, refund?.calculationLines)) {
    return 0;
  }
  const status = String(refund?.status || '').trim().toLowerCase();
  if (status === 'rejected' || status === 'cancelled') return 0;
  const requested = Math.max(0, Math.round(Number(refund?.amountNgn ?? refund?.amount_ngn) || 0));
  const paid = Math.max(0, Math.round(Number(refund?.paidAmountNgn ?? refund?.paid_amount_ngn) || 0));
  const paidAt = String(refund?.paidAtISO ?? refund?.paid_at_iso ?? '').trim();
  const paidBy = String(refund?.paidBy ?? refund?.paid_by ?? '').trim();
  const treasury = Math.max(0, Math.round(Number(treasuryPayoutNgn) || 0));
  const hasPayoutRecord = Boolean(paidAt || paidBy) || treasury > 0;
  const payout = hasPayoutRecord ? Math.max(paid, treasury) : treasury;
  if (!(payout > 0)) return 0;
  return requested > 0 ? Math.min(requested, payout) : payout;
}

/**
 * Overpayment already paid from till/wallet — finished. Must not reappear on confirm payment
 * as leftover credit or as an “on file” reminder (RF-KD-26-9456).
 */
export function refundOverpayFinishedPayout(refund, treasuryPayoutNgn = 0) {
  return refundOverpayConsumedNgn(refund, treasuryPayoutNgn) > 0;
}

/**
 * Drop finished till-paid overpay from confirm’s unavailable list.
 * False Paid (paid_amount, no payout date) stays visible.
 */
export function stripFinishedOverpayFromConfirmEligible(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const unavailableSources = (Array.isArray(payload.unavailableSources) ? payload.unavailableSources : []).filter(
    (s) => {
      const open = Math.max(0, Math.round(Number(s?.availableNgn) || 0));
      if (open > 0) return true;
      return !refundOverpayFinishedPayout(s);
    }
  );
  return { ...payload, unavailableSources };
}

/**
 * Partial use of a refund fund: already applied to another receipt vs still left.
 * @param {{
 *   amountNgn?: number,
 *   availableNgn?: number,
 *   creditAppliedNgn?: number,
 *   paidAmountNgn?: number,
 *   creditAppliedToQuotationRef?: string,
 * }} p
 */
export function refundFundUsageBreakdown({
  amountNgn = 0,
  availableNgn = 0,
  creditAppliedNgn = 0,
  paidAmountNgn = 0,
  creditAppliedToQuotationRef = '',
} = {}) {
  const requestedNgn = Math.max(0, Math.round(Number(amountNgn) || 0));
  const usedOnReceiptNgn = Math.max(0, Math.round(Number(creditAppliedNgn) || 0));
  const paidOutNgn = Math.max(0, Math.round(Number(paidAmountNgn) || 0));
  const leftNgn =
    availableNgn == null || availableNgn === ''
      ? Math.max(0, requestedNgn - usedOnReceiptNgn - paidOutNgn)
      : Math.max(0, Math.round(Number(availableNgn) || 0));
  const appliedToQuote = String(creditAppliedToQuotationRef || '').trim();
  return {
    requestedNgn,
    usedOnReceiptNgn,
    paidOutNgn,
    leftNgn,
    appliedToQuote,
    hasPartialUse: usedOnReceiptNgn > 0,
  };
}

/**
 * Cashier copy when some of this refund already covered another receipt.
 */
export function refundFundRemainingHowToUse(p = {}) {
  const b = refundFundUsageBreakdown(p);
  if (!b.hasPartialUse) return '';
  const usedBit = b.appliedToQuote
    ? `Already used ₦${b.usedOnReceiptNgn.toLocaleString('en-NG')} on ${b.appliedToQuote}`
    : `Already used ₦${b.usedOnReceiptNgn.toLocaleString('en-NG')} on another receipt`;
  const leftBit =
    b.leftNgn > 0
      ? `₦${b.leftNgn.toLocaleString('en-NG')} left — tick this leftover to cover this receipt, or pay it from till. Do not use the original amount again`
      : 'Nothing left on this refund';
  return `${usedBit}. ${leftBit}.`;
}

/**
 * Cashier confirm: offset usable refund fund against an unconfirmed receipt’s cash.
 * Quote due may already be 0 because Sales posted the receipt — offset against receipt cash instead.
 * @param {{ receiptCashNgn?: number, availableNgn?: number }} p
 */
export function planCashierRefundOffset({ receiptCashNgn, availableNgn }) {
  const receipt = Math.max(0, Math.round(Number(receiptCashNgn) || 0));
  const available = Math.max(0, Math.round(Number(availableNgn) || 0));
  const offsetNgn = Math.min(receipt, available);
  return {
    offsetNgn,
    cashToConfirmNgn: Math.max(0, receipt - offsetNgn),
    leftoverRefundNgn: Math.max(0, available - offsetNgn),
  };
}

/**
 * Allocate applyNgn across sources (FIFO as given). Remainder stays on older sources.
 * @param {Array<{ id: string, availableNgn: number }>} sources
 * @param {number} applyNgn
 */
export function allocateRefundCreditAcrossSources(sources, applyNgn) {
  let left = Math.max(0, Math.round(Number(applyNgn) || 0));
  const allocations = [];
  for (const src of sources || []) {
    if (left <= 0) break;
    const avail = Math.max(0, Math.round(Number(src?.availableNgn) || 0));
    if (avail <= 0) continue;
    const take = Math.min(left, avail);
    allocations.push({
      id: src.id,
      amountNgn: take,
      leftoverOnSourceNgn: avail - take,
    });
    left -= take;
  }
  return {
    allocations,
    appliedNgn: Math.max(0, Math.round(Number(applyNgn) || 0) - left),
    shortfallNgn: left,
  };
}

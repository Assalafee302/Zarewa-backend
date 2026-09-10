/**
 * Refund requests — shared between Sales (create / approve) and Finance (pay out).
 * Live data comes from workspace snapshot; localStorage is legacy-only if present.
 */
import { effectiveOutstandingNgn } from './paymentOutstandingTolerance.js';
import { refundQuotationRefundsBlocked } from './quotationRefundsBlocked.js';

const STORAGE_KEY = 'zarewa.sales.refunds';

/** @typedef {'Pending'|'Approved'|'Partially paid'|'Rejected'|'Cancelled'|'Paid'} RefundStatus */

function normalizeLine(line) {
  return {
    label: String(line?.label ?? '').trim(),
    amountNgn: Number(line?.amountNgn) || 0,
  };
}

function normalizePayoutLine(line) {
  return {
    id: String(line?.id ?? ''),
    postedAtISO: String(line?.postedAtISO ?? ''),
    treasuryAccountId: line?.treasuryAccountId ?? '',
    accountName: String(line?.accountName ?? ''),
    amountNgn: Number(line?.amountNgn) || 0,
    reference: String(line?.reference ?? ''),
    note: String(line?.note ?? ''),
  };
}

export function refundApprovedAmount(r) {
  const requested = Number(r?.amountNgn) || 0;
  const approved = Number(r?.approvedAmountNgn);
  if (Number.isFinite(approved) && approved > 0) return approved;
  if (r?.status === 'Approved' || r?.status === 'Paid' || r?.status === 'Partially paid') return requested;
  return 0;
}

/** Till/cash still owed after paid + refund-fund apply, ignoring a stale settlement summary. */
export function refundCreditAdjustedOutstandingNgn(r) {
  const requested = Math.round(Number(r?.amountNgn ?? r?.amount_ngn) || 0);
  const approved = refundApprovedAmount(r);
  const paid = Math.round(Number(r?.paidAmountNgn ?? r?.paid_amount_ngn) || 0);
  const creditApplied = Math.round(Number(r?.creditAppliedNgn ?? r?.credit_applied_ngn) || 0);
  const leftoverAfterCredit = Math.max(0, requested - creditApplied);
  // Manager already approved the leftover after fund use — do not subtract credit twice.
  if (creditApplied > 0 && approved > 0 && approved <= leftoverAfterCredit + 1) {
    const tillPaid = Math.max(0, paid - creditApplied);
    return effectiveOutstandingNgn(approved, tillPaid);
  }
  const companyCut = Math.round(Number(r?.companyCutNgn ?? r?.settlementSummary?.companyCutNgn) || 0);
  const due = companyCut > 0 ? Math.max(0, approved - companyCut) : approved;
  return effectiveOutstandingNgn(due, Math.max(paid, creditApplied));
}

export function refundOutstandingAmount(r) {
  const fromMath = refundCreditAdjustedOutstandingNgn(r);
  const fromSummary = r?.settlementSummary?.cashOutstandingNgn;
  if (fromSummary != null && Number.isFinite(Number(fromSummary))) {
    // Prefer the lower figure: a cached summary can still show the pre-apply till due.
    return Math.min(fromMath, Math.max(0, Math.round(Number(fromSummary) || 0)));
  }
  return fromMath;
}

/**
 * @param {object} r
 * @returns {object}
 */
export function normalizeRefund(r) {
  const amountNgn = Number(r.amountNgn) || 0;
  const paidAmountNgn = Number(r.paidAmountNgn) || 0;
  const approvedAmountNgn = refundApprovedAmount({ ...r, amountNgn, paidAmountNgn });
  return {
    refundID: r.refundID,
    customerID: r.customerID ?? '',
    customer: r.customer ?? '',
    quotationRef: r.quotationRef ?? '',
    cuttingListRef: r.cuttingListRef ?? '',
    product: r.product ?? '—',
    reasonCategory: r.reasonCategory ?? '',
    reason: r.reason ?? '—',
    amountNgn,
    calculationLines: Array.isArray(r.calculationLines) ? r.calculationLines.map(normalizeLine) : [],
    suggestedLines: Array.isArray(r.suggestedLines) ? r.suggestedLines.map(normalizeLine) : [],
    previewSnapshot:
      r.previewSnapshot != null && typeof r.previewSnapshot === 'object' ? r.previewSnapshot : null,
    calculationNotes: r.calculationNotes ?? '',
    status:
      r.status === 'Paid' ||
      r.status === 'Rejected' ||
      r.status === 'Cancelled' ||
      r.status === 'Approved' ||
      r.status === 'Partially paid'
        ? r.status
        : 'Pending',
    requestedBy: r.requestedBy ?? '—',
    requestedAtISO: r.requestedAtISO ?? '',
    approvalDate: r.approvalDate ?? '',
    approvedBy: r.approvedBy ?? '',
    approvedAmountNgn,
    managerComments: r.managerComments ?? '',
    paidAmountNgn,
    paidAtISO: r.paidAtISO ?? '',
    paidBy: r.paidBy ?? '',
    paymentNote: r.paymentNote ?? '',
    payoutHistory: Array.isArray(r.payoutHistory) ? r.payoutHistory.map(normalizePayoutLine) : [],
    creditAppliedNgn: Math.round(Number(r.creditAppliedNgn ?? r.credit_applied_ngn) || 0),
    settlementSummary:
      r.settlementSummary != null && typeof r.settlementSummary === 'object' ? r.settlementSummary : null,
    companyCutNgn: Math.round(Number(r.companyCutNgn ?? r?.settlementSummary?.companyCutNgn) || 0),
    outstandingAmountNgn: refundOutstandingAmount({
      ...r,
      amountNgn,
      paidAmountNgn,
      approvedAmountNgn,
    }),
    quotationRefundsBlockedAtISO:
      r.quotationRefundsBlockedAtISO ?? r.quotation_refunds_blocked_at_iso ?? null,
    quotationRefundsBlockedReason:
      r.quotationRefundsBlockedReason ?? r.quotation_refunds_blocked_reason ?? '',
  };
}

export function isRefundPayable(r) {
  if (refundQuotationRefundsBlocked(r)) return false;
  const status = r?.status;
  if (status !== 'Approved' && status !== 'Partially paid') return false;
  const approved = refundApprovedAmount(r);
  const paid = Math.round(Number(r?.paidAmountNgn ?? r?.paid_amount_ngn) || 0);
  const creditApplied = Math.round(Number(r?.creditAppliedNgn ?? r?.credit_applied_ngn) || 0);
  if (approved > 0 && Math.max(paid, creditApplied) >= approved) return false;
  const tillFromSummary = r?.settlementSummary?.tillPayableNgn;
  if (tillFromSummary != null) {
    const till = Math.round(Number(tillFromSummary) || 0);
    return Math.min(till, refundCreditAdjustedOutstandingNgn(r)) > 0;
  }
  if (Math.round(Number(r?.walletOpenNgn) || 0) > 0) return false;
  return refundOutstandingAmount(r) > 0;
}

export function loadRefunds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(normalizeRefund);
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveRefunds(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map(normalizeRefund)));
  } catch {
    /* ignore */
  }
}

export function approvedRefundsAwaitingPayment(list) {
  return (list ?? []).filter(isRefundPayable);
}

/**
 * Pure helpers: apply prior overpay / approved refund credit onto a new quotation.
 * Overpayment may apply without manager approval; other refund kinds need Approved status.
 */

import { normalizeRefundReasonCategoriesForApi } from '../refundConstants.js';
import { effectiveOutstandingNgn } from './paymentOutstandingTolerance.js';

export const REFUND_CREDIT_CONFIRMATION_STATUS = 'Credit confirmation';

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
 * Whether this refund row may be used as transferable credit onto another quotation.
 * @param {{ status?: string, reasonCategory?: unknown, calculationLines?: unknown, amountNgn?: number, approvedAmountNgn?: number, paidAmountNgn?: number }} refund
 */
export function refundIsEligibleCreditSource(refund) {
  const status = String(refund?.status || '').trim();
  const overpayOnly = refundCategoriesAreOverpaymentOnly(
    refund?.reasonCategory,
    refund?.calculationLines
  );
  if (overpayOnly) {
    if (status !== 'Pending' && status !== 'Approved') return false;
  } else if (status !== 'Approved') {
    return false;
  }
  return refundCreditOpenAmountNgn(refund) > 0;
}

/**
 * Open transferable amount on a refund (requested for Pending overpay; approved−paid otherwise).
 * @param {{ status?: string, reasonCategory?: unknown, calculationLines?: unknown, amountNgn?: number, approvedAmountNgn?: number, paidAmountNgn?: number }} refund
 */
export function refundCreditOpenAmountNgn(refund) {
  const status = String(refund?.status || '').trim();
  const paid = Math.round(Number(refund?.paidAmountNgn) || 0);
  const overpayOnly = refundCategoriesAreOverpaymentOnly(
    refund?.reasonCategory,
    refund?.calculationLines
  );
  if (status === 'Pending' && overpayOnly) {
    const requested = Math.round(Number(refund?.amountNgn) || 0);
    return Math.max(0, requested - paid);
  }
  const approved =
    Math.round(Number(refund?.approvedAmountNgn) || 0) ||
    (status === 'Approved' || status === 'Paid' ? Math.round(Number(refund?.amountNgn) || 0) : 0);
  return effectiveOutstandingNgn(approved, paid);
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
    error: applyNgn > 0 ? null : 'No transferable credit to apply against this quotation balance.',
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

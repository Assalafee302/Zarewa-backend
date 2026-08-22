/**
 * Below-floor quotation price exceptions: MD or administrator approves before cutting list / production.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/quotationPriceException.js
 */

/**
 * True when MD (or legacy confirm) has approved the below-floor exception on this quotation.
 * Branch-manager-only approvals no longer satisfy the gate.
 * @param {{
 *   mdPriceExceptionApprovedAtISO?: string | null;
 *   priceExceptionMdConfirmedAtISO?: string | null;
 * } | null | undefined} q
 */
export function quotationBelowFloorExceptionApproved(q) {
  if (!q) return false;
  if (String(q.mdPriceExceptionApprovedAtISO || '').trim()) return true;
  /** Legacy post-production MD confirm before single-step workflow. */
  if (String(q.priceExceptionMdConfirmedAtISO || '').trim()) return true;
  return false;
}

/** @deprecated Use {@link quotationBelowFloorExceptionApproved} */
export function quotationBmPriceExceptionApproved(q) {
  return quotationBelowFloorExceptionApproved(q);
}

/**
 * Quote is flagged below floor and still needs MD/admin approval.
 * @param {{
 *   priceExceptionMdReviewRequired?: boolean | number | null;
 *   mdPriceExceptionApprovedAtISO?: string | null;
 *   priceExceptionMdConfirmedAtISO?: string | null;
 * } | null | undefined} q
 */
export function quotationBelowFloorPendingMdApproval(q) {
  if (!q) return false;
  const flagged =
    q.priceExceptionMdReviewRequired === true ||
    q.priceExceptionMdReviewRequired === 1 ||
    String(q.priceExceptionMdReviewRequired || '') === '1';
  if (!flagged) return false;
  return !quotationBelowFloorExceptionApproved(q);
}

/** @deprecated Use {@link quotationBelowFloorPendingMdApproval} */
export function quotationFlaggedForMdPriceReview(q) {
  return quotationBelowFloorPendingMdApproval(q);
}

/** @deprecated Use {@link quotationBelowFloorExceptionApproved} */
export function quotationMdPriceReviewConfirmed(q) {
  return quotationBelowFloorExceptionApproved(q);
}

/**
 * Cutting list / refund blocked until MD approves a flagged below-floor quote.
 * @param {Parameters<typeof quotationBelowFloorPendingMdApproval>[0]} q
 */
export function quotationRefundBlockedPendingMdPriceConfirm(q) {
  return quotationBelowFloorPendingMdApproval(q);
}

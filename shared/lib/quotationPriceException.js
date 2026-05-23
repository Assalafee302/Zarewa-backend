/**
 * Below-floor quotation price exceptions: branch manager → production; MD confirm → refund.
 */

/**
 * @param {{ bmPriceExceptionApprovedAtISO?: string | null; mdPriceExceptionApprovedAtISO?: string | null } | null | undefined} q
 */
export function quotationBmPriceExceptionApproved(q) {
  if (!q) return false;
  if (String(q.bmPriceExceptionApprovedAtISO || '').trim()) return true;
  /** Legacy: MD-only approval before BM workflow existed. */
  if (String(q.mdPriceExceptionApprovedAtISO || '').trim()) return true;
  return false;
}

/**
 * @param {{ priceExceptionMdReviewRequired?: boolean | number | null; bmPriceExceptionApprovedAtISO?: string | null } | null | undefined} q
 */
export function quotationFlaggedForMdPriceReview(q) {
  if (!q) return false;
  const flagged =
    q.priceExceptionMdReviewRequired === true ||
    q.priceExceptionMdReviewRequired === 1 ||
    String(q.priceExceptionMdReviewRequired || '') === '1';
  return flagged && String(q.bmPriceExceptionApprovedAtISO || '').trim().length > 0;
}

/**
 * @param {{
 *   priceExceptionMdConfirmedAtISO?: string | null;
 *   mdPriceExceptionApprovedAtISO?: string | null;
 *   priceExceptionMdReviewRequired?: boolean | number | null;
 * } | null | undefined} q
 */
export function quotationMdPriceReviewConfirmed(q) {
  if (!q) return true;
  if (String(q.priceExceptionMdConfirmedAtISO || '').trim()) return true;
  if (!quotationFlaggedForMdPriceReview(q)) {
    /** Legacy MD approval without BM review flag — treat as fully cleared. */
    if (String(q.mdPriceExceptionApprovedAtISO || '').trim()) return true;
    return true;
  }
  return false;
}

/**
 * Refund on this quotation blocked until MD confirms the below-floor exception (after production).
 * @param {Parameters<typeof quotationFlaggedForMdPriceReview>[0]} q
 */
export function quotationRefundBlockedPendingMdPriceConfirm(q) {
  if (!quotationFlaggedForMdPriceReview(q)) return false;
  return !quotationMdPriceReviewConfirmed(q);
}

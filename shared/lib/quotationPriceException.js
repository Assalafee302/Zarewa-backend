/**
 * Below-floor quotation price exceptions: branch manager, MD, or administrator
 * approves before cutting list / refunds. Branch-manager approval notifies MD
 * (informational — MD does not need to re-approve).
 * Production register and start warn on below-floor prices but do not block — the quote already
 * passed earlier price-filter stages.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/quotationPriceException.js
 */

/**
 * True when branch manager, MD, or administrator (or legacy MD confirm) has approved
 * the below-floor exception on this quotation.
 * @param {{
 *   mdPriceExceptionApprovedAtISO?: string | null;
 *   priceExceptionMdConfirmedAtISO?: string | null;
 *   bmPriceExceptionApprovedAtISO?: string | null;
 * } | null | undefined} q
 */
export function quotationBelowFloorExceptionApproved(q) {
  if (!q) return false;
  if (String(q.mdPriceExceptionApprovedAtISO || '').trim()) return true;
  /** Legacy post-production MD confirm before single-step workflow. */
  if (String(q.priceExceptionMdConfirmedAtISO || '').trim()) return true;
  if (String(q.bmPriceExceptionApprovedAtISO || '').trim()) return true;
  return false;
}

/** @deprecated Use {@link quotationBelowFloorExceptionApproved} */
export function quotationBmPriceExceptionApproved(q) {
  return quotationBelowFloorExceptionApproved(q);
}

/**
 * True when a receipt has been posted (`paidNgn` / `paid_ngn` > 0).
 * Unpaid below-floor quotes stay off the MD Command Centre queue until money is in.
 * Partial payment counts.
 * @param {number | string | null | undefined | { paidNgn?: unknown, paid_ngn?: unknown }} paidNgnOrQuote
 */
export function quotationHasPaymentForMdBelowFloorQueue(paidNgnOrQuote) {
  if (paidNgnOrQuote != null && typeof paidNgnOrQuote === 'object') {
    return Math.round(Number(paidNgnOrQuote.paidNgn ?? paidNgnOrQuote.paid_ngn) || 0) > 0;
  }
  return Math.round(Number(paidNgnOrQuote) || 0) > 0;
}

/**
 * Quote is flagged below floor and still needs BM/MD/admin approval.
 * @param {{
 *   priceExceptionMdReviewRequired?: boolean | number | null;
 *   mdPriceExceptionApprovedAtISO?: string | null;
 *   priceExceptionMdConfirmedAtISO?: string | null;
 *   bmPriceExceptionApprovedAtISO?: string | null;
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
 * Cutting list / refund blocked until BM, MD, or admin approves a flagged below-floor quote.
 * Production register and start do not use this gate (warn-only).
 * @param {Parameters<typeof quotationBelowFloorPendingMdApproval>[0]} q
 */
export function quotationRefundBlockedPendingMdPriceConfirm(q) {
  return quotationBelowFloorPendingMdApproval(q);
}

/**
 * Paid below-floor quote waiting on the Branch Manager (or MD) approval page.
 * Maps snake_case SQL rows and camelCase quotation snapshots.
 * @param {object | null | undefined} q
 */
export function quotationNeedsBelowFloorManagerApproval(q) {
  if (!q) return false;
  if (!quotationHasPaymentForMdBelowFloorQueue(q)) return false;
  return quotationBelowFloorPendingMdApproval({
    priceExceptionMdReviewRequired: q.priceExceptionMdReviewRequired ?? q.price_exception_md_review_required,
    mdPriceExceptionApprovedAtISO: q.mdPriceExceptionApprovedAtISO ?? q.md_price_exception_approved_at_iso,
    priceExceptionMdConfirmedAtISO: q.priceExceptionMdConfirmedAtISO ?? q.price_exception_md_confirmed_at_iso,
    bmPriceExceptionApprovedAtISO: q.bmPriceExceptionApprovedAtISO ?? q.bm_price_exception_approved_at_iso,
  });
}

/**
 * SQL predicate: flagged below-floor, not yet BM/MD-approved.
 * Pair with `IFNULL(paid_ngn, 0) > 0` for the manager / MD queues.
 */
export const SQL_PENDING_BELOW_FLOOR_EXCEPTION = `
  price_exception_md_review_required = 1
  AND (md_price_exception_approved_at_iso IS NULL OR TRIM(IFNULL(md_price_exception_approved_at_iso,'')) = '')
  AND (price_exception_md_confirmed_at_iso IS NULL OR TRIM(IFNULL(price_exception_md_confirmed_at_iso,'')) = '')
  AND (bm_price_exception_approved_at_iso IS NULL OR TRIM(IFNULL(bm_price_exception_approved_at_iso,'')) = '')
`;

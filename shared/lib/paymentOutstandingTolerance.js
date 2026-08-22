/**
 * Payments within a small absolute NGN residual are treated as fully settled.
 * Percentage-of-invoice forgiveness (e.g. 0.5% of ₦10m = ₦50k) is not allowed.
 */
export const PAYMENT_OUTSTANDING_TOLERANCE_NGN = 1;

/** @deprecated Use PAYMENT_OUTSTANDING_TOLERANCE_NGN; kept for callers that read the old name. */
export const PAYMENT_EFFECTIVELY_FULL_FRACTION = 1;

/** @deprecated Residual is absolute naira, not a fraction of the invoice. */
export const PAYMENT_OUTSTANDING_TOLERANCE_FRACTION = 0;

/** Minimum paid NGN that counts as fully paid for a given obligation total. */
export function minimumPaidNgnForEffectivelyFull(obligationTotalNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  if (total <= 0) return 0;
  return Math.max(0, total - PAYMENT_OUTSTANDING_TOLERANCE_NGN);
}

/** @param {number} obligationTotalNgn */
export function outstandingToleranceNgn(obligationTotalNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  if (total <= 0) return 0;
  return Math.min(PAYMENT_OUTSTANDING_TOLERANCE_NGN, total);
}

/** @param {number} obligationTotalNgn @param {number} paidNgn */
export function rawOutstandingNgn(obligationTotalNgn, paidNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  const paid = Math.round(Number(paidNgn) || 0);
  return Math.max(0, total - paid);
}

/**
 * Outstanding after applying the absolute full-paid rule (returns 0 when within tolerance).
 * @param {number} obligationTotalNgn
 * @param {number} paidNgn
 */
export function effectiveOutstandingNgn(obligationTotalNgn, paidNgn) {
  if (isEffectivelyFullyPaid(paidNgn, obligationTotalNgn)) return 0;
  return rawOutstandingNgn(obligationTotalNgn, paidNgn);
}

/** @param {number} paidNgn @param {number} obligationTotalNgn */
export function isEffectivelyFullyPaid(paidNgn, obligationTotalNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  if (total <= 0) return true;
  const paid = Math.round(Number(paidNgn) || 0);
  if (paid >= total) return true;
  return paid >= minimumPaidNgnForEffectivelyFull(total);
}

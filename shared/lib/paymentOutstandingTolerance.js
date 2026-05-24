/**
 * Tiny payment residuals (below 0.01% of the obligation) are treated as fully settled.
 */
export const PAYMENT_OUTSTANDING_TOLERANCE_FRACTION = 0.0001;

/** @param {number} obligationTotalNgn */
export function outstandingToleranceNgn(obligationTotalNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  if (total <= 0) return 0;
  return Math.ceil(total * PAYMENT_OUTSTANDING_TOLERANCE_FRACTION);
}

/** @param {number} obligationTotalNgn @param {number} paidNgn */
export function rawOutstandingNgn(obligationTotalNgn, paidNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  const paid = Math.round(Number(paidNgn) || 0);
  return Math.max(0, total - paid);
}

/**
 * Outstanding after applying the 0.01% overlook rule (returns 0 when within tolerance).
 * @param {number} obligationTotalNgn
 * @param {number} paidNgn
 */
export function effectiveOutstandingNgn(obligationTotalNgn, paidNgn) {
  const raw = rawOutstandingNgn(obligationTotalNgn, paidNgn);
  const tol = outstandingToleranceNgn(obligationTotalNgn);
  return raw <= tol ? 0 : raw;
}

/** @param {number} paidNgn @param {number} obligationTotalNgn */
export function isEffectivelyFullyPaid(paidNgn, obligationTotalNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  if (total <= 0) return true;
  const paid = Math.round(Number(paidNgn) || 0);
  if (paid >= total) return true;
  return effectiveOutstandingNgn(total, paid) === 0;
}

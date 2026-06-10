/**
 * Payments at or above 99.5% of the obligation total are treated as fully settled system-wide.
 */
export const PAYMENT_EFFECTIVELY_FULL_FRACTION = 0.995;

export const PAYMENT_OUTSTANDING_TOLERANCE_FRACTION = 1 - PAYMENT_EFFECTIVELY_FULL_FRACTION;

/** Minimum paid NGN that counts as fully paid for a given obligation total. */
export function minimumPaidNgnForEffectivelyFull(obligationTotalNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  if (total <= 0) return 0;
  return Math.ceil(total * PAYMENT_EFFECTIVELY_FULL_FRACTION);
}

/** @param {number} obligationTotalNgn */
export function outstandingToleranceNgn(obligationTotalNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  if (total <= 0) return 0;
  return Math.max(0, total - minimumPaidNgnForEffectivelyFull(total));
}

/** @param {number} obligationTotalNgn @param {number} paidNgn */
export function rawOutstandingNgn(obligationTotalNgn, paidNgn) {
  const total = Math.round(Number(obligationTotalNgn) || 0);
  const paid = Math.round(Number(paidNgn) || 0);
  return Math.max(0, total - paid);
}

/**
 * Outstanding after applying the 99.5% full-paid rule (returns 0 when within tolerance).
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

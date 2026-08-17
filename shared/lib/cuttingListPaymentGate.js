/**
 * Cutting-list / production payment threshold — shared server + frontend parity.
 * Keep Zarewa-frontend-main/src/lib/cuttingListPaymentGate.js in sync.
 */

import { productionGateOverrideEffective } from './productionGateAccess.js';

/**
 * When a published list-price roll-forward raises quotation total after the customer
 * already met the branch payment gate, honor the total that was satisfied (basis).
 * Below-floor / discounted quotes always use the live total.
 *
 * @param {number} totalNgn
 * @param {number | null | undefined} paymentGateBasisTotalNgn
 * @param {boolean} [hasBelowFloorViolations]
 */
export function cuttingListPaymentThresholdTotalNgn(
  totalNgn,
  paymentGateBasisTotalNgn,
  hasBelowFloorViolations = false
) {
  const total = Math.round(Number(totalNgn) || 0);
  if (total <= 0) return 0;
  if (hasBelowFloorViolations) return total;
  const basis = Math.round(Number(paymentGateBasisTotalNgn) || 0);
  if (basis > 0 && total > basis) return basis;
  return total;
}

/**
 * @param {{
 *   id?: string;
 *   totalNgn?: number;
 *   total_ngn?: number;
 *   paidNgn?: number;
 *   paid_ngn?: number;
 *   paymentGateBasisTotalNgn?: number;
 *   payment_gate_basis_total_ngn?: number;
 *   manager_production_approved_at_iso?: string | null;
 *   managerProductionApprovedAtISO?: string | null;
 *   manager_production_approval_level?: string | null;
 *   managerProductionApprovalLevel?: string | null;
 * }} q
 * @param {number} cashPaidNgn Recorded receipts + applied advances/overpay
 * @param {number} [minPaidFraction=0.7]
 * @param {boolean} [hasBelowFloorViolations=false]
 */
export function meetsCuttingListPaymentGate(
  q,
  cashPaidNgn,
  minPaidFraction = 0.7,
  hasBelowFloorViolations = false
) {
  if (productionGateOverrideEffective(q)) return true;
  const total = Number(q?.totalNgn ?? q?.total_ngn) || 0;
  if (total <= 0) return false;
  const mf =
    Number.isFinite(minPaidFraction) && minPaidFraction >= 0.05 && minPaidFraction <= 1
      ? minPaidFraction
      : 0.7;
  const basis = Number(q?.paymentGateBasisTotalNgn ?? q?.payment_gate_basis_total_ngn) || 0;
  const thresholdTotal = cuttingListPaymentThresholdTotalNgn(total, basis, hasBelowFloorViolations);
  const threshold = thresholdTotal * mf - 1e-6;
  const book = Math.max(0, Math.round(Number(q?.paidNgn ?? q?.paid_ngn) || 0));
  const cash = Math.max(0, Math.round(Number(cashPaidNgn) || 0));
  return cash >= threshold || book >= threshold;
}

/**
 * Snap payment gate basis when paid amount first satisfies the branch threshold.
 * @param {number} paidNgn
 * @param {number} totalNgn
 * @param {number | null | undefined} existingBasisNgn
 * @param {number} [minPaidFraction=0.7]
 * @returns {number | null} New basis to persist, or null when unchanged
 */
export function nextPaymentGateBasisTotalNgn(paidNgn, totalNgn, existingBasisNgn, minPaidFraction = 0.7) {
  const paid = Math.round(Number(paidNgn) || 0);
  const total = Math.round(Number(totalNgn) || 0);
  if (paid <= 0 || total <= 0) return null;
  const mf =
    Number.isFinite(minPaidFraction) && minPaidFraction >= 0.05 && minPaidFraction <= 1
      ? minPaidFraction
      : 0.7;
  if (paid + 1e-6 < total * mf) return null;
  const next = Math.max(Math.round(Number(existingBasisNgn) || 0), total);
  const prev = Math.round(Number(existingBasisNgn) || 0);
  return next > prev ? next : null;
}

/**
 * Preserve gate satisfaction when list-price publish raises total on a list-priced quote.
 * @param {number} oldTotalNgn
 * @param {number} newTotalNgn
 * @param {number} paidNgn
 * @param {number | null | undefined} existingBasisNgn
 * @param {number} [minPaidFraction=0.7]
 * @returns {number | null}
 */
export function paymentGateBasisAfterQuotationTotalIncrease(
  oldTotalNgn,
  newTotalNgn,
  paidNgn,
  existingBasisNgn,
  minPaidFraction = 0.7
) {
  const oldTotal = Math.round(Number(oldTotalNgn) || 0);
  const newTotal = Math.round(Number(newTotalNgn) || 0);
  const paid = Math.round(Number(paidNgn) || 0);
  if (newTotal <= oldTotal || oldTotal <= 0) return null;
  const mf =
    Number.isFinite(minPaidFraction) && minPaidFraction >= 0.05 && minPaidFraction <= 1
      ? minPaidFraction
      : 0.7;
  if (paid + 1e-6 < oldTotal * mf) return null;
  const next = Math.max(Math.round(Number(existingBasisNgn) || 0), oldTotal);
  const prev = Math.round(Number(existingBasisNgn) || 0);
  return next > prev ? next : null;
}

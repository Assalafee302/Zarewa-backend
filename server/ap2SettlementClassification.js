/**
 * AP2c — PO/supplier settlement classification (read-model).
 */
import { roundMoney } from './ap2ReceivedBasisOps.js';

/**
 * @param {{
 *   receivedValueNgn?: number;
 *   supplierPaidNgn?: number;
 *   orderedValueNgn?: number;
 *   expectedApNgn?: number;
 *   supplierAdvanceNgn?: number;
 *   missingCostCount?: number;
 * }} econ
 */
export function classifyPoSettlement(econ) {
  const received = roundMoney(econ.receivedValueNgn);
  const paid = roundMoney(econ.supplierPaidNgn);
  const ordered = roundMoney(econ.orderedValueNgn);
  const payableOutstanding = roundMoney(econ.expectedApNgn);
  const supplierAdvance = roundMoney(econ.supplierAdvanceNgn ?? Math.max(paid - received, 0));
  const missingCost = (econ.missingCostCount || 0) > 0;

  let classification = 'normal_payable';
  const labels = [];

  if (received === 0 && paid === 0 && ordered > 0) {
    classification = 'missing_grn';
    labels.push('No GRN recorded');
  } else if (received === 0 && paid > 0) {
    classification = 'supplier_advance';
    labels.push('Paid before goods received');
  } else if (supplierAdvance > 0 && received > 0) {
    classification = 'partially_received_advance';
    labels.push('Advance with partial receipt');
  } else if (supplierAdvance > 0) {
    classification = 'supplier_advance';
    labels.push('Supplier prepayment');
  } else if (received > 0 && payableOutstanding === 0 && paid >= received) {
    classification = 'fully_paid';
    labels.push('Received goods fully paid');
  } else if (received > 0 && payableOutstanding > 0) {
    classification = 'normal_payable';
    labels.push('Outstanding on received goods');
  }

  if (missingCost) labels.push('Missing cost basis');

  return {
    classification,
    labels,
    payableOutstandingNgn: payableOutstanding,
    supplierAdvanceNgn: supplierAdvance,
  };
}

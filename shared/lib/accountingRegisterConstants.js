/** Minimum line amount (₦) captured on creditors / debtors accounting registers. */
export const MIN_ACCOUNTING_REGISTER_LINE_NGN = 1500;

/** @deprecated Use MIN_ACCOUNTING_REGISTER_LINE_NGN — same floor for customer trade AR. */
export const MIN_CUSTOMER_TRADE_RECEIVABLE_NGN = MIN_ACCOUNTING_REGISTER_LINE_NGN;

/** @param {number} amountNgn */
export function meetsAccountingRegisterCaptureFloor(amountNgn) {
  return Math.round(Number(amountNgn) || 0) >= MIN_ACCOUNTING_REGISTER_LINE_NGN;
}

/** @param {number} amountNgn */
export function meetsCustomerTradeReceivableRegisterFloor(amountNgn) {
  return meetsAccountingRegisterCaptureFloor(amountNgn);
}

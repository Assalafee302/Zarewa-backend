/** Minimum aggregated customer trade receivable (₦) on the creditors register. */
export const MIN_CUSTOMER_TRADE_RECEIVABLE_NGN = 1000;

/** @param {number} amountNgn */
export function meetsCustomerTradeReceivableRegisterFloor(amountNgn) {
  return Math.round(Number(amountNgn) || 0) >= MIN_CUSTOMER_TRADE_RECEIVABLE_NGN;
}

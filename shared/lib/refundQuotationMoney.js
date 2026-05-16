/**
 * Refund headroom on a quotation: cash received on this quote only (not unrelated customer balance).
 * When cash in exceeds the quote total, refundable excess = cash in − quote total − refunds already reserved.
 * Otherwise refundable headroom = cash in − refunds already reserved.
 */

export function roundRefundMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * @param {{ cashInNgn: number, quoteTotalNgn: number, totalRefundedNgn: number }} p
 * @returns {number}
 */
export function quotationRefundHeadroomNgn({ cashInNgn, quoteTotalNgn, totalRefundedNgn }) {
  const cashIn = roundRefundMoney(cashInNgn);
  const quoteTotal = roundRefundMoney(quoteTotalNgn);
  const refunded = roundRefundMoney(totalRefundedNgn);
  if (cashIn <= 0) return 0;
  if (quoteTotal > 0 && cashIn > quoteTotal) {
    return Math.max(0, cashIn - quoteTotal - refunded);
  }
  return Math.max(0, cashIn - refunded);
}

/**
 * Excess cash on this quotation above the quote total (before refunds).
 * @param {{ cashInNgn: number, quoteTotalNgn: number }} p
 * @returns {number}
 */
export function quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn }) {
  const cashIn = roundRefundMoney(cashInNgn);
  const quoteTotal = roundRefundMoney(quoteTotalNgn);
  if (quoteTotal <= 0 || cashIn <= quoteTotal) return 0;
  return cashIn - quoteTotal;
}

/**
 * Economic cash on one quotation for refund caps — avoids counting OVERPAY_ADVANCE twice when
 * staff post again on an already-settled quote (companion split overpay is already in receipt cash).
 *
 * @param {{
 *   receiptCashNgn: number,
 *   advanceAppliedNgn?: number,
 *   netOverpayLedgerNgn?: number,
 *   companionOverpayOnQuoteNgn?: number,
 *   settledQuoteFullOverpayNgn?: number,
 * }} p
 * @returns {number}
 */
export function quotationActualCashInNgn({
  receiptCashNgn,
  advanceAppliedNgn = 0,
  netOverpayLedgerNgn = 0,
  companionOverpayOnQuoteNgn = 0,
  settledQuoteFullOverpayNgn = 0,
}) {
  const receiptCash = roundRefundMoney(receiptCashNgn);
  const advance = roundRefundMoney(advanceAppliedNgn);
  const companion = Math.max(0, roundRefundMoney(companionOverpayOnQuoteNgn));
  const netOverpay = Math.max(0, roundRefundMoney(netOverpayLedgerNgn));
  const settledFull = Math.max(0, roundRefundMoney(settledQuoteFullOverpayNgn));

  let standaloneOverpay = Math.max(0, netOverpay - companion);
  if (receiptCash > 0 && settledFull > 0) {
    standaloneOverpay = Math.max(0, standaloneOverpay - settledFull);
  }

  return roundRefundMoney(receiptCash + advance + standaloneOverpay);
}
